import { describe, expect, it } from 'vitest'
import { CACHE_SCENARIOS, replayCacheScenarios } from './cache-scenarios'

/**
 * S21(WP2.6)场景回放引擎单测 —— p2-plan §8 任务 2 / api-spec §43 scenarios。
 * 口径:X10 确定性输入 → 逐字节一致输出;未声明失效必须为 0(二道门禁的判据)。
 *
 * 千轮报告在**模块作用域**只计算一次(它同时是二道门禁的主体),后续断言复用同一结果,
 * 避免同一重活跑多遍(千轮全量真实编译本就昂贵)。
 */
const FULL = replayCacheScenarios({ rounds: 1000, scenarios: CACHE_SCENARIOS })
const STEADY = FULL.rounds.filter(
  (r) => r.round > 1 && r.applied.length === 0 && r.declaredBreaks.length === 0 && r.trimmedSegments === 0,
)

describe('S21 场景回放引擎(§43 scenarios)', () => {
  it('纯稳态 40 轮:前缀逐轮延长、零意外失效、无被动裁剪', () => {
    const report = replayCacheScenarios({ rounds: 40, scenarios: [] })
    expect(report.rounds.length).toBe(40)
    expect(report.unexpectedBreakTotal).toBe(0)
    expect(report.rounds[0]!.cachedTokens).toBe(0)
    for (const r of report.rounds.slice(1)) {
      expect(r.cachedTokens).toBeGreaterThan(0)
      expect(r.cachedTokens).toBeLessThan(r.planInputTokens)
      expect(r.firstDivergence).toBeNull()
    }
    expect(report.hitRatio).toBeGreaterThan(0.7)
    expect(report.costReduction).toBeCloseTo(report.hitRatio, 10)
    expect(report.rounds.every((r) => r.trimmedSegments === 0)).toBe(true)
    expect(report.rounds.every((r) => r.applied.length === 0 && r.declaredBreaks.length === 0)).toBe(true)
  })

  it('承接 = 上轮总量减尾部(injection/tail 位于 history 之后,不进前缀)', () => {
    const report = replayCacheScenarios({ rounds: 3, scenarios: [] })
    expect(report.rounds[1]!.cachedTokens).toBeLessThan(report.rounds[0]!.planInputTokens)
    expect(report.rounds[1]!.cachedTokens).toBeGreaterThan(report.rounds[0]!.stableTokens)
  })

  it('1000 轮全场景:零未声明失效', () => {
    expect(FULL.rounds.length).toBe(1000)
    expect(FULL.unexpectedBreakTotal).toBe(0)
  })

  it('1000 轮稳态轮承接占比 > 70%(§2.2 口径 KPI 预演)', () => {
    expect(STEADY.length).toBeGreaterThan(500)
    for (const r of STEADY) {
      expect(r.cachedTokens / r.planInputTokens).toBeGreaterThan(0.7)
    }
    expect(FULL.hitRatio).toBeGreaterThan(0.7)
    expect(FULL.costReduction).toBeGreaterThan(0.6)
  })

  it('每个场景族在窗口内至少触发一次', () => {
    for (const name of CACHE_SCENARIOS) {
      expect(FULL.rounds.some((r) => r.applied.includes(name)), `场景未触发: ${name}`).toBe(true)
    }
  })

  it('触发轮确实改变了字节(除裁尾部的 budget)', () => {
    const byRound = new Map(FULL.rounds.map((r) => [r.round, r]))
    let checked = 0
    for (const r of FULL.rounds) {
      const byteChanging = r.applied.filter((name) => name !== 'budget')
      if (byteChanging.length === 0) continue
      const prev = byRound.get(r.round - 1)
      if (prev === undefined) continue
      expect(r.prefixHash, `${r.applied.join(',')} @ 轮 ${r.round} 未改变字节`).not.toBe(prev.prefixHash)
      checked += 1
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('budget 场景:真实裁掉尾部段,且承接量与不裁时逐字相同(§49"裁尾部零伤害")', () => {
    const withBudget = replayCacheScenarios({ rounds: 60, scenarios: ['budget'] })
    const without = replayCacheScenarios({ rounds: 60, scenarios: [] })
    const budgetRounds = withBudget.rounds.filter((r) => r.applied.includes('budget'))
    expect(budgetRounds.length).toBeGreaterThan(0)
    for (const r of budgetRounds) {
      expect(r.trimmedSegments).toBeGreaterThan(0)
      expect(r.cachedTokens).toBe(without.rounds[r.round - 1]!.cachedTokens)
      expect(r.planInputTokens).toBeLessThan(without.rounds[r.round - 1]!.planInputTokens)
      expect(r.unexpectedBreaks).toEqual([])
    }
  })

  it('确定性:同输入两次调用逐字节一致(X10)', () => {
    const a = replayCacheScenarios({ rounds: 120, scenarios: CACHE_SCENARIOS })
    const b = replayCacheScenarios({ rounds: 120, scenarios: CACHE_SCENARIOS })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('空窗口 → 空报告,零除安全', () => {
    const report = replayCacheScenarios({ rounds: 0, scenarios: CACHE_SCENARIOS })
    expect(report.rounds).toEqual([])
    expect(report.hitRatio).toBe(0)
    expect(report.costReduction).toBe(0)
    expect(report.unexpectedBreakTotal).toBe(0)
  })

  it('非法场景名被过滤(不静默当成已支持)', () => {
    const report = replayCacheScenarios({ rounds: 10, scenarios: ['nope' as never] })
    expect(report.rounds.every((r) => r.applied.length === 0)).toBe(true)
  })
})
