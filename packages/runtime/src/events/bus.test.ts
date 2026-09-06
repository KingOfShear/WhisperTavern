import { describe, expect, it } from 'vitest'
import type { Timestamp } from '@desiregrimoire/contracts'
import { EventBus, type EventSink, type RuntimeEvent } from './bus'
import { EVENT_CATALOG } from './catalog'

const NOW = '2026-09-05T12:00:00Z' as Timestamp

function memorySink(): { sink: EventSink; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = []
  return { sink: { insert: (batch) => events.push(...batch) }, events }
}

describe('Event Bus(总设计 §5.4)', () => {
  it('事件目录:P0 子集的分档注册(§5.4 权威表逐字对齐)', () => {
    expect(EVENT_CATALOG['generation.delta']).toBe('live')
    expect(EVENT_CATALOG['message.created']).toBe('durable')
    expect(EVENT_CATALOG['usage.recorded']).toBe('deferred-durable')
    expect(EVENT_CATALOG['provider.fallback']).toBe('durable')
  })

  it('未注册事件名 / 分档缺失 = INVARIANT_VIOLATION(新增事件必须声明分档)', () => {
    const { sink } = memorySink()
    const bus = new EventBus(sink)
    expect(() => bus.publish({ type: 'chat.message.created', payload: {}, timestamp: NOW })).toThrow(
      /INVARIANT_VIOLATION.*未注册/,
    )
  })

  it('durable:订阅者广播 + 同步落 sink;live:仅广播不落库', () => {
    const { sink, events } = memorySink()
    const bus = new EventBus(sink)
    const seen: string[] = []
    bus.subscribe('message.*', (e) => seen.push(e.type))
    bus.subscribe('generation.delta', () => seen.push('delta-seen'))

    bus.publish({ type: 'message.created', payload: { id: 'm1' }, timestamp: NOW })
    bus.publish({ type: 'generation.delta', payload: { text: 'x' }, timestamp: NOW })

    expect(seen).toEqual(['message.created', 'delta-seen'])
    expect(events.map((e) => e.type)).toEqual(['message.created']) // live 不落库
  })

  it('deferred-durable:先缓冲,flush 批量落库(允许延迟不允许丢)', () => {
    const { sink, events } = memorySink()
    const bus = new EventBus(sink)
    bus.publish({ type: 'usage.recorded', payload: { tokens: 5 }, timestamp: NOW })
    expect(events).toHaveLength(0)
    bus.publish({ type: 'usage.recorded', payload: { tokens: 7 }, timestamp: NOW })
    bus.flush()
    expect(events.map((e) => e.payload)).toMatchObject([{ tokens: 5 }, { tokens: 7 }])
    expect(bus.durableEvents()).toHaveLength(0) // deferred 不计入 durable 日志
  })

  it('D5:订阅者抛错被吃掉,后续订阅者照常收到,不冒泡为 publish 失败', () => {
    const { sink } = memorySink()
    const bus = new EventBus(sink, { onSubscriberError: (e) => errors.push(e) })
    const errors: unknown[] = []
    const seen: string[] = []
    bus.subscribe('chat.*', () => {
      throw new Error('bad subscriber')
    })
    bus.subscribe('chat.*', (e) => seen.push(e.type))
    expect(() => bus.publish({ type: 'chat.updated', payload: {}, timestamp: NOW })).not.toThrow()
    expect(seen).toEqual(['chat.updated'])
    expect(errors).toHaveLength(1)
  })

  it('durable 日志可按 runId 查询(§5.5 不变量 4 的查询面)', () => {
    const { sink } = memorySink()
    const bus = new EventBus(sink)
    bus.publish({ type: 'generation.started', runId: 'r1', payload: {}, timestamp: NOW })
    bus.publish({ type: 'generation.started', runId: 'r2', payload: {}, timestamp: NOW })
    expect(bus.durableEvents('r1')).toHaveLength(1)
    expect(bus.durableEvents()).toHaveLength(2)
  })
})
