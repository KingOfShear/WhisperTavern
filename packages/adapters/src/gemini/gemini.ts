import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderChatRequest,
  ProviderError,
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
 * Gemini streamGenerateContent adapter —— provider-adapter-spec §8.2 映射列的协议翻译层。
 *
 * 关键实现点:
 * - **usage 累积定稿(§17.1)**:每帧 `usageMetadata` 为累计值,取末帧为定稿,流末
 *   恰一次发出;`cachedContentTokenCount` → cachedInputTokens,`thoughtsTokenCount`
 *   → reasoningTokens;缺帧 → §17.3 estimated 降级(core 估算器)。
 * - **thought parts(PV8)**:`parts[].thought === true` → reasoning_delta;正文 part
 *   → text_delta;两者均原样透传。
 * - **SAFETY → finish=content_filter**(§8.2 finish 映射);§8.1 不变量"finish 恰一次
 *   且最后 / error 后无事件"决定了 error 与 finish 不共存——CONTENT_FILTERED 码由
 *   Runtime 在消费 finish(content_filter) 时归类(§19:provider 事件不出进程)。
 * - system 角色消息翻译为 `systemInstruction`(结构翻译,PV1 内容零改写);
 *   user/assistant → contents[].role 'user'/'model'。
 * - 缓存 = context-cache 家族;P0 无 CachePlan(R-P0-4),explicit caching 评估随 WP2.4(§23 开放点 1)。
 */

export interface GeminiConfig {
  /** 形如 https://generativelanguage.googleapis.com */
  baseUrl: string
  /** x-goog-api-key 头(不用 URL query,免 key 进日志/红act 面) */
  apiKey: string
  apiVersion?: string
  capabilityOverrides?: Partial<ProviderCapabilities>
  fetchImpl?: FetchLike
  timeouts?: Partial<TimeoutConfig>
}

