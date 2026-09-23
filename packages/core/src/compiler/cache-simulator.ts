import type { CacheBreakReason, CachePlan } from '@whispertavern/contracts'
import type { DeepReadonly } from '../ir/segment'

/**
 * Cache Simulator —— 总设计 §20(缓存模拟) / S20 WP2.5 交付面 3。
 *
 * 零 API 成本模拟(p2-plan §7 任务 3):吃**逐轮已编译的 CachePlan 记录序列**(不是重跑
 * compiler,而是消费真实编译产物),按 §20 口径输出:
 * - 逐轮 Stable/Fresh/CacheHit 曲线(理论缓存率,§2.2 token 计);
 * - 期望输入成本(有缓存 vs 无缓存基线)与削减率;
 * - 最常见 Cache Killer(breakReasons 统计)。
 *
 * 语义口径:
 * - **理论缓存交接** = 本轮 stablePrefixTokens 中,与前一轮 stablePrefix 逐字节一致的部分。
 *   精确逐字节比对需要两轮序列化文本;Simulator 用**稳定前缀段哈希链**近似——
 *   连续两轮 stablePrefixSegments 的段 ID 序列 + 每段 contentHash 一致(§20 口径:
 *   "理论缓存率"按 stablePrefix 计,不冒充 Provider Cache Hit,严禁把理论当实际命中)。
 * - **CacheBreak** = 本轮记录了 breakReasons(S18 §58 已装配)或 stablePrefix 段哈希
 *   链相对上轮出现首个分歧(消息追加不破坏前缀;首分歧位置之后的 fresh 部分重发)。
 * - 纯函数零 IO 零时钟零随机(X10:HIT 率口径的确定性输入),同一输入序列结果逐字节一致。
 */

/** 一轮模拟输入:真实 CachePlan + 该轮段级哈希(供跨轮前缀比对) */
export interface CacheSimRound {
  /** 轮次序号(1-based,展示用) */
  round: number
  /** 该轮真实编译产出的 CachePlan(含 stablePrefix/fresh/breakReasons/providerStrategy) */
  plan: DeepReadonly<CachePlan>
  /** 稳定前缀段 ID → contentHash(段框架哈希,与 diff/projectSegment 同口径) */
  stablePrefixHashes: Record<string, string>
  /** 实际 provider 回传的缓存命中 token(§2.2;缺省 undefined = 理论口径降级) */
  actualCachedTokens?: number
  /** 该轮总输入 token(用于成本估算;缺省 = stable+fresh+volatile 合计) */
  totalInputTokens?: number
}

/** 一轮模拟输出 */
export interface CacheSimRoundResult {
  round: number
  /** 理论稳定前缀 token(可缓存基线,§33.2 第 1 层) */
  theoreticalStableTokens: number
  /** 理论命中 token(与前一轮 stablePrefix 逐字节一致的部分;§33.2 第 2–3 层近似) */
  theoreticalCachedTokens: number
  /** 本轮新鲜 token(理论命中之外全部重发) */
  freshTokens: number
  /** 本轮实际回传命中 token(actualCachedTokens;undefined → 理论口径) */
  actualCachedTokens?: number
  /** 本轮输入成本估算(输入 token 计,§2.2;cached 按无缓存基线的 1/3 折算? 不——成本口径见 Simulator 汇总,这里只记 token 两个数) */
  inputTokens: number
  /** 命中率联合口径:命中/(命中+新鲜)。actual 缺失时回落 theoretical */
  hitRatio: number
  /** 本轮是否发生 CacheBreak(breakReasons 非空 或 稳定前缀相对上轮首分歧) */
  cacheBreak: boolean
  /** 本轮 CacheBreak 原因(breakReasons 映射的 type;空 = 无) */
  breakReasons: string[]
  /** 首个分歧段 ID(相对上轮稳定前缀;无分歧 = undefined) */
  firstDivergenceSegment?: string
}

