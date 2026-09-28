/**
 * §9–§11 AgentStatus 状态机单测:S23 的验收锚点是 §11「非法转换必须拒绝」,
 * 这里把**允许表逐弧 + 三条 §11 禁弧 + 聚合复位语义**全部钉死,防止 S24 接工具时
 * 顺手放宽状态机(spec 语义变更必须走 spec 修订,不能从代码侧绕)。
 *
 * 关键语义(见 state-machine.ts 调和注②):AgentStatus 是 Instance 的**聚合态**,
 * `completed` / `failed` / `cancelled` 是"刚结束那次 Run 的结果"的**瞬态**,Run 收尾
 * 复位为 `idle`(§7 长期 Instance + §29 UNIQUE + §11 共同推出)。所以"终态封闭"在
 * 本状态机里的精确含义是:**禁弧逐条不存在**(尤其 `completed → running`),
 * 而不是"终态无任何出边"。
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUSES,
  AgentStatusViolation,
  assertAgentTransition,
  canTransitionAgent,
  type AgentStatus,
} from './state-machine'

describe('AgentStatus 状态机(§9/§10/§11)', () => {
  it('允许表:§10 全部显式弧 + 聚合复位弧可走(canTransitionAgent = true)', () => {
    const allowed: readonly [AgentStatus, AgentStatus][] = [
      ['idle', 'queued'],
      ['queued', 'running'],
      ['running', 'waiting'],
      ['running', 'paused'],
      ['running', 'completed'],
      ['running', 'failed'],
      ['running', 'cancelled'],
      ['waiting', 'running'],
      ['waiting', 'cancelled'],
      ['paused', 'running'],
      ['paused', 'cancelled'],
      // §10 的 retry 弧:失败后可重新进入 running
      ['failed', 'running'],
      // §29 收编的恢复弧(§96/§97 同源)
      ['interrupted', 'running'],
      ['interrupted', 'cancelled'],
      ['interrupted', 'failed'],
      // 聚合复位(调和注②):Run 收尾回 idle
      ['completed', 'idle'],
      ['cancelled', 'idle'],
      ['failed', 'idle'],
    ]
    for (const [from, to] of allowed) {
      expect(canTransitionAgent(from, to), `${from} → ${to} 应允许`).toBe(true)
    }
  })

  it('§11 三条禁弧逐条拒绝(断言版抛 AgentStatusViolation)', () => {
    const forbidden: readonly [AgentStatus, AgentStatus][] = [
      ['completed', 'running'],
      ['cancelled', 'running'],
      ['failed', 'completed'],
    ]
    for (const [from, to] of forbidden) {
      expect(canTransitionAgent(from, to), `${from} → ${to} 应禁止`).toBe(false)
      expect(() => assertAgentTransition(from, to)).toThrow(AgentStatusViolation)
    }
  })

  it('终态(瞬态)只允许复位回 idle,不得直接接单或跳到别的终态', () => {
    for (const terminal of ['completed', 'cancelled'] as const) {
      for (const to of AGENT_STATUSES) {
        const allowed = to === 'idle'
        expect(canTransitionAgent(terminal, to), `${terminal} → ${to} ${allowed ? '仅 idle' : '应禁止'}`).toBe(allowed)
      }
    }
  })

  it('非法转换的错误信息带 from/to(可诊断)', () => {
    try {
      assertAgentTransition('completed', 'running')
      expect.unreachable('不应到达')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentStatusViolation)
      expect((error as AgentStatusViolation).message).toContain('completed')
      expect((error as AgentStatusViolation).message).toContain('running')
    }
  })
})
