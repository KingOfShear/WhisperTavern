import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { PromptIR, PromptSegment, PromptZoneName } from '@desiregrimoire/contracts'
import type { DeepReadonly } from '../ir/segment'

/**
 * 规范字节序列化与八区哈希 —— compiler-spec §56–§57、§62、§67(p0-plan S3 任务 2)。
 *
 * 关键口径:
 * - 哈希是**验证手段,不是稳定性的来源**(§57):真正保证稳定的是数据模型 +
 *   排序规则 + 宏策略;本文件只负责"同输入 → 逐字节同哈希"。
 * - 框架化字段 = (segmentId, role, content) + 区内 IR 数组序,netstring 长度前缀
 *   防分隔符碰撞。语义位(semanticPlacement)的变化若影响物理序,必须反映为
 *   IR 数组序变化——那是 Compiler 管线(S4,§93/§94)的职责。
 * - 指令元数据**永不进入字节**(instruction-security §17.1 / §5.5 不变量 3),
 *   因此不参与八区哈希;元数据审计走 authorityFingerprint(§19.1)。
 */

/** §18 默认区序(Cache Serialization 默认策略,非酒馆语义槽位) */
export const ZONE_ORDER: readonly PromptZoneName[] = [
  'header',
  'stableWB',
  'freshWB',
  'summary',
  'history',
  'injection',
  'tail',
]

const encoder = new TextEncoder()

/** netstring 框架化:`<字节数>:<utf8 字节>,` */
export function frameField(value: string): Uint8Array {
  const bytes = encoder.encode(value)
  const prefix = encoder.encode(`${bytes.length}:`)
  const out = new Uint8Array(prefix.length + bytes.length + 1)
  out.set(prefix, 0)
  out.set(bytes, prefix.length)
  out[prefix.length + bytes.length] = 0x2c // ','
  return out
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

/** 单段规范框架:netstring(id) + netstring(role) + netstring(content) */
function frameSegment(segment: DeepReadonly<PromptSegment>): Uint8Array {
  return concatBytes([
    frameField(segment.id),
    frameField(segment.role),
    frameField(segment.content),
  ])
}

/** 按 cachePlacement.zone 分桶,区内保持 IR 数组序(排序语义归 Compiler,§93/§94) */
function segmentsByZone(ir: DeepReadonly<PromptIR>): Map<PromptZoneName, readonly DeepReadonly<PromptSegment>[]> {
  const buckets = new Map<PromptZoneName, DeepReadonly<PromptSegment>[]>()
  for (const segment of ir.segments) {
    const zone = segment.cachePlacement.zone
    const bucket = buckets.get(zone)
    if (bucket) {
      bucket.push(segment)
    } else {
      buckets.set(zone, [segment])
    }
  }
  return buckets
}

/** 八区字节流(§18 区序);空区 = 空字节 */
export function buildZoneStreams(ir: DeepReadonly<PromptIR>): ReadonlyMap<PromptZoneName, Uint8Array> {
  const buckets = segmentsByZone(ir)
  const streams = new Map<PromptZoneName, Uint8Array>()
  for (const zone of ZONE_ORDER) {
    const segments = buckets.get(zone) ?? []
    streams.set(zone, concatBytes([...segments].map(frameSegment)))
  }
  return streams
}

/** 八区哈希(§67):各区分 SHA-256,final = 按 §18 区序拼接后总哈希 */
export function buildZoneHashes(ir: DeepReadonly<PromptIR>): {
  hashes: Record<PromptZoneName, string> & { final: string }
} {
  const streams = buildZoneStreams(ir)
  const hashes = {} as Record<PromptZoneName, string> & { final: string }
  const orderedStreams: Uint8Array[] = []
  for (const zone of ZONE_ORDER) {
    const stream = streams.get(zone)
    if (!stream) throw new Error(`zone stream missing: ${zone}`)
    hashes[zone] = sha256Hex(stream)
    orderedStreams.push(stream)
  }
  hashes.final = sha256Hex(concatBytes(orderedStreams))
  return { hashes }
}
