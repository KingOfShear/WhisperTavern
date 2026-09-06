import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderChatRequest,
  ProviderError,
  ProviderMessage,
  ProviderStreamEvent,
  ProviderUsage,
} from '@desiregrimoire/contracts'
import { estimateTokens } from '@desiregrimoire/core'
import { parseSseData } from '../shared/sse'
import {
  createRedact,
  mapHttpError,
  matchBodyTable,
  parseRetryAfter,
  providerError,
  type BodyErrorRow,
  type FetchLike,
  type ProviderHttpResponse,
} from '../shared/http'
import { DEFAULT_TIMEOUTS, TimeoutController, type TimeoutConfig } from '../shared/timeout'

/**
 * OpenAI 兼容 adapter —— technical-plan §5.1 方式 1/3 的协议翻译层:覆盖
 * OpenAI / DeepSeek / GLM / Qwen / Kimi / OpenRouter / 中转站,以及暴露兼容端点的
 * ollama / vLLM / LM Studio / llama.cpp(免密钥)。规格真相源:
 * provider-adapter-spec §2(PV1 只翻译不做语义)/ §8(流式归一)/ §12(错误表)/
 * §14(分层超时)/ §15(capabilities)/ §17(usage + redact)。
 *
 * 关键实现点:SSE 增量解码与帧解析共用 shared/sse(R1–R3);DeepSeek
 * `reasoning_content` → reasoning_delta(PV8);usage 经 stream_options.include_usage
 * 请求,缺帧 → §17.3 estimated 降级(本地端点常见);取消 = partial + CANCELLED(PV6);
 * 伪造 200 → PARSE_ERROR(R5)。缓存 = automatic-prefix 家族:无标记,唯一义务是
 * 前缀字节稳定(§16,由 Compiler 契约保证)。
 */

export interface OpenAICompatConfig {
  /** 形如 https://api.openai.com/v1 或 http://localhost:11434/v1 */
  baseUrl: string
  /** 本地端点/免鉴权中转可缺省;出现即随 Authorization 头发送(经 redact 覆盖) */
  apiKey?: string
  /** §15 三层探测:用户手动覆盖(最高)> 内置静态预设表 */
  capabilityOverrides?: Partial<ProviderCapabilities>
  /** 默认 globalThis.fetch;测试注入内存实现 */
  fetchImpl?: FetchLike
  timeouts?: Partial<TimeoutConfig>
}

