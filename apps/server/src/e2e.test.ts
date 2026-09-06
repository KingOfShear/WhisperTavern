import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDatabase,
  createSecretStore,
  createSqliteEventSink,
  EventBus,
  SnapshotRegistry,
  type DesireGrimoireDb,
} from '@desiregrimoire/runtime'
import { createApp, type CreatedApp } from './server'

/**
 * S8(WP0.9)端到端验收测试 —— implementation-plan §4.10 DoD 的自动化覆盖面:
 * - DoD 2:streaming 渲染 + 中途取消 → partial 可查(PV6)
 * - DoD 3:generation + usage 入库;重启恢复(消息树/运行记录/快照可查)
 * - DoD 4+5:Snapshot 重建模型可见内容;无绕过 Compiler(fake 调用入口闸口)
 * - §152 挂账补齐:资产注册路由
 * DoD 1(真实四链路)用 tests/smoke/real-provider-smoke.mjs(需用户自有 key);
 * DoD 6/7 由 adapter fixture 套件与 CI 门禁覆盖。
 */

const dirs: string[] = []
const opened: DesireGrimoireDb[] = []

interface Harness {
  root: string
  dbPath: string
  open: () => CreatedApp & { store: DesireGrimoireDb }
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dg-e2e-'))
  dirs.push(root)
  const dbPath = join(root, 'chats.sqlite')
  const open = (): CreatedApp & { store: DesireGrimoireDb } => {
    const store = createDatabase(dbPath)
    opened.push(store)
    const bus = new EventBus(createSqliteEventSink(store))
    const created = createApp({
      store,
      bus,
      snapshots: new SnapshotRegistry(),
      secretStore: createSecretStore(join(root, 'secrets')),
      secretsDir: join(root, 'secrets'),
    })
    return { ...created, store }
  }
  return { root, dbPath, open }
}

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close()
    } catch {
      // 已关闭
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄延迟释放:目录留待系统清理,不影响断言
    }
  }
})

