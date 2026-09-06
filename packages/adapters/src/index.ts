// S2(WP0.2):归一契约收编入 @desiregrimoire/contracts(provider-adapter-spec §6/§7),
// 临时占位文件 contract.ts 已删除;adapters 导出自己的实现与共享 SSE/HTTP 工具。
export { FakeProviderAdapter, type FakeTurn } from './fake/fake-adapter'
export { OpenAICompatAdapter, type OpenAICompatConfig } from './openai/openai-compat'
export { AnthropicAdapter, type AnthropicConfig } from './anthropic/anthropic'
export { GeminiAdapter, type GeminiConfig } from './gemini/gemini'
export { parseSseData } from './shared/sse'
export {
  createRedact,
  mapHttpError,
  parseRetryAfter,
  providerError,
  type FetchLike,
  matchBodyTable,
  type BodyErrorRow,
  type ProviderHttpResponse,
} from './shared/http'
export { DEFAULT_TIMEOUTS, TimeoutController, type TimeoutConfig } from './shared/timeout'
export {
  loadFixture,
  fixtureRequest,
  fixtureTransport,
  type ProviderFixture,
} from './testing/fixture'
