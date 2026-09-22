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

/** 追加 user 消息(每轮生成前置:链尾必须是 user,§24 续聊语义) */
async function sendUser(app: ReturnType<E2eHarness['open']>['app'], chatId: string, content: string): Promise<void> {
  const res = await app.request(`/api/v2/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content }),
  })
  expect(res.status).toBe(201)
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

  it('S17 缓存分区:轮1 freshWB → 轮2 毕业 stableWB,后轮以先轮为字节前缀(append-only)', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const worldbookId = await importWorldbook(app, OLD_LOREBOOK)
    const chatId = await createChat(app, '我们今晚去酒馆碰头')
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId }) })

    // 轮1:含"酒馆"关键词 → 条目 0 激活进 freshWB
    const r1 = await startGeneration(app, chatId, [{ text: '好,在酒馆见。' }])
    await new Promise((resolve) => setTimeout(resolve, 120))
    const snap1 = store.sqlite.prepare('SELECT serialized FROM prompt_snapshots WHERE id = ?').get(r1.snapshotId) as {
      serialized: string
    }
    const parts1 = (JSON.parse(snap1.serialized) as { parts: { role: string; content: string }[] }).parts

    // 轮1 落库:条目 0 cache_state=fresh + physical_order 分配 + content_hash 写入
    const entry0Id = store.sqlite
      .prepare('SELECT id FROM worldbook_entries WHERE worldbook_id = ? AND entry_key = ?')
      .get(worldbookId, '0') as { id: string }
    const rt1 = store.sqlite
      .prepare('SELECT cache_state, physical_order, content_hash, first_seen_msg FROM worldbook_runtime_entries WHERE worldbook_entry_id = ?')
      .get(entry0Id.id) as { cache_state: string; physical_order: number; content_hash: string; first_seen_msg: number }
    expect(rt1.cache_state).toBe('fresh')
    expect(rt1.physical_order).toBe(1)
    expect(rt1.content_hash).toBeTruthy()
    expect(rt1.first_seen_msg).toBeGreaterThan(0)

    // 轮2:追加 user 消息(含"酒馆")→ 条目 0 命中 → 毕业 stable,字节原位
    await sendUser(app, chatId, '那就去酒馆喝一杯。')
    const r2 = await startGeneration(app, chatId, [{ text: '干杯!' }])
    await new Promise((resolve) => setTimeout(resolve, 120))
    const snap2 = store.sqlite.prepare('SELECT serialized FROM prompt_snapshots WHERE id = ?').get(r2.snapshotId) as {
      serialized: string
    }
    const parts2 = (JSON.parse(snap2.serialized) as { parts: { role: string; content: string }[] }).parts

    const rt2 = store.sqlite
      .prepare('SELECT cache_state, physical_order FROM worldbook_runtime_entries WHERE worldbook_entry_id = ?')
      .get(entry0Id.id) as { cache_state: string; physical_order: number }
    expect(rt2.cache_state).toBe('stable')
    expect(rt2.physical_order).toBe(1) // append-only:物理序永不改变

    // 前缀稳定:轮2 的序列化 parts 以轮1 为字节前缀(header+stableWB+history 追加式)
    const joined1 = parts1.map((p) => p.content).join('|')
    const joined2 = parts2.map((p) => p.content).join('|')
    expect(joined2.startsWith(joined1)).toBe(true)
  })

  it('S17 失活照发(§30):stable 条目本轮关键词不出现仍发送', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const worldbookId = await importWorldbook(app, OLD_LOREBOOK)
    const chatId = await createChat(app, '我们今晚去酒馆碰头')
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId }) })

    // 轮1:激活 → fresh
    await startGeneration(app, chatId, [{ text: '好,在酒馆见。' }])
    await new Promise((resolve) => setTimeout(resolve, 120))
    // 轮2:激活 → stable
    await sendUser(app, chatId, '再去酒馆。')
    await startGeneration(app, chatId, [{ text: '行。' }])
    await new Promise((resolve) => setTimeout(resolve, 120))

    // 轮3:消息不含"酒馆" → 条目 0 未激活但 cacheState=stable → 仍发送(§30)
    await sendUser(app, chatId, '我们换个地方吧。')
    const r3 = await startGeneration(app, chatId, [{ text: '好。' }])
    await new Promise((resolve) => setTimeout(resolve, 120))
    const snap3 = store.sqlite.prepare('SELECT serialized FROM prompt_snapshots WHERE id = ?').get(r3.snapshotId) as {
      serialized: string
    }
    expect(snap3.serialized).toContain('镇上唯一的酒馆')
  })

  it('多书不同 scanDepth:全局窗口取最大值(超集),depth 大的书不被漏掉', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    // 书 A 关键词"酒馆"在最新消息;书 B 关键词"龙"只出现在最早消息
    const bookA = {
      '0': { uid: 0, key: ['酒馆'], keysecondary: [], comment: '酒馆', content: '镇上唯一的酒馆。', constant: false, selective: true, insertion_order: 10, position: 0, disable: false },
    }
    const bookB = {
      '0': { uid: 0, key: ['龙'], keysecondary: [], comment: '龙', content: '古老的龙盘踞山中。', constant: false, selective: true, insertion_order: 10, position: 0, disable: false },
    }
    const aId = await importWorldbook(app, bookA)
    const bId = await importWorldbook(app, bookB)

    const chat = (await (await app.request('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: 'S11-scan', systemPrompt: '测试' }) })).json()) as { data: { id: string } }
    const chatId = chat.data.id
    // 最早消息含"龙"(书 B 关键词);最新消息含"酒馆"(书 A 关键词)
    await app.request(`/api/v2/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: '山中有一条古老的龙沉睡' }) })
    await app.request(`/api/v2/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: '今晚我们去酒馆吧' }) })

    // 全局窗口必须取 max(A=1,B=5)=5,否则 B 在最早消息的"龙"会被漏掉(回归:Bug A min→max)
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId: aId, scanDepthOverride: 1 }) })
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId: bId, scanDepthOverride: 5 }) })

    await startGeneration(app, chatId, [{ text: '好,在酒馆见,当心山里的龙。' }])
    await new Promise((resolve) => setTimeout(resolve, 120))

    const bEntryId = store.sqlite
      .prepare('SELECT id FROM worldbook_entries WHERE worldbook_id = ? AND entry_key = ?')
      .get(bId, '0') as { id: string }
    const bAudit = store.sqlite
      .prepare('SELECT activated FROM worldbook_activations WHERE worldbook_entry_id = ? AND chat_id = ?')
      .get(bEntryId.id, chatId) as { activated: number }
    expect(bAudit.activated).toBe(1)
  })
})
