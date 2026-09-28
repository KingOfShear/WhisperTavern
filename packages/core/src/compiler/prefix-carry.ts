import type { PromptIR } from '@whispertavern/contracts'
import type { DeepReadonly } from '../ir/segment'
import { projectSegment } from '../serializer/diff'

/**
 * 前缀承接核算 —— worldbook-cache-design §2.2 端到端口径的**唯一定义处**
 * (S21/WP2.6;供场景回放引擎、`POST /cache/simulate` scenarios 回放、缓存稳定性门禁共用)。
 *
 * ## 与 S20 `simulateCachePlan.theoreticalHitRatio` 的区别(两套口径,不许互为冒充)
 * - S20 口径:只算 header+stableWB 的**连续稳定前缀**(`CachePlan.stablePrefixTokens`);
 * - 本模块口径:§2.2 的端到端**字节前缀**承接——缓存按前缀逐字节匹配,故承接 =
 *   与前一轮共享的连续字节前缀 token 和,自然含 append-only 的历史
 *   (这正是 §2.2 声称 60–90% 命中率的来源)。
 *
 * ## 布局推论(§2.2 prompt 布局)
 * injection/tail 位于 history **之后**:history 追加会把它们平移,故它们**永不进前缀缓存**。
 * 因此"追加式"只在前导可缓存区(header/stableWB/freshWB/summary/history)上断言;
 * 裁掉尾部的段(§49 裁剪序的第一步)对承接**零影响**。
 *
 * 纯函数:零 IO 零时钟零随机(X10);同一输入逐字节同输出。
 */

/** 可缓存区(§18 区序保证这段是段序前导) */
export const CACHEABLE_ZONES: ReadonlySet<string> = new Set([
  'header',
  'stableWB',
  'freshWB',
  'summary',
  'history',
])

interface SentSegment {
  id: string
  hash: string
  tokens: number
  zone: string
}

function sentOf(ir: DeepReadonly<PromptIR>): SentSegment[] {
  return ir.segments
    .filter((s) => s.enabled)
    .map((s) => {
      const p = projectSegment(s)
      return { id: p.id, hash: p.contentHash, tokens: p.tokenCount, zone: p.zone }
    })
}

function cacheableRegion(sent: readonly SentSegment[]): SentSegment[] {
  const out: SentSegment[] = []
  for (const s of sent) {
    if (!CACHEABLE_ZONES.has(s.zone)) break
    out.push(s)
  }
  return out
}

function sameSegment(a: SentSegment, b: SentSegment): boolean {
  return a.id === b.id && a.hash === b.hash
}

export interface PrefixCarry {
  /** §2.2 承接 token:与前轮共享的连续字节前缀 token 和(首轮 = 0) */
  cachedTokens: number
  /** 本轮实际发送 token 总量(enabled 段之和) */
  totalTokens: number
  /** 首个断裂段 ID(无断裂 = null) */
  firstDivergence: string | null
  /** 可缓存区是否仍是上轮的延长(append-only + 稳定区字节原位) */
  appendOnly: boolean
  /** 本轮实际发送段 ID → 段框架哈希(hash → hash 链;Simulator/遥测输入,免调用方重算) */
  hashes: Record<string, string>
}

export function computePrefixCarry(
  prevIr: DeepReadonly<PromptIR> | undefined,
  currIr: DeepReadonly<PromptIR>,
): PrefixCarry {
  const curr = sentOf(currIr)
  const totalTokens = curr.reduce((sum, s) => sum + s.tokens, 0)
  const hashes: Record<string, string> = {}
  for (const s of curr) hashes[s.id] = s.hash
  if (prevIr === undefined) {
    return { cachedTokens: 0, totalTokens, firstDivergence: null, appendOnly: true, hashes }
  }
  const prev = sentOf(prevIr)

  // 承接:按发送序逐位比对,首个不一致处截断(前缀缓存按字节前缀匹配)
  let cachedTokens = 0
  const limit = Math.min(prev.length, curr.length)
  for (let i = 0; i < limit; i += 1) {
    const a = prev[i]!
    const b = curr[i]!
    if (!sameSegment(a, b)) break
    cachedTokens += b.tokens
  }

  // 断裂点与追加式:只在前导可缓存区上判定(injection/tail 被 history 平移属常态)
  const a = cacheableRegion(prev)
  const b = cacheableRegion(curr)
  let firstDivergence: string | null = null
  const cmpLimit = Math.min(a.length, b.length)
  for (let i = 0; i < cmpLimit; i += 1) {
    if (!sameSegment(a[i]!, b[i]!)) {
      firstDivergence = a[i]!.id
      break
    }
  }
  if (firstDivergence === null && a.length > b.length) firstDivergence = a[b.length]?.id ?? null
  return { cachedTokens, totalTokens, firstDivergence, appendOnly: firstDivergence === null, hashes }
}
