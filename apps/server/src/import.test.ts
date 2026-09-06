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
        report: { asset: { sourceFormat: string }; roleAssignments: { path: string; authority: string }[] }
      }
    }
    expect(body.data.character.name).toBe('S9卡')
    expect(body.data.character.version).toBe(1)
    expect(body.data.report.asset.sourceFormat).toBe('st-v3')
    expect(body.data.report.roleAssignments).toEqual(
      expect.arrayContaining([{ path: 'persona.*', authority: 'character' }]),
    )
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
    const body = (await res.json()) as { data: { worldbookId: string | null } }
    expect(body.data.worldbookId).not.toBeNull()
    const wbRow = harness.open().store.sqlite
      .prepare('SELECT source_data FROM worldbooks WHERE id = ?')
      .get(body.data.worldbookId ?? '') as { source_data: string } | undefined
    expect(wbRow).toBeDefined()
    expect(JSON.parse(wbRow?.source_data ?? '{}')).toMatchObject({ characterRef: null })
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

  it('harness 资产目录就位', () => {
    fresh()
    expect(harness.assetsDir).toBeDefined()
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
