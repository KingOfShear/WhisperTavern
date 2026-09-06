import { describe, expect, it } from 'vitest'
import type { ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { FakeProviderAdapter } from './fake-adapter'

const baseRequest: ProviderChatRequest = {
  snapshotId: 'snap_fake_0001',
  model: 'fake-model',
  messages: [
    { role: 'system', content: 'system line' },
    { role: 'user', content: 'user line' },
  ],
  sampling: { maxOutputTokens: 256 },
  stream: true,
}

async function collect(
  adapter: FakeProviderAdapter,
  req: ProviderChatRequest,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of adapter.stream(req)) {
    events.push(event)
  }
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

describe('FakeProviderAdapter(形状契约)', () => {
  it('同一脚本两次回放产出完全相同的事件序列(PV7 确定性精神)', async () => {
    const script = [{ text: '你好,世界。', reasoning: '思考过程', chunkSize: 3 }]
    const first = await collect(new FakeProviderAdapter(script), baseRequest)
    const second = await collect(new FakeProviderAdapter(script), baseRequest)
    expect(first.length).toBeGreaterThan(4)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('事件顺序满足 §8.1 不变量:message_start 首位恰一次、usage 恰一次且在 finish 前、finish 末位恰一次', async () => {
    const events = await collect(
      new FakeProviderAdapter([{ text: 'hello world', chunkSize: 4 }]),
      baseRequest,
    )
    expect(events[0]).toEqual({ type: 'message_start' })
    expect(eventsOf(events, 'message_start')).toHaveLength(1)
    expect(eventsOf(events, 'usage')).toHaveLength(1)
    expect(eventsOf(events, 'finish')).toHaveLength(1)
    const usageIndex = events.findIndex((event) => event.type === 'usage')
    expect(usageIndex).toBeGreaterThan(0)
    expect(usageIndex).toBeLessThan(events.length - 1)
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' })
  })

  it('text_delta 拼接与脚本文本逐字节一致(PV1:只翻译不改写)', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. 混合内容与多字节字符!'
    const events = await collect(new FakeProviderAdapter([{ text }]), baseRequest)
    const deltas = eventsOf(events, 'text_delta')
      .map((event) => event.text)
      .join('')
    expect(deltas).toBe(text)
  })

  it('usage 为 reported 且含正数 input/output 计数(§17.1 形状)', async () => {
    const events = await collect(new FakeProviderAdapter([{ text: 'abcd' }]), baseRequest)
    const [usage] = eventsOf(events, 'usage')
    expect(usage?.usage.source).toBe('reported')
    expect(usage?.usage.inputTokens).toBeGreaterThan(0)
    expect(usage?.usage.outputTokens).toBeGreaterThan(0)
  })

  it('多轮脚本按 stream() 调用顺序消费', async () => {
    const adapter = new FakeProviderAdapter([{ text: 'first' }, { text: 'second' }])
    const firstRun = await collect(adapter, baseRequest)
    const secondRun = await collect(adapter, baseRequest)
    expect(
      eventsOf(firstRun, 'text_delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('first')
    expect(
      eventsOf(secondRun, 'text_delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('second')
  })

  it('signal 已中止:仅 message_start 后即 CANCELLED,无 delta、无 finish(PV6 取消优先)', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(new FakeProviderAdapter([{ text: '不应产出' }]), {
      ...baseRequest,
      signal: controller.signal,
    })
    expect(events[0]).toEqual({ type: 'message_start' })
    expect(events).toHaveLength(2)
    const last = events[1]
    expect(last?.type).toBe('error')
    if (last?.type === 'error') {
      expect(last.error.code).toBe('CANCELLED')
    }
  })

  it('脚本耗尽:抛 ProviderError{code: UNKNOWN, retryable: false}(PV4 fail-closed)', async () => {
    const adapter = new FakeProviderAdapter([{ text: 'only once' }])
    await collect(adapter, baseRequest)
    await expect(collect(adapter, baseRequest)).rejects.toMatchObject({
      code: 'UNKNOWN',
      retryable: false,
    })
  })
})
