import { describe, expect, it } from 'vitest'
import { simulateCachePlan, type CacheSimRound } from './cache-simulator'

/**
 * S20(WP2.5)Cache Simulator 单测 —— 总设计 §20 / p2-plan §7 任务 3。
 * 口径:X10 确定性输入 → 逐字节一致输出;理论缓存率按 token 计(§2.2),
 * 绝不把理论稳定前缀冒充 Provider 实际命中(§33.2 四层口径)。
 */

function makePlan(
  stablePrefixTokens: number,
  freshTokens: number,
  volatileTokens: number,
  breakReasons: { type: string }[] = [],
  stablePrefixSegments: string[] = ['a', 'b'],
  stablePrefixHashes: Record<string, string> = { a: 'aaaa', b: 'bbbb' },
): CacheSimRound {
  return {
    round: 1,
    plan: {
      version: 1,
      stablePrefixSegments,
      stablePrefixTokens,
      freshSegments: ['f'],
      freshTokens,
      volatileSegments: ['v'],
      volatileTokens,
      checkpoints: [],
      invalidationRisk: 'low',
      breakReasons: breakReasons as never,
    },
    stablePrefixHashes,
  }
}

describe('S20 Cache Simulator(§20)', () => {
  it('稳定前缀连续两轮一致 → 理论命中=stablePrefix,无 CacheBreak', () => {
    const report = simulateCachePlan([
      makePlan(200, 50, 30),
      makePlan(200, 50, 30),
    ])
    expect(report.rounds.length).toBe(2)
    expect(report.rounds[0]!.theoreticalCachedTokens).toBe(0) // 首轮无上一轮基线
    expect(report.rounds[1]!.theoreticalCachedTokens).toBe(200)
    expect(report.rounds[1]!.cacheBreak).toBe(false)
    // 本轮总输入 = stable(200) + fresh(50) + volatile(30) = 280;命中 200 → 新鲜 80
    expect(report.rounds[1]!.freshTokens).toBe(80)
    // 总输入 = 280×2 = 560;理论命中 = 200(仅第 2 轮)
    expect(report.theoreticalHitRatio).toBeCloseTo(200 / 560, 10)
    expect(report.inputCostReduction).toBeCloseTo(200 / 560, 10)
    expect(report.topCacheKillers).toEqual([])
  })

  it('稳定前缀首轮无基线 → 理论命中 0,后续轮才承接', () => {
    const report = simulateCachePlan([
      makePlan(300, 0, 0),
      makePlan(300, 100, 0),
    ])
    expect(report.rounds[0]!.theoreticalCachedTokens).toBe(0)
    expect(report.rounds[1]!.theoreticalCachedTokens).toBe(300)
    expect(report.rounds[1]!.freshTokens).toBe(100)
  })

  it('稳定前缀哈希分歧 → CacheBreak + firstDivergenceSegment,理论命中归零', () => {
    const report = simulateCachePlan([
      makePlan(200, 50, 30),
      makePlan(200, 50, 30, [], ['a', 'b'], { a: 'CHANGED', b: 'bbbb' }),
    ])
    expect(report.rounds[1]!.cacheBreak).toBe(true)
    expect(report.rounds[1]!.firstDivergenceSegment).toBe('a')
    expect(report.rounds[1]!.theoreticalCachedTokens).toBe(0)
    expect(report.rounds[1]!.freshTokens).toBe(280) // 全部重发
  })

  it('breakReasons 非空 → cacheBreak 且计入 Killer 统计', () => {
    const report = simulateCachePlan([
      makePlan(200, 50, 30),
      makePlan(200, 50, 30, [{ type: 'WORLD_BOOK_NEW_ENTRY' }, { type: 'MESSAGE_EDITED' }]),
    ])
    expect(report.rounds[1]!.cacheBreak).toBe(true)
    expect(report.rounds[1]!.breakReasons).toContain('MESSAGE_EDITED')
    // 两个 killer 各计 1 次(同 count 排序不稳定,断言集合而非顺序)
    expect(report.topCacheKillers).toHaveLength(2)
    expect(report.topCacheKillers.find((k) => k.reason === 'MESSAGE_EDITED')).toEqual({ reason: 'MESSAGE_EDITED', count: 1 })
    expect(report.topCacheKillers.find((k) => k.reason === 'WORLD_BOOK_NEW_ENTRY')).toEqual({ reason: 'WORLD_BOOK_NEW_ENTRY', count: 1 })
  })

  it('actualCachedTokens 缺失 → 理论口径;存在 → 实际口径且不高估(§33.2)', () => {
    const report = simulateCachePlan([
      makePlan(200, 0, 0),
      { ...makePlan(200, 0, 0), round: 2, actualCachedTokens: 180, inputTokens: 200 } as CacheSimRound,
    ])
    expect(report.rounds[1]!.hitRatio).toBe(180 / 200) // 实际口径
    expect(report.actualHitRatio).toBe(180 / 400)
    expect(report.theoreticalHitRatio).toBeCloseTo(200 / 400, 10) // 理论口径不受实际值影响
  })

  it('空输入 → 空报告零除安全', () => {
    const report = simulateCachePlan([])
    expect(report.rounds).toEqual([])
    expect(report.theoreticalHitRatio).toBe(0)
    expect(report.inputCostReduction).toBe(0)
    expect(report.topCacheKillers).toEqual([])
  })
})