/**
 * 事件目录分档断言(technical-design §5.4 硬约束二 / X13)。
 *
 * architecture.test.ts 的 A1–A3 已守"事件名与分档必须与 spec 逐字一致";
 * 这里补的是**语义面**:同一域内不同对象的档位必须符合判据
 * ——"进程重启后,重建执行树或账目是否需要它"。
 */
import { describe, expect, it } from 'vitest'
import { EVENT_CATALOG, durabilityOf, type EventName } from './catalog'

const NAMES = Object.keys(EVENT_CATALOG) as EventName[]

describe('§5.4 分档判据(§5.4 硬约束二 + X13)', () => {
  it('重启后重建执行树所必需的状态事件一律 durable', () => {
    const mustBeDurable: EventName[] = [
      'agent.run.created',
      'agent.run.started',
      'agent.run.paused',
      'agent.run.resumed',
      'agent.run.completed',
      'agent.run.failed',
      'agent.run.cancelled',
      'agent.run.interrupted',
      'agent.turn.started',
      'agent.turn.completed',
      'tool.call.started',
      'tool.call.completed',
      'tool.call.failed',
      'tool.call.denied',
      'approval.requested',
      'approval.decided',
      'workflow.started',
      'workflow.stage_started',
      'workflow.stage_completed',
      'workflow.completed',
    ]
    for (const name of mustBeDurable) {
      expect(durabilityOf(name), `${name} 应为 durable`).toBe('durable')
    }
  })

  it('waiting 的唤醒依据(approval.*)必须 durable——内存 Promise 重启即丢(§116–§119)', () => {
    expect(durabilityOf('approval.requested')).toBe('durable')
    expect(durabilityOf('approval.decided')).toBe('durable')
  })

  it('artifact.* / usage.* / cache.* 归 deferred-durable(可延迟、不可丢),不占同步路径', () => {
    expect(durabilityOf('artifact.created')).toBe('deferred-durable')
    expect(durabilityOf('artifact.updated')).toBe('deferred-durable')
    expect(durabilityOf('usage.recorded')).toBe('deferred-durable')
    expect(durabilityOf('cache.invalidated')).toBe('deferred-durable')
  })

  it('worldbook.activated 必须 durable:Activation Engine 有状态,Replay 依赖激活历史(§5.1/§5.4)', () => {
    expect(durabilityOf('worldbook.activated')).toBe('durable')
    expect(durabilityOf('worldbook.changed')).toBe('durable')
  })

  it('live 档只允许"丢了不影响重建"的高频事件', () => {
    const live = NAMES.filter((n) => EVENT_CATALOG[n] === 'live')
    expect(new Set(live)).toEqual(new Set(['generation.delta', 'prompt.compiling']))
  })

  it('域白名单:只许 §5.4 的域,禁止自造名(如 chat.message.* / tool.completed)', () => {
    const allowed = new Set([
      'chat',
      'message',
      'generation',
      'prompt',
      'provider',
      'worldbook',
      'usage',
      'cache',
      'agent',
      'tool',
      'approval',
      'workflow',
      'artifact',
    ])
    const strays = NAMES.filter((n) => !allowed.has(n.split('.')[0]!))
    expect(strays, `越权域:${strays.join(', ')}`).toEqual([])
  })

  it('P3 四层执行相关事件不得落在 live 档', () => {
    const p3Domains = new Set(['agent', 'tool', 'approval', 'workflow'])
    const wrong = NAMES.filter((n) => p3Domains.has(n.split('.')[0]!) && EVENT_CATALOG[n] === 'live')
    expect(wrong).toEqual([])
  })
})
