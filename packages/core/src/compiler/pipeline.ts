import {
  type CachePlan,
  type ChatId,
  type CompileMode,
  type CompileTrace,
  type Diagnostic,
  type MessageId,
  type PromptContribution,
  type PromptIR,
  type PromptSnapshot,
  type PromptZoneName,
  type Result,
  type RunId,
  type SerializedPrompt,
  type SnapshotId,
  type StabilityClass,
  type Timestamp,
} from '@whispertavern/contracts'
import { createPromptIR, deepFreeze, type DeepReadonly } from '../ir/segment'
import { expandWithAnalysis } from '../macro/engine'
import { seededRng } from '../macro/rng'
import type { MacroContext, MacroMode, MessageContext, RuntimeVariables } from '../macro/types'
import { ZONE_ORDER } from '../serializer/hash'
import { buildPromptSnapshot } from '../serializer/snapshot'
import { estimateTokens, type TokenCountMode } from '../tokens/estimate'

/**
 * Compiler 最小管线 —— compiler-spec §3 的 P0 子集(p0-plan S4 任务 1)+ S16 宏引擎。
 *
 * 阶段:分区归类(提交方声明 zone)→ 宏展开 + Macro Cache Rule(S16,§37–§45)
 * → stable sorting(§93/§94)→ 硬上限(R-P0-2,不裁剪)→ IR 组装(含 I5 运行期断言)
 * → 序列化(§62 规范路径)→ CachePlan=空(R-P0-4)→ Snapshot 落点(§66)。
 *
 * 不做(Non-goals):stableWB/freshWB/summary 填充策略(S17)、预算裁剪(P2)、
 * CachePlan(P2)、strict/preview 之外四模式(P1+)。宏引擎已落地(S16),
 * R-P0-1 宏透传退役(MACRO_UNEXPANDED_P0 移除)。
 *
 * 失败语义:可预期失败走 Result(共享契约 §2 禁 throw 作普通控制流);
 * 不变式违例按 compiler-spec 抛 INVARIANT_VIOLATION——那是实现 bug,不是控制流。
 */

/** §43 三档策略(缺省按 mode 推导:strict→'strict',preview→'normal') */
export type MacroCachePolicy = 'strict' | 'normal' | 'compat'

export interface CompileRequest {
  chatId: ChatId
  /** 调用方生成(UUIDv7,database-schema §3);builder 不产生随机 ID */
  snapshotId: SnapshotId
  runId?: RunId
  messageId?: MessageId
  provider: string
  model: string
  compilerVersion: string
  /** 注入时钟(确定性:同输入含同 now → 逐字节同输出;宏 {{time}}/{{date}}/{{random}} 种子源) */
  now: Timestamp
  /** R-P0-2 硬上限:总 token 超限 → PROMPT_CONTEXT_TOO_LARGE,不裁剪 */
  maxContextTokens: number
  mode: CompileMode
  contributions: readonly PromptContribution[]
  /** S16 必填:宏展开变量(server/runtime 构造;§44) */
  variables: RuntimeVariables
  /** S16 可选:{{lastMessage}} 取文对象(runtime 已有 chain,传最后一条) */
  lastMessage?: MessageContext
  /** §43 三档:缺省按 mode 推导(strict→'strict',preview→'normal');显式值优先 */
  macroCachePolicy?: MacroCachePolicy
  tokenCountMode?: TokenCountMode
}

export interface CompileSuccess {
  /** 不可变保证以类型兑现:DeepReadonly 是 contracts 同型对象的只读投影(非同义新类型) */
  ir: DeepReadonly<PromptIR>
  cachePlan: DeepReadonly<CachePlan>
  serialized: DeepReadonly<SerializedPrompt>
  snapshot: DeepReadonly<PromptSnapshot>
  diagnostics: readonly Diagnostic[]
  /** §101:性能数据源;含计时,不参与确定性比较与哈希 */
  trace: DeepReadonly<CompileTrace>
}

export type CompileFailureCode =
  | 'PROMPT_CONTEXT_TOO_LARGE'
  | 'DUPLICATE_SEGMENT_ID'
  | 'UNSUPPORTED_MODE'
  | 'COMPILE_FAILED'

