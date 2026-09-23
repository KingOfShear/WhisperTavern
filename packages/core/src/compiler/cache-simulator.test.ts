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
    expect(report.rounds[1]!.theoreticalFreshTokens).toBe(80)
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
    expect(report.rounds[1]!.theoreticalFreshTokens).toBe(100)
  })

  /** S20 金样抓出的缺陷回归:首轮无缓存可毁,不得判 CacheBreak */
  it('首轮(无基线)即使有段哈希也不算 CacheBreak,且无 firstDivergenceSegment', () => {
    const report = simulateCachePlan([makePlan(200, 50, 30)])
    expect(report.rounds[0]!.cacheBreak).toBe(false)
    expect(report.rounds[0]!.firstDivergenceSegment).toBeUndefined()
    expect(report.rounds[0]!.theoreticalCachedTokens).toBe(0)
  })

  it('稳定前缀哈希分歧 → CacheBreak + firstDivergenceSegment,理论命中归零', () => {
    const report = simulateCachePlan([
      makePlan(200, 50, 30),
      makePlan(200, 50, 30, [], ['a', 'b'], { a: 'CHANGED', b: 'bbbb' }),
    ])
    expect(report.rounds[1]!.cacheBreak).toBe(true)
    expect(report.rounds[1]!.firstDivergenceSegment).toBe('a')
    expect(report.rounds[1]!.theoreticalCachedTokens).toBe(0)
    expect(report.rounds[1]!.theoreticalFreshTokens).toBe(280) // 全部重发
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

  /** S20 金样抓出的缺陷回归:理论(plan 计)与实际(provider 回传)是两套口径,严禁相减 */
  it('实际层齐全 → 理论/实际两口径并列,理论恒非负且不受 provider 数干扰', () => {
    const report = simulateCachePlan([
      makePlan(200, 0, 0),
      { ...makePlan(200, 0, 0), round: 2, actualCachedTokens: 96, providerInputTokens: 150 },
    ])
    // 实际层:provider 口径
    expect(report.rounds[1]!.actualHitRatio).toBeCloseTo(96 / 150, 10)
    expect(report.actualHitRatio).toBeCloseTo(96 / 150, 10)
    // 理论层:plan 口径(200/200),不被 provider 的 150 改写
    expect(report.rounds[1]!.hitRatio).toBe(1)
    expect(report.rounds[1]!.theoreticalFreshTokens).toBe(0)
    expect(report.theoreticalHitRatio).toBeCloseTo(200 / 400, 10)
    expect(report.baselineInputTokens).toBe(400)
    expect(report.uncachedInputTokens).toBe(200)
  })

  it('provider 数目大于 plan 计(本地估算偏差)→ 理论新鲜仍非负(混算回归)', () => {
    const report = simulateCachePlan([
      makePlan(11720, 0, 0),
      { ...makePlan(11720, 0, 0), round: 2, actualCachedTokens: 0, providerInputTokens: 10956 },
    ])
    expect(report.rounds[1]!.theoreticalFreshTokens).toBe(0)
    expect(report.rounds[1]!.theoreticalFreshTokens).toBeGreaterThanOrEqual(0)
    expect(report.rounds[1]!.planInputTokens).toBe(11720)
    expect(report.rounds[1]!.providerInputTokens).toBe(10956)
  })

  it('provider 数缺失 → actualHitRatio undefined(不是 0,不冒充实际命中)', () => {
    const report = simulateCachePlan([
      makePlan(200, 0, 0),
      { ...makePlan(200, 0, 0), round: 2, actualCachedTokens: 96 },
    ])
    expect(report.rounds[1]!.actualHitRatio).toBeUndefined()
    expect(report.actualHitRatio).toBeUndefined()
  })

  it('空输入 → 空报告零除安全', () => {
    const report = simulateCachePlan([])
    expect(report.rounds).toEqual([])
    expect(report.theoreticalHitRatio).toBe(0)
    expect(report.actualHitRatio).toBeUndefined()
    expect(report.inputCostReduction).toBe(0)
    expect(report.topCacheKillers).toEqual([])
  })
})