import { describe, expect, it } from 'vitest'
import type { ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { AnthropicAdapter, type FetchLike, type ProviderHttpResponse } from '../index'

const API_KEY = 'sk-ant-test-1234567890abcdef'

function baseRequest(): ProviderChatRequest {
  return {
    snapshotId: 'snap_an_1',
    model: 'claude-sonnet-4',
    messages: [
      { role: 'system', content: 'sys line' },
      { role: 'user', content: '你好' },
    ],
    sampling: { maxOutputTokens: 256 },
    stream: true,
  }
}

function adapter(fetchImpl: FetchLike): AnthropicAdapter {
  return new AnthropicAdapter({
    baseUrl: 'https://api.anthropic.test',
    apiKey: API_KEY,
    fetchImpl,
    timeouts: { connectMs: 200, firstTokenMs: 200, idleMs: 200 },
  })
}

const encoder = new TextEncoder()

/** Anthropic 帧:event: 字段 + data JSON(R2:event 忽略,按 data 内 type 判型) */
function anthropicFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

function sseResponse(frames: string[], options?: { status?: number; contentType?: string; retryAfter?: string }): ProviderHttpResponse {
  const body = (async function* () {
    for (const frame of frames) yield encoder.encode(frame)
  })()
  const status = options?.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
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

function textDelta(text: string): string {
  return anthropicFrame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
}

async function collect(adapter: AnthropicAdapter, req: ProviderChatRequest): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of adapter.stream(req)) events.push(event)
  return events
}

function eventsOf<T extends ProviderStreamEvent['type']>(
  events: readonly ProviderStreamEvent[],
  type: T,
): Extract<ProviderStreamEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<ProviderStreamEvent, { type: T }> => event.type === type,
  )
}

describe('anthropic:SSE 归一流(T1/§8.2 映射)', () => {
  it('T1:text_delta 逐字节原样(PV1)+ 顺序不变量 + stop_reason 映射', async () => {
    const text = '你好,世界!The quick fox.'
    const events = await collect(
      adapter(async () =>
        sseResponse([
          anthropicFrame('message_start', { message: { usage: { input_tokens: 25 } } }),
          textDelta('你好,'),
          textDelta('世界!'),
          textDelta(text.slice(6)),
          anthropicFrame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
          anthropicFrame('message_stop', {}),
        ])),
      baseRequest(),
    )
    expect(events[0]).toEqual({ type: 'message_start' })
    expect(eventsOf(events, 'text_delta').map((e) => e.text).join('')).toBe(text)
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage).toMatchObject({ inputTokens: 25, outputTokens: 9, cachedInputTokens: 0, source: 'reported' })
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' })
    expect(eventsOf(events, 'usage')).toHaveLength(1) // PV3 恰一次
  })

  it('T3/PV8:thinking_delta → reasoning_delta;signature_delta → 空文本签名载体', async () => {
    const events = await collect(
      adapter(async () =>
        sseResponse([
          anthropicFrame('message_start', { message: { usage: { input_tokens: 30 } } }),
          anthropicFrame('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '先推理' } }),
          anthropicFrame('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
          textDelta('结论'),
          anthropicFrame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }),
        ])),
      baseRequest(),
    )
    const reasoning = eventsOf(events, 'reasoning_delta')
    expect(reasoning[0]).toEqual({ type: 'reasoning_delta', text: '先推理' })
    // 签名载体:空文本 + signature(P3 组装侧配对成 ContentBlock.thinking)
    expect(reasoning[1]).toEqual({ type: 'reasoning_delta', text: '', signature: 'sig-abc' })
    expect(eventsOf(events, 'text_delta').map((e) => e.text).join('')).toBe('结论')
  })

  it('stop_reason:max_tokens → length;tool_use → tool_use(§8.2)', async () => {
    for (const [reason, expected] of [
      ['max_tokens', 'length'],
      ['tool_use', 'tool_use'],
    ] as const) {
      const events = await collect(
        adapter(async () =>
          sseResponse([
            anthropicFrame('message_start', { message: { usage: { input_tokens: 1 } } }),
            anthropicFrame('message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: 1 } }),
          ])),
        baseRequest(),
      )
      expect(events.at(-1)).toMatchObject({ type: 'finish', reason: expected })
    }
  })
})

describe('anthropic:usage 双帧合成与降级(T4/T5)', () => {
  it('T4:input@message_start + output@message_delta 合成一次,cache_read 归一', async () => {
    const events = await collect(
      adapter(async () =>
        sseResponse([
          anthropicFrame('message_start', { message: { usage: { input_tokens: 100, cache_read_input_tokens: 64 } } }),
          textDelta('x'),
          anthropicFrame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
        ])),
      baseRequest(),
    )
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 64,
      outputTokens: 7,
      source: 'reported',
    })
  })

  it('T5:双帧缺失(伪造/中断)→ estimated 降级', async () => {
    const events = await collect(
      adapter(async () => sseResponse([textDelta('只有正文')])),
      baseRequest(),
    )
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage.source).toBe('estimated')
    expect(usage?.usage.inputTokens).toBeGreaterThan(0)
    expect(usage?.usage.outputTokens).toBeGreaterThan(0)
  })
})

