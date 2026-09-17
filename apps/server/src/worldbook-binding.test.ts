import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHarnesses, makeE2eHarness, type E2eHarness } from './harness'

/**
 * S11(WP1.2)chat↔worldbook 绑定 + 激活层接线测试:
 * - 绑定 API:绑定 / 列表 / 解绑
 * - 激活集成:导入世界书 → 绑定 chat → 含关键词消息 → startRun 触发激活 →
 *   审计表(§16)/ 运行时态表(§15)落库 + 激活内容进入 freshWB 贡献
 */

// 老格式书:条目 0「酒馆」selective(position 0 → slot before → freshWB)、条目 1 被 disable
const OLD_LOREBOOK = {
  '0': {
    uid: 0, key: ['酒馆'], keysecondary: [], comment: '酒馆', content: '镇上唯一的酒馆。',
    constant: false, selective: true, insertion_order: 10, position: 0, disable: false,
  },
  '1': {
    uid: 1, key: ['黑森林'], keysecondary: ['树林'], comment: '黑森林', content: '没有人能原路出来。',
    constant: true, selective: false, insertion_order: 20, position: 4, disable: true,
  },
}

function openHarness(): { harness: E2eHarness; app: ReturnType<E2eHarness['open']>['app']; store: ReturnType<E2eHarness['open']>['store'] } {
  const harness = makeE2eHarness()
  const opened = harness.open()
  return { harness, app: opened.app, store: opened.store }
}

async function importWorldbook(app: ReturnType<E2eHarness['open']>['app'], book: unknown): Promise<string> {
  const res = await app.request('/api/v2/worldbooks/import', {
    method: 'POST',
    body: JSON.stringify({ filename: 'book.json', base64: Buffer.from(JSON.stringify(book), 'utf8').toString('base64'), name: '地点' }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { worldbook: { id: string } } }).data.worldbook.id
}

async function createChat(app: ReturnType<E2eHarness['open']>['app'], message: string): Promise<string> {
  const chat = (await (await app.request('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: 'S11', systemPrompt: '测试' }) })).json()) as {
    data: { id: string }
  }
  await app.request(`/api/v2/chats/${chat.data.id}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: message }) })
  return chat.data.id
}

async function startGeneration(app: ReturnType<E2eHarness['open']>['app'], chatId: string, turns: { text: string }[]): Promise<{ runId: string; snapshotId: string }> {
  const res = await app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({ name: `fake-${Date.now()}-${Math.random()}`, type: 'fake', models: ['fake-model'], fakeTurns: turns }),
  })
  const p = (await res.json()) as { data: { id: string } }
  const gen = (await (
    await app.request(`/api/v2/chats/${chatId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ providerId: p.data.id, model: 'fake-model' }),
    })
  ).json()) as { data: { runId: string; snapshotId: string } }
  return gen.data
}

