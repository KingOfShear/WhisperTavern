import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHarnesses, makeE2eHarness, type E2eHarness } from './harness'
import { FakeProviderAdapter } from '@whispertavern/adapters'
import type { ProviderChatRequest } from '@whispertavern/contracts'

/**
 * S14(WP1.5)契约测试 —— api-spec §107 Inspector / §38 Prompt Diff /
 * §36 快照列表 / §60 debug 导出(还账 #15 RedactionPolicy + PV5)+ 可回放验收:
 * 导出 bundle.messages 直接构造 ProviderChatRequest 喂 FakeProviderAdapter。
 */

type App = ReturnType<E2eHarness['open']>['app']

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function makeChat(app: App, userText = '第一轮输入'): Promise<string> {
  const res = await app.request('/api/v2/chats', {
    method: 'POST',
    body: JSON.stringify({ title: 'S14', systemPrompt: '你是测试叙事者。' }),
  })
  const chat = (await res.json()) as { data: { id: string } }
  await app.request(`/api/v2/chats/${chat.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: userText }),
  })
  return chat.data.id
}

async function makeProvider(app: App, turns: { text: string }[], apiKey?: string): Promise<string> {
  const res = await app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: `fake-${Date.now()}-${Math.random()}`,
      type: 'fake',
      models: ['fake-model'],
      fakeTurns: turns,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
  })
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function generate(
  app: App,
  chatId: string,
  providerId: string,
  body: Record<string, unknown> = {},
): Promise<{ runId: string; snapshotId: string }> {
  const res = await app.request(`/api/v2/chats/${chatId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model: 'fake-model', ...body }),
  })
  expect(res.status).toBe(200)
  const data = (await res.json()) as { data: { runId: string; snapshotId: string } }
  await wait(120)
  return { runId: data.data.runId, snapshotId: data.data.snapshotId }
}

interface Envelope<T> {
  data: T
  requestId: string
}

afterEach(() => cleanupHarnesses())

describe('S14 §107 Prompt Inspector API', () => {
  it('run → snapshot + cache + provider + usage + diagnostics + durable 事件全投影', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, [{ text: '第一轮回复' }])
    const { runId, snapshotId } = await generate(app, chatId, providerId)

    const res = await app.request(`/api/v2/runs/${runId}/inspector`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{
      snapshot: { id: string; ir: { segments: unknown[] }; serialized: { tokenCount: number } }
      cache: unknown
      provider: { id: string; model: string }
      usage?: { inputTokens: number; outputTokens: number; source: string }
      warnings: { level: string }[]
      diagnostics: { level: string }[]
      events: { type: string }[]
    }>
    expect(data.snapshot.id).toBe(snapshotId)
    expect(data.snapshot.ir.segments.length).toBeGreaterThan(0)
    expect(data.snapshot.serialized.tokenCount).toBeGreaterThan(0)
    expect(data.provider).toEqual({ id: providerId, model: 'fake-model' })
    expect(data.usage).toBeDefined()
    expect(data.usage?.inputTokens).toBeGreaterThan(0)
    expect(data.usage?.source).toBe('reported') // fake 自报口径
    // diagnostics 必须成数组且每项含 level(原三元恒走 expect.anything() 退化为无效断言)
    expect(Array.isArray(data.diagnostics)).toBe(true)
    for (const d of data.diagnostics) {
      expect(typeof d.level).toBe('string')
    }
    expect(data.events.map((e) => e.type)).toContain('generation.started')
    expect(data.events.map((e) => e.type)).toContain('generation.completed')
    expect(data.events.map((e) => e.type)).toContain('prompt.snapshot.created')
  })

  it('run 不存在 → 404 GENERATION_NOT_FOUND(§8 映射)', async () => {
    const { app } = makeE2eHarness().open()
    const res = await app.request('/api/v2/runs/run_nope/inspector')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GENERATION_NOT_FOUND')
  })
})

