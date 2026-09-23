import type { ProviderCapabilities, ProviderStrategy } from '@whispertavern/contracts'

/**
 * CachePlan 翻译(provider-adapter-spec §16:断点选择归 CachePlanner,adapter 只翻译)。
 *
 * 翻译产物 = explicit-breakpoint 家族的 wire 标记定位;其余家族(automatic-prefix /
 * context-cache / none)一律 undefined = 无动作——前缀字节稳定由 Compiler 契约保证,
 * req.messages 原样发送即履行 §16 义务。
 *
 * §5 最小前缀阈值:header+stableWB 低于阈值时缓存不激活,整体抑制(prefixTooSmall
 * 数据仍留在快照供 S20 遥测消费)。
 *
 * PV1 边界:本函数只产生"挂标记的位置",不触碰 prompt 文本字节。
 */

export interface ProviderCacheMarkers {
  /** 需挂 cache_control 的 wire 位置(0-based part index;adapter 再按自家 wire 形状换算) */
  breakpoints: { afterPartIndex: number }[]
}

export function translateCachePlan(
  markers: ProviderStrategy | undefined,
  capabilities: ProviderCapabilities,
): ProviderCacheMarkers | undefined {
  if (markers === undefined || capabilities.cacheType !== 'explicit-breakpoint') return undefined
  // §5 前缀过小 → 缓存不激活,整体抑制
  if (markers.prefixTooSmall !== undefined) return undefined
  return { breakpoints: markers.breakpoints.map((b) => ({ afterPartIndex: b.afterPartIndex })) }
}