interface GeminiChunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[]; role?: string }
    finishReason?: string | null
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
  error?: { code?: number; message?: string; status?: string }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly providerId = 'gemini'

  private readonly redact: (text: string) => string
  private readonly timeouts: TimeoutConfig
  private readonly doFetch: FetchLike

  constructor(private readonly config: GeminiConfig) {
    this.redact = createRedact([config.apiKey])
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

  /** §15:静态预设 + 用户覆盖;gemini 全族 context-cache 缓存机制 */
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
        // R5:伪造 200(HTML / 非流式 JSON)——不当空流静默成功
        await response.text().catch(() => '')
        throw this.parseError(`伪造 200:非流式响应(content-type: ${contentType})`)
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
    const version = this.config.apiVersion ?? 'v1beta'
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/${version}/models/${req.model}:streamGenerateContent?alt=sse`
    // system 顶层化(systemInstruction);roles: user/assistant → user/model(PV1:文本零改写)
    const systemParts = req.messages.filter((m) => m.role === 'system')
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))
    const body = JSON.stringify({
      contents,
      ...(systemParts.length > 0
        ? { systemInstruction: { parts: systemParts.map((m) => ({ text: m.content })) } }
        : {}),
      generationConfig: {
        temperature: req.sampling.temperature,
        topP: req.sampling.topP,
        maxOutputTokens: req.sampling.maxOutputTokens,
        stopSequences: req.sampling.stopSequences,
        seed: req.sampling.seed,
      },
    })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-goog-api-key': this.config.apiKey,
    }
    tc.arm('connectMs', this.timeouts.connectMs)
    try {
      return await this.doFetch(url, { method: 'POST', headers, body, signal: tc.signal })
    } catch {
      // connect 失败 = TRANSPORT_ERROR;外层取消 = CANCELLED(§14)
      throw tc.toProviderError()
    }
  }

  private async *consumeStream(
    req: ProviderChatRequest,
    response: ProviderHttpResponse,
    tc: TimeoutController,
  ): AsyncGenerator<ProviderStreamEvent> {
    yield { type: 'message_start' } // §8.2:首个 chunk

    let text = ''
    let reasoning = ''
    let usage: ProviderUsage | undefined
    let finishReason: string | null = null
    let blocked = false

    const iterator = parseSseData(response.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    let firstFrame = true
    for (;;) {
      tc.arm(firstFrame ? 'firstTokenMs' : 'idleMs', firstFrame ? this.timeouts.firstTokenMs : this.timeouts.idleMs)
      let next: IteratorResult<string>
      try {
        next = await iterator.next()
      } catch {
        tc.disarm()
        yield { type: 'error', error: tc.toProviderError() }
        return
      }
      tc.disarm()
      if (next.done === true) break
      firstFrame = false

      let chunk: GeminiChunk
      try {
        chunk = JSON.parse(next.value) as GeminiChunk
      } catch (error) {
        yield { type: 'error', error: this.parseError(`SSE 帧 JSON 解析失败: ${String(error).slice(0, 120)}`) }
        return
      }

      if (chunk.error !== undefined && chunk.error !== null) {
        yield { type: 'error', error: this.classifyBodyError(chunk) }
        return
      }

      // §17.1:每帧 usageMetadata 为累计值,取末帧定稿
      if (chunk.usageMetadata !== undefined) usage = this.normalizeUsage(chunk.usageMetadata)
      if (chunk.promptFeedback?.blockReason !== undefined) blocked = true

      const candidate = chunk.candidates?.[0]
      if (candidate?.finishReason != null) finishReason = candidate.finishReason
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text !== 'string' || part.text === '') continue
        if (part.thought === true) {
          reasoning += part.text
          yield { type: 'reasoning_delta', text: part.text }
        } else {
          text += part.text
          yield { type: 'text_delta', text: part.text } // PV1 原样透传
        }
      }
    }

    // PV6:取消 = 已缓冲内容照常发出,随后 CANCELLED 终止(finish 不再发出)
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

    const finalUsage: ProviderUsage = usage ?? estimateFallback(req.messages, text, reasoning)
    yield { type: 'usage', usage: finalUsage }
    yield { type: 'finish', reason: mapFinishReason(finishReason, blocked) }
  }

  /** §17.1:usageMetadata → 归一形状(累积末帧即定稿) */
  private normalizeUsage(usage: NonNullable<GeminiChunk['usageMetadata']>): ProviderUsage {
    return {
      inputTokens: usage.promptTokenCount ?? 0,
      cachedInputTokens: usage.cachedContentTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      reasoningTokens: usage.thoughtsTokenCount,
      source: 'reported',
    }
  }

  /** 200 + 错误 JSON(Gemini status 字符串家族,§12 表驱动) */
  private classifyBodyError(chunk: GeminiChunk): ProviderError {
    const text = `${chunk.error?.status ?? ''} ${chunk.error?.message ?? ''}`
    return matchBodyTable(GEMINI_BODY_TABLE, text, this.redact, (chunk.error?.message ?? '').slice(0, 300))
  }

  private parseError(detail: string): ProviderError {
    return providerError('PARSE_ERROR', this.redact, { retryable: true, keyRotatable: false, detail })
  }
}

const GEMINI_BODY_TABLE: readonly BodyErrorRow[] = [
  { code: 'CONTEXT_TOO_LARGE', retryable: false, keyRotatable: false, match: /exceeds the maximum|token limit|too many tokens/i },
  { code: 'AUTH_INVALID', retryable: false, keyRotatable: true, match: /UNAUTHENTICATED|PERMISSION_DENIED/i },
  { code: 'RATE_LIMIT', retryable: true, keyRotatable: true, match: /RESOURCE_EXHAUSTED/i },
  { code: 'MODEL_OVERLOADED', retryable: true, keyRotatable: false, match: /UNAVAILABLE|overloaded/i },
  { code: 'INVALID_REQUEST', retryable: false, keyRotatable: false, match: /INVALID_ARGUMENT|NOT_FOUND|FAILED_PRECONDITION/i },
  { code: 'PROVIDER_ERROR', retryable: true, keyRotatable: false, match: /INTERNAL|INTERNAL_ERROR/i },
]

function mapFinishReason(raw: string | null, blocked: boolean): 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error' {
  if (blocked) return 'content_filter' // promptFeedback.blockReason(prompt 被拦)
  switch (raw) {
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return 'content_filter'
    case null:
    case 'STOP':
    default:
      return 'stop' // MALFORMED_FUNCTION_CALL 等随 P3 工具流细化
  }
}

/** §17.3 estimated 降级(core 估算器,§52 同源;estimated 不入命中率分母) */
function estimateFallback(messages: ProviderChatRequest['messages'], text: string, reasoning: string): ProviderUsage {
  const inputTokens = Math.max(1, messages.reduce((sum, m) => sum + estimateTokens(m.content), 0))
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: Math.max(1, estimateTokens(text) + estimateTokens(reasoning)),
    reasoningTokens: reasoning === '' ? undefined : estimateTokens(reasoning),
    source: 'estimated',
  }
}

// —— §15 静态预设表(gemini 全族;用户覆盖经 capabilityOverrides)——

const GEMINI_BASE: ProviderCapabilities = {
  systemRole: true,
  tools: true,
  vision: true,
  reasoning: false,
  streaming: true,
  promptCaching: true,
  cacheType: 'context-cache',
  maxContextTokens: 131072,
  maxOutputTokens: 8192,
  structuredOutput: 'json_mode',
  parallelToolCalls: false,
  toolChoice: true,
  instructionLayers: 'flat',
}

function familyPreset(model: string): ProviderCapabilities {
  if (/^gemini-(2\.5|3)/i.test(model)) {
    // 2.5+ thinking 系列:thought parts 外显;窗口/输出放宽(静态模板随版本更新,§15)
    return { ...GEMINI_BASE, reasoning: true, maxContextTokens: 1048576, maxOutputTokens: 65536 }
  }
  return GEMINI_BASE
}
