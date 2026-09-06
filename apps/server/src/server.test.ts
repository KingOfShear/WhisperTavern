import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDatabase,
  createSecretStore,
  EventBus,
  SnapshotRegistry,
  type WhisperTavernDb,
  type SecretStore,
} from '@whispertavern/runtime'
import { createApp, type CreatedApp } from './server'
import { events as eventsTable } from '@whispertavern/runtime'

/**
 * S6 契约测试(api-spec §144):信封 §6 / 错误码 §8 / Request ID §5 /
 * SSE sequence §27 / Last-Event-ID 续传 §142 / 密钥零回显(PV5/R-P0-6)。
 * 传输走 Hono app.request(),不起端口;provider 用 fake adapter。
 */

const dirs: string[] = []
const stores: WhisperTavernDb[] = []

function makeApp(): {
  app: CreatedApp['app']
  registry: CreatedApp['registry']
  bus: EventBus
  secretStore: SecretStore
  secretsDir: string
  logs: string[]
  store: WhisperTavernDb
} {
  const dir = mkdtempSync(join(tmpdir(), 'dg-server-'))
  dirs.push(dir)
  const store = createDatabase(':memory:')
  stores.push(store)
  const logs: string[] = []
  const secretStore = createSecretStore(join(dir, 'secrets'))
  const bus = new EventBus({
    insert: (batch) => {
      for (const event of batch) {
        store.db
          .insert(eventsTable)
          .values({
            id: event.id,
            eventType: event.type,
            durability: event.durability,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            runId: event.runId,
            payload: JSON.stringify(event.payload),
            sequence: event.sequence,
            createdAt: event.timestamp,
          })
          .run()
      }
    },
  })
  const created = createApp({
    store,
    bus,
    snapshots: new SnapshotRegistry(),
    secretStore,
    secretsDir: dir,
      assetsDir: dir,
    logger: (level, message, meta) => logs.push(`${level}: ${message} ${String(meta ?? '')}`),
  })
  return { ...created, bus, secretStore, secretsDir: join(dir, 'secrets'), logs, store }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function seedChatWithUserMessage(app: CreatedApp['app'], systemPrompt = '你是测试角色。'): Promise<{ chatId: string; messageId: string }> {
  const chatRes = await app.request('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: 'S6 契约', systemPrompt }) })
  const chat = (await chatRes.json()) as { data: { id: string } }
  const msgRes = await app.request(`/api/v2/chats/${chat.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: '你好' }),
  })
  const msg = (await msgRes.json()) as { data: { message: { id: string } } }
  return { chatId: chat.data.id, messageId: msg.data.message.id }
}

describe('信封与 Request ID(api-spec §5/§6/§7)', () => {
  it('POST /chats:201 信封 {data, requestId} + X-Request-ID 回显(客户端携带优先)', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/v2/chats', {
      method: 'POST',
      headers: { 'x-request-id': 'req_client_1' },
      body: JSON.stringify({ title: '测试' }),
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-request-id')).toBe('req_client_1')
    const body = (await res.json()) as { data: { id: string; title: string }; requestId: string }
    expect(body.requestId).toBe('req_client_1')
    expect(body.data.id).toBeTruthy()
  })

  it('GET 未知资源:404 错误信封(NOT_FOUND,含 requestId/retryable)', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/v2/chats/chat_missing', { method: 'GET' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string; retryable: boolean } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.retryable).toBe(false)
    expect(body.error.requestId).toMatch(/^req_/)
  })

  it('消息树路由:创建 user 消息 + 活跃链读取(§18/§16)', async () => {
    const { app } = makeApp()
    const { chatId, messageId } = await seedChatWithUserMessage(app)
    const list = await app.request(`/api/v2/chats/${chatId}/messages`)
    const body = (await list.json()) as { data: { id: string; role: string }[] }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.id).toBe(messageId)
    expect(body.data[0]?.role).toBe('user')
  })

  it('非法 role:VALIDATION_ERROR 400(§8)', async () => {
    const { app } = makeApp()
    const { chatId } = await seedChatWithUserMessage(app)
    const res = await app.request(`/api/v2/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'assistant', content: '伪造' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('生成链路(§24/§143 长任务原则 + fake provider)', () => {
  it('generate 立即返回 ids;完成后回复入树、run completed、快照可查', async () => {
    const { app } = makeApp()
    const { chatId } = await seedChatWithUserMessage(app)
    await app.request('/api/v2/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'fake', type: 'fake', fakeTurns: [{ text: 'fake 回复正文' }] }),
    })
    const providerList = (await (await app.request('/api/v2/providers')).json()) as { data: { id: string }[] }
    const providerId = providerList.data[0]?.id ?? ''

    const genRes = await app.request(`/api/v2/chats/${chatId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ providerId, model: 'fake-model' }),
    })
    expect(genRes.status).toBe(200)
    const gen = (await genRes.json()) as { data: { runId: string; generationId: string; messageId: string; snapshotId: string } }
    // §143:响应即时(不等生成完成)——三个 id 同时返回
    expect(gen.data.runId).toBeTruthy()
    expect(gen.data.generationId).toBeTruthy()
    expect(gen.data.messageId).toBeTruthy()

    // 等待完成侧(异步):轮询消息树
    for (let i = 0; i < 50; i += 1) {
      const list = (await (await app.request(`/api/v2/chats/${chatId}/messages`)).json()) as { data: { role: string; content: string }[] }
      if (list.data.some((m) => m.role === 'character')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const messages = (await (await app.request(`/api/v2/chats/${chatId}/messages`)).json()) as {
      data: { role: string; content: string }[]
    }
    expect(messages.data.at(-1)?.role).toBe('character')
    expect(messages.data.at(-1)?.content).toBe('fake 回复正文')

    // §36:快照可查(§5.5 证据链)
    const snapRes = await app.request(`/api/v2/prompt-snapshots/${gen.data.snapshotId}`)
    const snap = (await snapRes.json()) as { data: { ir: { segments: unknown[] }; hashes: { final: string } } }
    expect(snap.data.hashes.final).toBeTruthy()
    expect(snap.data.ir.segments.length).toBeGreaterThan(0)
  })

  it('compile 路由:返回哈希与诊断(§32–§34)', async () => {
    const { app } = makeApp()
    const { chatId } = await seedChatWithUserMessage(app)
    await app.request('/api/v2/providers', { method: 'POST', body: JSON.stringify({ name: 'fake', type: 'fake' }) })
    const providers = (await (await app.request('/api/v2/providers')).json()) as { data: { id: string }[] }
    const res = await app.request(`/api/v2/chats/${chatId}/prompt/compile`, {
      method: 'POST',
      body: JSON.stringify({ providerId: providers.data[0]?.id, model: 'fake-model' }),
    })
    const body = (await res.json()) as { data: { hashes: { final: string }; diagnostics: unknown[] } }
    expect(body.data.hashes.final).toBeTruthy()
    expect(Array.isArray(body.data.diagnostics)).toBe(true)
  })
})

describe('SSE(§26/§27/§142:sequence 单调 + Last-Event-ID 续传)', () => {
  it('已结束 run:重放 durable 事件,sequence 单调,Last-Event-ID 之后续传', async () => {
    const { app } = makeApp()
    const { chatId } = await seedChatWithUserMessage(app)
    await app.request('/api/v2/providers', { method: 'POST', body: JSON.stringify({ name: 'fake', type: 'fake', fakeTurns: [{ text: 'SSE 正文' }] }) })
    const providers = (await (await app.request('/api/v2/providers')).json()) as { data: { id: string }[] }
    const gen = (await (await app.request(`/api/v2/chats/${chatId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ providerId: providers.data[0]?.id, model: 'fake-model' }),
    })).json()) as { data: { runId: string } }
    await new Promise((resolve) => setTimeout(resolve, 50)) // 等完成

    // 全量重放:sequence 严格单调递增,终态为 generation.completed
    const all = await app.request(`/api/v2/runs/${gen.data.runId}/events`)
    expect(all.headers.get('content-type')).toContain('text/event-stream')
    const allText = await all.text()
    const allSequences = [...allText.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    expect(allSequences.length).toBeGreaterThan(2)
    for (let i = 1; i < allSequences.length; i += 1) {
      expect(allSequences[i]).toBeGreaterThan(allSequences[i - 1] ?? 0)
    }
    expect(allText).toContain('event: generation.completed')

    // §142:Last-Event-ID=第 2 条 → 只重放其后的行
    const partial = await app.request(`/api/v2/runs/${gen.data.runId}/events`, { headers: { 'last-event-id': String(allSequences[1] ?? 0) } })
    const partialText = await partial.text()
    const partialSequences = [...partialText.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    expect(partialSequences.length).toBeGreaterThan(0)
    for (const seq of partialSequences) {
      expect(seq).toBeGreaterThan(allSequences[1] ?? 0)
    }
  })

  it('未知 run:SSE 路由 404(GENERATION_NOT_FOUND)', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/v2/runs/run_missing/events')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('GENERATION_NOT_FOUND')
  })
})

