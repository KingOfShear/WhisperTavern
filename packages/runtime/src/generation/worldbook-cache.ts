import type { Diagnostic, PromptZoneName } from '@whispertavern/contracts'
import { sha256Hex } from '../util/id'

/**
 * 世界书缓存分区纯函数层 —— worldbook-cache-design §2.1/§3.1/§3.5/§4 + compiler-spec
 * §21/§29/§30/§31(S17 WP2.2)。零 DB 依赖、零 IO,可确定性单测(X10);IO 接线在
 * worldbook.ts。
 *
 * 核心不变量:参与分区判定的条目必先过 volatile 预检(stability ∈ {static, session}),
 * 其宏不消耗 rng、不依赖 now/message → 哈希对象 = 发送字节(R-P2-3)。任何未来新增
 * "session 级但消耗 rng"的宏会破坏该不变量。
 *
 * 分区口径(§2.1 二次修订):
 *   stableWB = { e | h(e) ∈ chatCache ∧ ¬retired(e) }   → 照常发送,无论本轮是否激活
 *   fresh    = { e ∈ A | h(e) ∉ chatCache }             → 本轮新条目,追加在物理尾
 * physicalOrder 首次进入分区时分配、此后永不改变(§3.1);毕业只改 cacheState(§22)。
 *
 * 文本/位置不在本层:调用方装配贡献时按 entryId 从 DB 行补 content/position。
 */

/** §29 缓存状态机(unseen→fresh→stable→retired;stale 转场 S17 不产出,留 P4) */
export type CacheState = 'unseen' | 'fresh' | 'stable' | 'stale' | 'retired'

/** §4 WBCacheEntry 的 runtime 投影(行存储形态,与 worldbook_runtime_entries 列一一对应) */
export interface CacheRowView {
  entryId: string
  contentHash: string | null
  cacheState: CacheState
  physicalOrder: number | null
  lastActivationSeq: number | null
  firstSeenMsg: number | null
}

/** 分区输出成员(§4 ZoningItem;文本/位置由调用方装配时补) */
export interface ZoningItem {
  entryId: string
  /** 首次激活顺序分配;fresh 阶段即分配、永不改变(§3.1) */
  physicalOrder: number
  zone: 'stableWB' | 'freshWB'
  /** fresh→stable 毕业标记(仅状态迁移,字节不动) */
  graduated: boolean
  /** 本轮被裁(evicted,S17 恒空,裁剪动作归 S18 Budget Manager) */
  evicted: boolean
}

/** 参与分区的候选条目(已过 volatile 预检;contentHash 由调用方预计算) */
export interface ZoningCandidate {
  entryId: string
  contentHash: string
  /** 本轮是否激活(§30:stable 失活照发;fresh 未激活命中即毕业) */
  activated: boolean
  /** 本轮轮序(首次注入轮序 / 退休 inactiveRounds 计算基准) */
  sequence: number
  priority: number
}

/** 分区输入 */
export interface ZoneInput {
  /** 本轮参与分区的条目集合(激活候选 + 既有缓存成员,调用方已合并) */
  candidates: ZoningCandidate[]
  /** chatCache = 运行时态行投影(per-chatId,已按 chatId 过滤) */
  cache: ReadonlyMap<string, CacheRowView>
  /** 退休判定配置(缺省关闭) */
  retirement?: {
    enabled: boolean
    inactiveRoundsThreshold: number
    priorityThreshold: number
  }
}

/** §4 WorldbookZoning 分区输出 */
export interface WorldbookZoning {
  /** chatCache 成员(含本轮未激活者),append-only */
  stableWB: ZoningItem[]
  /** 本轮新增 */
  freshWB: ZoningItem[]
  /** 本轮结束后的行写回(∪ 语义,§2.1 更新 5) */
  nextCache: CacheRowView[]
  /** 本轮因预算被裁的条目(§4;S17 恒空,供 UI 提示) */
  evicted: ZoningItem[]
  /** 本轮退休的 entryId(改 cacheState='retired' + 诊断) */
  retired: string[]
  diagnostics: readonly Diagnostic[]
}

/** §3.5 预算裁剪序(freshWB 尾 → tail → injection → stableWB 最后手段);S17 只定义序,动作归 S18 */
export const BUDGET_TRIM_ORDER = ['freshWB', 'tail', 'injection', 'stableWB'] as const satisfies readonly PromptZoneName[]

/** §3.2 哈希对象 = 确定性展开后最终文本;normalize 恒等(决策 B)——空白差异必须产生不同指纹 */
export function computeContentHash(renderedText: string): string {
  return sha256Hex(renderedText)
}

/** 命中判定(§2.1):h(e) ∈ chatCache ⇔ 行存在 ∧ contentHash === h(e) ∧ cacheState ∈ {fresh, stable} */
function isCached(row: CacheRowView | undefined, contentHash: string): boolean {
  if (row === undefined) return false
  if (row.contentHash !== contentHash) return false
  return row.cacheState === 'fresh' || row.cacheState === 'stable'
}

