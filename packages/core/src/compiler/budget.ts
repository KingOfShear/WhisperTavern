import { BUDGET_TRIM_ORDER, type BudgetTrimTarget, type PromptZoneName, type SegmentSource } from '@whispertavern/contracts'

/**
 * Budget Manager —— compiler-spec §46–§51(S18 WP2.3)。纯函数、零 IO、确定性(X10)。
 *
 * 裁剪语义:
 * - 裁剪 = 段标记 enabled=false,保留在 IR 原位(§91 Disabled Segment:不参与
 *   Serialization 但 Snapshot 可记录)。
 * - 两级裁剪:① 世界书 percent+cap 配额(technical-design §12 world_info_budget,
 *   P1 挂账解除);② 全局按 §49/§15.1 权威序裁到 available。
 * - header 区段 protect(硬编码不可裁)——否则可用空间过小时产出空 prompt;
 *   裁到只剩 header 仍超限 → 上层报 PROMPT_CONTEXT_TOO_LARGE(§71 修订口径
 *   "裁剪后仍放不进模型上下文窗口")。
 * - Elastic History(§50):history 区 Pinned/Elastic 分区,裁到 elasticHistory 档时
 *   整体推出(绝不逐条删,防连续 Cache Break)。
 */

/** ST world_info_budget 配置(percent=占可用上下文百分比,cap=硬上限 token) */
export interface WorldbookBudgetConfig {
  percent: number
  cap: number | null
}

/** §50 Elastic History:Pinned 消息数(0 = 不启用弹性分区,全 Pinned) */
export interface HistoryElasticConfig {
  pinnedMessageCount: number
}

/** 预算阶段可见的段视图(排序后;zone/order/tokenCount/source 是决策所需最小面) */
export interface BudgetSegment {
  id: string
  zone: PromptZoneName
  order: number
  tokenCount: number
  source: SegmentSource
}

export type BudgetTrimReason =
  | { type: 'zone_over_budget'; zone: PromptZoneName; excludedSegments: string[] }
  | { type: 'worldbook_percent_cap'; quotaTokens: number; excludedSegments: string[] }
  | { type: 'elastic_history_excluded'; pinnedCount: number; elasticSegments: string[] }
  | { type: 'header_protected'; segmentId: string }

export interface BudgetInput {
  segments: readonly BudgetSegment[]
  /** 可用 token = maxContext - output reservation - safety margin(§47) */
  availableTokens: number
  worldbookBudget?: WorldbookBudgetConfig
  elastic?: HistoryElasticConfig
}

export interface BudgetResult {
  included: string[]
  excluded: string[]
  /** included 汇总(与 serialized.tokenCount 一致) */
  totalTokens: number
  reasons: BudgetTrimReason[]
}

/** 默认 ST 生态 world_info_budget(technical-design §12 / st-reference-analysis §3.1) */
export const DEFAULT_WORLDBOOK_BUDGET: WorldbookBudgetConfig = { percent: 25, cap: null }
export const DEFAULT_ELASTIC: HistoryElasticConfig = { pinnedMessageCount: 0 }

/** §50:Pinned = 前 N 段(最老锚点),Elastic = 其余(最新尾部) */
export function partitionHistory(
  historySegments: readonly BudgetSegment[],
  pinnedMessageCount: number,
): { pinned: readonly BudgetSegment[]; elastic: readonly BudgetSegment[] } {
  if (pinnedMessageCount <= 0) return { pinned: historySegments, elastic: [] }
  const pinned = historySegments.slice(0, pinnedMessageCount)
  const elastic = historySegments.slice(pinnedMessageCount)
  return { pinned, elastic }
}

/** 段是否世界书分区条目(仅 stableWB/freshWB 受 percent+cap 约束;injection 受全局序管,R-P2-6) */
function isPartitionWorldbook(segment: BudgetSegment): boolean {
  return segment.source.type === 'worldbook' && (segment.zone === 'stableWB' || segment.zone === 'freshWB')
}

