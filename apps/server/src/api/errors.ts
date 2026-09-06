import type { ProviderErrorCode } from '@whispertavern/contracts'

/**
 * HTTP 错误信封(api-spec §7/§8)+ ProviderError → API 错误码映射(§19 三层映射:
 * provider 归一错误在 HTTP 面投影为 §8 核心错误码,不透传 provider 形状)。
 */

export type ApiErrorCode = string

/** §8 核心错误码的 P0 注册子集(开放 string,新码随 WP 增) */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'PROMPT_COMPILE_FAILED',
  'PROMPT_BUDGET_EXCEEDED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_BAD_RESPONSE',
  'GENERATION_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
] as const

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
    retryable: boolean
    requestId: string
  }
}

/** HTTP 状态映射:§8 码 → 状态码(P0 子集;§7 信封固定形状) */
export function httpStatusFor(code: string): number {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'BAD_REQUEST':
      return 400
    case 'NOT_FOUND':
    case 'GENERATION_NOT_FOUND':
    case 'PROVIDER_NOT_FOUND':
      return 404
    case 'CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
      return 409
    case 'PROMPT_COMPILE_FAILED':
    case 'PROMPT_BUDGET_EXCEEDED':
      return 422
    default:
      return 500
  }
}

/** provider-adapter §12 码 → api-spec §8 码(三层映射的最后一层) */
export function mapProviderErrorCode(code: ProviderErrorCode): ApiErrorCode {
  switch (code) {
    case 'AUTH_INVALID':
      return 'PROVIDER_AUTH_FAILED'
    case 'RATE_LIMIT':
      return 'PROVIDER_RATE_LIMITED'
    case 'TIMEOUT_FIRST_TOKEN':
    case 'TIMEOUT_IDLE':
      return 'PROVIDER_TIMEOUT'
    case 'PARSE_ERROR':
      return 'PROVIDER_BAD_RESPONSE'
    case 'CANCELLED':
      return 'GENERATION_CANCELLED'
    default:
      return 'PROVIDER_UNAVAILABLE'
  }
}
