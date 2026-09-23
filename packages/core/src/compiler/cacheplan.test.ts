import { describe, expect, it } from 'vitest'
import type { CacheBreakReason, Diagnostic, PromptIR, PromptSegment, PromptZoneName } from '@whispertavern/contracts'
import { createPromptIR, type DeepReadonly } from '../ir/segment'
import { buildCachePlan } from './cacheplan'

type SegmentOverride = Partial<PromptSegment> & { zone?: PromptZoneName }

function segment(overrides: SegmentOverride = {}): PromptSegment {
  const { zone, ...rest } = overrides
  return {
    id: 's',
    source: { type: 'runtime', key: 'x' },
    role: 'system',
    content: 'x',
    semanticPlacement: { type: 'header', order: 0 },
    cachePlacement: { zone: zone ?? 'header' },
    stability: 'session',
    order: 0,
    tokenCount: 1,
    dependencies: [],
    enabled: true,
    ...rest,
  }
}

function ir(segments: PromptSegment[]): DeepReadonly<PromptIR> {
  return createPromptIR({
    schemaVersion: 1,
    segments,
    zones: [...new Set(segments.map((s) => s.cachePlacement.zone))].map((name) => ({ name })),
    metadata: {},
  })
}

describe('S18 cacheplan:分区形状(§53/§54)', () => {
  it('stablePrefix = 从头连续稳定段;fresh/volatile 分列', () => {
    const plan = buildCachePlan({
      ir: ir([
        segment({ id: 'h', zone: 'header', stability: 'session' }),
        segment({ id: 'wb', zone: 'stableWB', stability: 'static', source: { type: 'worldbook', worldbookId: 'wb', entryId: 'e1' } }),
        segment({ id: 'f', zone: 'freshWB', stability: 'session' }),
        segment({ id: 'hist', zone: 'history', stability: 'message' }),
        segment({ id: 't', zone: 'tail', stability: 'volatile' }),
      ]),
      invalidations: [],
      diagnostics: [],
    })
    expect(plan.version).toBe(1)
    expect(plan.stablePrefixSegments).toEqual(['h', 'wb', 'f'])
    expect(plan.freshSegments).toEqual(['f'])
    expect(plan.volatileSegments).toEqual(['hist', 't'])
  })

  it('连续前缀契约:首个非稳定段截断(§56)', () => {
    const plan = buildCachePlan({
      ir: ir([
        segment({ id: 'h', zone: 'header', stability: 'session' }),
        segment({ id: 'v', zone: 'header', stability: 'volatile' }), // 非稳定 → 截断
        segment({ id: 'h2', zone: 'stableWB', stability: 'static' }),
      ]),
      invalidations: [],
      diagnostics: [],
    })
    expect(plan.stablePrefixSegments).toEqual(['h'])
    expect(plan.volatileSegments).toEqual(['v', 'h2'])
  })

  it('enabled=false 段不参与任何分区(§91 Disabled Segment)', () => {
    const plan = buildCachePlan({
      ir: ir([
        segment({ id: 'h', zone: 'header', stability: 'session' }),
        segment({ id: 'cut', zone: 'tail', stability: 'volatile', enabled: false }),
      ]),
      invalidations: [],
      diagnostics: [],
    })
    expect(plan.stablePrefixSegments).toEqual(['h'])
    expect(plan.volatileSegments).toEqual([])
  })
})

describe('S18 cacheplan:checkpoints(§55)', () => {
  it('三处 automatic 断点,prefixHash 逐段累积', () => {
    const plan = buildCachePlan({
      ir: ir([
        segment({ id: 'h', zone: 'header' }),
        segment({ id: 'wb', zone: 'stableWB', source: { type: 'worldbook', worldbookId: 'wb', entryId: 'e1' } }),
        segment({ id: 'f', zone: 'freshWB' }),
        segment({ id: 'sum', zone: 'summary' }),
        segment({ id: 'hist', zone: 'history', stability: 'message' }),
        segment({ id: 'inj', zone: 'injection', stability: 'request' }),
      ]),
      invalidations: [],
      diagnostics: [],
    })
    expect(plan.checkpoints).toHaveLength(3)
    expect(plan.checkpoints[0]).toMatchObject({ afterSegmentId: 'f', reason: 'automatic' })
    expect(plan.checkpoints[1]).toMatchObject({ afterSegmentId: 'hist', reason: 'automatic' })
    expect(plan.checkpoints[2]).toMatchObject({ afterSegmentId: 'inj', reason: 'automatic' })
    expect(plan.checkpoints[0]?.prefixHash).toBeTruthy()
    expect(plan.checkpoints[1]?.prefixHash).not.toBe(plan.checkpoints[0]?.prefixHash)
  })
})