interface OpenAIChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }[]
  usage?: OpenAIUsage | null
  error?: { message?: string; type?: string; code?: string }
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  prompt_cache_hit_tokens?: number // DeepSeek 缓存命中字段(总设计 §18.3)
  completion_tokens_details?: { reasoning_tokens?: number }
}

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly providerId = 'openai-compat'

  private readonly redact: (text: string) => string
  private readonly timeouts: TimeoutConfig
  private readonly doFetch: FetchLike

  constructor(private readonly config: OpenAICompatConfig) {
    this.redact = createRedact(config.apiKey ? [config.apiKey] : [])
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts }
    this.doFetch =
      config.fetchImpl ??
      (async (url, init) => {
        const res = await fetch(url, init)
        return {
          ok: res.ok,
          status: res.status,
          headers: res.headers,
          body: res.body,
          text: () => res.text(),
        }
      })
  }

  /** §15:静态预设表(按模型族)+ 用户覆盖;探测失败用保守默认,不阻塞聊天 */
  capabilities(model: string): ProviderCapabilities {
    return { ...familyPreset(model), ...this.config.capabilityOverrides }
  }

  async *stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    const tc = new TimeoutController(req.signal, this.redact)
    try {
      const response = await this.connect(req, tc)

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw mapHttpError(response.status, body, parseRetryAfter(response.headers), this.redact)
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        // R5:伪造 200(HTML / 错误 JSON / 非流式 JSON)——不当空流静默成功
        const body = await response.text().catch(() => '')
        throw this.classifyNonStreamBody(contentType, body)
      }
      if (response.body === null) {
        throw this.parseError('响应体为空')
      }

      yield* this.consumeStream(req, response, tc)
    } finally {
      tc.dispose()
    }
  }

  private async connect(req: ProviderChatRequest, tc: TimeoutController): Promise<ProviderHttpResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.config.apiKey !== undefined) headers.authorization = `Bearer ${this.config.apiKey}`
    // PV1:只翻译——messages 原样;usage 帧显式请求(§17.1);工具字段 P3
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: req.sampling.temperature,
      top_p: req.sampling.topP,
      max_tokens: req.sampling.maxOutputTokens,
      stop: req.sampling.stopSequences,
      seed: req.sampling.seed,
    })
    tc.arm('connectMs', this.timeouts.connectMs)
    try {
      return await this.doFetch(url, { method: 'POST', headers, body, signal: tc.signal })
    } catch {
      // connect 失败 = TRANSPORT_ERROR;外层取消 = CANCELLED(§14)
      throw tc.toProviderError()
    }
  }

  /** R5 分类:HTML / 错误 JSON / 其余非流式体 → PARSE_ERROR 或按 body 错误码 */
  private classifyNonStreamBody(contentType: string, body: string): ProviderError {
    if (contentType.includes('text/html')) {
      return this.parseError('伪造 200:text/html 响应(中转站拦截页,§8.3 R5)')
    }
    try {
      const json = JSON.parse(body) as OpenAIChunk
      if (json.error !== undefined && json.error !== null) {
        return this.classifyBodyError(json)
      }
    } catch {
      // fall through:非 JSON
    }
    return this.parseError(`伪造 200:非流式响应(content-type: ${contentType})`)
  }

  /** 200 + 错误 JSON:按 body 错误码分类(表驱动,§12;行表与 anthropic 共用 matchBodyTable) */
  private classifyBodyError(json: OpenAIChunk): ProviderError {
    return matchBodyTable(OPENAI_BODY_TABLE, bodyTextOf(json), this.redact, bodyTextOf(json))
  }

  private async *consumeStream(
    req: ProviderChatRequest,
    response: ProviderHttpResponse,
    tc: TimeoutController,
  ): AsyncGenerator<ProviderStreamEvent> {
    yield { type: 'message_start' }

    let text = ''
    let reasoning = ''
    let usage: ProviderUsage | undefined
    let finishReason: string | null = null

    const iterator = parseSseData(response.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    let firstFrame = true
    for (;;) {
      tc.arm(firstFrame ? 'firstTokenMs' : 'idleMs', firstFrame ? this.timeouts.firstTokenMs : this.timeouts.idleMs)
      let next: IteratorResult<string>
      try {
        next = await iterator.next()
      } catch {
        // 中途断开:外层取消 → CANCELLED;分层超时 → TIMEOUT_*(§14)
        tc.disarm()
        yield { type: 'error', error: tc.toProviderError() }
        return
      }
      tc.disarm()
      if (next.done === true) break
      firstFrame = false

      let chunk: OpenAIChunk
      try {
        chunk = JSON.parse(next.value) as OpenAIChunk
      } catch (error) {
        yield { type: 'error', error: this.parseError(`SSE 帧 JSON 解析失败: ${String(error).slice(0, 120)}`) }
        return
      }

      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      // PV8:DeepSeek reasoning_content 原样归一,不丢弃、不改写
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
        reasoning += delta.reasoning_content
        yield { type: 'reasoning_delta', text: delta.reasoning_content }
      }
      // PV1:content 原样透传,零字节 delta 不发
      if (typeof delta?.content === 'string' && delta.content !== '') {
        text += delta.content
        yield { type: 'text_delta', text: delta.content }
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason
      if (chunk.usage !== undefined && chunk.usage !== null) usage = this.normalizeUsage(chunk.usage)
    }

    // PV6:取消 = 已缓冲内容照常归一发出,随后 CANCELLED 终止(finish 不再发出)
    if (req.signal?.aborted === true) {
      yield {
        type: 'error',
        error: providerError('CANCELLED', this.redact, {
          retryable: false,
          keyRotatable: false,
          detail: 'aborted by caller signal',
        }),
      }
      return
    }

    // §17.3:usage 缺帧(本地端点/中转站常见)→ estimated 降级(core 估算器,§52 同源)
    const finalUsage: ProviderUsage = usage ?? estimateFallback(req.messages, text, reasoning)
    yield { type: 'usage', usage: finalUsage }
    yield { type: 'finish', reason: mapFinishReason(finishReason) }
  }

  /** §17.1:OpenAI/DeepSeek usage 字段 → 归一形状(cached/reasoning 细分原样归一) */
  private normalizeUsage(usage: OpenAIUsage): ProviderUsage {
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      cachedInputTokens:
        usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      source: 'reported',
    }
  }

  private parseError(detail: string): ProviderError {
    return providerError('PARSE_ERROR', this.redact, { retryable: true, keyRotatable: false, detail })
  }
}

