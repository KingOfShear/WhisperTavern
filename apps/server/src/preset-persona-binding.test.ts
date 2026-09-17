import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHarnesses, makeE2eHarness, type E2eHarness } from './harness'

/**
 * S12(WP1.3)ST Prompt Mapping + Persona 库 集成测试:
 * - §81 编译顺序:ST prompts[] + prompt_order[] → 段,按 prompt_order 索引排序;
 *   不在 prompt_order 的段(隐藏段)被排除;injection_position 0/1 → header/injection 区。
 * - Persona 注入:chat 绑定 persona → 档案渲染为 header 区贡献。
 * - 宏透传 R-P0-1:预设段含 {{user}} → 编译产出 MACRO_UNEXPANDED_P0 info 诊断。
 * - 绑定 API:persona/preset 单值绑定(成功 / 404 / 空体 / 解绑)。
 */

/** 代表性 ST 预设:5 条 prompts,其中 hidden 不在 prompt_order(应被排除) */
const ST_PRESET = {
  name: 'S12 测试预设',
  temperature: 0.8,
  max_context: 8000,
  prompts: [
    { identifier: 'main', role: 'system', content: 'A-系统角色设定', injection_position: 0 },
    { identifier: 'personaDescription', role: 'system', content: 'B-玩家档案占位', injection_position: 0 },
    { identifier: 'tailnote', role: 'system', content: 'C-风格约束', injection_position: 0 },
    { identifier: 'injected', role: 'system', content: '{{user}} 推门而入', injection_position: 1, injection_depth: 2 },
    { identifier: 'hidden', role: 'system', content: 'Z-不应出现', injection_position: 0 },
  ],
  prompt_order: [
    { identifier: 'main', order: 0, enabled: true },
    { identifier: 'personaDescription', order: 1, enabled: true },
    { identifier: 'tailnote', order: 2, enabled: true },
    { identifier: 'injected', order: 3, enabled: true },
  ],
}

function openHarness(): { harness: E2eHarness; app: ReturnType<E2eHarness['open']>['app']; store: ReturnType<E2eHarness['open']>['store'] } {
  const harness = makeE2eHarness()
  const opened = harness.open()
  return { harness, app: opened.app, store: opened.store }
}

