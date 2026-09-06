import type {
  PromptSnapshot,
  ProviderAdapter,
  ProviderChatRequest,
  ProviderMessage,
  ProviderStreamEvent,
  ProviderUsage,
  Timestamp,
} from '@whispertavern/contracts'
import type { DeepReadonly } from '@whispertavern/core'
import type { EventBus, RuntimeEvent } from '../events/bus'
import { uuidv7 } from '../util/id'

/**
 * 生成编排与不变量闸口 —— 总设计 §5.5 四不变量 + p0-plan S5 任务 5/6。
 *
 * 这是 **fake provider 调用入口的埋点位置**(technical-plan §8.5):任何测试路径
 * 绕过 Compiler 自己拼 prompt、或让元数据混进模型可见内容,都会在这里变红。
 * 四条不变量违反一律抛 INVARIANT_VIOLATION(§5.5:不发请求)。
 * 断言函数独立导出,供契约测试以"故意违规"路径验证其确实变红。
 */

/** P0 内存快照注册表(S6 起接 prompt_snapshots 表持久化) */
export class SnapshotRegistry {
  private readonly snapshots = new Map<string, DeepReadonly<PromptSnapshot>>()

  register(snapshot: DeepReadonly<PromptSnapshot>): void {
    this.snapshots.set(snapshot.id, snapshot)
  }

  get(snapshotId: string): DeepReadonly<PromptSnapshot> | undefined {
    return this.snapshots.get(snapshotId)
  }

  has(snapshotId: string): boolean {
    return this.snapshots.has(snapshotId)
  }
}

export class InvariantViolation extends Error {
  constructor(readonly invariant: string, message: string) {
    super(`INVARIANT_VIOLATION[${invariant}]: ${message}`)
    this.name = 'InvariantViolation'
  }
}

export interface GenerationRecord {
  id: string
  runId: string
  snapshotId: string
  providerId?: string
  request: Record<string, unknown>
  response?: Record<string, unknown>
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  usageSource?: 'reported' | 'estimated'
  latencyMs: number
  status: 'completed' | 'failed' | 'cancelled'
  error?: Record<string, unknown>
  createdAt: Timestamp
}

/** 生成记录落库口(S6 接 generations 表;测试用内存 sink) */
export type GenerationSink = (record: GenerationRecord) => void

export interface DispatchInput {
  runId: string
  chatId: string
  snapshot: DeepReadonly<PromptSnapshot>
  signal?: AbortSignal
  sampling?: ProviderChatRequest['sampling']
  /** 声明 run 已处于 waiting(§5.5 不变量 4 的触发面);P0 正常路径无 waiting */
  runStatus?: 'waiting'
  now: Timestamp
}

export interface DispatchResult {
  generationId: string
  text: string
  reasoning: string
  finishReason?: string
  usage?: ProviderUsage
  status: 'completed' | 'cancelled' | 'failed'
  error?: { code: string; message: string }
}

/**
 * 编排一次生成:四不变量闸口 → generation.started(durable)→ 归一事件流收集
 * → 落 generations(§51/§52,usage_source 区分 reported/estimated)
 * → usage.recorded(deferred-durable)+ generation.completed/failed(durable)。
 */
export async function dispatchGeneration(
  deps: { adapter: ProviderAdapter; bus: EventBus; snapshots: SnapshotRegistry; sink: GenerationSink },
  input: DispatchInput,
): Promise<DispatchResult> {
  const { adapter, bus, snapshots, sink } = deps
  const snapshot = input.snapshot
  const startedAt = Date.now()

  // —— 不变量 1:请求必挂 snapshotId 且快照存在(§5.5)——
  assertSnapshotRegistered(snapshots, snapshot.id)
  // 组装请求:唯一合法来源 = snapshot(模型可见即已记录的证据链)
  const request = buildGenerationRequest(snapshot, input)
  // —— 不变量 2/3:模型可见可重建;元数据不出网 ——
  assertRequestMatchesSnapshot(request, snapshot)
  assertNoMetadataOnWire(request)

  // —— 不变量 4:waiting 必有 durable 事件(§5.5)——
  if (input.runStatus === 'waiting') {
    assertWaitingHasDurableEvent(bus.durableEvents(input.runId), input.runId)
  }

  bus.publish({
    type: 'generation.started',
    runId: input.runId,
    aggregateType: 'generation',
    aggregateId: `${input.runId}:${snapshot.id}`,
    timestamp: input.now,
    payload: {
      runId: input.runId,
      snapshotId: snapshot.id,
      chatId: input.chatId,
      provider: adapter.providerId,
      model: snapshot.model,
    },
  })

  const generationId = uuidv7()
  let text = ''
  let reasoning = ''
  let usage: ProviderUsage | undefined
  let finishReason: string | undefined
  let failure: { code: string; message: string } | undefined
  let status: DispatchResult['status'] = 'completed'

  const collect = (event: ProviderStreamEvent): void => {
    if (event.type === 'text_delta') text += event.text
    else if (event.type === 'reasoning_delta') reasoning += event.text
    else if (event.type === 'usage') usage = event.usage
    else if (event.type === 'finish') finishReason = event.reason
    else if (event.type === 'error') {
      failure = { code: event.error.code, message: event.error.detail ?? event.error.code }
      status = event.error.code === 'CANCELLED' ? 'cancelled' : 'failed'
    }
  }

  try {
    for await (const event of adapter.stream(request)) {
      if (event.type === 'text_delta') {
        bus.publish({
          type: 'generation.delta',
          runId: input.runId,
          aggregateType: 'generation',
          aggregateId: generationId,
          timestamp: input.now,
          payload: { generationId, text: event.text },
        })
      }
      collect(event)
    }
  } catch (error) {
    // PV4:适配器必须以 ProviderError 抛;裸异常按 UNKNOWN 收敛(D2)
    failure = { code: 'UNKNOWN', message: String(error) }
    status = 'failed'
  }

  const latencyMs = Date.now() - startedAt
  const record: GenerationRecord = {
    id: generationId,
    runId: input.runId,
    snapshotId: snapshot.id,
    providerId: adapter.providerId,
    request: { model: request.model, messages: request.messages, sampling: request.sampling },
    response: { text, reasoning },
    finishReason,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cachedTokens: usage?.cachedInputTokens,
    usageSource: usage?.source,
    latencyMs,
    status: failure === undefined ? 'completed' : status,
    error: failure,
    createdAt: input.now,
  }
  sink(record)

  if (usage !== undefined) {
    bus.publish({
      type: 'usage.recorded',
      runId: input.runId,
      aggregateType: 'generation',
      aggregateId: generationId,
      timestamp: input.now,
      payload: { usage, generationId },
    })
  }

  if (failure !== undefined) {
    bus.publish({
      type: 'generation.failed',
      runId: input.runId,
      aggregateType: 'generation',
      aggregateId: generationId,
      timestamp: input.now,
      payload: { generationId, error: failure, status },
    })
  } else {
    bus.publish({
      type: 'generation.completed',
      runId: input.runId,
      aggregateType: 'generation',
      aggregateId: generationId,
      timestamp: input.now,
      payload: { generationId, finishReason, textLength: text.length },
    })
  }

  return { generationId, text, reasoning, finishReason, usage, status, error: failure }
}

