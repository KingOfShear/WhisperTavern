import { describe, expect, it } from 'vitest'
import { createDatabase, createSqliteEventSink, EventBus } from '@whispertavern/runtime'
import { RunStreamRegistry } from './api/run-streams'

/**
 * RunStreamRegistry 懒淘汰(终态+空订阅即清、track 时兜底扫描)——
 * 防长跑进程随 run 数线性涨内存;已结束 run 的重连一律走 §142 events 表重放。
 * 观察口径:isTracked 对终态流恒 false(原有语义),淘汰与否用 subscribe 的
 * replay 行为探针锁定——已淘汰 = 新订阅拿不到任何 buffer。
 */

function makeRegistry(): { registry: RunStreamRegistry; bus: EventBus } {
  const store = createDatabase(':memory:')
  const bus = new EventBus(createSqliteEventSink(store))
  return { registry: new RunStreamRegistry(bus), bus }
}

describe('RunStreamRegistry 懒淘汰', () => {
  it('终态 + 退订 → 流清出注册表(新订阅 replay 为空);订阅者在场时不淘汰', () => {
    const { registry, bus } = makeRegistry()
    registry.track('run-1', new AbortController())
    const seen: string[] = []
    const { unsubscribe } = registry.subscribe('run-1', (e) => seen.push(e.type))
    // publish 经构造时挂的总线订阅触发 fanout(与生产路径一致)
    bus.publish({ type: 'generation.delta', runId: 'run-1', payload: { text: 'x' } })
    bus.publish({ type: 'generation.completed', runId: 'run-1', payload: {} })
    expect(seen).toEqual(['generation.delta', 'generation.completed'])
    // 订阅者还在 → 不淘汰:新订阅仍能重放 buffer(含终态)
    const stillThere = registry.subscribe('run-1', () => undefined)
    expect(stillThere.replay.map((e) => e.type)).toEqual(['generation.delta', 'generation.completed'])
    stillThere.unsubscribe()
    unsubscribe() // 订阅清零 + finished → 淘汰
    const gone = registry.subscribe('run-1', () => undefined)
    expect(gone.replay).toEqual([]) // 已清出:stream undefined 分支
  })

  it('无订阅者的 run 终态后,由下一次 track 懒淘汰(兜底路径)', () => {
    const { registry, bus } = makeRegistry()
    registry.track('run-a', new AbortController())
    registry.track('run-b', new AbortController())
    bus.publish({ type: 'generation.completed', runId: 'run-a', payload: {} })
    registry.track('run-c', new AbortController()) // evictIdle 扫描:finished+空订阅 → 清
    // run-a 已淘汰:其后的事件不再入 buffer(fanout 找不到流)
    bus.publish({ type: 'generation.delta', runId: 'run-a', payload: { text: 'ghost' } })
    expect(registry.subscribe('run-a', () => undefined).replay).toEqual([])
    // run-b 未终态 → 不动:事件照常入 buffer
    bus.publish({ type: 'generation.delta', runId: 'run-b', payload: { text: 'alive' } })
    expect(registry.subscribe('run-b', () => undefined).replay).toHaveLength(1)
  })

  it('终态但订阅者在场 → 兜底扫描不淘汰(订阅者必须能收到终态事件)', () => {
    const { registry, bus } = makeRegistry()
    registry.track('run-2', new AbortController())
    registry.subscribe('run-2', () => undefined)
    bus.publish({ type: 'generation.failed', runId: 'run-2', payload: {} })
    registry.track('run-3', new AbortController()) // 兜底扫描:订阅者在场 → 保留
    bus.publish({ type: 'generation.delta', runId: 'run-2', payload: { text: 'late' } })
    expect(registry.subscribe('run-2', () => undefined).replay).toHaveLength(2) // buffer 仍在
  })
})