/**
 * 分区主算法(§2.1 修订公式 + §3.1 append-only + §22 毕业 + §31 退休)。
 *
 * 毕业 = 本轮渲染哈希命中,与"本轮是否仍在 A"无关(§30 对 fresh 失活的同构论断):
 *   命中 且 cacheState='fresh' → 本轮迁移 'stable'(graduated)
 *   命中 且 cacheState='stable' → 保持
 */
export function zoneWorldbook(input: ZoneInput): WorldbookZoning {
  const { candidates, cache, retirement } = input
  const stableWB: ZoningItem[] = []
  const freshWB: ZoningItem[] = []
  const nextCache = new Map<string, CacheRowView>()
  const retired: string[] = []
  const diagnostics: Diagnostic[] = []

  // physicalOrder 分配:max(全部既有 physicalOrder,含 retired 不回收)+1(§3.1 append-only;
  // 退休条目 order 保留不回收,防未来新条目撞号)
  let nextOrder = 0
  for (const row of cache.values()) {
    if (row.physicalOrder !== null) {
      nextOrder = Math.max(nextOrder, row.physicalOrder)
    }
  }
  nextOrder += 1

  const seen = new Set<string>()
  for (const candidate of candidates) {
    seen.add(candidate.entryId)
    const row = cache.get(candidate.entryId)
    const hit = isCached(row, candidate.contentHash)

    if (hit) {
      // chatCache 成员(无论本轮激活):stableWB;fresh→stable 毕业
      const isFresh = row?.cacheState === 'fresh'
      stableWB.push({
        entryId: candidate.entryId,
        physicalOrder: row?.physicalOrder ?? nextOrder++,
        zone: 'stableWB',
        graduated: isFresh,
        evicted: false,
      })
      if (isFresh) {
        nextCache.set(candidate.entryId, {
          entryId: candidate.entryId,
          contentHash: candidate.contentHash,
          cacheState: 'stable',
          physicalOrder: row?.physicalOrder ?? null,
          lastActivationSeq: candidate.activated ? candidate.sequence : row?.lastActivationSeq ?? null,
          firstSeenMsg: row?.firstSeenMsg ?? candidate.sequence,
        })
      }
      continue
    }

    // 未命中且激活 → freshWB(本轮新条目);行写回 contentHash + cacheState='fresh'
    const order = nextOrder++
    freshWB.push({
      entryId: candidate.entryId,
      physicalOrder: order,
      zone: 'freshWB',
      graduated: false,
      evicted: false,
    })
    nextCache.set(candidate.entryId, {
      entryId: candidate.entryId,
      contentHash: candidate.contentHash,
      cacheState: 'fresh',
      physicalOrder: order,
      lastActivationSeq: candidate.sequence,
      firstSeenMsg: candidate.sequence,
    })
  }

  // 既有 chatCache 成员(未在本轮候选,含未激活者)照常发送(§30 Performance:
  // stable but inactive 照发;成员资格由 chatCache 决定,与当轮激活无关)。
  // 渲染文本由调用方装配时按 entryId 从 DB 补全,本层只给排序键。
  for (const row of cache.values()) {
    if (seen.has(row.entryId)) continue
    if (row.cacheState !== 'fresh' && row.cacheState !== 'stable') continue
    if (row.physicalOrder === null) continue
    stableWB.push({
      entryId: row.entryId,
      physicalOrder: row.physicalOrder,
      zone: 'stableWB',
      graduated: row.cacheState === 'fresh',
      evicted: false,
    })
    if (row.cacheState === 'fresh') {
      // 未激活的 fresh 成员本轮毕业(哈希命中语义,§22)
      nextCache.set(row.entryId, { ...row, cacheState: 'stable' })
    }
  }

  // 退休判定(§7/§31):对既有 fresh|stable 成员(未在本轮候选或已处理)——
  // inactiveRounds > threshold ∧ priority < priorityThreshold → retired
  if (retirement?.enabled === true) {
    for (const row of cache.values()) {
      if (row.cacheState !== 'fresh' && row.cacheState !== 'stable') continue
      const candidate = candidates.find((c) => c.entryId === row.entryId)
      // 未在本轮候选中的条目无法取 priority,保守不退休(防误伤)
      if (candidate === undefined) continue
      const lastSeq = row.lastActivationSeq
      if (lastSeq === null) continue
      const inactiveRounds = candidate.sequence - lastSeq
      if (inactiveRounds > retirement.inactiveRoundsThreshold && candidate.priority < retirement.priorityThreshold) {
        retired.push(row.entryId)
        nextCache.set(row.entryId, { ...row, cacheState: 'retired' })
        diagnostics.push({
          level: 'info',
          code: 'WORLD_BOOK_RETIRED',
          message: `世界书条目退休(WP2.2 §31):连续 ${inactiveRounds} 轮未激活且低于优先级阈值`,
          details: { entryId: row.entryId, inactiveRounds, priority: candidate.priority },
        })
      }
    }
  }

  return {
    stableWB,
    freshWB,
    nextCache: [...nextCache.values()],
    evicted: [],
    retired,
    diagnostics,
  }
}
