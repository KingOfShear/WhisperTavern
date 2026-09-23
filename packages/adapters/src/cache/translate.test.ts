import { describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderStrategy } from '@whispertavern/contracts'
import { translateCachePlan } from './translate'

function strategy(overrides: Partial<ProviderStrategy> = {}): ProviderStrategy {
  return {
    version: 1,
    breakpoints: [
      { afterSegmentId: 'h', afterPartIndex: 0, reason: 'automatic' },
      { afterSegmentId: 'wb', afterPartIndex: 2, reason: 'automatic' },
      { afterSegmentId: 'inj', afterPartIndex: 5, reason: 'automatic' },
    ],
    stableZoneTokens: 4096,
    ...overrides,
  }
}

function caps(cacheType: ProviderCapabilities['cacheType']): ProviderCapabilities {
  return {
    systemRole: true,
    tools: false,
    vision: false,
    reasoning: false,
    streaming: true,
    promptCaching: true,
    cacheType,
    maxContextTokens: 200000,
    maxOutputTokens: 4096,
    structuredOutput: 'none',
    parallelToolCalls: false,
    toolChoice: false,
  }
}

describe('S19 translateCachePlan(§16 翻译分派)', () => {
  it('explicit-breakpoint → 三断点列表(afterPartIndex 透传)', () => {
    const markers = translateCachePlan(strategy(), caps('explicit-breakpoint'))
    expect(markers?.breakpoints.map((b) => b.afterPartIndex)).toEqual([0, 2, 5])
  })

  it('automatic-prefix / context-cache / none → undefined(无 wire 标记)', () => {
    for (const t of ['automatic-prefix', 'context-cache', 'none'] as const) {
      expect(translateCachePlan(strategy(), caps(t))).toBeUndefined()
    }
  })

  it('prefixTooSmall → 整体抑制(缓存不激活,§5)', () => {
    const markers = translateCachePlan(
      strategy({ prefixTooSmall: { threshold: 1024, actualTokens: 100, zone: 'header+stableWB' } }),
      caps('explicit-breakpoint'),
    )
    expect(markers).toBeUndefined()
  })

  it('markers undefined → undefined(无 cachePlan 请求逐字节不变)', () => {
    expect(translateCachePlan(undefined, caps('explicit-breakpoint'))).toBeUndefined()
  })
})
