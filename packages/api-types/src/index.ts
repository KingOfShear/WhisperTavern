import type {
  Chat,
  Diagnostic,
  Message,
  MessageRole,
  PromptHashes,
  ProviderCapabilities,
  ProviderUsage,
  SerializedPrompt,
} from '@desiregrimoire/contracts'

/**
 * HTTP/SSE 线格式 DTO —— contracts 的投影/反导出(shared-contracts-spec C2;
 * api-spec §1.2:DTO 是模块规格的线格式投影,字段裁剪与命名映射可以发生,
 * 语义不得漂移)。前端一律从这里引 DTO,禁止直接 import contracts(§1.2
 * 防止领域类型泄漏到线上协议)。
 *
 * S7(WP0.8)随 web 客户端充实;服务端响应形状以此为准(api-spec §6/§7/§27)。
 */

// ===== 信封(api-spec §6/§7)=====

export type ApiEnvelope<T> = { data: T; requestId: string }

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
    retryable: boolean
    requestId: string
  }
}

// ===== SSE(api-spec §26/§27)=====

/** §27 信封:id/event 载荷字段由 SSE 帧行承载,sequence 为 Last-Event-ID 锚点 */
export type SseEnvelope<T = unknown> = {
  id: string
  type: string
  runId?: string
  timestamp: string
  sequence: number
  data: T
}

/** P0 客户端订阅的事件名(§28;总设计 §5.4 权威名的 SSE 投影子集) */
export const SSE_EVENT_TYPES = [
  'generation.started',
  'generation.delta',
  'generation.completed',
  'generation.failed',
  'usage.recorded',
  'prompt.compiled',
  'prompt.snapshot.created',
  'message.created',
] as const
export type SseEventType = (typeof SSE_EVENT_TYPES)[number]

export type GenerationDeltaData = { generationId?: string; text: string }
export type GenerationTerminalData = { generationId?: string; finishReason?: string; error?: { code: string; message: string }; status?: string }
export type UsageRecordedData = { usage: ProviderUsage; generationId?: string }

// ===== chats / messages(§11–§19 投影)=====

/** 会话列表项(§12;裁剪自 contracts Chat) */
export type ChatSummaryDto = Pick<Chat, 'id' | 'title' | 'modelProvider' | 'modelName' | 'createdAt'> & {
  /** P0 服务端列表投影含绑定与活跃分支;字段随 §11/§13 对齐 */
  characterId?: Chat['characterId']
  activeBranchId?: Chat['activeBranchId']
}

export type ChatDto = Chat

/** §17 Message 线格式(DB 权威模型 variant_group_id/index 投影为兄弟链,§17 修订) */
export type MessageDto = Pick<
  Message,
  'id' | 'chatId' | 'parentMessageId' | 'sequence' | 'role' | 'authorType' | 'content' | 'createdAt' | 'variantGroupId' | 'variantIndex'
>

export type CreateMessageRequest = {
  parentId?: string
  role: Extract<MessageRole, 'user' | 'system' | 'narrator'>
  content: string
}

// ===== 生成(§24/§25/§28)=====

export type GenerateRequest = {
  parentMessageId?: string
  providerId?: string
  model?: string
  sampling?: { temperature?: number; topP?: number; maxOutputTokens: number; stopSequences?: string[]; seed?: number }
}

/** §24 响应:长任务原则——ids 立即返回,流走 SSE */
export type GenerateStartDto = {
  runId: string
  generationId: string
  messageId: string
  snapshotId: string
}

/** §25 GenerationState(P0 子集) */
export type GenerationState = 'streaming' | 'completed' | 'failed' | 'cancelled'

// ===== 编译与快照(§32–§36 投影)=====

export type CompilePreviewDto = {
  snapshotId: string
  hashes: PromptHashes
  serialized: SerializedPrompt
  diagnostics: Diagnostic[]
  authorityFingerprint?: string
}

export type PromptSnapshotDto = CompilePreviewDto & {
  chatId: string
  runId?: string
  provider: string
  model: string
  compilerVersion: string
  cachePlan: unknown
  createdAt: string
}

// ===== providers(§37 投影;密钥零回显)=====

export type ProviderDto = {
  id: string
  name: string
  type: 'openai-compat' | 'anthropic' | 'gemini' | 'fake'
  config: {
    baseUrl: string | null
    secretRef: string | null
    models: string[]
  }
  enabled: boolean
}

export type CreateProviderRequest = {
  name: string
  type: ProviderDto['type']
  baseUrl?: string
  apiKey?: string
  models?: string[]
  /** 测试/fake provider 的脚本(P0;不出现在响应投影) */
  fakeTurns?: { text: string }[]
}

// ===== capabilities 透传(§15;Inspector/设置页展示用)=====
export type CapabilitiesDto = ProviderCapabilities