export interface CompileFailure {
  code: CompileFailureCode
  message: string
  diagnostics: readonly Diagnostic[]
}

export type CompileOutcome = Result<CompileSuccess, CompileFailure>

/** §16 推断的 P0 占位:按区默认;S17 决策 A——stableWB/freshWB 默认 session(世界书条目
 * 几乎必含 {{user}} 等 session 宏,保持 static 会让 Macro Cache Rule 全量移 tail) */
const ZONE_DEFAULT_STABILITY: Record<PromptZoneName, StabilityClass> = {
  header: 'session',
  stableWB: 'session',
  freshWB: 'session',
  summary: 'session',
  history: 'message',
  injection: 'request',
  tail: 'volatile',
}

export function compile(request: CompileRequest): CompileOutcome {
  const t0 = performance.now()
  const stages: { name: string; durationMs: number }[] = []
  const mark = (name: string, from: number): void => {
    stages.push({ name, durationMs: performance.now() - from })
  }

  if (request.mode !== 'strict' && request.mode !== 'preview') {
    return failure('UNSUPPORTED_MODE', `mode ${request.mode} 未在 P0 实现(strict/preview 之外归 P1+)`, [])
  }

  // —— 唯一性(§9:ID 稳定且唯一,冲突直接破坏确定性)——
  let stageStart = performance.now()
  const seen = new Set<string>()
  for (const contribution of request.contributions) {
    if (seen.has(contribution.id)) {
      return failure('DUPLICATE_SEGMENT_ID', `segment id 重复: ${contribution.id}`, [])
    }
    seen.add(contribution.id)
  }
  mark('normalize', stageStart)

  // —— 分区/稳定性解析(zone 取自提交方声明;stability 取声明或按区默认,§16)——
  stageStart = performance.now()
  const diagnostics: Diagnostic[] = []
  const resolved = request.contributions.map((contribution, index) =>
    resolveContribution(contribution, index, diagnostics),
  )
  mark('resolve', stageStart)

  // —— 宏展开 + Macro Cache Rule(S16,§37–§45;替换 P0 宏透传 R-P0-1)——
  stageStart = performance.now()
  const macroPolicy = request.macroCachePolicy ?? (request.mode === 'strict' ? 'strict' : 'normal')
  const macroContext: MacroContext = {
    variables: request.variables,
    message: request.lastMessage,
    now: new Date(request.now),
    mode: mapMacroMode(request.mode),
    // §45/§40 种子:now|chatId(不含 snapshotId/messageId——同 chat 同 now 逐字节一致)
    rng: seededRng(`${request.now}|${request.chatId}`),
  }
  for (const item of resolved) {
    const { content, analysis } = expandWithAnalysis(item.contribution.segment.content, macroContext)
    for (const d of analysis.diagnostics) {
      diagnostics.push({ ...d, segmentId: item.contribution.id })
    }
    item.expandedContent = content
    applyMacroCacheRule(item, analysis, macroPolicy, diagnostics)
    if (item.expandedContent === '') {
      diagnostics.push({
        level: 'info',
        code: 'EMPTY_SEGMENT',
        message: '空段(compiler-spec §71)',
        segmentId: item.contribution.id,
      })
    }
  }
  mark('macro-scan', stageStart)

  // —— stable sorting(§93:zone → semantic order → 物理序 → stable ID;§94 确定性)——
  stageStart = performance.now()
  const sorted = [...resolved].sort((a, b) => {
    const zoneDelta = ZONE_ORDER.indexOf(a.zone) - ZONE_ORDER.indexOf(b.zone)
    if (zoneDelta !== 0) return zoneDelta
    const orderDelta = placementOrder(a.contribution) - placementOrder(b.contribution)
    if (orderDelta !== 0) return orderDelta
    if (a.index !== b.index) return a.index - b.index // 物理序 = 提交序
    return a.contribution.id < b.contribution.id ? -1 : 1 // stable ID tie breaker
  })
  mark('sorting', stageStart)

  // —— token 汇总与硬上限(R-P0-2:只报错终止,不裁剪;按展开后文本估算,R-P2-3)——
  stageStart = performance.now()
  const tokenCountMode = request.tokenCountMode ?? 'estimated'
  let totalTokens = 0
  for (const item of sorted) {
    item.tokenCount =
      item.contribution.segment.tokenCount ?? estimateTokens(item.expandedContent)
    totalTokens += item.tokenCount
  }
  if (totalTokens > request.maxContextTokens) {
    diagnostics.push({
      level: 'error',
      code: 'PROMPT_CONTEXT_TOO_LARGE',
      message: `序列化后 ${totalTokens} tokens 超过模型上限 ${request.maxContextTokens}(R-P0-2:不裁剪,报错终止)`,
      details: { totalTokens, maxContextTokens: request.maxContextTokens },
    })
    return failure('PROMPT_CONTEXT_TOO_LARGE', 'prompt 超出模型上下文硬上限', diagnostics)
  }
  mark('budget-limit', stageStart)

  // —— IR 组装 ——
  stageStart = performance.now()
  const ir = createPromptIR({
    schemaVersion: 1,
    segments: sorted.map((item) => ({
      id: item.contribution.id,
      source: item.contribution.source,
      role: item.contribution.segment.role,
      content: item.expandedContent, // 哈希对象 = 宏展开后的最终文本(R-P2-3)
      semanticPlacement: item.contribution.semanticPlacement,
      cachePlacement: { zone: item.zone },
      stability: item.stability,
      order: placementOrder(item.contribution),
      tokenCount: item.tokenCount,
      dependencies: [],
      enabled: true,
    })),
    zones: [...new Set(sorted.map((item) => item.zone))]
      .sort((a, b) => ZONE_ORDER.indexOf(a) - ZONE_ORDER.indexOf(b))
      .map((name) => ({ name })),
    metadata: {},
  })
  mark('ir-assembly', stageStart)

  // —— 序列化 + Snapshot 落点(S3 构建器;CachePlan 恒空 R-P0-4)——
  stageStart = performance.now()
  const snapshot = buildPromptSnapshot({
    id: request.snapshotId,
    chatId: request.chatId,
    runId: request.runId,
    messageId: request.messageId,
    provider: request.provider,
    model: request.model,
    compilerVersion: request.compilerVersion,
    ir,
    tokenCountMode,
    diagnostics,
    createdAt: request.now,
  })
  mark('snapshot', stageStart)

  // —— strict 判定(§75):存在 error 级诊断 → compile fail ——
  const finalDiagnostics = diagnostics
  if (finalDiagnostics.some((d) => d.level === 'error')) {
    return failure('COMPILE_FAILED', 'strict 模式存在 error 级诊断(compiler-spec §75)', finalDiagnostics)
  }

  const trace: CompileTrace = {
    startedAt: t0,
    stages,
    cacheHits: 0, // Compiler Cache(§99/§100)P2 起
    cacheMisses: 0,
    tokenCount: totalTokens,
  }
  return {
    ok: true,
    value: deepFreeze({
      ir,
      cachePlan: snapshot.cachePlan,
      serialized: snapshot.serialized,
      snapshot,
      diagnostics: finalDiagnostics,
      trace,
    }),
  }
}