describe('S19 cacheplan:providerStrategy 翻译指令(§16/§5)', () => {
  it('breakpoints 投影 afterPartIndex;stableZoneTokens 口径不含 freshWB', () => {
    const plan = buildCachePlan({
      ir: ir([
        segment({ id: 'h', zone: 'header' }),
        segment({ id: 'wb', zone: 'stableWB', source: { type: 'worldbook', worldbookId: 'wb', entryId: 'e1' } }),
        segment({ id: 'f', zone: 'freshWB' }),
        segment({ id: 'sum', zone: 'summary' }),
        segment({ id: 'hist', zone: 'history', stability: 'message' }),
      ]),
      invalidations: [],
      diagnostics: [],
    })
    expect(plan.providerStrategy).toBeDefined()
    expect(plan.providerStrategy?.version).toBe(1)
    // breakpoints 与 checkpoints 对齐:afterPartIndex = enabled 段数组下标(parts 1:1)
    expect(plan.providerStrategy?.breakpoints).toHaveLength(2) // cp-1(header+stableWB+freshWB 末尾) + cp-2(summary+history 末尾)
    expect(plan.providerStrategy?.breakpoints[0]?.afterSegmentId).toBe('f')
    expect(plan.providerStrategy?.breakpoints[0]?.afterPartIndex).toBe(2)
    expect(plan.providerStrategy?.breakpoints[1]?.afterSegmentId).toBe('hist')
    expect(plan.providerStrategy?.breakpoints[1]?.afterPartIndex).toBe(4)
    // stableZoneTokens = header+stableWB 合计(不含 freshWB)
    expect(plan.providerStrategy?.stableZoneTokens).toBe(2)
    // 未传 providerCacheType → 不产 prefixTooSmall
    expect(plan.providerStrategy?.prefixTooSmall).toBeUndefined()
  })

  it('prefixTooSmall:providerCacheType 阈值判定(§5 前缀过小)', () => {
    const small = buildCachePlan({
      ir: ir([segment({ id: 'h', zone: 'header', tokenCount: 100 })]),
      invalidations: [],
      diagnostics: [],
      providerCacheType: 'explicit-breakpoint', // 阈值 1024
    })
    expect(small.providerStrategy?.prefixTooSmall).toEqual({
      threshold: 1024,
      actualTokens: 100,
      zone: 'header+stableWB',
    })

    const big = buildCachePlan({
      ir: ir([segment({ id: 'h', zone: 'header', tokenCount: 5000 }), segment({ id: 'wb', zone: 'stableWB', tokenCount: 1000 })]),
      invalidations: [],
      diagnostics: [],
      providerCacheType: 'context-cache', // 阈值 4096
    })
    expect(big.providerStrategy?.prefixTooSmall).toBeUndefined()
  })

  it('checkpoints 为空(无任何区段)→ 不装配 providerStrategy(P0 空形状兼容)', () => {
    const plan = buildCachePlan({ ir: ir([]), invalidations: [], diagnostics: [] })
    expect(plan.providerStrategy).toBeUndefined()
  })
})

describe('S18 cacheplan:breakReasons 与 invalidationRisk(§58)', () => {
  it('注入失效 + MACRO_VOLATILE + WORLD_BOOK_NEW_ENTRY,去重', () => {
    const invalidations: CacheBreakReason[] = [
      { type: 'WORLD_BOOK_RETIREMENT', entryId: 'e9' },
      { type: 'MACRO_VOLATILE', segmentId: 's1', macro: 'time' },
    ]
    const diagnostics: Diagnostic[] = [
      { level: 'warning', code: 'CACHE_UNSAFE_MACRO', message: 'x', segmentId: 's2', details: { macros: ['random'] } },
      { level: 'warning', code: 'CACHE_UNSAFE_MACRO', message: 'x', segmentId: 's2', details: { macros: ['random'] } }, // 重复 → 去重
    ]
    const plan = buildCachePlan({
      ir: ir([
        segment({ id: 'h', zone: 'header' }),
        segment({ id: 'wb', zone: 'freshWB', source: { type: 'worldbook', worldbookId: 'wb', entryId: 'e1' } }),
      ]),
      invalidations,
      diagnostics,
    })
    expect(plan.breakReasons).toEqual(
      expect.arrayContaining([
        { type: 'WORLD_BOOK_RETIREMENT', entryId: 'e9' },
        { type: 'MACRO_VOLATILE', segmentId: 's1', macro: 'time' },
        { type: 'MACRO_VOLATILE', segmentId: 's2', macro: 'random' },
        { type: 'WORLD_BOOK_NEW_ENTRY', entryId: 'e1', tokenDelta: 1 },
      ]),
    )
    expect(plan.breakReasons.filter((r) => r.type === 'MACRO_VOLATILE' && r.segmentId === 's2')).toHaveLength(1)
  })

  it('invalidationRisk:无失效 → low;有失效 → medium;volatile 多 → high', () => {
    const low = buildCachePlan({
      ir: ir([segment({ id: 'h', zone: 'header' })]),
      invalidations: [],
      diagnostics: [],
    })
    expect(low.invalidationRisk).toBe('low')

    const med = buildCachePlan({
      ir: ir([segment({ id: 'h', zone: 'header' }), segment({ id: 't', zone: 'tail', stability: 'message' })]),
      invalidations: [{ type: 'MESSAGE_EDITED', messageId: 'm1' }],
      diagnostics: [],
    })
    expect(med.invalidationRisk).toBe('medium')

    const high = buildCachePlan({
      ir: ir([
        segment({ id: 'h', zone: 'header' }),
        segment({ id: 't1', zone: 'tail', stability: 'volatile' }),
        segment({ id: 't2', zone: 'tail', stability: 'volatile' }),
      ]),
      invalidations: [],
      diagnostics: [],
    })
    expect(high.invalidationRisk).toBe('high') // volatile 占比 2/3 > 20%
  })
})
