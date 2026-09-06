import { describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@desiregrimoire/contracts'
import { OpenAICompatAdapter, type FetchLike, type ProviderHttpResponse } from '../index'

const API_KEY = 'sk-test-1234567890abcdef'

function baseRequest(): ProviderChatRequest {
  return {
    snapshotId: 'snap_oc_1',
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
    ],
    sampling: { maxOutputTokens: 256 },
    stream: true,
  }
}

function adapter(fetchImpl: FetchLike, overrides?: Partial<ProviderCapabilities>) {
  return new OpenAICompatAdapter({
    baseUrl: 'https://relay.example/v1',
    apiKey: API_KEY,
    fetchImpl,
    capabilityOverrides: overrides,
    timeouts: { connectMs: 200, firstTokenMs: 200, idleMs: 200 },
  })
}

const encoder = new TextEncoder()

function sseResponse(frames: string[], options?: { contentType?: string; retryAfter?: string; status?: number }): ProviderHttpResponse {
  const body = (async function* () {
    for (const frame of frames) yield encoder.encode(frame)
  })()
  return {
    ok: (options?.status ?? 200) >= 200 && (options?.status ?? 200) < 300,
    status: options?.status ?? 200,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') return options?.contentType ?? 'text/event-stream'
        if (name.toLowerCase() === 'retry-after') return options?.retryAfter ?? null
        return null
      },
    },
    body,
    text: async () => frames.join(''),
  }
}

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`
}

function usageFrame(usage: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`
}

async function collect(adapter: OpenAICompatAdapter, req: ProviderChatRequest): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of adapter.stream(req)) events.push(event)
  return events
}

describe('openai-compat:SSE 归一流(T1/T4,§8.1/§8.2)', () => {
  it('T1:纯文本流 delta 逐字节原样(PV1)+ 顺序不变量', async () => {
    const text = '你好,世界!The quick fox.'
    const events = await collect(
      adapter(async () => sseResponse([chunk('你好,'), chunk('世界!'), chunk(text.slice(6)), usageFrame({
        prompt_tokens: 12,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 0 },
      })])),
      baseRequest(),
    )
    expect(events[0]).toEqual({ type: 'message_start' })
    expect(
      eventsOf(events, 'text_delta').map((e) => e.text).join(''),
    ).toBe(text)
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 9,
      cachedInputTokens: 4,
      source: 'reported',
    })
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' })
    // §8.1:usage 恰一次且在 finish 前
    expect(eventsOf(events, 'usage')).toHaveLength(1)
    expect(events.findIndex((e) => e.type === 'usage')).toBeLessThan(events.length - 1)
  })

  it('PV8/DeepSeek:reasoning_content → reasoning_delta,先于 text_delta', async () => {
    const events = await collect(
      adapter(async () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一步' }, finish_reason: null }] })}\n\n`,
          chunk('答案'),
          usageFrame({ prompt_tokens: 5, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } }),
        ])),
      baseRequest(),
    )
    const types = events.map((e) => e.type)
    expect(types.indexOf('reasoning_delta')).toBeGreaterThan(0)
    expect(types.indexOf('reasoning_delta')).toBeLessThan(types.indexOf('text_delta'))
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage.reasoningTokens).toBe(2)
  })

  it('T4/DeepSeek:prompt_cache_hit_tokens 归一为 cachedInputTokens(总设计 §18.3)', async () => {
    const events = await collect(
      adapter(async () => sseResponse([chunk('x'), usageFrame({ prompt_tokens: 100, completion_tokens: 3, prompt_cache_hit_tokens: 88 })])),
      baseRequest(),
    )
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage.cachedInputTokens).toBe(88)
  })
})

