import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeE2eHarness, type E2eHarness } from './harness'

/** S9(WP1.1a)导入路由契约测试:三载体 → .dgcard 落盘 + 注册 + v1 快照 + 报告 + R-P1-3 档位 */
describe('POST /api/v2/characters/import(S9)', () => {
  let harness: E2eHarness
  let app: E2eHarness['open'] extends (...args: never[]) => infer R ? R extends { app: infer A } ? A : never : never

  const fresh = (): void => {
    harness = makeE2eHarness()
    ;({ app } = harness.open())
  }

  it('V3 JSON 导入:注册 + v1 快照 + 报告档位断言(R-P1-3/I1)', async () => {
    fresh()
    const card = { spec: 'chara_card_v3', name: 'S9卡', data: { name: 'S9卡', description: '导入测试角色', first_mes: '你好。' } }
    const res = await app.request('/api/v2/characters/import', {
      method: 'POST',
      body: JSON.stringify({ filename: 's9.json', base64: Buffer.from(JSON.stringify(card), 'utf8').toString('base64') }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      data: {
        character: { id: string; name: string; version: number }
        report: { asset: { sourceFormat: string } }
      }
    }
    expect(body.data.character.name).toBe('S9卡')
    expect(body.data.character.version).toBe(1)
    expect(body.data.report.asset.sourceFormat).toBe('st-v3')
    const list = (await (await app.request('/api/v2/characters')).json()) as { data: { name: string }[] }
    expect(list.data.some((c) => c.name === 'S9卡')).toBe(true)
  })

  it('PNG 载体导入(tEXt chara)→ st-v2 报告', async () => {
    fresh()
    const v2 = { spec: 'chara_card_v2', name: 'Png卡', data: { name: 'Png卡', description: 'PNG 导入' } }
    const png = buildMinimalPng([{ keyword: 'chara', text: Buffer.from(JSON.stringify(v2), 'utf8').toString('base64') }])
    const res = await app.request('/api/v2/characters/import', {
      method: 'POST',
      body: JSON.stringify({ filename: 'card.png', base64: Buffer.from(png).toString('base64') }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { report: { asset: { sourceFormat: string } } } }
    expect(body.data.report.asset.sourceFormat).toBe('png-v2')
  })

  it('charx 导入:内嵌书抽取为独立 worldbooks 注册(双向引用)', async () => {
    fresh()
    const { zipSync, strToU8 } = await import('fflate')
    const card = {
      spec: 'chara_card_v3',
      name: 'Charx卡',
      data: {
        name: 'Charx卡',
        description: 'charx 导入',
        character_book: { name: '内嵌书', entries: [{ keys: ['书店'], content: '设定' }] },
      },
    }
    const charx = zipSync({ 'card.json': strToU8(JSON.stringify(card)) })
    const res = await app.request('/api/v2/characters/import', {
      method: 'POST',
      body: JSON.stringify({ filename: 'card.charx', base64: Buffer.from(charx).toString('base64') }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { worldbookId: string | null; character: { id: string } } }
    expect(body.data.worldbookId).not.toBeNull()
    const wbRow = harness.open().store.sqlite
      .prepare('SELECT source_data FROM worldbooks WHERE id = ?')
      .get(body.data.worldbookId ?? '') as { source_data: string } | undefined
    expect(wbRow).toBeDefined()
    // 双向引用:内嵌书行回指角色(S10 起走完整归一,不再是 passthrough 原始 JSON)
    expect(JSON.parse(wbRow?.source_data ?? '{}')).toMatchObject({ characterRef: body.data.character.id })
    const entryCount = harness.open().store.sqlite
      .prepare('SELECT COUNT(*) AS n FROM worldbook_entries WHERE worldbook_id = ?')
      .get(body.data.worldbookId ?? '') as { n: number }
    expect(entryCount.n).toBe(1)
  })

  it('非法卡体:VALIDATION_ERROR(不当静默成功,R5 同源纪律)', async () => {
    fresh()
    const res = await app.request('/api/v2/characters/import', {
      method: 'POST',
      body: JSON.stringify({ filename: 'x.png', base64: Buffer.from([1, 2, 3]).toString('base64') }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('charx Zip-Slip:资产 uri 越界(../)→ 400 且不落盘到卡目录之外', async () => {
    fresh()
    const { zipSync, strToU8 } = await import('fflate')
    const escapeTarget = join(harness.root, 'slipped.txt')
    const card = {
      spec: 'chara_card_v3',
      name: 'Slip卡',
      data: {
        name: 'Slip卡',
        description: 'zip-slip',
        assets: [{ type: 'background', uri: '../slipped.txt', name: '越界' }],
      },
    }
    const charx = zipSync({
      'card.json': strToU8(JSON.stringify(card)),
      '../slipped.txt': strToU8('pwned'),
    })
    const res = await app.request('/api/v2/characters/import', {
      method: 'POST',
      body: JSON.stringify({ filename: 'slip.charx', base64: Buffer.from(charx).toString('base64') }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(existsSync(escapeTarget)).toBe(false)
  })

  it('harness 资产目录就位', () => {
    fresh()
    expect(harness.assetsDir).toBeDefined()
  })
})

// —— S10:两代世界书样书 ——
const OLD_LOREBOOK = {
  '0': {
    uid: 0, key: ['酒馆'], keysecondary: [], comment: '酒馆', content: '镇上唯一的酒馆。',
    constant: false, selective: true, insertion_order: 10, position: 0, disable: false,
  },
  '1': {
    uid: 1, key: ['黑森林'], keysecondary: ['树林'], comment: '黑森林', content: '没有人能原路出来。',
    constant: true, selective: false, insertion_order: 20, position: 4, disable: true, addMemo: true,
  },
}

const MODERN_LOREBOOK = {
  name: '现代书',
  entries: [{
    uid: 12, key: ['魔法'], keysecondary: ['法术'], comment: '魔法体系', content: '魔力来自呼吸。',
    constant: false, selective: true, selectiveLogic: 1, order: 100, position: 4, disable: false,
    ignoreBudget: true, preventRecursion: true, scanDepth: 3, caseSensitive: true,
    sticky: 2, cooldown: 3, delay: 1, group: 'world-core', groupOverride: true, groupWeight: 80,
    useGroupScoring: true, probability: 85, triggers: ['魔力暴走'], matchPersonaDescription: true,
    characterFilter: { enabled: true, characters: ['艾拉'] }, outletName: 'my-outlet', role: 'system',
    depth: 4, addMemo: true, automationId: 'auto-1',
  }],
}

describe('POST /api/v2/worldbooks/import(S10)', () => {
  let harness: E2eHarness
  let app: E2eHarness['open'] extends (...args: never[]) => infer R ? R extends { app: infer A } ? A : never : never

  const fresh = (): void => {
    harness = makeE2eHarness()
    ;({ app } = harness.open())
  }

  const post = async (payload: unknown): Promise<Response> =>
    app.request('/api/v2/worldbooks/import', { method: 'POST', body: JSON.stringify(payload) })

  it('老格式(裸 uid 键对象):注册 + 条目落库(R-P1-3/I1)', async () => {
    fresh()
    const res = await post({ filename: '地点.json', base64: Buffer.from(JSON.stringify(OLD_LOREBOOK), 'utf8').toString('base64'), name: '地点' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      data: { worldbook: { id: string; entryCount: number }; report: { asset: { sourceFormat: string } } }
    }
    expect(body.data.worldbook.entryCount).toBe(2)
    expect(body.data.report.asset.sourceFormat).toBe('st-lorebook-legacy')

    const rows = harness.open().store.sqlite
      .prepare('SELECT entry_key, name, enabled, position, insertion_order, activation_mode, source_data FROM worldbook_entries WHERE worldbook_id = ? ORDER BY entry_key')
      .all(body.data.worldbook.id) as { entry_key: string; name: string; enabled: number; position: number; insertion_order: number; activation_mode: string; source_data: string }[]
    expect(rows.map((r) => r.entry_key)).toEqual(['0', '1']) // uid 原样保留为映射键
    expect(rows[0]).toMatchObject({ name: '酒馆', enabled: 1, position: 0, insertion_order: 10, activation_mode: 'selective' })
    expect(rows[1]).toMatchObject({ name: '黑森林', enabled: 0, position: 4, insertion_order: 20, activation_mode: 'constant' })
    // addMemo 无原生语义 → source_data(compat 的 DB 镜像),不静默丢失
    expect(JSON.parse(rows[1]?.source_data ?? '{}')).toMatchObject({ addMemo: true })
  })

  it('现代 42 字段书:语义列显式落库(不藏进 source_data,§69 自洽)', async () => {
    fresh()
    const res = await post({ base64: Buffer.from(JSON.stringify(MODERN_LOREBOOK), 'utf8').toString('base64') })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { worldbook: { id: string }; report: { compatFields: string[] } } }
    const row = harness.open().store.sqlite
      .prepare('SELECT * FROM worldbook_entries WHERE worldbook_id = ?')
      .get(body.data.worldbook.id) as Record<string, unknown>
    expect(row).toMatchObject({
      entry_key: '12',
      name: '魔法体系',
      activation_mode: 'selective',
      keyword_logic: 'andAll',
      keywords_primary: '["魔法"]',
      keywords_secondary: '["法术"]',
      position: 4,
      insertion_order: 100,
      case_sensitive: 1,
      scan_depth: 3,
      sticky_rounds: 2,
      cooldown: 3,
      delay: 1,
      probability: 85,
      group_id: 'world-core',
      group_weight: 80,
      use_group_scoring: 1,
      ignore_budget: 1,
      prevent_recursion: 1,
      outlet_name: 'my-outlet',
      match_scope: '["personaDescription"]',
      triggers: '["魔力暴走"]',
    })
    expect(body.data.report.compatFields).toEqual(expect.arrayContaining(['addMemo', 'automationId']))
  })

  it('条目 v1 快照落库(worldbook_entry_versions,database-schema §14)', async () => {
    fresh()
    const res = await post({ base64: Buffer.from(JSON.stringify(MODERN_LOREBOOK), 'utf8').toString('base64') })
    const body = (await res.json()) as { data: { worldbook: { id: string } } }
    const versions = harness.open().store.sqlite
      .prepare('SELECT v.version, v.content_hash FROM worldbook_entry_versions v JOIN worldbook_entries e ON e.id = v.entry_id WHERE e.worldbook_id = ?')
      .all(body.data.worldbook.id) as { version: number; content_hash: string }[]
    expect(versions).toHaveLength(1)
    expect(versions[0]?.version).toBe(1)
    expect(versions[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('导入后出现在书列表;非法体 → VALIDATION_ERROR', async () => {
    fresh()
    const imported = await post({ base64: Buffer.from(JSON.stringify(MODERN_LOREBOOK), 'utf8').toString('base64') })
    expect(imported.status).toBe(201)
    const list = (await (await app.request('/api/v2/worldbooks')).json()) as { data: { name: string }[] }
    expect(list.data.some((w) => w.name === '现代书')).toBe(true)

    const bad = await post({ base64: Buffer.from('{ not json', 'utf8').toString('base64') })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })
})

// —— 最小 PNG 构造(签名 + tEXt + IEND;解析器不校验 CRC)——
function buildMinimalPng(chunks: { keyword: string; text: string }[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  for (const { keyword, text } of chunks) {
    const body = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write('tEXt', 4, 'ascii')
    parts.push(head, body, Buffer.from([0, 0, 0, 0]))
  }
  const iend = Buffer.alloc(8)
  iend.writeUInt32BE(0, 0)
  iend.write('IEND', 4, 'ascii')
  parts.push(iend)
  return new Uint8Array(Buffer.concat(parts))
}