describe('anthropic:取消与错误(T6/T10/T12,§12/§14)', () => {
  it('T6:signal 已中止 → CANCELLED 终止,无 finish(PV6)', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(
      adapter(async () => sseResponse([textDelta('不应产出')])),
      { ...baseRequest(), signal: controller.signal },
    )
    expect(events[0]).toEqual({ type: 'message_start' })
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.error.code).toBe('CANCELLED')
    expect(events.some((e) => e.type === 'finish')).toBe(false)
  })

  it('T10:伪造 200(HTML)→ PARSE_ERROR(R5)', async () => {
    const html = adapter(async () => sseResponse(['<html>blocked</html>'], { contentType: 'text/html' }))
    await expect(collect(html, baseRequest())).rejects.toMatchObject({ code: 'PARSE_ERROR' })
  })

  it('T12:400 "prompt is too long" → CONTEXT_TOO_LARGE(§12 Anthropic 表述)', async () => {
    const tooLong = adapter(async () => ({
      ...sseResponse([], { status: 400, contentType: 'application/json' }),
      text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200000 tokens > 190000 maximum"}}',
    }))
    await expect(collect(tooLong, baseRequest())).rejects.toMatchObject({
      code: 'CONTEXT_TOO_LARGE',
      retryable: false,
    })
  })

  it('401 → AUTH_INVALID;429 + Retry-After → RATE_LIMIT;529 → MODEL_OVERLOADED(T9)', async () => {
    const unauthorized = adapter(async () => ({
      ...sseResponse([], { status: 401, contentType: 'application/json' }),
      text: async () => '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    }))
    await expect(collect(unauthorized, baseRequest())).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      keyRotatable: true,
    })

    const limited = adapter(async () => ({
      ...sseResponse([], { status: 429, contentType: 'application/json', retryAfter: '5' }),
      text: async () => '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests too high"}}',
    }))
    await expect(collect(limited, baseRequest())).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
      retryAfterMs: 5000,
    })

    const overloaded = adapter(async () => ({
      ...sseResponse([], { status: 529, contentType: 'application/json' }),
      text: async () => '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    }))
    await expect(collect(overloaded, baseRequest())).rejects.toMatchObject({
      code: 'MODEL_OVERLOADED',
      retryable: true,
    })
  })

  it('流内 error 事件(overloaded)→ 分类为 MODEL_OVERLOADED 终止流', async () => {
    const events = await collect(
      adapter(async () =>
        sseResponse([
          anthropicFrame('message_start', { message: { usage: { input_tokens: 5 } } }),
          anthropicFrame('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
        ])),
      baseRequest(),
    )
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.error.code).toBe('MODEL_OVERLOADED')
    expect(events.some((e) => e.type === 'finish')).toBe(false)
  })

  it('PV5:redact——错误 detail 不含 x-api-key 明文', async () => {
    const leaky = adapter(async () => ({
      ...sseResponse([], { status: 500, contentType: 'application/json' }),
      text: async () => `{"type":"error","error":{"type":"api_error","message":"bad gateway for key ${API_KEY}"}}`,
    }))
    await expect(collect(leaky, baseRequest())).rejects.toSatisfy((error: { detail?: string }) => {
      expect(error.detail).toContain('[redacted]')
      expect(error.detail).not.toContain(API_KEY)
      return true
    })
  })
})

describe('anthropic:分层超时与多字节(§14/R1)', () => {
  it('first-token 超时 → TIMEOUT_FIRST_TOKEN(§14)', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 80))
        if (init.signal?.aborted) throw new Error('The operation was aborted')
        yield encoder.encode(textDelta('迟到'))
      })()
      return { ...sseResponse([]), body }
    }
    const slow = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.test',
      apiKey: API_KEY,
      fetchImpl,
      timeouts: { firstTokenMs: 20 },
    })
    const events = await collect(slow, baseRequest())
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.error.code).toBe('TIMEOUT_FIRST_TOKEN')
  })

  it('T11/R1:多字节 UTF-8 跨 chunk 切断 → 解码无损', async () => {
    const text = '深度合并字节边界测'
    const frame = textDelta(text)
    const bytes = encoder.encode(frame)
    const splitAt = bytesIndexOf(bytes, '并') + 1
    const events = await collect(
      adapter(async () => {
        const body = (async function* () {
          yield bytes.slice(0, splitAt)
          yield bytes.slice(splitAt)
        })()
        return { ...sseResponse([]), body }
      }),
      baseRequest(),
    )
    expect(eventsOf(events, 'text_delta').map((e) => e.text).join('')).toBe(text)
  })
})

