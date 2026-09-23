import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderChatRequest,
  ProviderError,
  ProviderStreamEvent,
  ProviderUsage,
} from '@whispertavern/contracts'
import { estimateTokens } from '@whispertavern/core'
import { translateCachePlan } from '../cache/translate'
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
 * Anthropic Messages adapter —— provider-adapter-spec §8.2 映射列的协议翻译层。
 *
 * 关键实现点:
 * - **usage 双帧合成(PV3 实现点)**:input 取 `message_start`,output 取
 *   `message_delta`(累积,取末值),流末合成**恰一次** usage 事件(§17.1);
 *   任一侧缺失 → 整体 estimated 降级(§17.3,core 估算器)。
 * - **thinking 签名块(PV8)**:`thinking_delta` → reasoning_delta;
 *   `signature_delta` → 空文本 reasoning_delta 携带 signature(§8.1 载体约定),
 *   P3 组装侧配对成 ContentBlock.thinking,工具循环原样回传。
 * - system 角色消息翻译为顶层 `system` 参数(协议结构翻译,PV1 内容零改写);
 *   Anthropic 无 seed 参数,静默不发送(发未知参数 = 400)。
 * - 缓存 = explicit-breakpoint 家族:S19 已实现 CachePlan → cache_control 翻译(§16),
 *   system 转块形 + user 消息挂 ephemeral 标记,assistant 目标防御性丢弃,前缀过小抑制。
 */

export interface AnthropicConfig {
  /** 形如 https://api.anthropic.com */
  baseUrl: string
  /** x-api-key 头(Anthropic 必需;经 redact 覆盖) */
  apiKey: string
  anthropicVersion?: string
  capabilityOverrides?: Partial<ProviderCapabilities>
  fetchImpl?: FetchLike
  timeouts?: Partial<TimeoutConfig>
}

