import { providerError } from './http'
import type { ProviderError, ProviderErrorCode } from '@whispertavern/contracts'

/**
 * 分层超时 —— provider-adapter-spec §14(全部可配置,默认值实施期定,P0 落默认):
 * connect(TCP/TLS 建连)→ TRANSPORT_ERROR;
 * first-token(建连后无首事件)→ TIMEOUT_FIRST_TOKEN;
 * idle(流中途无任何字节)→ TIMEOUT_IDLE。
 * 内部 AbortController 与调用方 signal 链接;超时 = abort 网络读 + 归一错误。
 */

export interface TimeoutConfig {
  connectMs: number
  firstTokenMs: number
  idleMs: number
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  connectMs: 15_000,
  firstTokenMs: 60_000,
  idleMs: 120_000,
}

/** 链接调用方 signal 与超时:任一触发都 abort 内部 controller */
export class TimeoutController {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly onOuterAbort = (): void => this.controller.abort()

  constructor(
    outerSignal: AbortSignal | undefined,
    private readonly redact: (text: string) => string,
  ) {
    this.signal = this.controller.signal
    outerSignal?.addEventListener('abort', this.onOuterAbort, { once: true })
    if (outerSignal?.aborted === true) this.controller.abort()
  }

  /** 设定当前阶段的截止;每次调用先清除上一阶段计时器 */
  arm(kind: keyof TimeoutConfig, ms: number): void {
    this.disarm()
    this.timer = setTimeout(() => {
      this.timedOut = kind
      this.controller.abort()
    }, ms)
  }

  disarm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private timedOut: keyof TimeoutConfig | undefined

  /** 外层 signal 触发 = CANCELLED;超时触发 = 对应 TIMEOUT 码 */
  toProviderError(): ProviderError {
    if (this.timedOut !== undefined) {
      const code: ProviderErrorCode =
        this.timedOut === 'connectMs' ? 'TRANSPORT_ERROR' : this.timedOut === 'firstTokenMs' ? 'TIMEOUT_FIRST_TOKEN' : 'TIMEOUT_IDLE'
      return providerError(code, this.redact, { retryable: true, keyRotatable: false, detail: `分层超时触发: ${this.timedOut}` })
    }
    return providerError('CANCELLED', this.redact, { retryable: false, keyRotatable: false, detail: 'aborted by caller signal' })
  }

  dispose(): void {
    this.disarm()
  }
}