async function seed(app: CreatedApp['app']): Promise<{ chatId: string; providerId: string }> {
  const chat = (await (
    await app.request('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: 'E2E', systemPrompt: '你是端到端测试角色。' }) })
  ).json()) as { data: { id: string } }
  await app.request(`/api/v2/chats/${chat.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: '讲一个故事' }),
  })
  await app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({ name: 'fake', type: 'fake', models: ['fake-model'] }),
  })
  const providers = (await (await app.request('/api/v2/providers')).json()) as { data: { id: string }[] }
  const providerId = providers.data[0]?.id
  if (providerId === undefined) throw new Error('provider 未创建')
  return { chatId: chat.data.id, providerId }
}

async function startGeneration(
  app: CreatedApp['app'],
  chatId: string,
  turns: { text: string; chunkSize?: number; delayMs?: number }[],
): Promise<{ runId: string; snapshotId: string }> {
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

/** 读 SSE 流到终态,返回帧列表 */
async function readSse(res: Response): Promise<{ id: number; event: string; data: Record<string, unknown> }[]> {
  const text = await res.text()
  const frames: { id: number; event: string; data: Record<string, unknown> }[] = []
  for (const block of text.split('\n\n')) {
    const id = /^id: (\d+)$/m.exec(block)
    const event = /^event: (.+)$/m.exec(block)
    const data = /^data: (.+)$/m.exec(block)
    if (id !== null && event !== null && data !== null) {
      frames.push({
        id: Number(id[1]),
        event: event[1] ?? '',
        data: JSON.parse(data[1] ?? '{}') as Record<string, unknown>,
      })
    }
  }
  return frames
}

describe('S8 端到端(§4.10 DoD 自动化面)', () => {
  it('DoD 2:流式 → 中途取消 → partial 可查;run/generation 终态 cancelled(PV6)', async () => {
    const harness = makeHarness()
    const { app } = harness.open()
    const { chatId } = await seed(app)
    const gen = await startGeneration(app, chatId, [
      { text: '第一段第二段第三段第四段第五段。', chunkSize: 4, delayMs: 100 },
    ])

    // 边读 SSE 边取消:收到首个 delta 后 POST cancel(§30 取消传播)
    const sseRes = await app.request(`/api/v2/runs/${gen.runId}/events`)
    expect(sseRes.status).toBe(200)
    const reader = sseRes.body?.getReader()
    expect(reader).toBeDefined()
    const decoder = new TextDecoder()
    let seen = ''
    let cancelled = false
    for (let i = 0; i < 60; i += 1) {
      const chunk = await Promise.race([
        reader?.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ])
      if (chunk === 'timeout' || chunk === undefined || chunk.done) break
      seen += decoder.decode(chunk.value)
      if (!cancelled && seen.includes('generation.delta')) {
        const cancelRes = await app.request(`/api/v2/runs/${gen.runId}/cancel`, { method: 'POST' })
        expect(cancelRes.status).toBe(200)
        cancelled = true
      }
      if (seen.includes('generation.failed')) break
    }
    expect(cancelled).toBe(true)

    // partial 可查(重连重放 durable):failed 帧带 CANCELLED 与 status=cancelled
    const frames = await readSse(await app.request(`/api/v2/runs/${gen.runId}/events`))
    const failed = frames.find((f) => f.event === 'generation.failed')
    expect(failed).toBeDefined()
    expect(failed?.data.data).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } })
    // generations 表:partial 正文照常归一入库(PV6 已缓冲内容)
    const genRow = harness
      .open()
      .store.sqlite.prepare('SELECT status, response FROM generations')
      .all()[0] as { status: string; response: string }
    expect(genRow.status).toBe('cancelled')
    const partial = (JSON.parse(genRow.response) as { text: string }).text
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(16) // 取消生效:未产出全量
    expect('第一段第二段第三段第四段第五段。'.startsWith(partial)).toBe(true)
  })

  it('DoD 3+4+5:完成链路 → usage 入库(source 分对)→ 重启恢复 → 快照重建模型可见内容', async () => {
    const harness = makeHarness()
    const { app, store } = harness.open()
    const { chatId, providerId } = await seed(app)
    await startGeneration(app, chatId, [{ text: '完整回复正文。' }])
    await new Promise((resolve) => setTimeout(resolve, 60))

    // 重启恢复:关闭后重开同一库文件
    store.close()
    const reopened = harness.open()
    expect(reopened.store.appliedMigrations.to).toBe(3)

    const messages = (await (await reopened.app.request(`/api/v2/chats/${chatId}/messages`)).json()) as {
      data: { role: string; content: string }[]
    }
    expect(messages.data.at(-1)).toMatchObject({ role: 'character', content: '完整回复正文。' })

    const runsRows = reopened.store.sqlite.prepare('SELECT status, snapshot_id FROM runs').all() as {
      status: string
      snapshot_id: string
    }[]
    expect(runsRows[0]?.status).toBe('completed')
    const snapshotId = runsRows[0]?.snapshot_id ?? ''

    // usage 入库且 source 分对(§17.3:estimated 不入命中率分母,字段先分对)
    const genRow = reopened.store.sqlite
      .prepare('SELECT input_tokens, output_tokens, usage_source, status FROM generations')
      .all()[0] as { input_tokens: number; output_tokens: number; usage_source: string; status: string }
    expect(genRow.status).toBe('completed')
    expect(genRow.usage_source).toBe('reported')
    expect(genRow.input_tokens).toBeGreaterThan(0)
    expect(genRow.output_tokens).toBeGreaterThan(0)

    // DoD 4/5:快照重建模型可见内容 —— serialized.parts 与 generations.request.messages 逐条一致
    const snap = (await (await reopened.app.request(`/api/v2/prompt-snapshots/${snapshotId}`)).json()) as {
      data: { ir: { segments: { content: string }[] }; serialized: { parts: { role: string; content: string }[] } }
    }
    const genRows = reopened.store.sqlite.prepare('SELECT request FROM generations').all() as { request: string }[]
    const request = JSON.parse(genRows[0]?.request ?? '{}') as { messages: { role: string; content: string }[] }
    const fromSnapshot = snap.data.serialized.parts.map((p) => `${p.role}:${p.content}`)
    const fromWire = request.messages.map((m) => `${m.role}:${m.content}`)
    expect(fromSnapshot).toEqual(fromWire) // §5.5 不变量 2:模型可见即已记录
    expect(snap.data.ir.segments.length).toBeGreaterThan(0)
    void providerId
  })

  it('§152 挂账补齐:characters/worldbooks/presets 注册路由(version 1 快照落库)', async () => {
    const harness = makeHarness()
    const { app } = harness.open()
    const charRes = await app.request('/api/v2/characters', {
      method: 'POST',
      body: JSON.stringify({ name: '测试角色', description: 'E2E', firstMessage: '你好,旅行者。' }),
    })
    expect(charRes.status).toBe(201)
    const charList = (await (await app.request('/api/v2/characters')).json()) as { data: { name: string }[] }
    expect(charList.data.some((c) => c.name === '测试角色')).toBe(true)

    const wbRes = await app.request('/api/v2/worldbooks', {
      method: 'POST',
      body: JSON.stringify({ name: '测试世界书', scanDepth: 4, recursive: true }),
    })
    expect(wbRes.status).toBe(201)

    const presetRes = await app.request('/api/v2/presets', {
      method: 'POST',
      body: JSON.stringify({ name: '测试预设', compilerMode: 'performance' }),
    })
    expect(presetRes.status).toBe(201)
    const presetList = (await (await app.request('/api/v2/presets')).json()) as { data: { name: string }[] }
    expect(presetList.data.some((p) => p.name === '测试预设')).toBe(true)

    // version 1 快照随创建落库(database-schema §7/§11)
    const versions = app.request
    void versions
    const charVersions = (
      harness.open().store.sqlite.prepare('SELECT version FROM character_versions').all() as { version: number }[]
    ).map((v) => v.version)
    expect(charVersions).toContain(1)
  })
})