describe('密钥零回显与泄露扫描(PV5/R-P0-6)', () => {
  const SECRET = 'sk-secret-e2bb4255c566a961'

  it('POST /providers:密钥只进 SecretStore,响应/列表零明文;落盘文件无明文', async () => {
    const { app, secretsDir } = makeApp()
    const res = await app.request('/api/v2/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'deepseek', type: 'openai-compat', baseUrl: 'https://api.test/v1', apiKey: SECRET, models: ['deepseek-chat'] }),
    })
    expect(res.status).toBe(201)
    const created = JSON.stringify(await res.json())
    expect(created).not.toContain(SECRET)

    const list = JSON.stringify(await (await app.request('/api/v2/providers')).json())
    expect(list).not.toContain(SECRET)

    // 落盘扫描:secrets 目录文件不含明文(加密文件兜底/R-P0-6)
    const masterKey = readFileSync(join(secretsDir, '.master.key'), 'utf8') // master key 存在
    expect(masterKey).not.toContain(SECRET)
    for (const entry of readdirSync(secretsDir)) {
      if (entry === '.master.key') continue
      const content = readFileSync(join(secretsDir, entry), 'utf8')
      expect(content).not.toContain(SECRET)
    }
  })

  it('POST /providers/:id/secret:只写不回显', async () => {
    const { app } = makeApp()
    await app.request('/api/v2/providers', { method: 'POST', body: JSON.stringify({ name: 'x', type: 'fake' }) })
    const providers = (await (await app.request('/api/v2/providers')).json()) as { data: { id: string }[] }
    const id = providers.data[0]?.id ?? ''
    const res = await app.request(`/api/v2/providers/${id}/secret`, {
      method: 'POST',
      body: JSON.stringify({ secret: SECRET }),
    })
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain(SECRET)
    expect(body).toContain('"stored":true')
  })

  it('错误路径日志扫描:logger 输出不含密钥(PV5)', async () => {
    const { app, logs } = makeApp()
    await app.request('/api/v2/chats/chat_missing/generate', {
      method: 'POST',
      headers: { 'x-api-key': SECRET },
      body: JSON.stringify({}),
    })
    expect(logs.join('\n')).not.toContain(SECRET)
  })
})

