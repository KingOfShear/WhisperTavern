import { describe, expect, it } from 'vitest'
import { BUDGET_TRIM_ORDER, computeContentHash, zoneWorldbook, type CacheRowView, type ZoningCandidate } from './worldbook-cache'

/** 构造候选(宏安全已预检;contentHash 由调用方预计算) */
function candidate(overrides: Partial<ZoningCandidate> = {}): ZoningCandidate {
  return {
    entryId: 'e1',
    contentHash: 'h1',
    activated: true,
    sequence: 1,
    priority: 100,
    ...overrides,
  }
}

function cacheRow(overrides: Partial<CacheRowView> = {}): CacheRowView {
  return {
    entryId: 'e1',
    contentHash: null,
    cacheState: 'unseen',
    physicalOrder: null,
    lastActivationSeq: null,
    firstSeenMsg: null,
    ...overrides,
  }
}

const cacheMap = (rows: CacheRowView[]): ReadonlyMap<string, CacheRowView> =>
  new Map(rows.map((r) => [r.entryId, r]))

/** 合并增量写回:nextCache 只是变化行,须与上轮行合并(§2.1 更新 5 ∪ 语义) */
function mergeCache(prev: ReadonlyMap<string, CacheRowView>, delta: readonly CacheRowView[]): ReadonlyMap<string, CacheRowView> {
  const merged = new Map(prev)
  for (const row of delta) merged.set(row.entryId, row)
  return merged
}

describe('S17 worldbook-cache:分区核心(§2.1 修订公式)', () => {
  it('首次注入:未命中∧激活 → freshWB + physicalOrder 从 1 分配 + 行写回 fresh', () => {
    const zoning = zoneWorldbook({
      candidates: [
        candidate({ entryId: 'a', contentHash: 'ha' }),
        candidate({ entryId: 'b', contentHash: 'hb' }),
      ],
      cache: cacheMap([]),
    })
    expect(zoning.freshWB.map((i) => [i.entryId, i.physicalOrder])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect(zoning.stableWB).toEqual([])
    expect(zoning.nextCache).toMatchObject([
      { entryId: 'a', contentHash: 'ha', cacheState: 'fresh', physicalOrder: 1 },
      { entryId: 'b', contentHash: 'hb', cacheState: 'fresh', physicalOrder: 2 },
    ])
  })

  it('命中 ∧ 既有 fresh → stableWB 成员 + graduated + 行迁移 stable(§22 毕业只改状态)', () => {
    const zoning = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha' })],
      cache: cacheMap([
        cacheRow({ entryId: 'a', contentHash: 'ha', cacheState: 'fresh', physicalOrder: 1, firstSeenMsg: 1, lastActivationSeq: 1 }),
      ]),
    })
    expect(zoning.stableWB).toMatchObject([{ entryId: 'a', physicalOrder: 1, zone: 'stableWB', graduated: true }])
    expect(zoning.nextCache).toMatchObject([{ entryId: 'a', cacheState: 'stable', physicalOrder: 1 }])
    expect(zoning.freshWB).toEqual([])
  })

  it('命中 ∧ 既有 stable → 保持(不重复毕业)', () => {
    const zoning = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha' })],
      cache: cacheMap([
        cacheRow({ entryId: 'a', contentHash: 'ha', cacheState: 'stable', physicalOrder: 1, firstSeenMsg: 1, lastActivationSeq: 1 }),
      ]),
    })
    expect(zoning.stableWB).toMatchObject([{ entryId: 'a', graduated: false }])
    expect(zoning.nextCache).toEqual([]) // 状态无迁移 → 无写回
  })

  it('未激活但命中 → stableWB 照发(§30 Performance:stable but inactive 照常发送)', () => {
    const zoning = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha', activated: false })],
      cache: cacheMap([
        cacheRow({ entryId: 'a', contentHash: 'ha', cacheState: 'stable', physicalOrder: 1, firstSeenMsg: 1, lastActivationSeq: 1 }),
      ]),
    })
    expect(zoning.stableWB).toMatchObject([{ entryId: 'a', physicalOrder: 1 }])
  })

  it('编辑条目:新哈希未命中 → freshWB 重注入 + 新 physicalOrder(§11.4 新化身)', () => {
    const zoning = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'h-new' })],
      cache: cacheMap([
        cacheRow({ entryId: 'a', contentHash: 'h-old', cacheState: 'stable', physicalOrder: 1, firstSeenMsg: 1, lastActivationSeq: 1 }),
      ]),
    })
    expect(zoning.freshWB).toMatchObject([{ entryId: 'a', physicalOrder: 2 }])
    expect(zoning.stableWB).toEqual([]) // 旧化身不再发送(新文本取代)
  })

  it('retired 行不参与命中判定(¬retired 条件)', () => {
    const zoning = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha' })],
      cache: cacheMap([
        cacheRow({ entryId: 'a', contentHash: 'ha', cacheState: 'retired', physicalOrder: 1, lastActivationSeq: 1 }),
      ]),
    })
    expect(zoning.freshWB).toMatchObject([{ entryId: 'a', physicalOrder: 2 }])
    expect(zoning.stableWB).toEqual([])
  })
})

