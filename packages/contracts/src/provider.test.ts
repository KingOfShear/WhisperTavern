import { describe, expect, it } from 'vitest'
import {
  ProviderChatRequestPayloadSchema,
  ProviderErrorCodeSchema,
  ProviderStreamEventSchema,
  ProviderUsageSchema,
  type ProviderChatRequest,
} from './provider'

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)))
}

const payload: ProviderChatRequest = {
  snapshotId: 'snap_0001',
  model: 'fake-model',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ],
  sampling: { maxOutputTokens: 256 },
  stream: true,
}

describe('contracts/provider(归一契约)', () => {
  it('错误码 14 码穷尽且无重复(provider-adapter §12)', () => {
    expect(ProviderErrorCodeSchema.options).toHaveLength(14)
    expect(new Set(ProviderErrorCodeSchema.options).size).toBe(14)
  })

  it('请求 payload round-trip;signal 为 IO 注入字段不进 Schema', () => {
    expect(roundTrip(ProviderChatRequestPayloadSchema, payload)).toEqual(payload)
    expect('signal' in ProviderChatRequestPayloadSchema.shape).toBe(false)
  })

  it('七类流式事件逐一可解析(§8.1)', () => {
    const events = [
      { type: 'message_start' },
      { type: 'text_delta', text: 'hello' },
      { type: 'reasoning_delta', text: 'thinking' },
      { type: 'tool_call_delta', index: 0, name: 'search' },
      {
        type: 'usage',
        usage: ProviderUsageSchema.parse({
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 4,
          source: 'reported',
        }),
      },
      { type: 'finish', reason: 'stop' },
      {
        type: 'error',
        error: {
          code: 'CANCELLED',
          retryable: false,
          keyRotatable: false,
          detail: 'aborted',
        },
      },
    ] as const
    for (const event of events) {
      expect(roundTrip(ProviderStreamEventSchema, event)).toEqual(event)
    }
    expect(ProviderStreamEventSchema.safeParse({ type: 'chunk', text: 'x' }).success).toBe(false)
  })

  it('usage source 双值;estimated 缺帧降级语义有型可依(§17.3)', () => {
    expect(ProviderUsageSchema.safeParse({
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      source: 'estimated',
    }).success).toBe(true)
    expect(ProviderUsageSchema.safeParse({
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      source: 'guess',
    }).success).toBe(false)
  })
})