function mapFinishReason(raw: string | null): 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error' {
  switch (raw) {
    case 'length':
      return 'length'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'content_filter'
    case null:
    case 'stop':
    default:
      return 'stop'
  }
}

const OPENAI_BODY_TABLE: readonly BodyErrorRow[] = [
  { code: 'QUOTA_EXCEEDED', retryable: false, keyRotatable: true, match: /insufficient_quota/i },
  { code: 'CONTEXT_TOO_LARGE', retryable: false, keyRotatable: false, match: /context_length|maximum context/i },
  { code: 'RATE_LIMIT', retryable: true, keyRotatable: true, match: /rate_limit/i },
  { code: 'MODEL_OVERLOADED', retryable: true, keyRotatable: false, match: /overloaded|server_error/i },
  { code: 'INVALID_REQUEST', retryable: false, keyRotatable: false, match: /invalid_request/i },
]

function bodyTextOf(json: OpenAIChunk): string {
  return `${json.error?.type ?? ''} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim().slice(0, 300)
}

/** §17.3 estimated 降级:core 本地估算器(compiler-spec §52 同源),estimated 不入命中率分母 */
function estimateFallback(messages: readonly ProviderMessage[], text: string, reasoning: string): ProviderUsage {
  const inputTokens = Math.max(1, messages.reduce((sum, m) => sum + estimateTokens(m.content), 0))
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: Math.max(1, estimateTokens(text) + estimateTokens(reasoning)),
    reasoningTokens: reasoning === '' ? undefined : estimateTokens(reasoning),
    source: 'estimated',
  }
}

// —— §15 静态预设表(内置 provider/模型模板;用户覆盖经 capabilityOverrides)——

interface CapabilityPreset {
  pattern: RegExp
  caps: Partial<ProviderCapabilities>
}

const MODEL_PRESETS: readonly CapabilityPreset[] = [
  {
    // DeepSeek R 系:reasoning 外显(reasoning_content)
    pattern: /^deepseek-r/i,
    caps: { reasoning: true, tools: false, maxContextTokens: 65536, maxOutputTokens: 8192 },
  },
  {
    pattern: /^deepseek/i,
    caps: {
      reasoning: false,
      tools: true,
      promptCaching: true,
      cacheType: 'automatic-prefix',
      maxContextTokens: 65536,
      maxOutputTokens: 8192,
    },
  },
  {
    pattern: /^(gpt-4o|gpt-4\.1|gpt-4-turbo|o[1345])/i,
    caps: {
      vision: true,
      tools: true,
      promptCaching: true,
      cacheType: 'automatic-prefix',
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
    },
  },
  {
    // 本地小模型(ollama 默认族):保守能力,usage 常缺 → estimated 降级
    pattern: /^(llama|qwen|mistral|gemma|phi)/i,
    caps: { vision: false, tools: false, promptCaching: false, cacheType: 'none', maxContextTokens: 8192, maxOutputTokens: 4096 },
  },
]

const FAMILY_DEFAULT: ProviderCapabilities = {
  systemRole: true,
  tools: false,
  vision: false,
  reasoning: false,
  streaming: true,
  promptCaching: true,
  cacheType: 'automatic-prefix',
  maxContextTokens: 8192,
  maxOutputTokens: 4096,
  structuredOutput: 'none',
  parallelToolCalls: false,
  toolChoice: false,
  instructionLayers: 'flat',
}

function familyPreset(model: string): ProviderCapabilities {
  const row = MODEL_PRESETS.find((p) => p.pattern.test(model))
  return { ...FAMILY_DEFAULT, ...(row?.caps ?? {}) }
}