interface AnthropicFrame {
  type?: string
  message?: { usage?: AnthropicUsage }
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; stop_reason?: string }
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic'

  private readonly redact: (text: string) => string
  private readonly timeouts: TimeoutConfig
  private readonly doFetch: FetchLike

  constructor(private readonly config: AnthropicConfig) {
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

  /** §15:静态预设 + 用户覆盖;claude 全族 explicit-breakpoint 缓存 */
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
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`
    // system 角色翻译为顶层 system 参数(PV1:内容零改写,只做结构翻译)
    const systemParts = req.messages.filter((m): m is Extract<ProviderChatRequest['messages'][number], { role: 'system' }> => m.role === 'system')
    const messages = req.messages.filter(
      (m): m is AnthropicMessage => m.role !== 'system',
    )

    // §16 缓存标记翻译(S19):explicit-breakpoint 家族把 CachePlan 断点翻译为 cache_control。
    // 无标记(undefined)→ 保持现状逐字节不变(兼容既有 fixture/回放)。
    const cacheMarkers = translateCachePlan(req.cachePlan, this.capabilities(req.model))
    // system 只在"断点确落 system 区"时才转块形挂标记;否则保持 join 串(无 cachePlan 时逐字节一致)
    const systemBlocks = cacheMarkers === undefined ? undefined : withSystemCacheControl(systemParts, cacheMarkers)
    const system =
      systemParts.length === 0 ? undefined : systemBlocks ?? systemParts.map((m) => m.content).join('\n\n')

    // messages 区 cache_control:对 target 在 messages 区的断点,把该条 content 转块形挂标记
    const wiredMessages =
      cacheMarkers === undefined
        ? messages
        : applyMessageBreakpoints(messages, systemParts.length, cacheMarkers)

    const body = JSON.stringify({
      model: req.model,
      max_tokens: req.sampling.maxOutputTokens, // Anthropic 必填
      stream: true,
      ...(system !== undefined ? { system } : {}),
      messages: wiredMessages,
      temperature: req.sampling.temperature,
      top_p: req.sampling.topP,
      stop_sequences: req.sampling.stopSequences,
      // seed 不是 Anthropic 参数,静默不发送(发未知参数 = 400)
    })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': this.config.anthropicVersion ?? '2023-06-01',
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
    yield { type: 'message_start' }

    // 双帧合成(§17.1):input@message_start + output@message_delta,流末恰一次
    let inputTokens: number | undefined
    let cachedInputTokens: number | undefined
    let outputTokens: number | undefined
    let text = ''
    let reasoning = ''
    let stopReason: string | null = null

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

      let frame: AnthropicFrame
      try {
        frame = JSON.parse(next.value) as AnthropicFrame
      } catch (error) {
        yield { type: 'error', error: this.parseError(`SSE 帧 JSON 解析失败: ${String(error).slice(0, 120)}`) }
        return
      }

      switch (frame.type) {
        case 'message_start':
          inputTokens = frame.message?.usage?.input_tokens
          cachedInputTokens = frame.message?.usage?.cache_read_input_tokens
          break
        case 'content_block_delta': {
          if (frame.delta?.type === 'text_delta' && typeof frame.delta.text === 'string' && frame.delta.text !== '') {
            text += frame.delta.text
            yield { type: 'text_delta', text: frame.delta.text }
          }
          // PV8:thinking 文本归一 reasoning_delta;签名块以空文本事件携带(§8.1 载体约定)
          if (frame.delta?.type === 'thinking_delta' && typeof frame.delta.thinking === 'string' && frame.delta.thinking !== '') {
            reasoning += frame.delta.thinking
            yield { type: 'reasoning_delta', text: frame.delta.thinking }
          }
          if (frame.delta?.type === 'signature_delta' && typeof frame.delta.signature === 'string' && frame.delta.signature !== '') {
            yield { type: 'reasoning_delta', text: '', signature: frame.delta.signature }
          }
          break
        }
        case 'message_delta':
          if (frame.delta?.stop_reason !== undefined) stopReason = frame.delta.stop_reason
          if (frame.usage?.output_tokens !== undefined) outputTokens = frame.usage.output_tokens
          break
        case 'error':
          yield { type: 'error', error: this.classifyStreamError(frame) }
          return
        default:
          break // ping / content_block_start / content_block_stop / message_stop:无归一产出
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

    // §17.1/§17.3:双帧齐备 → reported;任一侧缺失 → 整体 estimated(诚实降级)
    const usage: ProviderUsage =
      inputTokens !== undefined && outputTokens !== undefined
        ? {
            inputTokens,
            cachedInputTokens: cachedInputTokens ?? 0,
            outputTokens,
            // §17.1:Anthropic thinking 计入 outputTokens,不单列 reasoningTokens
            source: 'reported',
          }
        : estimateFallback(req.messages, text, reasoning)
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: mapStopReason(stopReason) }
  }

  /** 流内 error 事件(§12 表驱动;Anthropic error.type 家族) */
  private classifyStreamError(frame: AnthropicFrame): ProviderError {
    const text = `${frame.error?.type ?? ''} ${frame.error?.message ?? ''}`
    return matchBodyTable(ANTHROPIC_ERROR_TABLE, text, this.redact, (frame.error?.message ?? '').slice(0, 300))
  }

  private parseError(detail: string): ProviderError {
    return providerError('PARSE_ERROR', this.redact, { retryable: true, keyRotatable: false, detail })
  }
}

/** Anthropic error.type → §12 码(流内 error 与 200 错误体共用) */
const ANTHROPIC_ERROR_TABLE: readonly BodyErrorRow[] = [
  { code: 'CONTEXT_TOO_LARGE', retryable: false, keyRotatable: false, match: /prompt is too long|context length|exceed[s]? the maximum/i },
  { code: 'AUTH_INVALID', retryable: false, keyRotatable: true, match: /authentication_error|permission_error/i },
  { code: 'RATE_LIMIT', retryable: true, keyRotatable: true, match: /rate_limit_error/i },
  { code: 'MODEL_OVERLOADED', retryable: true, keyRotatable: false, match: /overloaded_error/i },
  { code: 'INVALID_REQUEST', retryable: false, keyRotatable: false, match: /invalid_request_error|not_found_error/i },
  { code: 'PROVIDER_ERROR', retryable: true, keyRotatable: false, match: /api_error/i },
]

function mapStopReason(raw: string | null): 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error' {
  switch (raw) {
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'content_filter'
    case null:
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'stop'
  }
}

/** §17.3 estimated 降级(core 估算器,§52 同源;estimated 不入命中率分母) */
function estimateFallback(messages: ProviderChatRequest['messages'], text: string, reasoning: string): ProviderUsage {
  const inputTokens = Math.max(1, messages.reduce((sum, m) => sum + estimateTokens(m.content), 0))
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: Math.max(1, estimateTokens(text) + estimateTokens(reasoning)),
    source: 'estimated', // thinking 计入 output,不单列(§17.1)
  }
}

// —— §16 缓存标记翻译辅助(S19:explicit-breakpoint → cache_control)——

type AnthropicMessage = Extract<ProviderChatRequest['messages'][number], { role: 'assistant' | 'user' }>

/** cache_control 挂载后的块形(P0 content 纯文本 → blocks;P3 工具块随工具流收编) */
interface AnthropicCacheBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}
/** wire 消息形状:纯文本(未挂标记)或块形(已挂标记) */
type WiredMessage = AnthropicMessage | { role: 'assistant' | 'user'; content: AnthropicCacheBlock[] }

/**
 * system 参数转块形并挂 cache_control(§5 断点1:header+stableWB+freshWB 末尾落 system)。
 * 断点不在 system 区 → 返回 undefined 退回 join 串(无标记必要,基线零漂移)。
 * 结构翻译(PV1):text 字节零改写,仅字符串 → blocks 容器 + 标记。
 */
function withSystemCacheControl(
  systemParts: readonly { role: 'system'; content: string }[],
  markers: { breakpoints: { afterPartIndex: number }[] },
): AnthropicCacheBlock[] | undefined {
  const systemBreak = markers.breakpoints.find((b) => b.afterPartIndex < systemParts.length)
  if (systemBreak === undefined) return undefined
  const blocks: AnthropicCacheBlock[] = systemParts.map((m) => ({ type: 'text' as const, text: m.content }))
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1]
    if (last !== undefined) last.cache_control = { type: 'ephemeral' }
  }
  return blocks
}

/**
 * messages 区 cache_control:目标 = 断点 afterPartIndex 对应的消息(parts 下标扣除 system 前缀)。
 * assistant 角色目标 → 防御性丢弃(Anthropic 禁止 assistant 挂 cache_control,宁缺毋滥)。
 */
function applyMessageBreakpoints(
  messages: AnthropicMessage[],
  systemCount: number,
  markers: { breakpoints: { afterPartIndex: number }[] },
): WiredMessage[] {
  const targets = new Set<number>()
  for (const b of markers.breakpoints) {
    const wireIndex = b.afterPartIndex - systemCount
    const target = messages[wireIndex]
    if (target === undefined || target.role === 'assistant') continue // assistant 丢弃
    targets.add(wireIndex)
  }
  if (targets.size === 0) return messages
  return messages.map((m, i) => {
    if (!targets.has(i)) return m
    return {
      ...m,
      content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
    }
  })
}

// —— §15 静态预设表(claude 全族;用户覆盖经 capabilityOverrides)——

const CLAUDE_BASE: ProviderCapabilities = {
  systemRole: true,
  tools: true,
  vision: true,
  reasoning: false,
  streaming: true,
  promptCaching: true,
  cacheType: 'explicit-breakpoint',
  maxContextTokens: 200000,
  maxOutputTokens: 8192,
  structuredOutput: 'none',
  parallelToolCalls: false,
  toolChoice: true,
}

const REASONING_PATTERN = /^claude-(3-7|4|opus-4|sonnet-4)/i

function familyPreset(model: string): ProviderCapabilities {
  if (REASONING_PATTERN.test(model)) {
    // 3.7+ 支持 extended thinking;maxOutput 随之放宽(静态模板随版本更新,§15)
    return { ...CLAUDE_BASE, reasoning: true, maxOutputTokens: 64000 }
  }
  return CLAUDE_BASE
}