describe('S14 §38 Prompt Diff(相邻两轮)', () => {
  it('第二轮新增历史/尾段:added 记录 + firstDivergence + tokenDelta 三项', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app, '第一轮输入')
    const providerA = await makeProvider(app, [{ text: '第一轮回复' }])
    const round1 = await generate(app, chatId, providerA)

    // 第二轮:追加 user 消息再生成(每轮一个 provider,S13 踩坑沉淀)
    await app.request(`/api/v2/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: '第二轮输入' }),
    })
    const providerB = await makeProvider(app, [{ text: '第二轮回复' }])
    const round2 = await generate(app, chatId, providerB)
    expect(round2.snapshotId).not.toBe(round1.snapshotId)

    const res = await app.request(`/api/v2/prompt-snapshots/${round1.snapshotId}/diff/${round2.snapshotId}`)
    expect(res.status).toBe(200)
    const { data: diff } = (await res.json()) as Envelope<{
      snapshotAId: string
      snapshotBId: string
      segments: { kind: string; segmentId: string; after?: { contentHash: string } }[]
      firstDivergence?: { segmentId: string }
      tokenDelta: { input: number; cached: number; fresh: number }
      cacheBreak?: { type: string }
    }>
    expect(diff.snapshotAId).toBe(round1.snapshotId)
    expect(diff.snapshotBId).toBe(round2.snapshotId)
    const kinds = new Set(diff.segments.map((s) => s.kind))
    expect(kinds.has('added')).toBe(true) // 新 assistant 回复 + 新 user 尾段
    expect(kinds.has('same')).toBe(true) // header/首轮 user 消息逐段一致
    expect(diff.firstDivergence).toBeDefined()
    expect(diff.tokenDelta.input).toBeGreaterThan(0)
    expect(diff.tokenDelta.cached).toBeGreaterThan(0)
    expect(diff.tokenDelta.fresh).toBeGreaterThan(0)
  })

  it('同快照自比:全 same、无 firstDivergence、tokenDelta 全 0、无 cacheBreak', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, [{ text: '回复' }])
    const { snapshotId } = await generate(app, chatId, providerId)

    const res = await app.request(`/api/v2/prompt-snapshots/${snapshotId}/diff/${snapshotId}`)
    expect(res.status).toBe(200)
    const { data: diff } = (await res.json()) as Envelope<{
      segments: { kind: string }[]
      firstDivergence?: unknown
      tokenDelta: { input: number; cached: number; fresh: number }
      cacheBreak?: unknown
    }>
    expect(diff.segments.every((s) => s.kind === 'same')).toBe(true)
    expect(diff.segments.length).toBeGreaterThan(0)
    expect(diff.firstDivergence).toBeUndefined()
    expect(diff.tokenDelta).toEqual({ input: 0, cached: expect.any(Number), fresh: 0 })
    expect(diff.cacheBreak).toBeUndefined()
  })

  it('任一侧快照不存在 → 404', async () => {
    const { app } = makeE2eHarness().open()
    const res = await app.request('/api/v2/prompt-snapshots/snap_nope/diff/snap_nope2')
    expect(res.status).toBe(404)
  })

  it('§36 修订:会话快照列表按 createdAt 降序,含 tokenCount', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app, '第一轮输入')
    const providerA = await makeProvider(app, [{ text: '第一轮回复' }])
    await generate(app, chatId, providerA)
    await app.request(`/api/v2/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: '第二轮输入' }),
    })
    const providerB = await makeProvider(app, [{ text: '第二轮回复' }])
    await generate(app, chatId, providerB)

    const res = await app.request(`/api/v2/chats/${chatId}/prompt-snapshots`)
    expect(res.status).toBe(200)
    const { data: list } = (await res.json()) as Envelope<{ id: string; tokenCount: number; createdAt: string }[]>
    expect(list).toHaveLength(2)
    expect(list[0]!.createdAt >= list[1]!.createdAt).toBe(true)
    expect(list.every((s) => s.tokenCount > 0)).toBe(true)
  })
})