/** Simulator 汇总输出(§20:曲线 / 理论缓存率 / 成本削减 / 最常见 Cache Killer) */
export interface CacheSimulatorReport {
  rounds: CacheSimRoundResult[]
  /** 理论缓存率:Σ 理论命中 token / Σ 总输入 token(§2.2 token 计) */
  theoreticalHitRatio: number
  /** 实际命中率(仅统计 actualCachedTokens 非空的轮次;无一轮有实际值 → undefined) */
  actualHitRatio?: number
  /** 无缓存基线输入总量(Σ 总输入 token;成本削减分母) */
  baselineInputTokens: number
  /** 有缓存输入总量(Σ 理论命中之外重发的 token) */
  cachedInputTokens: number
  /** 输入成本削减率(1 − 有缓存/无缓存;§20 "省 XX%") */
  inputCostReduction: number
  /** 最常见 Cache Killer(breakReasons type 计数降序;空 = 无失效) */
  topCacheKillers: { reason: string; count: number }[]
}

/** 稳定前缀断裂(相对上轮):返回首个分歧段 ID,整段一致返回 undefined */
function firstStableDivergence(
  prev: ReadonlyMap<string, string>,
  curr: Readonly<Record<string, string>>,
  order: readonly string[],
): string | undefined {
  for (const id of order) {
    const prevHash = prev.get(id)
    if (prevHash === undefined || prevHash !== curr[id]) return id
  }
  return undefined
}

export function simulateCachePlan(rounds: readonly CacheSimRound[]): CacheSimulatorReport {
  const results: CacheSimRoundResult[] = []
  let prevPrefix = new Map<string, string>()
  let totalTheoreticalCached = 0
  let totalInput = 0
  let actualRounds = 0
  let actualCachedSum = 0
  const killerCounts = new Map<string, number>()

  for (const round of rounds) {
    const plan = round.plan
    const hasOption = Object.keys(round.stablePrefixHashes).length > 0
    const stableHashById = new Map(Object.entries(round.stablePrefixHashes))
    // 段哈希记录缺失(遥测侧未投影段级哈希)时跳过跨轮比对,退化为 breakReasons + 单轮统计
    const divergence = hasOption ? firstStableDivergence(prevPrefix, round.stablePrefixHashes, plan.stablePrefixSegments) : undefined
    const theoreticalCached = divergence === undefined ? plan.stablePrefixTokens : 0
    const totalTokens =
      round.totalInputTokens ?? plan.stablePrefixTokens + plan.freshTokens + plan.volatileTokens
    const freshTokens = totalTokens - theoreticalCached
    const reasons = plan.breakReasons.map((r: DeepReadonly<CacheBreakReason>): string => r.type)
    for (const r of reasons) killerCounts.set(r, (killerCounts.get(r) ?? 0) + 1)

    const cacheBreak = reasons.length > 0 || divergence !== undefined
    // §33.2:命中率联合口径——actual 缺失回落 theoretical;绝不把"未回传"当 100% 命中
    const actualCached = round.actualCachedTokens
    const hitRatio =
      actualCached !== undefined
        ? totalTokens === 0
          ? 0
          : actualCached / totalTokens
        : totalTokens === 0
          ? 0
          : theoreticalCached / totalTokens

    results.push({
      round: round.round,
      theoreticalStableTokens: plan.stablePrefixTokens,
      theoreticalCachedTokens: theoreticalCached,
      freshTokens,
      actualCachedTokens: actualCached,
      inputTokens: totalTokens,
      hitRatio,
      cacheBreak,
      breakReasons: reasons,
      firstDivergenceSegment: divergence,
    })

    totalTheoreticalCached += theoreticalCached
    totalInput += totalTokens
    if (actualCached !== undefined) {
      actualRounds += 1
      actualCachedSum += actualCached
    }
    // 跨轮交接:本轮的稳定前缀哈希链成为下轮基线(append-only:只进不出)
    prevPrefix = stableHashById
  }

  const theoreticalHitRatio = totalInput === 0 ? 0 : totalTheoreticalCached / totalInput
  const cachedInput = totalInput - totalTheoreticalCached
  return {
    rounds: results,
    theoreticalHitRatio,
    actualHitRatio: actualRounds === 0 ? undefined : actualCachedSum / totalInput,
    baselineInputTokens: totalInput,
    cachedInputTokens: cachedInput,
    inputCostReduction: totalInput === 0 ? 0 : 1 - cachedInput / totalInput,
    topCacheKillers: [...killerCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  }
}