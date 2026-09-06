import type { ProviderError, ProviderErrorCode } from '@desiregrimoire/contracts'

/**
 * HTTP 边界共享件 —— 响应形状 / 错误映射表(§12 表驱动)/ redact(§17.2,PV5)。
 * 三家 adapter 共用;不写 if 链,新错误码进表 = 改 §12 + 此表。
 */

/** 传输抽象:默认 fetch;测试注入内存实现;未来 fixture 回放复用同一形状 */
export type FetchLike = (url: string, init: RequestInit) => Promise<ProviderHttpResponse>

export interface ProviderHttpResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: AsyncIterable<Uint8Array> | null
  text(): Promise<string>
}

/** PV5:密钥零泄漏——错误/日志出模块前必须过 redact(§17.2) */
export function createRedact(secrets: readonly string[]) {
  const known = [...secrets].filter((s) => s.length >= 8)
  return (text: string): string => {
    let redacted = text
    for (const secret of known) {
      redacted = redacted.split(secret).join('[redacted]')
    }
    // 通用兜底:Bearer / sk- 形态的凭据
    redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
    redacted = redacted.replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]')
    return redacted
  }
}

/** ProviderError 构造出口:detail 强制 redact(PV4 + PV5 的唯一收口) */
export function providerError(
  code: ProviderErrorCode,
  redact: (text: string) => string,
  fields: {
    retryable: boolean
    keyRotatable: boolean
    retryAfterMs?: number
    providerStatus?: number
    detail?: string
    raw?: unknown
  },
): ProviderError {
  return {
    code,
    retryable: fields.retryable,
    keyRotatable: fields.keyRotatable,
    retryAfterMs: fields.retryAfterMs,
    providerStatus: fields.providerStatus,
    detail: fields.detail === undefined ? undefined : redact(fields.detail),
    raw: undefined, // §6:raw 调试用,不得进日志默认输出——出模块前统一剥除
  }
}

/**
 * HTTP 状态 → 错误码映射表(§12 表驱动;OpenAI 兼容家族)。
 * 400 的 context_length 细分按 body 判定(表驱动 + 单一谓词,禁 if 链蔓延)。
 */
interface ErrorRow {
  code: ProviderErrorCode
  statuses: readonly number[]
  retryable: boolean
  keyRotatable: boolean
}

const STATUS_TABLE: readonly ErrorRow[] = [
  { code: 'AUTH_INVALID', statuses: [401, 403], retryable: false, keyRotatable: true },
  { code: 'QUOTA_EXCEEDED', statuses: [402], retryable: false, keyRotatable: true },
  { code: 'INVALID_REQUEST', statuses: [404], retryable: false, keyRotatable: false },
  { code: 'RATE_LIMIT', statuses: [429], retryable: true, keyRotatable: true },
  { code: 'MODEL_OVERLOADED', statuses: [503, 529], retryable: true, keyRotatable: false },
  { code: 'PROVIDER_ERROR', statuses: [500, 502, 504], retryable: true, keyRotatable: false },
]

/** 400 细分:context length → CONTEXT_TOO_LARGE;其余 → INVALID_REQUEST(§12) */
export function mapHttpError(
  status: number,
  bodyText: string,
  retryAfterMs: number | undefined,
  redact: (text: string) => string,
): ProviderError {
  if (status === 400) {
    // 覆盖两家表述:OpenAI "maximum context length" / Anthropic "prompt is too long"
    const contextLike =
      /context[_ ]length|max_tokens|maximum context|reduce the length|prompt is too long|exceed[s]? the maximum/i.test(
        bodyText,
      )
    return providerError(
      contextLike ? 'CONTEXT_TOO_LARGE' : 'INVALID_REQUEST',
      redact,
      { retryable: false, keyRotatable: false, providerStatus: status, detail: bodyText.slice(0, 500) },
    )
  }
  const row = STATUS_TABLE.find((r) => r.statuses.includes(status))
  if (row !== undefined) {
    return providerError(row.code, redact, {
      retryable: row.retryable,
      keyRotatable: row.keyRotatable,
      providerStatus: status,
      retryAfterMs,
      detail: bodyText.slice(0, 500),
    })
  }
  return providerError('UNKNOWN', redact, {
    retryable: false, // fail-closed:未知错误不自动重试(§12 UNKNOWN 行)
    keyRotatable: false,
    providerStatus: status,
    detail: bodyText.slice(0, 500),
  })
}

/** Retry-After 头解析(§12:尊重 Retry-After) */
export function parseRetryAfter(headers: ProviderHttpResponse['headers']): number | undefined {
  const raw = headers.get('retry-after')
  if (raw === null || raw === '') return undefined
  const seconds = Number.parseInt(raw, 10)
  return Number.isNaN(seconds) ? undefined : seconds * 1000
}

/**
 * body 错误码表匹配(§12 表驱动;各家 adapter 提供自家行的表,本函数只做查表)。
 * 供"200 + 错误 JSON"与流内 error 事件共用。
 */
export interface BodyErrorRow {
  code: ProviderErrorCode
  retryable: boolean
  keyRotatable: boolean
  match: RegExp
}

export function matchBodyTable(
  rows: readonly BodyErrorRow[],
  text: string,
  redact: (text: string) => string,
  detail: string,
): ProviderError {
  const row = rows.find((r) => r.match.test(text))
  return providerError(row?.code ?? 'UNKNOWN', redact, {
    retryable: row?.retryable ?? false, // fail-closed:未知错误不自动重试(§12)
    keyRotatable: row?.keyRotatable ?? false,
    detail,
  })
}
