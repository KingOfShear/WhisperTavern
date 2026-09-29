import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chats as chatsTable,
  createChat,
  createDatabase,
  createMessage,
  createSecretStore,
  createSqliteEventSink,
  EventBus,
  SnapshotRegistry,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import { eq } from 'drizzle-orm'
import { createApp, type CreatedApp } from './server'

/**
 * S31(WP4.2b)Memory HTTP 面契约测试(api-spec §88–§92 / §155;DTO 按 §89–§92 对齐)。
 * 路由:POST /chats/:id/memory/search、GET/POST /chats/:id/summaries、
 * GET/POST /chats/:id/dossier/entities、PATCH /dossier/entities/:id、
 * GET/POST /chats/:id/timeline、POST /chats/:id/memory/scribe。
 * 传输走 Hono app.request();写入经 Repository(记忆读写唯一入口)。
 */
const dirs: string[] = []
const stores: WhisperTavernDb[] = []

function makeApp(): { app: CreatedApp['app']; registry: CreatedApp['registry']; store: WhisperTavernDb; bus: EventBus } {
  const dir = mkdtempSync(join(tmpdir(), 'dg-memory-api-'))
  dirs.push(dir)
  const store = createDatabase(':memory:')
  stores.push(store)
  const secretStore = createSecretStore(join(dir, 'secrets'))
  const bus = new EventBus(createSqliteEventSink(store))
  const created = createApp({ store, bus, snapshots: new SnapshotRegistry(), secretStore, secretsDir: dir, assetsDir: dir })
  return { ...created, store, bus }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function json(data: unknown): { method: string; body: string } {
  return { method: 'POST', body: JSON.stringify(data) }
}

async function makeChat(store: WhisperTavernDb, bus: EventBus, title = '记忆测试会话'): Promise<{ chatId: string; from: string; to: string }> {
  const chat = createChat(store, bus, { title, now: NOW })
  if (!chat.ok) throw new Error(`建 chat 失败: ${JSON.stringify(chat)}`)
  const m1 = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '神社的乌鸦在低语。', now: NOW })
  if (!m1.ok) throw new Error(`建消息失败: ${JSON.stringify(m1)}`)
  const m2 = createMessage(store, bus, { chatId: chat.value.id, role: 'character', content: '狐神睁开金色的眼睛。', now: NOW })
  if (!m2.ok) throw new Error(`建消息失败: ${JSON.stringify(m2)}`)
  return { chatId: chat.value.id, from: m1.value.message.id, to: m2.value.message.id }
}

const NOW = '2026-09-28T12:00:00.000Z'

