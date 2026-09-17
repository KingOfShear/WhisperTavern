import type { PromptSegment, PromptSnapshot, SegmentDiff, SegmentProjection } from '@whispertavern/contracts'
import { concatBytes, frameField, sha256Hex } from './hash'
import type { DeepReadonly } from '../ir/segment'

/**
 * Snapshot Diff —— api-spec §38 Prompt Diff 的构建器(S14/WP1.5,p1-plan §8 任务 1)。
 *
 * 口径:
 * - 对齐键 = **段 ID**(compiler-spec §9 稳定语义 ID 是 diff 可对齐的前提);
 * - 内容一致性 = 段框架哈希((id,role,content) netstring,§57 口径)——role 变化
 *   同样算 changed,因为它改变序列化字节;
 * - 序:先 A 侧发送序(removed/changed/same 在原位),再 B 侧新增段(发送序);
 *   firstDivergence = 该序下第一个非 same 段(removed 也破坏字节前缀,算分歧);
 * - tokenDelta.input = B 总 token − A 总 token;cached = 两轮逐段一致 token;
 *   fresh = B 中不能沿用上轮缓存的部分(added + changed.after);
 * - cacheBreak 是 P0 **启发式标签**(§58 精确归因属 Cache Planner P2):按首分歧
 *   段来源族归类最可能原因,Inspector 展示为"疑似"。
 *
 * 纯函数:输入只读快照,输出新对象;零时钟零随机(diff 不含元数据)。
 */

export interface SnapshotDiffResult {
  segments: SegmentDiff[]
  firstDivergence?: { segmentId: string }
  tokenDelta: { input: number; cached: number; fresh: number }
  cacheBreak?: PromptDiffCacheBreak
}

/** cacheBreak 形状 = contracts CacheBreakReason(§58 判别联合的宽松投影) */
type PromptDiffCacheBreak = { type: string } & Record<string, unknown>

/** 段框架哈希:netstring(id)+netstring(role)+netstring(content) 的 SHA-256(§57) */
function frameHash(segment: DeepReadonly<PromptSegment>): string {
  return sha256Hex(
    concatBytes([frameField(segment.id), frameField(segment.role), frameField(segment.content)]),
  )
}

/** 段投影(Inspector 展示与 diff 共用;八区哈希口径下的单段视图) */
export function projectSegment(segment: DeepReadonly<PromptSegment>): SegmentProjection {
  return {
    id: segment.id,
    source: segment.source,
    role: segment.role,
    zone: segment.cachePlacement.zone,
    stability: segment.stability,
    tokenCount: segment.tokenCount,
    contentHash: frameHash(segment),
  } as SegmentProjection
}

export function diffSnapshots(a: DeepReadonly<PromptSnapshot>, b: DeepReadonly<PromptSnapshot>): SnapshotDiffResult {
  const bById = new Map(b.ir.segments.map((s) => [s.id, s]))

  const segments: SegmentDiff[] = []
  for (const segA of a.ir.segments) {
    const segB = bById.get(segA.id)
    if (segB === undefined) {
      segments.push({ kind: 'removed', segmentId: segA.id, before: projectSegment(segA) })
      continue
    }
    const before = projectSegment(segA)
    const after = projectSegment(segB)
    segments.push(
      before.contentHash === after.contentHash
        ? { kind: 'same', segmentId: segA.id, before, after }
        : { kind: 'changed', segmentId: segA.id, before, after },
    )
  }
  const seen = new Set(a.ir.segments.map((s) => s.id))
  for (const segB of b.ir.segments) {
    if (!seen.has(segB.id)) {
      segments.push({ kind: 'added', segmentId: segB.id, after: projectSegment(segB) })
    }
  }

  const firstChanged = segments.find((d) => d.kind !== 'same')
  let cached = 0
  let added = 0
  let changedAfter = 0
  for (const d of segments) {
    if (d.kind === 'same') cached += d.after?.tokenCount ?? 0
    else if (d.kind === 'added') added += d.after?.tokenCount ?? 0
    else if (d.kind === 'changed') changedAfter += d.after?.tokenCount ?? 0
  }
  const totalA = a.ir.segments.reduce((sum, s) => sum + s.tokenCount, 0)
  const totalB = b.ir.segments.reduce((sum, s) => sum + s.tokenCount, 0)

  const breakSegment =
    firstChanged?.after !== undefined ? bById.get(firstChanged.after.id) : undefined
  return {
    segments,
    firstDivergence: firstChanged === undefined ? undefined : { segmentId: firstChanged.segmentId },
    tokenDelta: { input: totalB - totalA, cached, fresh: added + changedAfter },
    cacheBreak: classifyBreak(breakSegment, firstChanged?.kind),
  }
}

/** cacheBreak 启发式(模块头"不假装精确"):按首分歧段来源族归类 */
function classifyBreak(
  segment: DeepReadonly<PromptSegment> | undefined,
  kind: SegmentDiff['kind'] | undefined,
): PromptDiffCacheBreak | undefined {
  if (segment === undefined || kind === undefined) return undefined
  if (segment.source.type === 'message') {
    return { type: 'MESSAGE_EDITED', messageId: segment.source.messageId }
  }
  if (segment.source.type === 'worldbook') {
    return { type: 'WORLD_BOOK_CONTENT_CHANGED', entryId: segment.source.entryId }
  }
  if (segment.source.type === 'preset') {
    return { type: 'PRESET_CHANGED', presetId: segment.source.presetId }
  }
  if (segment.source.type === 'persona') {
    return { type: 'PERSONA_CHANGED', personaId: segment.source.assetId }
  }
  if (segment.source.type === 'character') {
    return { type: 'CHARACTER_CHANGED', characterId: segment.source.assetId }
  }
  return { type: 'MANUAL_INVALIDATION', reason: `P0 启发式:${kind} @ ${segment.cachePlacement.zone}` }
}
