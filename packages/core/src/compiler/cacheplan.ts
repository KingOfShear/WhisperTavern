import type {
  CacheBreakReason,
  CacheCheckpoint,
  CachePlan,
  Diagnostic,
  PromptIR,
  PromptZoneName,
} from '@whispertavern/contracts'
import { buildPrefixHash } from '../serializer/hash'
import { deepFreeze, type DeepReadonly } from '../ir/segment'

/**
 * Cache Planner —— compiler-spec §53–§55(S18 WP2.3)。纯函数、零 IO、确定性。
 *
 * 装配算法:
 * - stablePrefixSegments:从头开始**连续**满足 zone ∈ STABLE_ZONES ∧ stability ∈
 *   {static, session} 的段 id(保序)——"Round N == Round N+1"的前缀契约(§14.1)。
 * - freshSegments:zone === 'freshWB'(本轮新内容)。
 * - volatileSegments:其余(history/injection/tail/非稳定段)。
 * - checkpoints:S18 只做 automatic 断点(S19 才翻译 provider 原语,providerStrategy 留空)。
 * - breakReasons:runtime 注入的跨轮失效 + 本编译推断(MACRO_VOLATILE / WORLD_BOOK_NEW_ENTRY),去重。
 * - invalidationRisk:启发式(§59 待完善)。
 * - version:1(R-P0-4 退役)。
 */

/** 稳定区(与 pipeline STABLE_ZONES 同构;S16 §43) */
const STABLE_ZONES: readonly PromptZoneName[] = ['header', 'stableWB', 'freshWB', 'summary']

/** §15 稳定性:session 级及以上可进稳定前缀(static/session 跨轮逐字节一致) */
const PREFIX_STABLE: readonly string[] = ['static', 'session']

export interface BuildCachePlanInput {
  /** 排序后、enabled 标记后的 IR */
  ir: DeepReadonly<PromptIR>
  /** 跨轮失效事件(runtime 注入) */
  invalidations: readonly CacheBreakReason[]
  /** 编译诊断(供 CACHE_UNSAFE_MACRO → MACRO_VOLATILE 映射) */
  diagnostics: readonly Diagnostic[]
}

/** 断点位置(§5 映射表:header+stableWB+freshWB 末尾 / summary+history 末尾 / injection 末尾) */
const CHECKPOINT_ZONES: readonly (readonly PromptZoneName[])[] = [
  ['header', 'stableWB', 'freshWB'],
  ['summary', 'history'],
  ['injection'],
]

export function buildCachePlan(input: BuildCachePlanInput): DeepReadonly<CachePlan> {
  const { ir, invalidations, diagnostics } = input
  const segments = ir.segments.filter((s) => s.enabled)

  // —— stablePrefix:从头连续稳定段 ——
  const stablePrefixSegments: string[] = []
  for (const s of segments) {
    if (STABLE_ZONES.includes(s.cachePlacement.zone) && PREFIX_STABLE.includes(s.stability)) {
      stablePrefixSegments.push(s.id)
    } else {
      break // 连续前缀契约:首个非稳定段即截断
    }
  }
  const stablePrefixTokens = segments
    .filter((s) => stablePrefixSegments.includes(s.id))
    .reduce((sum, s) => sum + s.tokenCount, 0)

  const freshSegments = segments.filter((s) => s.cachePlacement.zone === 'freshWB').map((s) => s.id)
  const freshTokens = segments.filter((s) => s.cachePlacement.zone === 'freshWB').reduce((sum, s) => sum + s.tokenCount, 0)

  const volatileSegments = segments.filter((s) => !stablePrefixSegments.includes(s.id) && !freshSegments.includes(s.id)).map((s) => s.id)
  const volatileTokens = segments
    .filter((s) => volatileSegments.includes(s.id))
    .reduce((sum, s) => sum + s.tokenCount, 0)

  // —— checkpoints:automatic 断点(§55)——
  const checkpoints: CacheCheckpoint[] = []
  const zoneLastId = new Map<PromptZoneName, string>()
  const zoneTokens = new Map<PromptZoneName, number>()
  for (const s of segments) {
    const zone = s.cachePlacement.zone
    zoneLastId.set(zone, s.id)
    zoneTokens.set(zone, (zoneTokens.get(zone) ?? 0) + s.tokenCount)
  }
  let checkpointIndex = 0
  for (const zoneGroup of CHECKPOINT_ZONES) {
    const lastId = [...zoneGroup].reverse().map((z) => zoneLastId.get(z)).find((id) => id !== undefined)
    if (lastId === undefined) continue
    const tokenCount = zoneGroup.reduce((sum, z) => sum + (zoneTokens.get(z) ?? 0), 0)
    checkpoints.push({
      id: `cp-${checkpointIndex + 1}`,
      afterSegmentId: lastId,
      prefixHash: buildPrefixHash(ir, lastId),
      tokenCount,
      reason: 'automatic',
    })
    checkpointIndex += 1
  }

  // —— breakReasons:注入失效 + 本编译推断,去重 ——
  const breakReasons: CacheBreakReason[] = [...invalidations]
  const seen = new Set<string>(breakReasons.map((r) => `${r.type}:${'entryId' in r ? r.entryId : ''}`))
  for (const d of diagnostics) {
    if (d.code === 'CACHE_UNSAFE_MACRO' && d.segmentId !== undefined) {
      const macro = Array.isArray(d.details?.macros) ? String(d.details.macros[0]) : 'unknown'
      const key = `MACRO_VOLATILE:${d.segmentId}`
      if (!seen.has(key)) {
        breakReasons.push({ type: 'MACRO_VOLATILE', segmentId: d.segmentId, macro })
        seen.add(key)
      }
    }
  }
  for (const s of segments) {
    if (s.cachePlacement.zone !== 'freshWB') continue
    if (s.source.type !== 'worldbook') continue
    const key = `WORLD_BOOK_NEW_ENTRY:${s.source.entryId}`
    if (!seen.has(key)) {
      breakReasons.push({ type: 'WORLD_BOOK_NEW_ENTRY', entryId: s.source.entryId, tokenDelta: s.tokenCount })
      seen.add(key)
    }
  }

  // —— invalidationRisk 启发式(§59 待完善)——
  // 只看 stability='volatile' 的段占比(volatileSegments 是 catch-all 含 history/injection,
  // 不能直接代表"每轮易变";§15 volatile 才是逐轮漂移的)
  const hasVolatileBreak = breakReasons.some((r) => r.type === 'MACRO_VOLATILE')
  const trulyVolatile = segments.filter((s) => s.stability === 'volatile').length
  const volatileRatio = segments.length > 0 ? trulyVolatile / segments.length : 0
  const invalidationRisk = hasVolatileBreak || volatileRatio > 0.2 ? 'high' : breakReasons.length > 0 ? 'medium' : 'low'

  return deepFreeze({
    version: 1,
    stablePrefixSegments,
    stablePrefixTokens,
    freshSegments,
    freshTokens,
    volatileSegments,
    volatileTokens,
    checkpoints,
    invalidationRisk,
    breakReasons,
  })
}
