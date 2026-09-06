import { describe, expect, it } from 'vitest'
import type { ProviderChatRequest, ProviderStreamEvent } from '@desiregrimoire/contracts'
import { AnthropicAdapter } from '../anthropic/anthropic'
import { GeminiAdapter } from '../gemini/gemini'
import { OpenAICompatAdapter } from '../openai/openai-compat'
import { fixtureRequest, fixtureTransport, loadFixture, type ProviderFixture } from './fixture'

/**
 * fixture 回放全家桶 —— provider-adapter-spec §20 P0 必测集(T1/T4/T6/T10/T11/T12)
 * + T14(PV7:同 fixture 重复回放字节级一致,CI 硬门禁)。
 * 三家 × 6 案例全走同一套数据驱动断言;fixture 内容见 tests/fixtures/provider(只读)。
 */

const CASES = [
  'T1-basic-stream',
  'T4-usage',
  'T6-cancel',
  'T10-fake-200',
  'T11-multibyte',
  'T12-context-too-large',
] as const

type FixtureProvider = 'openai-compat' | 'anthropic' | 'gemini'

function makeAdapter(provider: FixtureProvider, fixture: ProviderFixture) {
  const { fetchImpl } = fixtureTransport(fixture)
  switch (provider) {
    case 'openai-compat':
      return new OpenAICompatAdapter({ baseUrl: 'https://fixture.openai/v1', apiKey: 'sk-fixture-not-real', fetchImpl })
    case 'anthropic':
      return new AnthropicAdapter({ baseUrl: 'https://fixture.anthropic', apiKey: 'sk-ant-fixture-not-real', fetchImpl })
    case 'gemini':
      return new GeminiAdapter({ baseUrl: 'https://fixture.googleapis', apiKey: 'gem-fixture-not-real', fetchImpl })
  }
}

async function runFixture(
  provider: FixtureProvider,
  fixture: ProviderFixture,
): Promise<ProviderStreamEvent[]> {
  const adapter = makeAdapter(provider, fixture)
  const request: ProviderChatRequest = fixtureRequest(fixture)
  const events: ProviderStreamEvent[] = []
  for await (const event of adapter.stream(request)) events.push(event)
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

describe.each<FixtureProvider>(['openai-compat', 'anthropic', 'gemini'])('fixture 回放:%s(§20)', (provider) => {
  it.each(CASES)('%s:回放断言(PV1/§8.1/§12/§14/§17)', async (caseName) => {
    const fixture = loadFixture(provider, caseName)
    expect(fixture.provider).toBe(provider)

    if (fixture.expect.kind === 'error') {
      await expect(runFixture(provider, fixture)).rejects.toMatchObject({
        code: fixture.expect.errorCode,
      })
      return
    }

    const events = await runFixture(provider, fixture)
    // §8.1 顺序不变量(正常结束路径):message_start 恰一次且最先;usage 恰一次且在 finish 前
    expect(events[0]).toEqual({ type: 'message_start' })
    expect(eventsOf(events, 'message_start')).toHaveLength(1)
    if (fixture.expect.lastError === undefined) {
      // 取消路径(PV6)以 error 终止:无 usage、无 finish
      expect(eventsOf(events, 'usage')).toHaveLength(1)
      expect(events.findIndex((e) => e.type === 'usage')).toBeLessThan(events.length - 1)
      expect(events.at(-1)?.type).toBe('finish')
    }

    if (fixture.expect.text !== undefined) {
      expect(
        eventsOf(events, 'text_delta').map((e) => e.text).join(''),
      ).toBe(fixture.expect.text) // PV1 逐字节
    }
    if (fixture.expect.finishReason !== undefined) {
      expect(events.at(-1)).toMatchObject({ type: 'finish', reason: fixture.expect.finishReason })
    }
    if (fixture.expect.usageSource !== undefined) {
      const [usage] = eventsOf(events, 'usage')
      expect(usage?.usage.source).toBe(fixture.expect.usageSource)
    }
    if (fixture.expect.lastError !== undefined) {
      const last = events.at(-1)
      expect(last?.type).toBe('error')
      if (last?.type === 'error') expect(last.error.code).toBe(fixture.expect.lastError)
      expect(events.some((e) => e.type === 'finish')).toBe(false) // 取消后无 finish(§8.1)
    }
  })

  it.each(CASES)('T14/%s:同 fixture 重复回放字节级一致(PV7 硬门禁)', async (caseName) => {
    const fixture = loadFixture(provider, caseName)
    const first = await runFixture(provider, fixture).catch((error: { code?: string; detail?: string }) => ({
      __rejected: true,
      code: error.code,
      detail: error.detail,
    }))
    const second = await runFixture(provider, fixture).catch((error: { code?: string; detail?: string }) => ({
      __rejected: true,
      code: error.code,
      detail: error.detail,
    }))
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})
