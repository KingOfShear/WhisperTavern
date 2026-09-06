import type { WhisperTavernDb, EventBus, RuntimeEvent, SecretStore, SnapshotRegistry } from '@whispertavern/runtime'

/**
 * Server 依赖装配(总设计 §7:apps/server 纯传输层,无业务逻辑——本接口是
 * 组合根;路由只做 HTTP ↔ runtime 调用的翻译)。
 */

export interface ServerLogger {
  (level: 'error' | 'info', message: string, meta?: unknown): void
}

export interface ServerDeps {
  store: WhisperTavernDb
  bus: EventBus
  snapshots: SnapshotRegistry
  secretStore: SecretStore
  logger?: ServerLogger
  /** 密钥目录(server 引导时已建;测试用临时目录) */
  secretsDir: string
  /** 资产根目录(data/):cards/<slug>/ 与 worldbooks/ 落盘 */
  assetsDir: string
}

/** api-spec §27 SSE 信封 */
export interface SseEnvelope {
  id: string
  type: string
  runId?: string
  timestamp: string
  sequence: number
  data: unknown
}

export function envelopeOf(event: RuntimeEvent): SseEnvelope {
  return {
    id: event.id,
    type: event.type,
    runId: event.runId,
    timestamp: event.timestamp,
    sequence: event.sequence ?? 0,
    data: event.payload,
  }
}

/** SSE 帧:id = sequence(Last-Event-ID 锚点)/ event = 事件名 / data = 信封 JSON */
export function sseFrame(event: RuntimeEvent): string {
  return `id: ${event.sequence ?? 0}\nevent: ${event.type}\ndata: ${JSON.stringify(envelopeOf(event))}\n\n`
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
} as const
