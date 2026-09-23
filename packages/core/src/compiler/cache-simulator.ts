import type { CacheBreakReason, CachePlan } from '@whispertavern/contracts'
import type { DeepReadonly } from '../ir/segment'

/**
 * Cache Simulator —— 总设计 §20(缓存模拟) / S20 WP2.5 交付面 3。
 *
 * 零 API 成本模拟(p2-plan §7 任务 3):吃**逐轮已编译的 CachePlan 记录序列**(不是重跑
 * compiler,而是消费真实编译产物),按 §20 口径输出:
 * - 逐轮 Stable/Fresh/CacheHit 曲线(理论缓存率);
 * - 无缓存基线与输入成本削减率;
 * - 最常见 Cache Killer(breakReasons 统计)。
 *
 * ## 两套 token 口径**严禁混算**(§33.2 四层;S20 金样抓出的真实缺陷)
 * - **理论层(plan token 计)**:compiler 侧 `stablePrefixTokens/freshTokens/volatileTokens`
 *   是本地估算(tokenCountMode=estimated,§2.2),用于预测"理论缓存率/成本削减";
 * - **实际层(provider 口径)**:provider 回传的 `prompt_tokens/cached_tokens`
 *   (§2.2),只用于 `actualHitRatio`。
 * 两套数是不同来源的**不同量**,禁止相加相减——否则会产出负 fresh(S20 金样实测抓出)。
 *
 * 语义口径:
 * - **理论缓存交接** = 本轮 stablePrefixTokens 中,与前一轮 stablePrefix 逐字节一致的部分。
 *   精确逐字节比对需要两轮序列化文本;Simulator 用**稳定前缀段哈希链**近似——
 *   连续两轮 stablePrefixSegments 的段 ID 序列 + 每段 contentHash 一致(§20 口径:
 *   "理论缓存率"按 stablePrefix 计,不冒充 Provider Cache Hit)。
 * - **CacheBreak** = 本轮记录了 breakReasons(S18 §58 已装配)或**存在上一轮基线时**
 *   stablePrefix 段哈希链出现首个分歧。**首轮无基线 → 不算 Break**(无缓存可毁),
 *   其理论承接自然为 0。
 * - 纯函数零 IO 零时钟零随机(HIT 率口径的确定性输入),同一输入序列结果逐字节一致。
 */

/** 一轮模拟输入:真实 CachePlan + 该轮段级哈希(供跨轮前缀比对) */
export interface CacheSimRound {
  /** 轮次序号(1-based,展示用;序即时间序) */
  round: number
  /** 该轮真实编译产出的 CachePlan(含 stablePrefix/fresh/breakReasons/providerStrategy) */
  plan: DeepReadonly<CachePlan>
  /** 稳定前缀段 ID → contentHash(段框架哈希,与 diff/projectSegment 同口径)。
   *  **理论承接的唯一校验依据**:缺省/空对象 → 本轮无法校验前缀一致性,理论承接记 0
   *  (保守口径,绝不乐观当成全命中)。 */
  stablePrefixHashes: Record<string, string>
  /** 实际 provider 回传的 cached_tokens(§2.2;缺省 undefined = 无实际口径) */
  actualCachedTokens?: number
  /** 实际 provider 回传的 prompt_tokens(§2.2;actualHitRatio 的分母) */
  providerInputTokens?: number
}

/** 一轮模拟输出 */
export interface CacheSimRoundResult {
  round: number
  /** 理论可缓存基线 token(plan 计,§33.2 第 1 层) */
  theoreticalStableTokens: number
  /** 理论承接 token(与前一轮 stablePrefix 逐字节一致的部分) */
  theoreticalCachedTokens: number
  /** 理论新鲜 token(= planInput − theoreticalCached;恒 ≥ 0) */
  theoreticalFreshTokens: number
  /** 本轮计划总输入 token(plan 计 = stable + fresh + volatile) */
  planInputTokens: number
  /** 实际 provider prompt_tokens(provider 口径;缺省 = 未回传) */
  providerInputTokens?: number
  /** 实际 provider cached_tokens(provider 口径;缺省 = 未回传) */
  actualCachedTokens?: number
  /** 本轮**理论**命中率(theoreticalCached / planInput) */
  hitRatio: number
  /** 本轮**实际**命中率(actualCached / providerInput;provider 未回传则 undefined) */
  actualHitRatio?: number
  /** 本轮是否发生 CacheBreak(breakReasons 非空 或 有基线时稳定前缀首分歧) */
  cacheBreak: boolean
  /** 本轮 CacheBreak 原因(breakReasons 的 type;空 = 无) */
  breakReasons: string[]
  /** 首个分歧段 ID(相对上轮稳定前缀;无基线/无分歧 = undefined) */
  firstDivergenceSegment?: string
}

