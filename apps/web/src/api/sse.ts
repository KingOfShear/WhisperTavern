import { SSE_EVENT_TYPES, type SseEnvelope } from '@desiregrimoire/api-types'

/**
 * SSE 客户端(api-spec §26/§27/§142):
 * - 原生 EventSource 承载 GET /api/v2/runs/{runId}/events;断线自动重连,
 *   浏览器自动回传 Last-Event-ID(§142 续传)。
 * - §27 sequence 校验:重复/回退丢弃(重连重放语义),缺口告警但不中断。
 * - 终态事件(generation.completed/failed)到达即关流(D4)。
 */

const TERMINAL_TYPES = new Set(['generation.completed', 'generation.failed'])

/** §27 sequence 校验(纯函数,测试锁定) */
export function validateSequence(last: number, next: number): 'accept' | 'duplicate' | 'gap' {
  if (next <= last) return 'duplicate'
  if (last > 0 && next > last + 1) return 'gap'
  return 'accept'
}

export interface RunStreamHandlers {
  onEvent: (envelope: SseEnvelope) => void
  onDone?: () => void
  onError?: (error: unknown) => void
}

export interface RunStream {
  close: () => void
}

export function openRunStream(runId: string, handlers: RunStreamHandlers): RunStream {
  const source = new EventSource(`/api/v2/runs/${runId}/events`)
  let lastSequence = 0
  let done = false

  const handle = (raw: MessageEvent<string>): void => {
    let envelope: SseEnvelope
    try {
      envelope = JSON.parse(raw.data) as SseEnvelope
    } catch (error) {
      handlers.onError?.(error)
      return
    }
    const verdict = validateSequence(lastSequence, envelope.sequence)
    if (verdict === 'duplicate') return
    if (verdict === 'gap') {
      // §27:客户端可检测缺口(如 1,2,3,5);告警但不中断(§142 重连语义下属正常)
      console.warn(`[sse] sequence gap: ${lastSequence} → ${envelope.sequence}`)
    }
    lastSequence = envelope.sequence
    handlers.onEvent(envelope)
    if (TERMINAL_TYPES.has(envelope.type)) {
      done = true
      source.close()
      handlers.onDone?.()
    }
  }

  for (const type of SSE_EVENT_TYPES) {
    source.addEventListener(type, handle as EventListener)
  }
  source.onerror = (error) => {
    if (!done) handlers.onError?.(error) // EventSource 将自动重连并回传 Last-Event-ID
  }
  return {
    close: () => {
      source.close()
    },
  }
}
