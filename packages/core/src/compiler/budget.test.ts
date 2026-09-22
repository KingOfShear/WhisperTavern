import { describe, expect, it } from 'vitest'
import type { SegmentSource } from '@whispertavern/contracts'
import { applyBudget, partitionHistory, type BudgetSegment } from './budget'

/** 测试默认禁用 percent 配额干扰(percent=100 = 世界书可用全部),专注裁剪序 */
const NO_WB_QUOTA = { percent: 100, cap: null }

function seg(overrides: Partial<BudgetSegment> = {}): BudgetSegment {
  return {
    id: 's',
    zone: 'header',
    order: 0,
    tokenCount: 1,
    source: { type: 'runtime', key: 'x' },
    ...overrides,
  }
}

function wbSource(): SegmentSource {
  return { type: 'worldbook', worldbookId: 'wb', entryId: 'e1' }
}

describe('S18 budget:裁剪序(§49 权威序)', () => {
  it('超限先裁 tail/injection(缓存零伤害),保留 header/stableWB', () => {
    const result = applyBudget({
      availableTokens: 2,
      worldbookBudget: NO_WB_QUOTA,
      segments: [
        seg({ id: 'h', zone: 'header', order: 0, tokenCount: 1 }),
        seg({ id: 'wb', zone: 'stableWB', order: 1, tokenCount: 1, source: wbSource() }),
        seg({ id: 't', zone: 'tail', order: 2, tokenCount: 1 }),
        seg({ id: 'inj', zone: 'injection', order: 3, tokenCount: 1 }),
      ],
    })
    expect(result.included).toEqual(['h', 'wb'])
    expect(result.excluded).toEqual(expect.arrayContaining(['t', 'inj']))
  })

  it('裁 freshWB 在 injection 之后(§15.1 修正:裁 freshWB 位移 history,代价中)', () => {
    const result = applyBudget({
      availableTokens: 2,
      worldbookBudget: NO_WB_QUOTA,
      segments: [
        seg({ id: 'h', zone: 'header', order: 0, tokenCount: 1 }),
        seg({ id: 'f', zone: 'freshWB', order: 1, tokenCount: 1, source: wbSource() }),
        seg({ id: 'inj', zone: 'injection', order: 2, tokenCount: 1 }),
        seg({ id: 't', zone: 'tail', order: 3, tokenCount: 1 }),
        seg({ id: 's', zone: 'summary', order: 4, tokenCount: 1 }),
      ],
    })
    // 保留 header+summary;裁 tail/injection/freshWB
    expect(result.included).toEqual(['h', 's'])
    expect(result.excluded).toEqual(expect.arrayContaining(['t', 'inj', 'f']))
  })
})

describe('S18 budget:header protect + 仍超限报错', () => {
  it('header 不可裁:裁到只剩 header 仍超限 → reasons 记 header_protected', () => {
    const result = applyBudget({
      availableTokens: 1,
      worldbookBudget: NO_WB_QUOTA,
      segments: [
        seg({ id: 'h', zone: 'header', order: 0, tokenCount: 5 }),
        seg({ id: 't', zone: 'tail', order: 1, tokenCount: 2 }),
      ],
    })
    expect(result.included).toEqual(['h'])
    expect(result.reasons.some((r) => r.type === 'header_protected')).toBe(true)
  })
})

describe('S18 budget:世界书 percent+cap 配额(§12,P1 挂账解除)', () => {
  it('percent 配额超限 → 从尾部裁世界书段(worldbook_percent_cap)', () => {
    // available=100,percent=25 → quota=25;三个世界书段各 10 → 30 > 25
    const result = applyBudget({
      availableTokens: 100,
      worldbookBudget: { percent: 25, cap: null },
      segments: [
        seg({ id: 'h', zone: 'header', order: 0, tokenCount: 1 }),
        seg({ id: 'wb1', zone: 'stableWB', order: 1, tokenCount: 10, source: wbSource() }),
        seg({ id: 'wb2', zone: 'freshWB', order: 2, tokenCount: 10, source: wbSource() }),
        seg({ id: 'wb3', zone: 'freshWB', order: 3, tokenCount: 10, source: wbSource() }),
      ],
    })
    expect(result.excluded).toContain('wb3') // 尾部先裁
    expect(result.reasons.some((r) => r.type === 'worldbook_percent_cap')).toBe(true)
  })

  it('cap 硬上限优先于 percent', () => {
    const result = applyBudget({
      availableTokens: 1000,
      worldbookBudget: { percent: 25, cap: 5 },
      segments: [
        seg({ id: 'h', zone: 'header', order: 0, tokenCount: 1 }),
        seg({ id: 'wb1', zone: 'stableWB', order: 1, tokenCount: 10, source: wbSource() }),
      ],
    })
    expect(result.excluded).toContain('wb1') // quota=min(250, 5)=5 < 10
  })
})

describe('S18 budget:Elastic History(§50)', () => {
  it('pinned=0(缺省) → 全 Pinned,不分区', () => {
    const { pinned, elastic } = partitionHistory(
      [seg({ id: 'h1', zone: 'history' }), seg({ id: 'h2', zone: 'history' })],
      0,
    )
    expect(pinned.length).toBe(2)
    expect(elastic.length).toBe(0)
  })

  it('超限 → Elastic 整体推出(不逐条删)', () => {
    const result = applyBudget({
      availableTokens: 2,
      worldbookBudget: NO_WB_QUOTA,
      elastic: { pinnedMessageCount: 1 },
      segments: [
        seg({ id: 'h', zone: 'header', order: 0, tokenCount: 1 }),
        seg({ id: 'hist1', zone: 'history', order: 1, tokenCount: 1 }), // Pinned
        seg({ id: 'hist2', zone: 'history', order: 2, tokenCount: 1 }), // Elastic
        seg({ id: 'hist3', zone: 'history', order: 3, tokenCount: 1 }), // Elastic
        seg({ id: 't', zone: 'tail', order: 4, tokenCount: 2 }), // tail 先裁
      ],
    })
    expect(result.included).toEqual(['h', 'hist1']) // header + pinned;elastic 整体推出
    expect(result.excluded).toContain('hist2')
    expect(result.excluded).toContain('hist3')
    expect(result.reasons.some((r) => r.type === 'elastic_history_excluded')).toBe(true)
  })

  it('Pinned 放得下但 elastic 超限 → 整体推出 elastic,保留 pinned', () => {
    const result = applyBudget({
      availableTokens: 3,
      worldbookBudget: NO_WB_QUOTA,
      elastic: { pinnedMessageCount: 2 },
      segments: [
        seg({ id: 'h', zone: 'header', order: 0, tokenCount: 1 }),
        seg({ id: 'hist1', zone: 'history', order: 1, tokenCount: 1 }),
        seg({ id: 'hist2', zone: 'history', order: 2, tokenCount: 1 }),
        seg({ id: 'hist3', zone: 'history', order: 3, tokenCount: 4 }),
      ],
    })
    expect(result.included).toEqual(['h', 'hist1', 'hist2'])
    expect(result.excluded).toContain('hist3')
  })
})