describe('openai-compat:usage 降级与取消(T5/T6)', () => {
  it('T5:usage 缺帧(本地端点)→ estimated 降级,正数计数', async () => {
    const events = await collect(
      adapter(async () => sseResponse([chunk('回答正文')])),
      baseRequest(),
    )
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage.source).toBe('estimated')
    expect(usage?.usage.inputTokens).toBeGreaterThan(0)
    expect(usage?.usage.outputTokens).toBeGreaterThan(0)
  })

  it('T6:signal 已中止 → partial 照常发出 + CANCELLED 终止,无 finish(PV6)', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(
      adapter(async () => sseResponse([chunk('不应产出')])),
      { ...baseRequest(), signal: controller.signal },
    )
    expect(events[0]).toEqual({ type: 'message_start' })
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    const last = events.at(-1)
    if (last?.type === 'error') expect(last.error.code).toBe('CANCELLED')
    expect(events.some((e) => e.type === 'finish')).toBe(false)
  })

  it('T6:流中途取消(AbortError)→ 已收 delta 保留 + CANCELLED', async () => {
    const controller = new AbortController()
    const fetchImpl: FetchLike = async () => {
      const body = (async function* () {
        yield encoder.encode(chunk('部分内容'))
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('The operation was aborted')
      })()
      return sseResponse([]) && { ...sseResponse([]), body }
    }
    const events = await collect(adapter(fetchImpl), { ...baseRequest(), signal: controller.signal })
    const text = eventsOf(events, 'text_delta').map((e) => e.text).join('')
    expect(text).toBe('部分内容')
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.error.code).toBe('CANCELLED')
  })
})

describe('openai-compat:错误分类(T10/T12,§12 表驱动)', () => {
  it('T12:400 context_length → CONTEXT_TOO_LARGE,不自动重试', async () => {
    const fetchImpl: FetchLike = async () => sseResponse([], { status: 400, contentType: 'application/json' })
    // 400 分支走 text();此处 body 需要错误文案
    const a = adapter(async () => ({ ...sseResponse([], { status: 400, contentType: 'application/json' }), text: async () => '{"error":{"message":"maximum context length exceeded"}}' }))
    await expect(collect(a, baseRequest())).rejects.toMatchObject({
      code: 'CONTEXT_TOO_LARGE',
      retryable: false,
    })
    void fetchImpl
  })

  it('401 → AUTH_INVALID(keyRotatable);429 + Retry-After → RATE_LIMIT(retryAfterMs)', async () => {
    const unauthorized = adapter(async () => ({
      ...sseResponse([], { status: 401, contentType: 'application/json' }),
      text: async () => '{"error":{"message":"invalid api key"}}',
    }))
    await expect(collect(unauthorized, baseRequest())).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      retryable: false,
      keyRotatable: true,
    })

    const limited = adapter(async () => ({
      ...sseResponse([], { status: 429, contentType: 'application/json', retryAfter: '3' }),
      text: async () => '{"error":{"message":"rate limit exceeded"}}',
    }))
    await expect(collect(limited, baseRequest())).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
      keyRotatable: true,
      retryAfterMs: 3000,
    })
  })

  it('T10:伪造 200(HTML / 非 SSE JSON)→ PARSE_ERROR,不当空流成功', async () => {
    const html = adapter(async () => sseResponse(['<html>blocked by gateway</html>'], { contentType: 'text/html' }))
    await expect(collect(html, baseRequest())).rejects.toMatchObject({ code: 'PARSE_ERROR' })

    const notSse = adapter(async () => sseResponse(['{"choices":[]}'], { contentType: 'application/json' }))
    await expect(collect(notSse, baseRequest())).rejects.toMatchObject({ code: 'PARSE_ERROR' })
  })

  it('200 + 错误 JSON(insufficient_quota)→ QUOTA_EXCEEDED(R5 分类)', async () => {
    const quota = adapter(async () => ({
      ...sseResponse([], { contentType: 'application/json' }),
      text: async () => '{"error":{"code":"insufficient_quota","message":"You exceeded your quota"}}',
    }))
    await expect(collect(quota, baseRequest())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('PV5:redact——错误 detail 不含 API key 明文', async () => {
    const leaky = adapter(async () => ({
      ...sseResponse([], { status: 500, contentType: 'application/json' }),
      text: async () => `{"error":{"message":"upstream auth failed for ${API_KEY} at gateway"}}`,
    }))
    await expect(collect(leaky, baseRequest())).rejects.toSatisfy((error: { detail?: string }) => {
      expect(error.detail).toContain('[redacted]')
      expect(error.detail).not.toContain(API_KEY)
      return true
    })
  })
})

describe('openai-compat:分层超时与多字节(§14/R1)', () => {
  it('first-token 超时 → TIMEOUT_FIRST_TOKEN 错误事件(§14)', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 80))
        if (init.signal?.aborted) throw new Error('The operation was aborted') // 真传输:abort 即断流
        yield encoder.encode(chunk('迟到的首帧'))
      })()
      return { ...sseResponse([]), body }
    }
    const slow = new OpenAICompatAdapter({
      baseUrl: 'https://relay.example/v1',
      apiKey: API_KEY,
      fetchImpl,
      timeouts: { firstTokenMs: 20 },
    })
    const events = await collect(slow, baseRequest())
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.error.code).toBe('TIMEOUT_FIRST_TOKEN')
  })

  it('idle 超时 → TIMEOUT_IDLE(§14)', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = (async function* () {
        yield encoder.encode(chunk('首帧'))
        await new Promise((resolve) => setTimeout(resolve, 80))
        if (init.signal?.aborted) throw new Error('The operation was aborted')
        yield encoder.encode(chunk('迟到的二帧'))
      })()
      return { ...sseResponse([]), body }
    }
    const stall = new OpenAICompatAdapter({
      baseUrl: 'https://relay.example/v1',
      apiKey: API_KEY,
      fetchImpl,
      timeouts: { idleMs: 20 },
    })
    const events = await collect(stall, baseRequest())
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.error.code).toBe('TIMEOUT_IDLE')
    expect(events.some((e) => e.type === 'finish')).toBe(false)
  })

  it('T11/R1:多字节 UTF-8 跨 chunk 切断 → 解码无损', async () => {
    const text = '深合并字节边界测'
    const frame = chunk(text)
    const bytes = encoder.encode(frame)
    const splitAt = frame.indexOf('并') >= 0 ? bytesIndexOf(bytes, '并') + 1 : 8
    const fetchImpl: FetchLike = async () => {
      const body = (async function* () {
        yield bytes.slice(0, splitAt)
        yield bytes.slice(splitAt)
      })()
      return { ...sseResponse([]), body }
    }
    const events = await collect(adapter(fetchImpl), baseRequest())
    expect(eventsOf(events, 'text_delta').map((e) => e.text).join('')).toBe(text)
  })
})