interface ResolvedItem {
  contribution: PromptContribution
  index: number
  zone: PromptZoneName
  stability: StabilityClass
  tokenCount: number
  /** 宏展开后的最终文本(R-P2-3:哈希对象;IR 组装用) */
  expandedContent: string
}

/** 单条贡献解析:zone 取自提交方声明;stability 取声明或按区默认(§16) */
function resolveContribution(
  contribution: PromptContribution,
  index: number,
  diagnostics: Diagnostic[],
): ResolvedItem {
  const zone = contribution.segment.zone

  // §17:手动覆盖稳定性必须记录 warning——系统不能假装它真的稳定
  const declared = contribution.segment.stability
  if (declared !== undefined && declared !== ZONE_DEFAULT_STABILITY[zone]) {
    diagnostics.push({
      level: 'warning',
      code: 'STABILITY_OVERRIDE',
      message: '手动覆盖稳定性推断(compiler-spec §17)',
      segmentId: contribution.id,
      details: { inferred: ZONE_DEFAULT_STABILITY[zone], declared },
    })
  }

  return {
    contribution,
    index,
    zone,
    stability: contribution.segment.stability ?? ZONE_DEFAULT_STABILITY[zone],
    tokenCount: 0,
    expandedContent: contribution.segment.content,
  }
}

