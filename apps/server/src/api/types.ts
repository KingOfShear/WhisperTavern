import type { WhisperTavernDb, EventBus, RuntimeEvent, SecretStore, SnapshotRegistry } from '@whispertavern/runtime'
import type { ToolRegistry, WebSearchToolOptions } from '@whispertavern/agent'

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
  /**
   * S28(WP3.6)§154 工具注册表(缺省 = 空注册表)。GET /tools 的读面(§75/§76);
   * agent run 的 tools 清单也出自同一注册面(缺工具 = 模型收不到 tools 清单)。
   */
  tools?: ToolRegistry
  /**
   * S32(WP4.3)网络搜索后端配置(端点 / 凭据 / 传输注入)。
   *
   * **不配 endpoint = 工具 fail-closed**:搜索工具照常注册进注册面(GET /tools 可见、
   * 审批管线照走),但执行时确定性失败而不是静默返回假结果。
   * 为什么"注册但会失败"优于"不配置就不注册":注册面随部署环境漂移会让
   * 缓存面/审批面/测试基线都变成环境相关;把配置差异收敛到工具的**执行**里,
   * 结构面保持恒定。
   */
  webSearch?: WebSearchToolOptions
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