/** Simulator 汇总输出(§20:曲线 / 理论缓存率 / 成本削减 / 最常见 Cache Killer) */
export interface CacheSimulatorReport {
  rounds: CacheSimRoundResult[]
  /** 理论缓存率:Σ 理论承接 / Σ 计划输入(plan token 计) */
  theoreticalHitRatio: number
  /** 实际命中率:Σ 实际 cached / Σ provider prompt(仅统计实际层齐全的轮次;无 → undefined) */
  actualHitRatio?: number
  /** 无缓存基线输入总量(Σ 计划输入 token;成本削减分母) */
  baselineInputTokens: number
  /** 需全价处理的 token 总量(Σ 理论新鲜;成本削减分子) */
  uncachedInputTokens: number
  /** 输入成本削减率(1 − uncached/baseline;§20 "省 XX%") */
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

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

export function simulateCachePlan(rounds: readonly CacheSimRound[]): CacheSimulatorReport {
  const results: CacheSimRoundResult[] = []
  let prevPrefix = new Map<string, string>()
  let totalTheoreticalCached = 0
  let totalPlanInput = 0
  let actualCachedSum = 0
  let providerInputSum = 0
  const killerCounts = new Map<string, number>()

  for (const round of rounds) {
    const plan = round.plan
    const planInputTokens = plan.stablePrefixTokens + plan.freshTokens + plan.volatileTokens
    // 段哈希记录缺失(调用方未投影段级哈希)或**首轮无基线** → 不做跨轮前缀比对(无缓存可毁)
    const hasBaseline = prevPrefix.size > 0
    const hasHashes = Object.keys(round.stablePrefixHashes).length > 0
    const divergence =
      hasBaseline && hasHashes
        ? firstStableDivergence(prevPrefix, round.stablePrefixHashes, plan.stablePrefixSegments)
        : undefined
    // 理论承接成立的两个前提:**存在上一轮基线** + 段哈希可校验且无分歧;
    // 任一缺失 → 0(首轮无可承接;哈希缺失时"无法校验"绝不乐观当成全命中,§33.2)
    const canCarry = hasBaseline && hasHashes && divergence === undefined
    const theoreticalCached = canCarry ? plan.stablePrefixTokens : 0
    const theoreticalFresh = planInputTokens - theoreticalCached
    const reasons = plan.breakReasons.map((r: DeepReadonly<CacheBreakReason>): string => r.type)
    for (const r of reasons) killerCounts.set(r, (killerCounts.get(r) ?? 0) + 1)

    // §33.2:实际层只在 provider 两数齐全时成立,绝不拿理论冒充实际
    const actualCached = round.actualCachedTokens
    const providerInput = round.providerInputTokens
    const hasActual = actualCached !== undefined && providerInput !== undefined && providerInput > 0

    results.push({
      round: round.round,
      theoreticalStableTokens: plan.stablePrefixTokens,
      theoreticalCachedTokens: theoreticalCached,
      theoreticalFreshTokens: theoreticalFresh,
      planInputTokens,
      providerInputTokens: providerInput,
      actualCachedTokens: actualCached,
      hitRatio: ratio(theoreticalCached, planInputTokens),
      actualHitRatio: hasActual ? ratio(actualCached, providerInput) : undefined,
      cacheBreak: reasons.length > 0 || divergence !== undefined,
      breakReasons: reasons,
      firstDivergenceSegment: divergence,
    })

    totalTheoreticalCached += theoreticalCached
    totalPlanInput += planInputTokens
    if (hasActual) {
      actualCachedSum += actualCached
      providerInputSum += providerInput
    }
    // 跨轮交接:本轮的稳定前缀哈希链成为下轮基线(append-only:只进不出)
    prevPrefix = new Map(Object.entries(round.stablePrefixHashes))
  }

  const uncachedInput = totalPlanInput - totalTheoreticalCached
  return {
    rounds: results,
    theoreticalHitRatio: ratio(totalTheoreticalCached, totalPlanInput),
    actualHitRatio: providerInputSum === 0 ? undefined : ratio(actualCachedSum, providerInputSum),
    baselineInputTokens: totalPlanInput,
    uncachedInputTokens: uncachedInput,
    inputCostReduction: totalPlanInput === 0 ? 0 : 1 - uncachedInput / totalPlanInput,
    topCacheKillers: [...killerCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  }
}