/** §93 语义序:全部 SemanticPlacement 变体均携带 order */
function placementOrder(contribution: PromptContribution): number {
  return contribution.semanticPlacement.order
}

function failure(
  code: CompileFailureCode,
  message: string,
  diagnostics: readonly Diagnostic[],
): CompileOutcome {
  return { ok: false, error: { code, message, diagnostics } }
}

/** §43 稳定区枚举(技术计划 §5.2:history 之前的缓存敏感前缀区) */
const STABLE_ZONES: readonly PromptZoneName[] = ['header', 'stableWB', 'freshWB', 'summary']

/** §15 稳定性阶梯:rank 越高越不稳(static < session < request < message < volatile) */
const STABILITY_RANK: Record<StabilityClass, number> = {
  static: 0,
  session: 1,
  request: 2,
  message: 3,
  volatile: 4,
}

/** CompileMode → MacroMode(§45);pipeline 只放行 strict/preview,其余不会抵达 */
function mapMacroMode(mode: CompileMode): MacroMode {
  switch (mode) {
    case 'strict':
      return 'compile'
    case 'preview':
      return 'preview'
    case 'simulation':
      return 'simulation'
    case 'replay':
      return 'replay'
    default:
      // compatibility/performance:未达此处(UNSUPPORTED_MODE 已拦),防御性兜底
      return 'compile'
  }
}

/**
 * §43 Macro Cache Rule:stable zone 含低于段稳定性的宏 → CACHE_UNSAFE_MACRO,
 * 按三档策略处置。处置粒度=整段(spec §43 S16 口径:不做段内 split,防哈希键自伤)。
 *
 * §13 双 Placement 分离:normal 档只改 cachePlacement.zone(sorting 前改写 item.zone
 * 即自然落 tail 区),不改 semanticPlacement——语义位不变,物理位移入 tail。
 */
function applyMacroCacheRule(
  item: ResolvedItem,
  analysis: ReturnType<typeof expandWithAnalysis>['analysis'],
  policy: MacroCachePolicy,
  diagnostics: Diagnostic[],
): void {
  const unsafe = analysis.macros.some(
    (o) => STABLE_ZONES.includes(item.zone) && STABILITY_RANK[o.volatility] > STABILITY_RANK[item.stability],
  )
  if (!unsafe) return

  const macros = analysis.macros.map((m) => m.name)
  if (policy === 'strict') {
    diagnostics.push({
      level: 'error',
      code: 'CACHE_UNSAFE_MACRO',
      message: '稳定区含低于段稳定性的宏,strict 档直接编译失败(compiler-spec §43/§75)',
      segmentId: item.contribution.id,
      details: { macros, action: 'compile_error' },
    })
    return
  }

  if (policy === 'normal') {
    item.zone = 'tail'
    // 仅当非用户显式声明才降级稳定性(§17 显式声明保留原值,矛盾已由 STABILITY_OVERRIDE 先行警告)
    if (item.contribution.segment.stability === undefined) {
      item.stability = 'volatile'
    }
    diagnostics.push({
      level: 'warning',
      code: 'CACHE_UNSAFE_MACRO',
      message: '稳定区含 volatile 宏,已移至 tail 区隔离(R-P2-4)',
      segmentId: item.contribution.id,
      details: { macros, action: 'moved_to_tail' },
    })
    return
  }

  // compat:保留原位置,仅标记缓存不安全(§43)
  diagnostics.push({
    level: 'warning',
    code: 'CACHE_UNSAFE_MACRO',
    message: '稳定区含 volatile 宏,compat 档保留位置并标记缓存不安全(compiler-spec §43)',
    segmentId: item.contribution.id,
    details: { macros, action: 'preserved' },
  })
}