export function applyBudget(input: BudgetInput): BudgetResult {
  const { segments, availableTokens } = input
  const wbBudget = input.worldbookBudget ?? DEFAULT_WORLDBOOK_BUDGET
  const elastic = input.elastic ?? DEFAULT_ELASTIC
  const reasons: BudgetTrimReason[] = []

  const excluded = new Set<string>()
  const included = new Set<string>()
  let remaining = availableTokens

  // —— ① 世界书 percent+cap 配额裁剪(两级裁剪第一级,P1 挂账解除)——
  const wbSegments = segments.filter(isPartitionWorldbook)
  const wbTokens = wbSegments.reduce((sum, s) => sum + s.tokenCount, 0)
  const wbQuota = Math.min(Math.floor((availableTokens * wbBudget.percent) / 100), wbBudget.cap ?? availableTokens)
  if (wbTokens > wbQuota) {
    // 超配额:按 order 降序从尾部裁(先 freshWB 尾、再 stableWB 尾——与缓存代价序方向一致)
    const excess = wbTokens - wbQuota
    const toTrim = [...wbSegments].sort((a, b) => b.order - a.order)
    let trimmedTokens = 0
    const trimmed: BudgetSegment[] = []
    for (const s of toTrim) {
      trimmedTokens += s.tokenCount
      trimmed.push(s)
      excluded.add(s.id)
      if (trimmedTokens >= excess) break
    }
    reasons.push({ type: 'worldbook_percent_cap', quotaTokens: wbQuota, excludedSegments: trimmed.map((s) => s.id) })
  }

  // —— ② 全局缓存代价序裁剪 ——
  // 保留优先序 = §49 裁剪序的逆序(header 最先保留、tail 最后保留;越稳定越晚被裁)
  const RETAIN_ORDER: readonly BudgetTrimTarget[] = [...BUDGET_TRIM_ORDER].reverse()
  const zoneByOrder = new Map<PromptZoneName, BudgetSegment[]>()
  for (const s of segments) {
    const bucket = zoneByOrder.get(s.zone)
    if (bucket) bucket.push(s)
    else zoneByOrder.set(s.zone, [s])
  }
  for (const bucket of zoneByOrder.values()) bucket.sort((a, b) => a.order - b.order)
  // history 特殊档:elastic 子集按整体推出;pinned 子集按段保留(位置 = elastic 档之后)
  const historySegments = zoneByOrder.get('history') ?? []
  const { pinned, elastic: elasticSegs } = partitionHistory(historySegments, elastic.pinnedMessageCount)
  const elasticTokens = elasticSegs.reduce((sum, s) => sum + s.tokenCount, 0)
  const elasticHandled = elastic.pinnedMessageCount > 0 && elasticSegs.length > 0
  zoneByOrder.delete('history')
  zoneByOrder.set('freshWB', [...(zoneByOrder.get('freshWB') ?? []), ...pinned])

  /** 逐段保留:放得下 → included;放不下 → excluded(同 zone 按 order 序)。
   * header 例外:protect 硬编码——放不下也 included,超限记 reason(防空 prompt) */
  const retainZone = (zone: PromptZoneName): void => {
    for (const s of zoneByOrder.get(zone) ?? []) {
      if (excluded.has(s.id) || included.has(s.id)) continue
      if (remaining >= s.tokenCount || zone === 'header') {
        included.add(s.id)
        remaining -= s.tokenCount
        if (zone === 'header' && remaining < 0) {
          reasons.push({ type: 'header_protected', segmentId: s.id })
        }
      } else {
        excluded.add(s.id)
        reasons.push({ type: 'zone_over_budget', zone, excludedSegments: [s.id] })
      }
    }
  }

  for (const target of RETAIN_ORDER) {
    if (target === 'elasticHistory') {
      // §50:Elastic 段整体推出当且仅当"连 elastic 也放不下";放得下则全部保留
      if (elasticHandled && remaining - elasticTokens < 0) {
        for (const s of elasticSegs) excluded.add(s.id)
        reasons.push({ type: 'elastic_history_excluded', pinnedCount: pinned.length, elasticSegments: elasticSegs.map((s) => s.id) })
      } else if (elasticHandled) {
        for (const s of elasticSegs) {
          included.add(s.id)
          remaining -= s.tokenCount
        }
      }
      continue
    }
    retainZone(target)
  }

  // 最终 included 按原始 IR 序输出(保留物理序;§49 序只决定"谁被裁",不重排)
  // 令牌表化:原 segments.find-in-reduce 为 O(n²),长对话下与 cacheplan 同属热点(S21 千轮门禁实测)
  const tokenById = new Map(segments.map((s) => [s.id, s.tokenCount]))
  const finalIncluded = segments.filter((s) => included.has(s.id)).map((s) => s.id)
  const totalTokens = finalIncluded.reduce((sum, id) => sum + (tokenById.get(id) ?? 0), 0)

  return {
    included: finalIncluded,
    excluded: [...excluded].filter((id) => !included.has(id)),
    totalTokens,
    reasons,
  }
}