describe('S31 §90 Summary API', () => {
  it('GET /summaries 空链返回 [];POST 建冻结块后 GET 返回 DTO(seq/covers/frozenAt 对齐 §90)', async () => {
    const { app, store, bus } = makeApp()
    const { chatId, from, to } = await makeChat(store, bus)

    const empty = await app.request(`/api/v2/chats/${chatId}/summaries`)
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { data: unknown[] }).data).toEqual([])

    const post = await app.request(`/api/v2/chats/${chatId}/summaries`, json({
      content: '第 1 章:狐神苏醒于温泉',
      coversMessageRange: { from, to },
    }))
    expect(post.status).toBe(201)
    const created = (await post.json()) as { data: { id: string; seq: number; content: string; coversMessageRange: { from: string; to: string }; frozenAt: string } }
    expect(created.data.seq).toBe(1)
    expect(created.data.coversMessageRange.from).toBe(from)
    expect(created.data.coversMessageRange.to).toBe(to)
    expect(created.data.frozenAt).toBeTruthy()

    // 冻结不原地修改:再 POST 一块 → 追加 seq=2,两块都在
    const post2 = await app.request(`/api/v2/chats/${chatId}/summaries`, json({
      content: '第 2 章:乌鸦占领神社',
      coversMessageRange: { from, to },
    }))
    expect(post2.status).toBe(201)
    const list = await app.request(`/api/v2/chats/${chatId}/summaries`)
    const listBody = (await list.json()) as { data: { seq: number; content: string; frozenAt: string }[] }
    expect(listBody.data.map((s) => s.seq)).toEqual([1, 2])
    expect(listBody.data[0]!.content).toBe('第 1 章:狐神苏醒于温泉')
    expect(listBody.data[0]!.frozenAt).toBeTruthy()
  })

  it('POST 缺 content / coversMessageRange → VALIDATION_ERROR 400', async () => {
    const { app, store, bus } = makeApp()
    const { chatId } = await makeChat(store, bus)
    const bad = await app.request(`/api/v2/chats/${chatId}/summaries`, json({ content: '' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })
})

describe('S31 §91 Dossier API', () => {
  it('POST /dossier/entities 201 建卡;同 entity 再 POST = 版本化更新(version+1);GET /dossier 列表含 DTO', async () => {
    const { app, store, bus } = makeApp()
    const { chatId } = await makeChat(store, bus)

    const created = await app.request(`/api/v2/chats/${chatId}/dossier/entities`, json({ entity: '狐神', content: '神社守护灵', importance: 0.9 }))
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { data: { id: string; entity: string; version: number; chatId: string } }
    expect(createdBody.data.entity).toBe('狐神')
    expect(createdBody.data.version).toBe(1)
    expect(createdBody.data.chatId).toBe(chatId)

    const updated = await app.request(`/api/v2/chats/${chatId}/dossier/entities`, json({ entity: '狐神', content: '神社守护灵,金瞳', importance: 0.95 }))
    expect(updated.status).toBe(201)
    const updatedBody = (await updated.json()) as { data: { version: number } }
    expect(updatedBody.data.version).toBe(2)

    const list = await app.request(`/api/v2/chats/${chatId}/dossier`)
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { data: { entity: string; content: string; version: number; createdAt: string; updatedAt: string }[] }
    expect(listBody.data).toHaveLength(1)
    expect(listBody.data[0]).toMatchObject({ entity: '狐神', content: '神社守护灵,金瞳', version: 2 })
    expect(listBody.data[0]!.createdAt).toBeTruthy()
    expect(listBody.data[0]!.updatedAt).toBeTruthy()

    const bad = await app.request(`/api/v2/chats/${chatId}/dossier/entities`, json({ content: 'x' }))
    expect(bad.status).toBe(400)
  })

  it('PATCH /dossier/entities/:id 更新内容/重要度并版本化;不存在 → MEMORY_NOT_FOUND 404', async () => {
    const { app, store, bus } = makeApp()
    const { chatId } = await makeChat(store, bus)
    const created = await app.request(`/api/v2/chats/${chatId}/dossier/entities`, json({ entity: '少女', content: '求护身符', importance: 0.6 }))
    const createdBody = (await created.json()) as { data: { id: string } }

    const patched = await app.request(`/api/v2/dossier/entities/${createdBody.data.id}`, { method: 'PATCH', body: JSON.stringify({ content: '求护身符并成为见习巫女', importance: 0.85 }) })
    expect(patched.status).toBe(200)
    const patchedBody = (await patched.json()) as { data: { content: string; importance: number; version: number } }
    expect(patchedBody.data).toMatchObject({ content: '求护身符并成为见习巫女', importance: 0.85, version: 2 })

    const missing = await app.request('/api/v2/dossier/entities/no-such-id', { method: 'PATCH', body: JSON.stringify({ content: 'x' }) })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('MEMORY_NOT_FOUND')
  })
})

describe('§2 Timeline API', () => {
  it('POST /timeline 201 追加;GET /timeline 返回 DTO(createdAt 降序最新在前);只追加不 UPDATE', async () => {
    const { app, store, bus } = makeApp()
    const { chatId } = await makeChat(store, bus)

    const e1 = await app.request(`/api/v2/chats/${chatId}/timeline`, json({ eventType: 'visit', summary: '少女到访神社' }))
    expect(e1.status).toBe(201)
    const e1Body = (await e1.json()) as { data: { id: string; eventType: string; summary: string } }
    expect(e1Body.data).toMatchObject({ eventType: 'visit', summary: '少女到访神社' })

    const e2 = await app.request(`/api/v2/chats/${chatId}/timeline`, json({ eventType: 'promise', summary: '少女承诺常来', importance: 0.8 }))
    expect(e2.status).toBe(201)

    const list = await app.request(`/api/v2/chats/${chatId}/timeline`)
    const listBody = (await list.json()) as { data: { eventType: string; importance?: number; createdAt: string }[] }
    expect(listBody.data).toHaveLength(2)
    expect(listBody.data[0]!.eventType).toBe('promise') // 最新在前
    expect(listBody.data[1]!.eventType).toBe('visit')

    const bad = await app.request(`/api/v2/chats/${chatId}/timeline`, json({ eventType: 'x' }))
    expect(bad.status).toBe(400)
  })
})

describe('§8 Search Memory', () => {
  it('POST /memory/search 中文子串跨层命中 Dossier;kinds 过滤生效;query 必填', async () => {
    const { app, store, bus } = makeApp()
    const { chatId, from, to } = await makeChat(store, bus)
    // 种三层数据:Dossier / timeline / summary(经契约层同一入口)
    await app.request(`/api/v2/chats/${chatId}/dossier/entities`, json({ entity: '狐神', content: '狐神琥珀色的眼睛看穿一切谎言', importance: 0.9 }))
    await app.request(`/api/v2/chats/${chatId}/timeline`, json({ eventType: 'discovery', summary: '狐神发现少女的谎言', importance: 0.8 }))
    await app.request(`/api/v2/chats/${chatId}/summaries`, json({ content: '第二夜:狐神戳穿少女的谎言', coversMessageRange: { from, to } }))

    const search = await app.request(`/api/v2/chats/${chatId}/memory/search`, json({ query: '狐神' }))
    expect(search.status).toBe(200)
    const body = (await search.json()) as { data: { items: { id: string; chatId: string; kind: string; content: string; createdAt: string; updatedAt: string }[]; total: number } }
    expect(body.data.total).toBeGreaterThan(0)
    for (const item of body.data.items) {
      expect(item.chatId).toBe(chatId)
      expect(item.createdAt).toBeTruthy()
      expect(item.updatedAt).toBeTruthy()
    }

    const dossierOnly = await app.request(`/api/v2/chats/${chatId}/memory/search`, json({ query: '狐神', kinds: ['dossier'] }))
    const dossierBody = (await dossierOnly.json()) as { data: { items: { kind: string; content: string }[] } }
    expect(dossierBody.data.items.length).toBeGreaterThan(0)
    expect(dossierBody.data.items.every((i) => i.kind === 'dossier')).toBe(true)
    expect(dossierBody.data.items[0]!.content).toBe('狐神琥珀色的眼睛看穿一切谎言')

    const bad = await app.request(`/api/v2/chats/${chatId}/memory/search`, json({ query: '' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })
})

describe('wp4.2b Scribe 触发(POST /chats/:id/memory/scribe)', () => {
  it('202 + runId + status=running;chat 未绑 provider → VALIDATION_ERROR', async () => {
    const { app, store, bus } = makeApp()
    const { chatId } = await makeChat(store, bus)

    const noProvider = await app.request(`/api/v2/chats/${chatId}/memory/scribe`, json({}))
    expect(noProvider.status).toBe(400)
    expect(((await noProvider.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')

    // 建 fake provider 并把 chat 绑定 modelProvider/modelName
    const providerId = await seedFakeProvider(app)
    store.db.update(chatsTable)
      .set({ modelProvider: providerId, modelName: 'fake-model' })
      .where(eq(chatsTable.id, chatId))
      .run()

    const triggered = await app.request(`/api/v2/chats/${chatId}/memory/scribe`, json({ providerId, model: 'fake-model' }))
    expect(triggered.status).toBe(202)
    const triggerBody = (await triggered.json()) as { data: { runId: string; status: string } }
    expect(triggerBody.data.runId).toBeTruthy()
    expect(triggerBody.data.status).toBe('running')

    // 长任务异步跑;短暂等待让 fake provider 一轮纯文本完成(不产生工具调用)
    await new Promise((r) => setTimeout(r, 150))
  })
})

async function seedFakeProvider(app: CreatedApp['app']): Promise<string> {
  const res = await app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({ name: `fake-${Date.now()}-${Math.random()}`, type: 'fake', fakeTurns: [{ text: '已记录。' }] }),
  })
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}