describe('S17 worldbook-cache:physicalOrder append-only(§3.1)', () => {
  it('§2.3 轮1–4 演化:physicalOrder 首次分配后永不改变', () => {
    // 轮1: A B C fresh(order 1,2,3)
    const r1 = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha' }), candidate({ entryId: 'b', contentHash: 'hb' }), candidate({ entryId: 'c', contentHash: 'hc' })],
      cache: cacheMap([]),
    })
    const after1 = cacheMap(r1.nextCache as CacheRowView[])

    // 轮2: A B C 命中 → stable(字节原位)
    const r2 = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha' }), candidate({ entryId: 'b', contentHash: 'hb' }), candidate({ entryId: 'c', contentHash: 'hc' })],
      cache: after1,
    })
    expect(r2.stableWB.map((i) => [i.entryId, i.physicalOrder])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    const after2 = mergeCache(after1, r2.nextCache)

    // 轮3: D 新触发 → fresh(order 4,追加在尾部)
    const r3 = zoneWorldbook({
      candidates: [candidate({ entryId: 'd', contentHash: 'hd' }), candidate({ entryId: 'a', contentHash: 'ha' })],
      cache: after2,
    })
    expect(r3.freshWB.map((i) => [i.entryId, i.physicalOrder])).toEqual([['d', 4]])
    expect(r3.stableWB.map((i) => [i.entryId, i.physicalOrder])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    const after3 = mergeCache(after2, r3.nextCache)

    // 轮4: D 命中 → 毕业 stable,字节原位(仍 order 4);a/b/c 继续照发(既有成员)
    const r4 = zoneWorldbook({
      candidates: [candidate({ entryId: 'd', contentHash: 'hd' })],
      cache: after3,
    })
    expect(r4.stableWB).toEqual(
      expect.arrayContaining([expect.objectContaining({ entryId: 'd', physicalOrder: 4, graduated: true })]),
    )
    expect(r4.stableWB.map((i) => i.entryId).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('fresh 且未激活 → 哈希命中即毕业发送(轮2 关键词消失仍发送)', () => {
    const r1 = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha' })],
      cache: cacheMap([]),
    })
    // 轮2: a 未激活(activated=false)但 contentHash 一致 → 命中 → stableWB 照发
    const r2 = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha', activated: false })],
      cache: cacheMap(r1.nextCache as CacheRowView[]),
    })
    expect(r2.stableWB).toMatchObject([{ entryId: 'a', physicalOrder: 1, graduated: true }])
  })
})

describe('S17 worldbook-cache:退休(§7/§31)', () => {
  it('连续 inactiveRounds 超阈值且低优先级 → retired + 诊断 WORLD_BOOK_RETIRED', () => {
    const row = cacheRow({
      entryId: 'a',
      contentHash: 'ha',
      cacheState: 'stable',
      physicalOrder: 1,
      lastActivationSeq: 1,
      firstSeenMsg: 1,
    })
    const zoning = zoneWorldbook({
      // 轮5 激活但低优先级;inactiveRounds = 5 - 1 = 4 > 2 → 退休
      candidates: [candidate({ entryId: 'a', contentHash: 'ha', sequence: 5, priority: 10 })],
      cache: cacheMap([row]),
      retirement: { enabled: true, inactiveRoundsThreshold: 2, priorityThreshold: 50 },
    })
    expect(zoning.retired).toEqual(['a'])
    expect(zoning.nextCache).toMatchObject([{ entryId: 'a', cacheState: 'retired' }])
    expect(zoning.diagnostics).toMatchObject([{ code: 'WORLD_BOOK_RETIRED', level: 'info' }])
  })

  it('缺省关闭:即使超阈值也不退休', () => {
    const zoning = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha', sequence: 5, priority: 10 })],
      cache: cacheMap([
        cacheRow({ entryId: 'a', contentHash: 'ha', cacheState: 'stable', physicalOrder: 1, lastActivationSeq: 1 }),
      ]),
    })
    expect(zoning.retired).toEqual([])
  })

  it('优先级不低于阈值 → 不退休', () => {
    const zoning = zoneWorldbook({
      candidates: [candidate({ entryId: 'a', contentHash: 'ha', sequence: 5, priority: 60 })],
      cache: cacheMap([
        cacheRow({ entryId: 'a', contentHash: 'ha', cacheState: 'stable', physicalOrder: 1, lastActivationSeq: 1 }),
      ]),
      retirement: { enabled: true, inactiveRoundsThreshold: 2, priorityThreshold: 50 },
    })
    expect(zoning.retired).toEqual([])
  })
})

describe('S17 worldbook-cache:哈希与裁剪序', () => {
  it('§3.2 哈希 normalize 恒等:空白差异产生不同指纹', () => {
    expect(computeContentHash('a b')).not.toBe(computeContentHash('a  b'))
    expect(computeContentHash('hello')).toBe(computeContentHash('hello'))
  })

  it('§3.5 裁剪序:freshWB → tail → injection → stableWB(最后手段)', () => {
    expect([...BUDGET_TRIM_ORDER]).toEqual(['freshWB', 'tail', 'injection', 'stableWB'])
  })
})
