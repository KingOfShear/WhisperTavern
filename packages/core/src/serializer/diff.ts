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
 * - **只比"实际发送"的段**(`enabled` 为真的段)——§91 Disabled Segment 不参与
 *   Serialization(serializer/snapshot.ts 与 hash.ts 均跳过),故被预算裁掉的段
 *   在字节流里等同于不存在:既是前缀分歧点(removed),也**绝不能计入 cached**。
 *   (此处曾漏过滤 enabled,导致裁剪段被判 same 且 token 记入命中——S20 修)
 * - 序:先 A 侧发送序(removed/changed/same 在原位),再 B 侧新增段(发送序);
 *   firstDivergence = 该序下第一个非 same 段(removed 也破坏字节前缀,算分歧),
 *   并给出该段 content 内**首个分歧字节的 UTF-8 偏移**(S20/WP2.5 二分工具定位锚点);
 * - tokenDelta.input = B 总 token − A 总 token;cached = 两轮逐段一致 token;
 *   fresh = B 中不能沿用上轮缓存的部分(added + changed.after);
 * - cacheBreak 是 P0 **启发式标签**(§58 精确归因属 Cache Planner P2):按首分歧
 *   段来源族归类最可能原因,Inspector 展示为"疑似"。
 *
 * 纯函数:输入只读快照,输出新对象;零时钟零随机(diff 不含元数据)。
 */

export interface SnapshotDiffResult {
  segments: SegmentDiff[]
  /** byteOffset = 该段 content 内首个分歧字节的 UTF-8 偏移(added/removed 记 0);S20 二分工具消费 */
  firstDivergence?: { segmentId: string; byteOffset: number }
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

/**
 * 首个分歧字节的 UTF-8 偏移(S20/WP2.5;ui-design §4.5 第二层定位锚点)。
 * 按**字节**而非字符定位:多字节字符(中文/emoji)下字符偏移会低估真实断裂位置,
 * 而缓存前缀是字节前缀(provider 按 token/字节切分),故必须按 UTF-8 字节比。
 * 一方为另一方前缀时返回较短者长度(= 插入点)。
 */
function firstDivergingByteOffset(a: string, b: string): number {
  const encoder = new TextEncoder()
  const bytesA = encoder.encode(a)
  const bytesB = encoder.encode(b)
  const limit = Math.min(bytesA.length, bytesB.length)
  for (let i = 0; i < limit; i += 1) {
    if (bytesA[i] !== bytesB[i]) return i
  }
  return limit
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
  // 只比实际发送的段(§91 Disabled Segment 不参与 Serialization):被裁段 = 未发送 = 既非 same 也不可计入 cached
  const sentA = a.ir.segments.filter((s) => s.enabled)
  const sentB = b.ir.segments.filter((s) => s.enabled)
  const bById = new Map(sentB.map((s) => [s.id, s]))

  const segments: SegmentDiff[] = []
  for (const segA of sentA) {
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
  const seen = new Set(sentA.map((s) => s.id))
  for (const segB of sentB) {
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
  const totalA = sentA.reduce((sum, s) => sum + s.tokenCount, 0)
  const totalB = sentB.reduce((sum, s) => sum + s.tokenCount, 0)

  // removed 段没有 after:归因要落到"消失的那个段"的 before 投影上,否则裁剪/A 侧删除永远归不出原因
  const breakSegment =
    firstChanged === undefined
      ? undefined
      : bById.get(firstChanged.segmentId) ?? sentA.find((s) => s.id === firstChanged.segmentId)
  // 首个分歧字节(S20):changed 取两段 content 的公共前缀字节数;added/removed 整段缺失记 0
  const aById = new Map(sentA.map((s) => [s.id, s]))
  let byteOffset = 0
  if (firstChanged !== undefined) {
    const segA = aById.get(firstChanged.segmentId)
    const segB = bById.get(firstChanged.segmentId)
    if (segA !== undefined && segB !== undefined) {
      byteOffset = firstDivergingByteOffset(segA.content, segB.content)
    }
  }
  return {
    segments,
    firstDivergence:
      firstChanged === undefined ? undefined : { segmentId: firstChanged.segmentId, byteOffset },
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