describe('openai-compat:capabilities(§15,还账 #2 定稿)', () => {
  it('静态预设表按模型族匹配;用户覆盖最高;instructionLayers 登记 flat', () => {
    const a = adapter(async () => sseResponse([]))
    expect(a.capabilities('deepseek-r1').reasoning).toBe(true)
    expect(a.capabilities('deepseek-chat').cacheType).toBe('automatic-prefix')
    expect(a.capabilities('gpt-4o').vision).toBe(true)
    expect(a.capabilities('llama3.2')).toMatchObject({ tools: false, cacheType: 'none' })
    expect(a.capabilities('unknown-model').instructionLayers).toBe('flat')

    const overridden = adapter(async () => sseResponse([]), { maxContextTokens: 999 })
    expect(overridden.capabilities('deepseek-chat').maxContextTokens).toBe(999)
  })
})

// —— 工具 ——
function eventsOf<T extends ProviderStreamEvent['type']>(
  events: readonly ProviderStreamEvent[],
  type: T,
): Extract<ProviderStreamEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<ProviderStreamEvent, { type: T }> => event.type === type,
  )
}

function bytesIndexOf(bytes: Uint8Array, char: string): number {
  const probe = encoder.encode(char)
  for (let i = 0; i <= bytes.length - probe.length; i += 1) {
    let matched = true
    for (let j = 0; j < probe.length; j += 1) {
      if (bytes[i + j] !== probe[j]) {
        matched = false
        break
      }
    }
    if (matched) return i
  }
  return 8
}