describe('S14 还账 #15 Sanitized Debug Export', () => {
  it('默认 sanitized:用户/角色正文去内容、ID 匿名化(原始 ID 零出现)、结构保留', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app, '第一轮输入')
    const providerId = await makeProvider(app, [{ text: '回复正文' }])
    const { snapshotId } = await generate(app, chatId, providerId)

    const res = await app.request('/api/v2/debug/export', {
      method: 'POST',
      body: JSON.stringify({ resourceType: 'snapshot', resourceId: snapshotId }),
    })
    expect(res.status).toBe(200)
    const { data: bundle } = (await res.json()) as Envelope<{
      format: string
      version: number
      policy: { mode: string; stripUserContent: boolean; anonymizeIds: boolean }
      snapshot: { chatId: string; tokenCount: number; hashes: Record<string, string> }
      segments: { id: string; role: string; zone: string; content?: string }[]
      messages: { role: string; content: string }[]
      idMap: Record<string, string>
      diagnostics: unknown[]
    }>
    expect(bundle.format).toBe('whispertavern-debug-bundle')
    expect(bundle.policy).toEqual({ mode: 'sanitized', stripUserContent: true, anonymizeIds: true, redactSecrets: true })

    const raw = JSON.stringify(bundle)
    // 去用户内容:user 输入与角色发言正文不出模块(§19)
    expect(raw).not.toContain('第一轮输入')
    expect(raw).toContain('[user-content removed]')
    // 配置层(system prompt)保留——结构调试价值
    expect(raw).toContain('你是测试叙事者。')
    // 匿名化:原始 chat id 零出现(含段 ID 内嵌)
    expect(raw).not.toContain(chatId)
    expect(bundle.snapshot.chatId).toMatch(/^redact-/)
    expect(bundle.segments.every((s) => !s.id.includes(chatId))).toBe(true)
    expect(bundle.idMap).toEqual({})

    // 结构保留:段数/角色/分区逐段在案
    expect(bundle.segments.length).toBeGreaterThan(0)
    expect(bundle.segments.some((s) => s.zone === 'tail')).toBe(true)
    expect(bundle.messages.length).toBe(bundle.segments.length)
  })

  it('full 模式:正文保留但 PV5 密钥必被 redact(已知密钥表 + 通用形态)', async () => {
    const { app } = makeE2eHarness().open()
    // 密钥不在 system prompt 时也要被拦:放进 user 正文,走 full 模式验证 redact 不可关闭
    const chatId = await makeChat(app, '检查我的密钥 sk-abcdef12345678 与 TOKEN9Z8Y7X6W5V')
    const providerId = await makeProvider(app, [{ text: '回复正文' }], 'SECRET-VALUE-0123456789')
    const { snapshotId } = await generate(app, chatId, providerId)

    const res = await app.request('/api/v2/debug/export', {
      method: 'POST',
      body: JSON.stringify({ resourceType: 'snapshot', resourceId: snapshotId, policy: { mode: 'full' } }),
    })
    expect(res.status).toBe(200)
    const { data: bundle } = (await res.json()) as Envelope<{
      policy: { mode: string; stripUserContent: boolean; anonymizeIds: boolean }
      snapshot: { chatId: string }
      messages: { content: string }[]
    }>
    expect(bundle.policy.mode).toBe('full')
    expect(bundle.policy.stripUserContent).toBe(false)
    expect(bundle.policy.anonymizeIds).toBe(false)

    const raw = JSON.stringify(bundle)
    expect(raw).toContain('检查我的密钥') // full 保留正文
    expect(raw).toContain(bundle.snapshot.chatId) // full 不匿名化
    // PV5:sk- 形态、已知密钥值全部替换
    expect(raw).not.toContain('sk-abcdef12345678')
    expect(raw).not.toContain('SECRET-VALUE-0123456789')
  })

  it('exported messages 可构造合法 ProviderChatRequest 并回放(结构保真)', async () => {
    const { app } = makeE2eHarness().open()
    const userText = '第一轮输入'
    const chatId = await makeChat(app, userText)
    const providerId = await makeProvider(app, [{ text: '回放验收正文' }])
    const { snapshotId } = await generate(app, chatId, providerId)

    // full 模式:正文保留,验证导出确实承载了可回放的真实 prompt(而非 sanitized 占位符)
    const res = await app.request('/api/v2/debug/export', {
      method: 'POST',
      body: JSON.stringify({ resourceType: 'snapshot', resourceId: snapshotId, policy: { mode: 'full' } }),
    })
    expect(res.status).toBe(200)
    const { data: bundle } = (await res.json()) as Envelope<{
      snapshot: { model: string }
      messages: { role: string; content: string }[]
    }>
    expect(bundle.messages.length).toBeGreaterThan(0)
    // 真实正文确实在(否则无法"回放同轮")
    expect(JSON.stringify(bundle)).toContain(userText)
    // 结构保真:角色均为合法 chat 角色,无 tool(投影规则:tool 跳过)
    const validRoles = new Set(['system', 'user', 'assistant'])
    expect(bundle.messages.every((m) => validRoles.has(m.role))).toBe(true)

    // 可回放:与 buildGenerationRequest 同一投影规则构造请求,喂 FakeProviderAdapter
    const messages = bundle.messages
      .filter((m) => m.role !== 'tool')
      .map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }))
    const adapter = new FakeProviderAdapter([{ text: '回放验收正文' }])
    const request: ProviderChatRequest = {
      snapshotId,
      model: bundle.snapshot.model,
      messages,
      sampling: { maxOutputTokens: 1024 },
      stream: true,
    }
    let replayed = ''
    let finishReason: string | undefined
    for await (const event of adapter.stream(request)) {
      if (event.type === 'text_delta') replayed += event.text
      if (event.type === 'finish') finishReason = event.reason
    }
    // 请求结构合法 → 适配器流到终态(fake 无视输入,但形状错会抛)
    expect(finishReason).toBe('stop')
    expect(replayed).toBe('回放验收正文')
  })

  it('快照不存在 → 404;resourceType 非法 → 400', async () => {
    const { app } = makeE2eHarness().open()
    const missing = await app.request('/api/v2/debug/export', {
      method: 'POST',
      body: JSON.stringify({ resourceType: 'snapshot', resourceId: 'snap_nope' }),
    })
    expect(missing.status).toBe(404)
    const badType = await app.request('/api/v2/debug/export', {
      method: 'POST',
      body: JSON.stringify({ resourceType: 'chat', resourceId: 'whatever' }),
    })
    expect(badType.status).toBe(400)
  })
})
