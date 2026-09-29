import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDatabase,
  createSecretStore,
  EventBus,
  SnapshotRegistry,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import { ToolRegistry } from '@whispertavern/agent'
import { createApp, type CreatedApp } from './server'
import { events as eventsTable } from '@whispertavern/runtime'

/**
 * S28(WP3.6)§154 P3 Agent API 契约测试(api-spec §144 全套思想:信封/错误码/幂等)。
 * 路由:GET/POST /agents、POST /agents/:id/runs、GET /agent-runs/:id、
 * cancel/pause/resume/delegate/handoff、GET /tools、GET /skills。
 * 传输走 Hono app.request();provider 用 fake adapter(零 API 成本)。
 */
const dirs: string[] = []
const stores: WhisperTavernDb[] = []

function makeApp(opts: { tools?: ToolRegistry } = {}): {
  app: CreatedApp['app']
  registry: CreatedApp['registry']
  store: WhisperTavernDb
} {
  const dir = mkdtempSync(join(tmpdir(), 'dg-agent-api-'))
  dirs.push(dir)
  const store = createDatabase(':memory:')
  stores.push(store)
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
    tools: opts.tools,
  })
  return { ...created, store }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 建 fake provider 行(§64 run 前必需 provider) */
async function seedProvider(app: CreatedApp['app'], turns: { text: string }[] = []): Promise<string> {
  const res = await app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({ name: `fake-${Date.now()}-${Math.random()}`, type: 'fake', fakeTurns: turns }),
  })
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

function post(app: CreatedApp['app'], path: string, body: unknown): ReturnType<CreatedApp['app']['request']> {
  return app.request(path, { method: 'POST', body: JSON.stringify(body) })
}

describe('S28 §154 GET/POST /agents(§62/§63)', () => {
  it('POST /agents 201 建 Definition;GET /agents 列表含新条', async () => {
    const { app } = makeApp()
    const created = await post(app, '/api/v2/agents', { name: 'S28 测试代理', type: 'writer', instructions: '写手' })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { data: { id: string; version: number } }
    expect(createdBody.data.id).toBeTruthy()
    expect(createdBody.data.version).toBe(1)

    const list = await app.request('/api/v2/agents')
    const listBody = (await list.json()) as { data: { id: string; name: string; type: string }[] }
    expect(listBody.data.some((a) => a.id === createdBody.data.id)).toBe(true)
  })

  it('POST /agents 空 name → VALIDATION_ERROR 400;未知 type → 400', async () => {
    const { app } = makeApp()
    const noName = await post(app, '/api/v2/agents', {})
    expect(noName.status).toBe(400)
    const noNameBody = (await noName.json()) as { error: { code: string } }
    expect(noNameBody.error.code).toBe('VALIDATION_ERROR')

    const badType = await post(app, '/api/v2/agents', { name: 'x', type: 'self-replicating' })
    expect(badType.status).toBe(400)
  })
})

