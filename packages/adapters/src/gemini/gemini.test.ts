import { describe, expect, it } from 'vitest'
import type { ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { GeminiAdapter, type FetchLike, type ProviderHttpResponse } from '../index'

const API_KEY = 'gem-test-key-123456'

function baseRequest(): ProviderChatRequest {
  return {
    snapshotId: 'snap_gem_1',
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: 'sys line' },
      { role: 'user', content: '你好' },
    ],
    sampling: { maxOutputTokens: 256 },
    stream: true,
  }
}

function adapter(fetchImpl: FetchLike): GeminiAdapter {
  return new GeminiAdapter({
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: API_KEY,
    fetchImpl,
    timeouts: { connectMs: 200, firstTokenMs: 200, idleMs: 200 },
  })
}

const encoder = new TextEncoder()

/** 合法 Gemini 流帧:usageMetadata 定稿 + STOP,保证 usage reported + finish stop */
function geminiFrame(): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
  })}\n\n`
}

function sseResponse(): ProviderHttpResponse {
  const body = (async function* () {
    yield encoder.encode(geminiFrame())
  })()
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body,
    text: async () => geminiFrame(),
  }
}

async function collect(adapter: GeminiAdapter, req: ProviderChatRequest): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of adapter.stream(req)) events.push(event)
  return events
}

describe('gemini:S19 §16 context-cache 家族无动作(开放点 1:显式 cachedContent 暂缓)', () => {
  it('capabilities:gemini 全族 context-cache', () => {
    const a = adapter(async () => sseResponse())
    expect(a.capabilities('gemini-2.5-flash').cacheType).toBe('context-cache')
  })

  it('收到 cachePlan(显式断点指令) → wire body 与无 cachePlan 逐字节一致,不注入缓存字段', async () => {
    async function captureBody(req: ProviderChatRequest): Promise<Record<string, unknown>> {
      let captured: { init: RequestInit } | undefined
      const a = adapter(async (_url, init) => {
        captured = { init }
        return sseResponse()
      })
      await collect(a, req)
      return JSON.parse(String(captured?.init.body)) as Record<string, unknown>
    }
    const withPlan = await captureBody({
      ...baseRequest(),
      cachePlan: {
        version: 1,
        breakpoints: [{ afterSegmentId: 'h', afterPartIndex: 0, reason: 'automatic' }],
        stableZoneTokens: 2048,
      },
    })
    const baseline = await captureBody(baseRequest())
    expect(JSON.stringify(withPlan)).toBe(JSON.stringify(baseline))
    expect(JSON.stringify(withPlan)).not.toContain('cached')
    expect(JSON.stringify(withPlan)).not.toContain('cache')
  })
})
