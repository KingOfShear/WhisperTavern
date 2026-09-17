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
import { ZONE_ORDER } from '../serializer/hash'
import { buildPromptSnapshot } from '../serializer/snapshot'
import { estimateTokens, type TokenCountMode } from '../tokens/estimate'

/**
 * Compiler 最小管线 —— compiler-spec §3 的 P0 子集(p0-plan S4 任务 1)。
 *
 * 阶段:分区归类(提交方声明 zone)→ 宏透传扫描(R-P0-1)→ stable sorting(§93/§94)
 * → 硬上限(R-P0-2,不裁剪)→ IR 组装(含 I5 运行期断言)→ 序列化(§62 规范路径)
 * → CachePlan=空(R-P0-4)→ Snapshot 落点(§66)。
 *
 * 不做(Non-goals,p0-plan S4):Macro 展开(P2)、stableWB/freshWB/summary 填充
 * 策略(P1/P2)、预算裁剪(P2)、CachePlan(P2)、strict/preview 之外四模式(P1+)。
 *
 * 失败语义:可预期失败走 Result(共享契约 §2 禁 throw 作普通控制流);
 * 不变式违例按 compiler-spec 抛 INVARIANT_VIOLATION——那是实现 bug,不是控制流。
 */

export interface CompileRequest {
  chatId: ChatId
  /** 调用方生成(UUIDv7,database-schema §3);builder 不产生随机 ID */
  snapshotId: SnapshotId
  runId?: RunId
  messageId?: MessageId
  provider: string
  model: string
  compilerVersion: string
  /** 注入时钟(确定性:同输入含同 now → 逐字节同输出) */
  now: Timestamp
  /** R-P0-2 硬上限:总 token 超限 → PROMPT_CONTEXT_TOO_LARGE,不裁剪 */
  maxContextTokens: number
  mode: CompileMode
  contributions: readonly PromptContribution[]
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

/** §16 推断的 P0 占位:按区默认;宏感知推断归 P2 */
const ZONE_DEFAULT_STABILITY: Record<PromptZoneName, StabilityClass> = {
  header: 'session',
  stableWB: 'static',
  freshWB: 'static',
  summary: 'session',
  history: 'message',
  injection: 'request',
  tail: 'volatile',
}

const MACRO_PATTERN = /\{\{[^{}]+\}\}/g

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

  // —— 宏透传扫描(R-P0-1:{{macro}} 原样透传 + info 诊断;Macro Engine P2)——
  stageStart = performance.now()
  for (const item of resolved) {
    const macros = [...new Set(item.contribution.segment.content.match(MACRO_PATTERN) ?? [])]
    if (macros.length > 0) {
      diagnostics.push({
        level: 'info',
        code: 'MACRO_UNEXPANDED_P0',
        message: '宏引擎不在 P0,{{macro}} 原样透传(R-P0-1)',
        segmentId: item.contribution.id,
        details: { macros },
      })
    }
    if (item.contribution.segment.content === '') {
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

  // —— token 汇总与硬上限(R-P0-2:只报错终止,不裁剪)——
  stageStart = performance.now()
  const tokenCountMode = request.tokenCountMode ?? 'estimated'
  let totalTokens = 0
  for (const item of sorted) {
    item.tokenCount =
      item.contribution.segment.tokenCount ?? estimateTokens(item.contribution.segment.content)
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
      content: item.contribution.segment.content,
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