describe('S11 chat↔worldbook 绑定 API', () => {
  let ctx: ReturnType<typeof openHarness>
  afterEach(() => cleanupHarnesses())

  it('绑定 → 列表 → 解绑 → 列表空', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const worldbookId = await importWorldbook(app, OLD_LOREBOOK)
    const chatId = await createChat(app, '你好')

    const bind = await app.request(`/api/v2/chats/${chatId}/worldbooks`, {
      method: 'POST',
      body: JSON.stringify({ worldbookId, order: 3 }),
    })
    expect(bind.status).toBe(201)
    expect(((await bind.json()) as { data: { order: number } }).data.order).toBe(3)

    const list = (await (await app.request(`/api/v2/chats/${chatId}/worldbooks`)).json()) as { data: { worldbookId: string; order: number }[] }
    expect(list.data).toHaveLength(1)
    expect(list.data[0]?.worldbookId).toBe(worldbookId)

    const del = await app.request(`/api/v2/chats/${chatId}/worldbooks/${worldbookId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const list2 = (await (await app.request(`/api/v2/chats/${chatId}/worldbooks`)).json()) as { data: unknown[] }
    expect(list2.data).toHaveLength(0)
    void store
  })

  it('绑定不存在的世界书 → WORLDBOOK_NOT_FOUND', async () => {
    ctx = openHarness()
    const { app } = ctx
    const chatId = await createChat(app, '你好')
    const res = await app.request(`/api/v2/chats/${chatId}/worldbooks`, {
      method: 'POST',
      body: JSON.stringify({ worldbookId: 'nope', order: 0 }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('WORLDBOOK_NOT_FOUND')
  })

  it('重复绑定:幂等返回 200', async () => {
    ctx = openHarness()
    const { app } = ctx
    const worldbookId = await importWorldbook(app, OLD_LOREBOOK)
    const chatId = await createChat(app, '你好')
    const first = await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId }) })
    expect(first.status).toBe(201)
    const again = await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId }) })
    expect(again.status).toBe(200)
  })
})

describe('S11 激活层接线(startRun → freshWB 贡献 + 审计 + 运行时态)', () => {
  let ctx: ReturnType<typeof openHarness>
  afterEach(() => cleanupHarnesses())

  it('含关键词消息触发激活:内容进 freshWB、审计与运行时态落库', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const worldbookId = await importWorldbook(app, OLD_LOREBOOK)
    const chatId = await createChat(app, '我们今晚去酒馆碰头')
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId }) })

    const { snapshotId } = await startGeneration(app, chatId, [{ text: '好,在酒馆见。' }])
    await new Promise((resolve) => setTimeout(resolve, 120))

    // 审计表:条目 0 激活、条目 1(被 disable)未激活
    const audits = store.sqlite
      .prepare('SELECT worldbook_entry_id, activated, reason FROM worldbook_activations WHERE chat_id = ?')
      .all(chatId) as { worldbook_entry_id: string; activated: number; reason: string | null }[]
    expect(audits.length).toBe(2)
    const byEntry = new Map(audits.map((a) => [a.worldbook_entry_id, a]))
    const entry0Id = store.sqlite
      .prepare('SELECT id FROM worldbook_entries WHERE worldbook_id = ? AND entry_key = ?')
      .get(worldbookId, '0') as { id: string }
    const entry1Id = store.sqlite
      .prepare('SELECT id FROM worldbook_entries WHERE worldbook_id = ? AND entry_key = ?')
      .get(worldbookId, '1') as { id: string }
    expect(byEntry.get(entry0Id.id)?.activated).toBe(1)
    expect(byEntry.get(entry0Id.id)?.reason).toBe('keyword')
    expect(byEntry.get(entry1Id.id)?.activated).toBe(0)

    // 运行时态:条目 0 激活计数 = 1
    const rt = store.sqlite
      .prepare('SELECT activation_count FROM worldbook_runtime_entries WHERE worldbook_entry_id = ?')
      .get(entry0Id.id) as { activation_count: number }
    expect(rt.activation_count).toBe(1)

    // 贡献进入 freshWB:快照序列化内容含世界书条目正文
    const snap = store.sqlite.prepare('SELECT serialized FROM prompt_snapshots WHERE id = ?').get(snapshotId) as { serialized: string }
    expect(snap.serialized).toContain('镇上唯一的酒馆')
  })

  it('无关键词消息:不触发激活,审计记录未激活', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const worldbookId = await importWorldbook(app, OLD_LOREBOOK)
    const chatId = await createChat(app, '今天天气真好')
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId }) })

    await startGeneration(app, chatId, [{ text: '是的。' }])
    await new Promise((resolve) => setTimeout(resolve, 120))

    const audits = store.sqlite
      .prepare('SELECT activated FROM worldbook_activations WHERE chat_id = ?')
      .all(chatId) as { activated: number }[]
    expect(audits.every((a) => a.activated === 0)).toBe(true)

    const snap = store.sqlite
      .prepare('SELECT serialized FROM prompt_snapshots ORDER BY created_at DESC LIMIT 1')
      .get() as { serialized: string }
    expect(snap.serialized).not.toContain('镇上唯一的酒馆')
  })
})
