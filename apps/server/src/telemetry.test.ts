import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHarnesses, makeE2eHarness, type E2eHarness } from './harness'

/**
 * S20(WP2.5)遥测 API 契约测试 —— 总设计 §33 / p2-plan §7 任务 1。
 * GET /api/v2/chats/:id/telemetry:命中率曲线(input/cached/output per round)+
 * §33.2 四层口径汇总 + §33.3 CacheBreak 事件 + Simulator 理论缓存率/成本削减/Killer。
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

/** 建 chat 并跑 n 轮生成,返回 chatId(轮 k 追加一条 user 消息再生成,每轮新 provider) */
async function runRounds(app: App, rounds: number, firstText = '第一轮输入'): Promise<string> {
  const chatId = await makeChat(app, firstText)
  for (let i = 0; i < rounds; i += 1) {
    // 首轮无缓存基线;第二轮起模拟 provider 前缀命中(§33.2 第 3 层 Actual Cached)
    const cachedInputTokens = i === 0 ? 0 : 48
    const providerId = await makeProvider(app, [{ text: `第${i + 1}轮回复`, cachedInputTokens }])
    const res = await app.request(`/api/v2/chats/${chatId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ providerId, model: 'fake-model' }),
    })
    expect(res.status).toBe(200)
    await wait(100)
    if (i < rounds - 1) {
      await app.request(`/api/v2/chats/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: `第${i + 2}轮输入` }),
      })
    }
  }
  return chatId
}

interface Envelope<T> {
  data: T
  requestId: string
}

afterEach(() => cleanupHarnesses())

describe('S20 §33 遥测与缓存诊断 API', () => {
  it('多轮生成 → rounds 曲线 + summary 命中率口径 + Simulator 理论缓存率', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await runRounds(app, 3)

    const res = await app.request(`/api/v2/chats/${chatId}/telemetry`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{
      rounds: {
        round: number
        inputTokens: number
        cachedTokens: number
        outputTokens: number
        usageSource: string
        stablePrefixTokens: number
        freshTokens: number
        prefixTooSmall?: unknown
        breakReasons: string[]
      }[]
      summary: {
        costEstimate: {
          baselineInputTokens: number
          cachedInputTokens: number
          freshInputTokens: number
          reportedHitRatio?: number
          overallHitRatio?: number
        }
        cacheBreaks: { round: number; reasons: string[] }[]
      }
      simulator: {
        theoreticalHitRatio: number
        actualHitRatio?: number
        baselineInputTokens: number
        cachedInputTokens: number
        inputCostReduction: number
        topCacheKillers: { reason: string; count: number }[]
      }
    }>

    expect(data.rounds.length).toBe(3)
    // 每轮都应有 usage(reported 是 fake 自报口径)与缓存计划
    for (const r of data.rounds) {
      expect(r.inputTokens).toBeGreaterThan(0)
      expect(r.usageSource).toBe('reported')
      expect(r.stablePrefixTokens).toBeGreaterThan(0)
      expect(Array.isArray(r.breakReasons)).toBe(true)
    }
    // §33.2 四层口径:reported 命中率在有 usage 时必定义
    expect(data.summary.costEstimate.baselineInputTokens).toBeGreaterThan(0)
    expect(data.summary.costEstimate.reportedHitRatio).toBeDefined()
    expect(data.summary.costEstimate.reportedHitRatio!).toBeGreaterThan(0)
    // Simulator:消费真实产物,理论缓存率 > 0(至少第二轮起有 stable 前缀承接)
    expect(data.simulator.theoreticalHitRatio).toBeGreaterThan(0)
    expect(data.simulator.baselineInputTokens).toBe(data.summary.costEstimate.baselineInputTokens)
    expect(data.simulator.inputCostReduction).toBeGreaterThan(0)
    expect(data.simulator.inputCostReduction).toBeLessThan(1)
    expect(data.simulator.topCacheKillers).toBeDefined()
  })

  it('chat 不存在 → 404', async () => {
    const { app } = makeE2eHarness().open()
    const res = await app.request('/api/v2/chats/chat_nope/telemetry')
    expect(res.status).toBe(404)
  })

  it('空会话(无 run)→ rounds 空 + 命中率 undefined + Simulator 空', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const res = await app.request(`/api/v2/chats/${chatId}/telemetry`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Envelope<{
      rounds: unknown[]
      summary: { costEstimate: { reportedHitRatio?: number } }
      simulator: { theoreticalHitRatio: number; inputCostReduction: number; topCacheKillers: unknown[] }
    }>
    expect(data.rounds).toEqual([])
    expect(data.summary.costEstimate.reportedHitRatio).toBeUndefined()
    expect(data.simulator.theoreticalHitRatio).toBe(0)
    expect(data.simulator.inputCostReduction).toBe(0)
    expect(data.simulator.topCacheKillers).toEqual([])
  })
})