async function importPreset(app: ReturnType<E2eHarness['open']>['app'], preset: unknown): Promise<string> {
  const res = await app.request('/api/v2/presets/import', {
    method: 'POST',
    body: JSON.stringify({ filename: 'preset.json', base64: Buffer.from(JSON.stringify(preset), 'utf8').toString('base64'), name: 'S12' }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { preset: { id: string } } }).data.preset.id
}

async function createPersona(app: ReturnType<E2eHarness['open']>['app'], body: { name: string; description?: string; metadata?: Record<string, unknown> }): Promise<string> {
  const res = await app.request('/api/v2/personas', { method: 'POST', body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function createChat(app: ReturnType<E2eHarness['open']>['app'], message: string): Promise<string> {
  const chat = (await (await app.request('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: 'S12', systemPrompt: 'S12 系统提示' }) })).json()) as {
    data: { id: string }
  }
  await app.request(`/api/v2/chats/${chat.data.id}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: message }) })
  return chat.data.id
}

async function bindChat(app: ReturnType<E2eHarness['open']>['app'], chatId: string, body: { personaId?: string | null; presetId?: string | null }): Promise<Response> {
  return app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify(body) })
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

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('S12 预设编译顺序(§81)', () => {
  let ctx: ReturnType<typeof openHarness>
  afterEach(() => cleanupHarnesses())

  it('prompt_order 段按序进入 header/injection 区,隐藏段被排除', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const presetId = await importPreset(app, ST_PRESET)
    const chatId = await createChat(app, '你好')
    const bind = await bindChat(app, chatId, { presetId })
    expect(bind.status).toBe(200)

    const { snapshotId } = await startGeneration(app, chatId, [{ text: '你好，世界。' }])
    await wait(80)

    const snap = store.sqlite.prepare('SELECT serialized FROM prompt_snapshots WHERE id = ?').get(snapshotId) as { serialized: string }
    const serialized = snap.serialized
    // 系统提示 + 三段 header + 一段 injection 均在场
    expect(serialized).toContain('S12 系统提示')
    expect(serialized).toContain('A-系统角色设定')
    expect(serialized).toContain('B-玩家档案占位')
    expect(serialized).toContain('C-风格约束')
    expect(serialized).toContain('{{user}} 推门而入')
    // 隐藏段(不在 prompt_order)必须被排除
    expect(serialized).not.toContain('Z-不应出现')

    // §81 顺序:prompt_order 索引即段语义序(header 区内 A<B<C)
    const iA = serialized.indexOf('A-系统角色设定')
    const iB = serialized.indexOf('B-玩家档案占位')
    const iC = serialized.indexOf('C-风格约束')
    expect(iA).toBeLessThan(iB)
    expect(iB).toBeLessThan(iC)

    // 审计:导入报告段数 = 4(prompt_order 实际条目),排除 hidden
    const list = (await (await app.request('/api/v2/presets')).json()) as { data: { id: string; name: string }[] }
    expect(list.data.some((p) => p.id === presetId)).toBe(true)
  })
})

describe('S12 Persona 注入 header 区', () => {
  let ctx: ReturnType<typeof openHarness>
  afterEach(() => cleanupHarnesses())

  it('chat 绑定 persona → 档案渲染进 header 区贡献', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const personaId = await createPersona(app, { name: '艾琳', description: '一名来自北境的猎人。', metadata: { 年龄: 24, 职业: '猎人' } })
    const chatId = await createChat(app, '你好')
    const bind = await bindChat(app, chatId, { personaId })
    expect(bind.status).toBe(200)

    await startGeneration(app, chatId, [{ text: '你好，冒险者。' }])
    await wait(80)

    const snap = store.sqlite.prepare('SELECT serialized FROM prompt_snapshots ORDER BY created_at DESC LIMIT 1').get() as { serialized: string }
    // 渲染档案:姓名行 + 描述 + 结构化 metadata
    expect(snap.serialized).toContain('用户：艾琳')
    expect(snap.serialized).toContain('一名来自北境的猎人。')
    expect(snap.serialized).toContain('年龄：24')
    expect(snap.serialized).toContain('职业：猎人')
  })
})

describe('S12 宏透传 R-P0-1', () => {
  let ctx: ReturnType<typeof openHarness>
  afterEach(() => cleanupHarnesses())

  it('预设段含 {{user}} → 编译产出 MACRO_UNEXPANDED_P0 info 诊断', async () => {
    ctx = openHarness()
    const { app, store } = ctx
    const presetId = await importPreset(app, ST_PRESET)
    const chatId = await createChat(app, '你好')
    await bindChat(app, chatId, { presetId })

    const { snapshotId } = await startGeneration(app, chatId, [{ text: '推门进来。' }])
    await wait(80)

    const diag = store.sqlite.prepare('SELECT diagnostics FROM prompt_snapshots WHERE id = ?').get(snapshotId) as { diagnostics: string }
    const diagnostics = JSON.parse(diag.diagnostics) as { code: string }[]
    expect(diagnostics.some((d) => d.code === 'MACRO_UNEXPANDED_P0')).toBe(true)
  })
})

describe('S12 绑定 API(persona / preset)', () => {
  let ctx: ReturnType<typeof openHarness>
  afterEach(() => cleanupHarnesses())

  it('绑定 persona + preset → 200 回显绑定 id', async () => {
    ctx = openHarness()
    const { app } = ctx
    const personaId = await createPersona(app, { name: 'P' })
    const presetId = await importPreset(app, ST_PRESET)
    const chatId = await createChat(app, 'hi')

    const res = await bindChat(app, chatId, { personaId, presetId })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { personaId: string; presetId: string } }
    expect(body.data.personaId).toBe(personaId)
    expect(body.data.presetId).toBe(presetId)
  })

  it('绑定不存在的 preset → PRESET_NOT_FOUND(404)', async () => {
    ctx = openHarness()
    const { app } = ctx
    const chatId = await createChat(app, 'hi')
    const res = await bindChat(app, chatId, { presetId: 'nope' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PRESET_NOT_FOUND')
  })

  it('绑定不存在的 persona → PERSONA_NOT_FOUND(404)', async () => {
    ctx = openHarness()
    const { app } = ctx
    const chatId = await createChat(app, 'hi')
    const res = await bindChat(app, chatId, { personaId: 'nope' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERSONA_NOT_FOUND')
  })

  it('空绑定体 → VALIDATION_ERROR(400)', async () => {
    ctx = openHarness()
    const { app } = ctx
    const chatId = await createChat(app, 'hi')
    const res = await bindChat(app, chatId, {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('传 null 解除绑定 → 200,绑定字段置空', async () => {
    ctx = openHarness()
    const { app } = ctx
    const personaId = await createPersona(app, { name: 'P' })
    const chatId = await createChat(app, 'hi')
    await bindChat(app, chatId, { personaId })

    const unbind = await bindChat(app, chatId, { personaId: null })
    expect(unbind.status).toBe(200)
    const body = (await unbind.json()) as { data: { personaId: string | null; presetId: string | null } }
    expect(body.data.personaId).toBeNull()
    expect(body.data.presetId).toBeNull()
  })
})
