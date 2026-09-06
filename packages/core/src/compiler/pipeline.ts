import {
  type CachePlan,
  type ChatId,
  type CompileMode,
  type CompileTrace,
  type Diagnostic,
  type InstructionAuthority,
  type InstructionMetadata,
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
} from '@desiregrimoire/contracts'
import { createPromptIR, deepFreeze, type DeepReadonly } from '../ir/segment'
import { buildZoneHashes, ZONE_ORDER } from '../serializer/hash'
import { buildPromptSnapshot } from '../serializer/snapshot'
import { estimateTokens, type TokenCountMode } from '../tokens/estimate'
import { outranks, resolveInstruction } from './derive'

/**
 * Compiler 最小管线 —— compiler-spec §3 的 P0 子集(p0-plan S4 任务 1)。
 *
 * 阶段:分区归类(提交方声明 zone)→ 指令元数据解析(§10 推导 + I4/R2/R3 裁决)
 * → 宏透传扫描(R-P0-1)→ I3 隔离(§21)→ stable sorting(§93/§94)
 * → 硬上限(R-P0-2,不裁剪)→ IR 组装(含 I5 运行期断言)→ 序列化(§62 规范路径)
 * → CachePlan=空(R-P0-4)→ Snapshot 落点(§66)。
 *
 * 不做(Non-goals,p0-plan S4):Macro 展开(P2)、stableWB/freshWB/summary 填充
 * 策略(P1/P2)、预算裁剪(P2)、CachePlan(P2)、strict/preview 之外四模式(P1+)。
 *
 * 失败语义:可预期失败走 Result(共享契约 §2 禁 throw 作普通控制流);
 * 不变式违例(I4/I5)按 instruction-security §5 **抛 INVARIANT_VIOLATION**——
 * 那是实现 bug,不是控制流。strict 把 warning 级安全诊断升格为 fail(§75/§21)。
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
  /**
   * §12 override 槽位(用户显式配置;默认关闭/空 = G2 零字节差异锚点)。
   * I4:白名单只对 preset 来源生效;P0 无 UI,恒由调用方显式传入。
   */
  overrideSlot?: { readonly segments: readonly string[] }
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

/** I3 稳定前缀区(instruction-security §5 I3:untrusted 禁入) */
const STABLE_PREFIX_ZONES: readonly PromptZoneName[] = ['header', 'stableWB', 'summary']

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

/** §21:warning 级、strict 下升格 error 的安全诊断码 */
const STRICT_PROMOTABLE = new Set(['AUTHORITY_OVERRIDE_DENIED', 'UNTRUSTED_IN_STABLE_ZONE'])

export function compile(request: CompileRequest): CompileOutcome {
  const t0 = performance.now()
  const stages: { name: string; durationMs: number }[] = []
  const mark = (name: string, from: number): void => {
    stages.push({ name, durationMs: performance.now() - from })
  }

  if (request.mode !== 'strict' && request.mode !== 'preview') {
    return failure('UNSUPPORTED_MODE', `mode ${request.mode} 未在 P0 实现(strict/preview 之外归 P1+)`, [])
  }
  const strict = request.mode === 'strict'

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

  // —— 指令元数据解析(§10 推导 + override 槽位 I4 + R2/R3 裁决)——
  stageStart = performance.now()
  const diagnostics: Diagnostic[] = []
  const resolved = request.contributions.map((contribution, index) =>
    resolveContribution(contribution, index, request, diagnostics),
  )
  mark('instruction-resolution', stageStart)

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

  // —— I3:untrusted 禁入稳定前缀;preview 自动降位 tail,strict 报错(§21 处置)——
  stageStart = performance.now()
  for (const item of resolved) {
    if (item.instruction.trust !== 'untrusted') continue
    if (!STABLE_PREFIX_ZONES.includes(item.zone)) continue
    if (strict) {
      diagnostics.push(untrustedDiagnostic(item, 'error'))
    } else {
      diagnostics.push(untrustedDiagnostic(item, 'warning'))
      item.zone = 'tail'
      item.stability = ZONE_DEFAULT_STABILITY.tail
    }
  }
  mark('containment', stageStart)

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
      instruction: item.instruction,
    })),
    zones: [...new Set(sorted.map((item) => item.zone))]
      .sort((a, b) => ZONE_ORDER.indexOf(a) - ZONE_ORDER.indexOf(b))
      .map((name) => ({ name })),
    metadata: {},
  })

  // —— I5 运行期断言(instr-sec §5/§17.1):剥离指令元数据重算哈希必须逐字节一致 ——
  const stripped = createPromptIR({
    ...ir,
    segments: ir.segments.map((segment) => ({ ...segment, instruction: undefined })),
  })
  if (JSON.stringify(buildZoneHashes(ir).hashes) !== JSON.stringify(buildZoneHashes(stripped).hashes)) {
    throw new Error('INVARIANT_VIOLATION: I5 违例——指令元数据泄漏进序列化字节(instr-sec §5/§17.1)')
  }
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
    createdAt: request.now,
  })
  mark('snapshot', stageStart)

  // —— strict 升格(§75/§21):warning 级安全诊断 → error → compile fail ——
  const finalDiagnostics = strict
    ? diagnostics.map((d) =>
        d.level === 'warning' && STRICT_PROMOTABLE.has(d.code) ? { ...d, level: 'error' as const } : d,
      )
    : diagnostics
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
  instruction: InstructionMetadata
  zone: PromptZoneName
  stability: StabilityClass
  tokenCount: number
}

