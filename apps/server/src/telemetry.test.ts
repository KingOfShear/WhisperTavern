import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHarnesses, makeE2eHarness, type E2eHarness } from './harness'

/**
 * S20(WP2.5)缓存遥测 / 二分诊断 / 模拟 API 契约测试 —— api-spec §41 / §42 / §43 / §44。
 *
 * - §41 GET /api/v2/chats/:id/cache/telemetry:每轮实际发送内容 + 命中率曲线 +
 *   cached/prompt 口径(§2.2)+ 前缀过小提示 + §33.2 四层口径 aggregate + Simulator;
 * - §42 GET /api/v2/runs/:id/cache-break:二分层定位 CacheBreak 源(段 + 首个分歧字节)+ 影响 token + 建议;
 * - §43/§44 POST /api/v2/cache/simulate:零 API 成本(只消费已编译快照,不调 Provider)。
 */

type App = ReturnType<E2eHarness['open']>['app']

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function makeChat(app: App, userText = '第一轮输入'): Promise<string> {
  const res = await app.request('/api/v2/chats', {
    method: 'POST',
    body: JSON.stringify({ title: 'S20', systemPrompt: '你是测试叙事者。' }),
  })
  const chat = (await res.json()) as { data: { id: string } }
  await app.request(`/api/v2/chats/${chat.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: userText }),
  })
  return chat.data.id
}

async function makeProvider(app: App, turns: { text: string; cachedInputTokens?: number }[]): Promise<string> {
  const res = await app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: `fake-${Date.now()}-${Math.random()}`,
      type: 'fake',
      models: ['fake-model'],
      fakeTurns: turns,
    }),
  })
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** 建 chat 并跑 n 轮生成,返回 { chatId, runIds }(轮 k 追加一条 user 消息再生成,每轮新 provider) */
async function runRounds(app: App, rounds: number, firstText = '第一轮输入'): Promise<{ chatId: string; runIds: string[] }> {
  const chatId = await makeChat(app, firstText)
  const runIds: string[] = []
  for (let i = 0; i < rounds; i += 1) {
    // 首轮无缓存基线;第二轮起模拟 provider 前缀命中(§33.2 第 3 层 Actual Cached)
    const cachedInputTokens = i === 0 ? 0 : 48
    const providerId = await makeProvider(app, [{ text: `第${i + 1}轮回复`, cachedInputTokens }])
    const res = await app.request(`/api/v2/chats/${chatId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ providerId, model: 'fake-model' }),
    })
    expect(res.status).toBe(200)
    runIds.push(((await res.json()) as { data: { runId: string } }).data.runId)
    await wait(100)
    if (i < rounds - 1) {
      await app.request(`/api/v2/chats/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: `第${i + 2}轮输入` }),
      })
    }
  }
  return { chatId, runIds }
}

interface Envelope<T> {
  data: T
  requestId: string
}

afterEach(() => cleanupHarnesses())

describe('S20 §41 缓存遥测 API', () => {
  it('多轮生成 → 逐轮发送内容 + aggregate 口径 + Simulator 理论缓存率', async () => {
    const { app } = makeE2eHarness().open()
    const { chatId } = await runRounds(app, 3)

    const res = await app.request(`/api/v2/chats/${chatId}/cache/telemetry`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{
      rounds: {
        round: number
        promptTokens: number
        cachedTokens: number
        outputTokens: number
        usageSource: string
        stablePrefixTokens: number
        freshTokens: number
        volatileTokens: number
        prefixTooSmall?: { threshold: number; actualTokens: number }
        breakReasons: string[]
        sentParts: { role: string | null; content: string }[]
        sentTokenCount: number
        sentHash: string
        segmentCount: number
      }[]
      aggregate: {
        stableTokens: number
        eligibleTokens: number
        cachedTokens: number
        freshTokens: number
        theoreticalHitRate: number
        actualHitRate?: number
      }
      cacheBreaks: { round: number; reasons: string[] }[]
      simulator: {
        theoreticalHitRatio: number
        actualHitRatio?: number
        baselineInputTokens: number
        uncachedInputTokens: number
        inputCostReduction: number
        topCacheKillers: { reason: string; count: number }[]
        rounds: { round: number; theoreticalCachedTokens: number; cacheBreak: boolean }[]
      }
    }>

    expect(data.rounds.length).toBe(3)
    for (const r of data.rounds) {
      expect(r.promptTokens).toBeGreaterThan(0)
      expect(r.usageSource).toBe('reported')
      expect(r.stablePrefixTokens).toBeGreaterThan(0)
      expect(r.volatileTokens).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(r.breakReasons)).toBe(true)
      // §7 任务 1「每轮实际发送内容」:serialized.parts 投影 + 哈希锚点
      expect(r.sentParts.length).toBeGreaterThan(0)
      expect(r.sentParts.every((p) => typeof p.content === 'string')).toBe(true)
      expect(r.sentTokenCount).toBeGreaterThan(0)
      expect(r.sentHash.length).toBeGreaterThan(0)
      expect(r.segmentCount).toBeGreaterThan(0)
    }
    // history 追加式:第 2 轮发送块数不少于第 1 轮,且哈希必不同
    expect(data.rounds[1]!.sentParts.length).toBeGreaterThanOrEqual(data.rounds[0]!.sentParts.length)
    expect(data.rounds[1]!.sentHash).not.toBe(data.rounds[0]!.sentHash)

    // §41 aggregate:plan 计理论面 + provider 计实际面并列
    expect(data.aggregate.stableTokens).toBeGreaterThan(0)
    expect(data.aggregate.eligibleTokens).toBeGreaterThan(0)
    expect(data.aggregate.cachedTokens).toBeGreaterThan(0)
    expect(data.aggregate.actualHitRate).toBeGreaterThan(0)
    expect(data.aggregate.theoreticalHitRate).toBeGreaterThan(0)

    // Simulator:理论承接从第 2 轮起(首轮无基线),金样抓出的缺陷回归
    expect(data.simulator.rounds[0]!.theoreticalCachedTokens).toBe(0)
    expect(data.simulator.rounds[0]!.cacheBreak).toBe(false)
    expect(data.simulator.rounds[1]!.theoreticalCachedTokens).toBeGreaterThan(0)
    expect(data.simulator.theoreticalHitRatio).toBeGreaterThan(0)
    expect(data.simulator.inputCostReduction).toBeGreaterThan(0)
    expect(data.simulator.inputCostReduction).toBeLessThan(1)
    // 理论新鲜恒非负(两套口径混算回归)
    expect(data.aggregate.eligibleTokens).toBeGreaterThanOrEqual(0)
    // §33.2 首轮无缓存可毁:失效事件不得落在第 1 轮
    expect(data.cacheBreaks.every((b) => b.round >= 2)).toBe(true)
  })

  it('§41 Query from/to 时间窗过滤', async () => {
    const { app } = makeE2eHarness().open()
    const { chatId } = await runRounds(app, 2)
    const future = await app.request(`/api/v2/chats/${chatId}/cache/telemetry?from=2099-01-01T00:00:00.000Z`)
    const futureBody = (await future.json()) as Envelope<{ rounds: unknown[] }>
    expect(future.status).toBe(200)
    expect(futureBody.data.rounds).toEqual([])
  })

  it('chat 不存在 → 404', async () => {
    const { app } = makeE2eHarness().open()
    const res = await app.request('/api/v2/chats/chat_nope/cache/telemetry')
    expect(res.status).toBe(404)
  })

  it('空会话(无 run)→ rounds 空 + 命中率 undefined + Simulator 空', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const res = await app.request(`/api/v2/chats/${chatId}/cache/telemetry`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{
      rounds: unknown[]
      aggregate: { theoreticalHitRate: number; actualHitRate?: number }
      simulator: { theoreticalHitRatio: number; inputCostReduction: number; topCacheKillers: unknown[]; rounds: unknown[] }
    }>
    expect(data.rounds).toEqual([])
    expect(data.aggregate.actualHitRate).toBeUndefined()
    expect(data.simulator.theoreticalHitRatio).toBe(0)
    expect(data.simulator.inputCostReduction).toBe(0)
    expect(data.simulator.topCacheKillers).toEqual([])
    expect(data.simulator.rounds).toEqual([])
  })
})

describe('S20 §42 缓存二分诊断 API', () => {
  it('两轮生成 → 定位首分歧段 + 首个分歧字节 + 影响 token + 建议', async () => {
    const { app } = makeE2eHarness().open()
    const { runIds } = await runRounds(app, 2)
    const res = await app.request(`/api/v2/runs/${runIds[1]}/cache-break`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{
      broken: boolean
      firstDivergence?: { segmentId: string; byteOffset: number; reason: string; sourceId?: string }
      affectedTokens: number
      suggestions: string[]
    }>
    // 两轮之间追加了 user 消息 → 必然产生新增段(新增也是分歧)
    expect(data.broken).toBe(true)
    expect(data.firstDivergence?.segmentId).toBeDefined()
    expect(typeof data.firstDivergence?.byteOffset).toBe('number')
    expect(data.firstDivergence!.byteOffset).toBeGreaterThanOrEqual(0)
    expect(data.affectedTokens).toBeGreaterThan(0)
    expect(data.suggestions.length).toBeGreaterThan(0)
  })

  it('首轮 run → broken false(无前置缓存可破坏,§33)', async () => {
    const { app } = makeE2eHarness().open()
    const { runIds } = await runRounds(app, 1)
    const res = await app.request(`/api/v2/runs/${runIds[0]}/cache-break`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{ broken: boolean; affectedTokens: number; suggestions: string[] }>
    expect(data.broken).toBe(false)
    expect(data.affectedTokens).toBe(0)
    expect(data.suggestions.length).toBeGreaterThan(0)
  })

  it('run 不存在 → 404', async () => {
    const { app } = makeE2eHarness().open()
    const res = await app.request('/api/v2/runs/run_nope/cache-break')
    expect(res.status).toBe(404)
  })
})

describe('S20 §43/§44 缓存模拟 API(零 API 成本)', () => {
  it('POST /cache/simulate → 预期缓存率 + 失效总量(不调 Provider)', async () => {
    const { app } = makeE2eHarness().open()
    const { chatId } = await runRounds(app, 3)
    const res = await app.request('/api/v2/cache/simulate', {
      method: 'POST',
      body: JSON.stringify({ chatId, rounds: 10 }),
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{
      rounds: { round: number; stableTokens: number; freshTokens: number; volatileTokens: number; prefixHash: string; theoreticalCachedTokens: number }[]
      aggregate: { expectedCacheRatio: number; totalInvalidatedTokens: number }
      simulator: { theoreticalHitRatio: number; inputCostReduction: number }
      unsupportedScenarios: string[]
    }>
    expect(data.rounds.length).toBe(3)
    expect(data.rounds[2]!.prefixHash.length).toBeGreaterThan(0)
    expect(data.rounds[0]!.theoreticalCachedTokens).toBe(0)
    expect(data.rounds[1]!.theoreticalCachedTokens).toBeGreaterThan(0)
    expect(data.aggregate.expectedCacheRatio).toBe(data.simulator.theoreticalHitRatio)
    expect(data.aggregate.expectedCacheRatio).toBeGreaterThan(0)
    expect(data.aggregate.totalInvalidatedTokens).toBeGreaterThanOrEqual(0)
    // §43 scenarios 属确定性回放(S21):回显未支持项
    expect(data.unsupportedScenarios).toEqual([])
  })

  it('rounds 窗口 → 只聚合最近 N 轮', async () => {
    const { app } = makeE2eHarness().open()
    const { chatId } = await runRounds(app, 3)
    const res = await app.request('/api/v2/cache/simulate', {
      method: 'POST',
      body: JSON.stringify({ chatId, rounds: 2 }),
    })
    const { data } = (await res.json()) as Envelope<{ rounds: unknown[] }>
    expect(data.rounds.length).toBe(2)
  })

  it('缺 chatId → 400;chat 不存在 → 404', async () => {
    const { app } = makeE2eHarness().open()
    const missing = await app.request('/api/v2/cache/simulate', { method: 'POST', body: JSON.stringify({}) })
    expect(missing.status).toBe(400)
    const notFound = await app.request('/api/v2/cache/simulate', {
      method: 'POST',
      body: JSON.stringify({ chatId: 'chat_nope' }),
    })
    expect(notFound.status).toBe(404)
  })
})