describe('S28 §154 POST /agents/:id/runs + GET /agent-runs/:id(§64/§66)', () => {
  it('建 agent(runtimePolicy 声明的 modelPolicy)→ 建 provider → run → 202 runId → 状态可查', async () => {
    const { app } = makeApp()
    const providerId = await seedProvider(app, [{ text: '代理回复' }])
    const created = await post(app, '/api/v2/agents', {
      name: '调查员',
      type: 'tool-agent',
      instructions: '调查真相',
      modelPolicy: { provider: providerId, model: 'fake-model' },
    })
    const agent = ((await created.json()) as { data: { id: string } }).data

    const run = await post(app, `/api/v2/agents/${agent.id}/runs`, { input: '查一下' })
    expect(run.status).toBe(202)
    const runBody = (await run.json()) as { data: { runId: string; chatId: string; agentId: string; status: string } }
    expect(runBody.data.runId).toBeTruthy()
    expect(runBody.data.agentId).toBe(agent.id)
    expect(runBody.data.status).toBe('running')

    // 轮询至终态(fake provider 即时完成;最多 50 轮)
    let state: { status: string } = { status: 'running' }
    for (let i = 0; i < 50 && state.status === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
      const got = await app.request(`/api/v2/agent-runs/${runBody.data.runId}`)
      state = ((await got.json()) as { data: { status: string } }).data
    }
    expect(['succeeded', 'failed', 'cancelled']).toContain(state.status)
  })

  it('未知 agent → AGENT_NOT_FOUND;缺 input → VALIDATION_ERROR', async () => {
    const { app } = makeApp()
    const missing = await post(app, '/api/v2/agents/agent_ghost/runs', { input: '喂' })
    expect(missing.status).toBe(404)
    const missingBody = (await missing.json()) as { error: { code: string } }
    expect(missingBody.error.code).toBe('AGENT_NOT_FOUND')

    const created = await post(app, '/api/v2/agents', { name: '无模型代理' })
    const agent = ((await created.json()) as { data: { id: string } }).data
    const noInput = await post(app, `/api/v2/agents/${agent.id}/runs`, {})
    expect(noInput.status).toBe(400)

    // 无 provider 声明 → VALIDATION_ERROR(agent 未绑定 provider/model)
    const noProvider = await post(app, `/api/v2/agents/${agent.id}/runs`, { input: '喂' })
    expect(noProvider.status).toBe(400)
    const noProviderBody = (await noProvider.json()) as { error: { code: string } }
    expect(noProviderBody.error.code).toBe('VALIDATION_ERROR')
  })

  it('GET /agent-runs/:id 不存在 → NOT_FOUND', async () => {
    const { app } = makeApp()
    const got = await app.request('/api/v2/agent-runs/run_ghost')
    expect(got.status).toBe(404)
    const body = (await got.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe('S28 §154 cancel/pause/resume(§66)', () => {
  it('cancel 未知 run → AGENT_NOT_FOUND', async () => {
    const { app } = makeApp()
    const res = await post(app, '/api/v2/agent-runs/run_ghost/cancel', {})
    expect(res.status).toBe(404)
  })
})

describe('S28 §154 delegate/handoff(§71/§73 + §93 树护栏)', () => {
  it('delegate 未知父 Run → AGENT_NOT_FOUND', async () => {
    const { app } = makeApp()
    const res = await post(app, '/api/v2/agent-runs/run_ghost/delegate', { agentId: 'a', task: 't' })
    expect(res.status).toBe(404)
  })

  it('delegate 超 maxDepth 护栏 → AGENT_RECURSION_LIMIT 409(§93)', async () => {
    const { app, store } = makeApp()
    // 直接造父 Run 行(免跑真实 run);父 Run 在 chat_s28_delegate 下
    const providerId = await seedProvider(app, [{ text: '子代理回复' }])
    const now = '2026-09-27T12:00:00.000Z'
    store.sqlite.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat_s28_del', 'd', ?, ?)`).run(now, now)
    store.sqlite
      .prepare(`INSERT INTO runs (id, chat_id, status, created_at, updated_at) VALUES ('run_parent_del', 'chat_s28_del', 'running', ?, ?)`)
      .run(now, now)
    const agentRes = await post(app, '/api/v2/agents', { name: 'child', type: 'custom', modelPolicy: { provider: providerId, model: 'fake-model' } })
    const agentId = ((await agentRes.json()) as { data: { id: string } }).data.id

    // maxDepth=0 → 任何子 spawn 都拒绝(根之上不允许)
    const res = await post(app, '/api/v2/agent-runs/run_parent_del/delegate', {
      agentId,
      task: '查',
      budget: { maxDepth: 0 },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('AGENT_RECURSION_LIMIT')
  })

  it('handoff 未知父 Run → AGENT_NOT_FOUND', async () => {
    const { app } = makeApp()
    const res = await post(app, '/api/v2/agent-runs/run_ghost/handoff', { targetAgentId: 'a', reason: 'r' })
    expect(res.status).toBe(404)
  })
})

describe('S28 任务 3 观测面(§121/§122/§124)', () => {
  it('GET /agent-runs/:id/timeline:未知 run → AGENT_NOT_FOUND;存在 run → 时序数组', async () => {
    const { app } = makeApp()
    const missing = await app.request('/api/v2/agent-runs/run_ghost/timeline')
    expect(missing.status).toBe(404)

    const providerId = await seedProvider(app, [{ text: '回复' }])
    const created = await post(app, '/api/v2/agents', { name: '观测', type: 'custom', modelPolicy: { provider: providerId, model: 'fake-model' } })
    const agent = ((await created.json()) as { data: { id: string } }).data
    const runRes = await post(app, `/api/v2/agents/${agent.id}/runs`, { input: '喂' })
    const { runId } = ((await runRes.json()) as { data: { runId: string } }).data
    for (let i = 0; i < 50; i += 1) {
      const got = await app.request(`/api/v2/agent-runs/${runId}`)
      const body = (await got.json()) as { data: { status: string } }
      if (body.data.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const timeline = await app.request(`/api/v2/agent-runs/${runId}/timeline`)
    expect(timeline.status).toBe(200)
    const body = (await timeline.json()) as { data: { at: string; kind: string; label: string }[] }
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.every((e) => e.at !== undefined && e.kind !== undefined)).toBe(true)
  })

  it('GET /agent-runs/:id/cost:汇总 Token 账;未知 run → AGENT_NOT_FOUND', async () => {
    const { app } = makeApp()
    const missing = await app.request('/api/v2/agent-runs/run_ghost/cost')
    expect(missing.status).toBe(404)

    const providerId = await seedProvider(app, [{ text: '回复' }])
    const created = await post(app, '/api/v2/agents', { name: '计费', type: 'custom', modelPolicy: { provider: providerId, model: 'fake-model' } })
    const agent = ((await created.json()) as { data: { id: string } }).data
    const runRes = await post(app, `/api/v2/agents/${agent.id}/runs`, { input: '喂' })
    const { runId } = ((await runRes.json()) as { data: { runId: string } }).data
    for (let i = 0; i < 50; i += 1) {
      const got = await app.request(`/api/v2/agent-runs/${runId}`)
      const body = (await got.json()) as { data: { status: string } }
      if (body.data.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const costRes = await app.request(`/api/v2/agent-runs/${runId}/cost`)
    expect(costRes.status).toBe(200)
    const body = (await costRes.json()) as { data: { runId: string; inputTokens: number; outputTokens: number; cachedTokens: number } }
    expect(body.data.runId).toBe(runId)
    expect(typeof body.data.inputTokens).toBe('number')
  })

  it('GET /agents/:id/inspector:Definition 读面;未知 agent → AGENT_NOT_FOUND', async () => {
    const { app } = makeApp()
    const missing = await app.request('/api/v2/agents/agent_ghost/inspector')
    expect(missing.status).toBe(404)

    const created = await post(app, '/api/v2/agents', { name: '检视', type: 'custom', runtimePolicy: { maxTurns: 5, maxToolCalls: 10, maxExecutionTimeMs: 9999 } })
    const agent = ((await created.json()) as { data: { id: string } }).data
    const res = await app.request(`/api/v2/agents/${agent.id}/inspector`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        agent: { id: string; version: number; runtimePolicy: { maxTurns: number } }
        states: { status: string }[]
        toolCalls: unknown[]
        artifacts: unknown[]
      }
    }
    expect(body.data.agent.id).toBe(agent.id)
    expect(body.data.agent.runtimePolicy.maxTurns).toBe(5)
    expect(Array.isArray(body.data.toolCalls)).toBe(true)
  })
})

describe('S28 §154 GET /tools + GET /skills(§75/§76/§79)', () => {
  it('GET /tools 返回注册面投影(§76 shape);默认注册面 = S31 三个 memory 写入工具', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/v2/tools')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string; name: string; permission: string; source: string }[] }
    // S31 把三个 memory 写入工具注册进默认注册面(Scribe 与 HTTP 面共享);wire name = memory.*
    expect(body.data.map((t) => t.name).sort()).toEqual(
      ['memory.append_summary', 'memory.append_timeline', 'memory.upsert_dossier'].sort(),
    )
    expect(body.data.every((t) => t.source === 'core')).toBe(true)
  })

  it('GET /tools 投影已注册工具(capability 过滤);注入注册面叠加内建 memory 工具', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-agent-api2-'))
    dirs.push(dir)
    const store = createDatabase(':memory:')
    stores.push(store)
    const tools = new ToolRegistry({ store, bus: null as never, persistApprovalAudit: () => undefined })
    tools.register({
      id: 't_query',
      name: 'query_state',
      description: '读状态',
      inputSchema: {},
      permissions: ['chat.read'],
      async execute() {
        return { toolCallId: '', status: 'success' as const, output: { value: 42 } }
      },
    })
    const { app } = makeApp({ tools })
    const res = await app.request('/api/v2/tools')
    const body = (await res.json()) as { data: { id: string; name: string; permission: string; source: string }[] }
    // 注入的 t_query + 内建 3 个 memory 写入工具 = 4(wire name=memory.*)
    expect(body.data).toHaveLength(4)
    expect(body.data.some((t) => t.id === 't_query')).toBe(true)
    expect(body.data.some((t) => t.name === 'memory.upsert_dossier')).toBe(true)

    const filtered = await app.request('/api/v2/tools?capability=chat.read')
    const filteredBody = (await filtered.json()) as { data: unknown[] }
    expect(filteredBody.data).toHaveLength(1)
    const memoryWrite = await app.request('/api/v2/tools?capability=memory.write')
    const memoryWriteBody = (await memoryWrite.json()) as { data: unknown[] }
    expect(memoryWriteBody.data).toHaveLength(3)
    const none = await app.request('/api/v2/tools?capability=chat.write')
    const noneBody = (await none.json()) as { data: unknown[] }
    expect(noneBody.data).toEqual([])
  })

  it('GET /skills:目录为空 → []', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/v2/skills')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })
})