/** 单条贡献解析:§10 推导 → override 槽位(I4)→ R2/R3 越权裁决 */
function resolveContribution(
  contribution: PromptContribution,
  index: number,
  request: CompileRequest,
  diagnostics: Diagnostic[],
): ResolvedItem {
  const zone = contribution.segment.zone
  const { instruction, overrideDenied } = resolveInstruction(contribution, zone)

  // §12 preset 保留段白名单:override 档的唯一产生路径之一(用户显式配置)
  const presetSource =
    contribution.source.type === 'preset' ? contribution.source : undefined
  const whitelistHit =
    presetSource !== undefined &&
    (request.overrideSlot?.segments.includes(presetSource.segmentId) ?? false)
  const effective: InstructionMetadata = whitelistHit
    ? { ...instruction, authority: 'override' }
    : instruction

  // §12.5 审计:含 override 槽位的编译必须上报(info,Inspector/审计可见)
  if (whitelistHit && presetSource) {
    diagnostics.push({
      level: 'info',
      code: 'OVERRIDE_SLOT_ACTIVE',
      message: '本轮编译含 override 槽位(instr-sec §12.5)',
      segmentId: contribution.id,
      details: {
        presetId: presetSource.presetId,
        segmentId: presetSource.segmentId,
      },
    })
  }

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

  // I4 断言(instr-sec §5):override 只能来自 preset 来源 + 显式配置;
  // 角色/世界书/记忆/工具/Agent/导入自动产生 override = 实现 bug,抛出。
  if (effective.authority === 'override' && contribution.source.type !== 'preset') {
    throw new Error(
      `INVARIANT_VIOLATION: I4 违例——非 preset 来源 ${contribution.source.type} 产生 override 档(instr-sec §5/§12)`,
    )
  }

  if (overrideDenied) {
    diagnostics.push({
      level: 'warning',
      code: 'AUTHORITY_OVERRIDE_DENIED',
      message: '低档来源声明高档身份被拒绝,段按推导档入位(instr-sec §11 R2)',
      segmentId: contribution.id,
      details: {
        declared: contribution.instruction?.authority,
        sourceType: contribution.source.type,
      },
    })
  }

  // R3:overrides 细调表只能指向低于自身档的目标;越权条目剥离(不可变重建)并报告
  let finalInstruction = effective
  if (effective.overrides) {
    const deniedTargets = Object.entries(effective.overrides)
      .filter(([target]) => outranks(target as InstructionAuthority, effective.authority))
      .map(([target]) => target)
    if (deniedTargets.length > 0) {
      const kept = { ...effective.overrides }
      for (const target of deniedTargets) {
        delete kept[target]
      }
      finalInstruction = { ...effective, overrides: kept }
      diagnostics.push({
        level: 'warning',
        code: 'AUTHORITY_OVERRIDE_DENIED',
        message: 'overrides 细调目标不低于自身档,条目被剥离(instr-sec §11 R3)',
        segmentId: contribution.id,
        details: { deniedTargets },
      })
    }
  }

  return {
    contribution,
    index,
    instruction: finalInstruction,
    zone,
    stability: contribution.segment.stability ?? ZONE_DEFAULT_STABILITY[zone],
    tokenCount: 0,
  }
}

function untrustedDiagnostic(item: ResolvedItem, level: 'warning' | 'error'): Diagnostic {
  return {
    level,
    code: 'UNTRUSTED_IN_STABLE_ZONE',
    message: 'untrusted 段进入稳定前缀(I3 违例);preview 自动降位 tail,strict compile fail',
    segmentId: item.contribution.id,
    details: { from: item.zone },
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