/** 从快照组装请求——请求内容的唯一合法来源(不允许调用方注入 messages) */
export function buildGenerationRequest(
  snapshot: DeepReadonly<PromptSnapshot>,
  input: Pick<DispatchInput, 'sampling' | 'signal' | 'runId'>,
): ProviderChatRequest {
  // P0:tool 角色消息随 P3 工具流收编,构造时跳过(invariant 2 的期望投影同口径)
  const messages: ProviderMessage[] = snapshot.serialized.parts.flatMap(
    (part): ProviderMessage[] => {
      const role = part.role ?? 'user'
      const content = part.content ?? ''
      if (role === 'system') return [{ role: 'system', content }]
      if (role === 'assistant') return [{ role: 'assistant', content }]
      if (role === 'tool') return []
      return [{ role: 'user', content }]
    },
  )
  return {
    snapshotId: snapshot.id,
    model: snapshot.model,
    messages,
    sampling: input.sampling ?? { maxOutputTokens: 1024 },
    stream: true,
    signal: input.signal,
    metadata: { runId: input.runId },
  }
}

/** 不变量 1:请求必挂 snapshotId 且该快照必须存在(§5.5,违反 = 不发请求) */
export function assertSnapshotRegistered(
  snapshots: SnapshotRegistry,
  snapshotId: string | undefined,
): void {
  if (snapshotId === undefined || snapshotId === '' || !snapshots.has(snapshotId)) {
    throw new InvariantViolation('snapshot-attached', `请求未挂已注册的 snapshotId: ${String(snapshotId)}`)
  }
}

/** 不变量 2:模型可见即已记录——请求 messages 必须能从快照序列化逐条重建(§5.5) */
export function assertRequestMatchesSnapshot(
  request: ProviderChatRequest,
  snapshot: DeepReadonly<PromptSnapshot>,
): void {
  const expected = snapshot.serialized.parts.map((p) => `${p.role ?? 'user'}\u0000${p.content ?? ''}`)
  const actual = request.messages.map((m) => `${m.role}\u0000${m.content}`)
  if (expected.join('\u0001') !== actual.join('\u0001')) {
    throw new InvariantViolation('model-visible-recorded', '请求 messages 与快照序列化不一致')
  }
}

/** 不变量 3:元数据不进模型可见前缀——messages 只许 role/content,遥测只走 metadata 字段 */
export function assertNoMetadataOnWire(request: ProviderChatRequest): void {
  for (const message of request.messages) {
    const keys = Object.keys(message)
    if (keys.some((k) => k !== 'role' && k !== 'content')) {
      throw new InvariantViolation('metadata-off-wire', `message 出现非 role/content 键: ${keys.join(',')}`)
    }
  }
  if (request.metadata !== undefined && request.messages.some((m) => JSON.stringify(m).includes('"metadata"'))) {
    throw new InvariantViolation('metadata-off-wire', 'message 内嵌 metadata 对象')
  }
}

/**
 * 不变量 4(§5.5):`waiting` 状态必须有对应的 durable 事件——waiting 不能依赖
 * 内存 Promise,重启后要能靠 durable 事件唤醒。P0 的 Agent waiting 状态机在 P3,
 * 本断言面先行就位(事件源 = bus durable 日志 / events 表)。
 */
export function assertWaitingHasDurableEvent(events: readonly RuntimeEvent[], runId: string): void {
  const has = events.some(
    (e) =>
      e.durability === 'durable' &&
      // agent.run.started 属 P3 域(未入 P0 目录);字符串比较保留前向兼容
      (e.type === 'generation.started' || (e.type as string) === 'agent.run.started'),
  )
  if (!has) {
    throw new InvariantViolation('waiting-durable-event', `run ${runId} 声明 waiting 但无 durable 事件支撑`)
  }
}