describe('anthropic:capabilities(§15)与请求翻译', () => {
  it('claude 全族 explicit-breakpoint;3.7+/4 系 reasoning;用户覆盖最高', () => {
    const a = adapter(async () => sseResponse([]))
    expect(a.capabilities('claude-sonnet-4')).toMatchObject({
      cacheType: 'explicit-breakpoint',
      reasoning: true,
      maxOutputTokens: 64000,
      systemRole: true,
    })
    expect(a.capabilities('claude-3-5-sonnet').reasoning).toBe(false)
    const overridden = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.test',
      apiKey: API_KEY,
      fetchImpl: async () => sseResponse([]),
      capabilityOverrides: { maxOutputTokens: 999 },
    })
    expect(overridden.capabilities('claude-sonnet-4').maxOutputTokens).toBe(999)
  })

  it('请求翻译:system 顶层化 + max_tokens 必填 + x-api-key/版本头', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const a = adapter(async (url, init) => {
      captured = { url, init }
      return sseResponse([
        anthropicFrame('message_start', { message: { usage: { input_tokens: 1 } } }),
        anthropicFrame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      ])
    })
    await collect(a, baseRequest())
    expect(captured?.url).toBe('https://api.anthropic.test/v1/messages')
    const headers = captured?.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(API_KEY)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(String(captured?.init.body)) as Record<string, unknown>
    expect(body.system).toBe('sys line') // system 顶层化(结构翻译)
    expect(body.max_tokens).toBe(256) // Anthropic 必填
    expect(Array.isArray(body.messages)).toBe(true)
    expect(JSON.stringify(body.messages)).not.toContain('sys line') // messages 不含 system
    expect(body.seed).toBeUndefined() // Anthropic 无此参数,静默不发送
  })
})

describe('anthropic:S19 §16 缓存标记翻译(显式断点 → cache_control)', () => {
  /** 捕获 connect 实际发出的 body(断言 wire 翻译产物) */
  async function captureBody(req: ProviderChatRequest): Promise<Record<string, unknown>> {
    let captured: { init: RequestInit } | undefined
    const a = adapter(async (_url, init) => {
      captured = { init }
      return sseResponse([
        anthropicFrame('message_start', { message: { usage: { input_tokens: 1 } } }),
        anthropicFrame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      ])
    })
    await collect(a, req)
    return JSON.parse(String(captured?.init.body)) as Record<string, unknown>
  }

  it('system 区断点 → system 转块形,末块挂 ephemeral;messages 原样(PV1 字节零改写)', async () => {
    const body = await captureBody({
      ...baseRequest(),
      cachePlan: {
        version: 1,
        breakpoints: [{ afterSegmentId: 'h', afterPartIndex: 0, reason: 'automatic' }],
        stableZoneTokens: 2048,
      },
    })
    expect(body.system).toEqual([{ type: 'text', text: 'sys line', cache_control: { type: 'ephemeral' } }])
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }])
  })

  it('messages 区断点 → 目标 user 消息 content 转块形挂标记;system 保持 join 串', async () => {
    const body = await captureBody({
      ...baseRequest(),
      cachePlan: {
        version: 1,
        breakpoints: [{ afterSegmentId: 'f', afterPartIndex: 1, reason: 'automatic' }],
        stableZoneTokens: 2048,
      },
    })
    expect(body.system).toBe('sys line')
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '你好', cache_control: { type: 'ephemeral' } }] },
    ])
  })

  it('assistant 目标防御性丢弃:任何消息都不挂标记(Anthropic 禁止 assistant cache_control)', async () => {
    const body = await captureBody({
      ...baseRequest(),
      messages: [
        { role: 'system', content: 'sys line' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '好的' },
      ],
      cachePlan: {
        version: 1,
        breakpoints: [{ afterSegmentId: 'hist', afterPartIndex: 2, reason: 'automatic' }],
        stableZoneTokens: 2048,
      },
    })
    expect(body.system).toBe('sys line')
    expect(body.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '好的' },
    ])
    expect(JSON.stringify(body)).not.toContain('cache_control')
  })

  it('prefixTooSmall → 整体抑制:与无 cachePlan 逐字节一致(基线零漂移)', async () => {
    const suppressed = await captureBody({
      ...baseRequest(),
      cachePlan: {
        version: 1,
        breakpoints: [{ afterSegmentId: 'h', afterPartIndex: 0, reason: 'automatic' }],
        stableZoneTokens: 512,
        prefixTooSmall: { threshold: 1024, actualTokens: 512, zone: 'header+stableWB' },
      },
    })
    const baseline = await captureBody(baseRequest())
    expect(JSON.stringify(suppressed)).toBe(JSON.stringify(baseline))
    expect(JSON.stringify(suppressed)).not.toContain('cache_control')
  })
})

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
