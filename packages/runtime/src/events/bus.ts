import type { Timestamp } from '@desiregrimoire/contracts'
import {
  assertEventName,
  durabilityOf,
  EventCatalogViolation,
  type EventDurability,
  type RuntimeEvent,
} from './catalog'
import { uuidv7 } from '../util/id'

/**
 * Event Bus 最小版(总设计 §5.4;p0-plan S5 任务 1)。
 *
 * 分档行为:
 * - durable         → 订阅者广播 + **同步**落 sink(P0 先正确后优化;§5.4 允许异步化)
 * - deferred-durable→ 订阅者广播 + 缓冲,flush() 批量落 sink(允许延迟不允许丢)
 * - live            → 仅订阅者广播,不落 sink(generation.delta 等)
 *
 * 工程纪律 D5(§5.5):派发循环吃掉订阅者异常——单个坏订阅者只影响自己,
 * 不得中断派发链、不得冒泡为 publish 失败;异常经 onSubscriberError 上报。
 */

export interface EventSink {
  insert(events: readonly RuntimeEvent[]): void
}

export interface PublishInput<TPayload> {
  type: string
  payload: TPayload
  traceId?: string
  runId?: string
  attemptId?: string
  aggregateType?: string
  aggregateId?: string
  /** 注入时钟;缺省系统时间(测试传固定值保确定性) */
  timestamp?: Timestamp
}

export type Subscription = (event: RuntimeEvent) => void

export class EventBus {
  private readonly subscriptions = new Map<symbol, { pattern: string | RegExp; handler: Subscription }>()
  private readonly deferredBuffer: RuntimeEvent[] = []
  /** SSE sequence(api-spec §27):run 内单调递增;durable 行随 sink 落库,续传可重放 */
  private readonly runSequences = new Map<string, number>()

  constructor(
    private readonly sink: EventSink,
    private readonly options: { onSubscriberError?: (error: unknown, event: RuntimeEvent) => void; now?: () => Timestamp } = {},
  ) {}

  /** 订阅;pattern 为事件名或前缀通配('message.*')。返回退订函数(D4:先退订再停) */
  subscribe(pattern: string | RegExp, handler: Subscription): () => void {
    const key = Symbol('subscription')
    this.subscriptions.set(key, { pattern, handler })
    return () => {
      this.subscriptions.delete(key)
    }
  }

  publish<TPayload extends Record<string, unknown>>(input: PublishInput<TPayload>): RuntimeEvent<TPayload> {
    assertEventName(input.type)
    const event: RuntimeEvent<TPayload> = {
      id: uuidv7(),
      type: input.type,
      durability: durabilityOf(input.type),
      traceId: input.traceId,
      runId: input.runId,
      attemptId: input.attemptId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      timestamp: input.timestamp ?? this.options.now?.() ?? (new Date().toISOString() as Timestamp),
      payload: input.payload,
    }

    this.assignSequence(event)
    this.dispatch(event)

    if (event.durability === 'durable') {
      this.sink.insert([event])
      this.durableLog.push(event)
    } else if (event.durability === 'deferred-durable') {
      this.deferredBuffer.push(event)
    }
    return event
  }

  /** run 内单调 sequence(api-spec §27);durable 行随 sink 落库,Last-Event-ID 续传依据 */
  private assignSequence(event: RuntimeEvent): void {
    if (event.runId === undefined) return
    const next = (this.runSequences.get(event.runId) ?? 0) + 1
    this.runSequences.set(event.runId, next)
    ;(event as { sequence?: number }).sequence = next
  }

  /** deferred-durable 批量落库(允许延迟不允许丢);应用可定时/退出于 flush */
  flush(): void {
    if (this.deferredBuffer.length === 0) return
    const batch = this.deferredBuffer.splice(0, this.deferredBuffer.length)
    this.sink.insert(batch)
  }

  /**
   * durable 事件日志(P0 单进程内存尾;权威存储在 events 表,经 sink 落库)。
   * §5.5 不变量"waiting 必有 durable 事件"的查询面。
   */
  private readonly durableLog: RuntimeEvent[] = []

  durableEvents(runId?: string): readonly RuntimeEvent[] {
    return this.durableLog.filter((e) => runId === undefined || e.runId === runId)
  }

  /** D5:吃掉订阅者异常;正则仅匹配事件名本身,前缀串转锚定正则 */
  private dispatch(event: RuntimeEvent): void {
    for (const { pattern, handler } of [...this.subscriptions.values()]) {
      const matches =
        typeof pattern === 'string' ? matchWildcard(pattern, event.type) : pattern.test(event.type)
      if (!matches) continue
      try {
        handler(event)
      } catch (error) {
        this.options.onSubscriberError?.(error, event)
      }
    }
  }
}

function matchWildcard(pattern: string, type: string): boolean {
  if (!pattern.endsWith('*')) return pattern === type
  const prefix = pattern.slice(0, -1)
  return type.startsWith(prefix)
}

export { EventCatalogViolation }
export type { EventDurability, RuntimeEvent }
