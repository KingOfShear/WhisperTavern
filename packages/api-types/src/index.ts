import type {
  Chat,
  DebugExportBundle,
  Diagnostic,
  Message,
  MessageRole,
  PromptDiff,
  PromptHashes,
  PromptIR,
  ProviderCapabilities,
  ProviderUsage,
  RedactionPolicy,
  SerializedPrompt,
} from '@whispertavern/contracts'

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

/** §16 响应附带的兄弟链投影(§17 修订):同 variant_group 的未删兄弟(含自身,index 升序) */
export type MessageVariantRefDto = { id: string; variantIndex: number | null }
export type MessageWithVariantsDto = MessageDto & { variants: MessageVariantRefDto[] }

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
}

/** §36/§37 投影:完整 Prompt Snapshot 线格式(字段逐键对齐 GET /prompt-snapshots/:id 响应) */
export type PromptSnapshotDto = {
  id: string
  chatId: string
  runId?: string
  /** §107 Inspector:段级视图的证据源(swipe 轮 = 变体壳 message id) */
  messageId?: string
  provider: string
  model: string
  compilerVersion: string
  /** §36「完整 Prompt Snapshot」:段列表/分区/stability 的线格式面 */
  ir: PromptIR
  cachePlan: unknown
  serialized: SerializedPrompt
  hashes: PromptHashes
  diagnostics: Diagnostic[]
  createdAt: string
}

// ===== Inspector / Diff / Debug Export(§107/§38/§60 debug;S14/WP1.5)=====

/** §36 修订:会话快照列表项(相邻两轮 diff 的枚举面;新建时间降序) */
export type ChatSnapshotSummaryDto = {
  id: string
  chatId: string
  runId: string | null
  provider: string
  model: string
  tokenCount: number
  createdAt: string
}

export type PromptDiffDto = PromptDiff
export type SegmentDiffDto = PromptDiff['segments'][number]

export type InspectorUsageDto = ProviderUsage

/** §107 events 投影(events 表行;live 不落库故天然缺 generation.delta) */
export type InspectorEventDto = {
  id: string
  type: string
  durability: 'durable' | 'deferred-durable' | 'live'
  runId?: string
  sequence: number
  timestamp: string
  payload: Record<string, unknown>
}

/** §107 InspectorData P1 投影:warning 级诊断 + 全量 diagnostics + usage + durable 事件 */
export type InspectorDataDto = {
  snapshot: PromptSnapshotDto
  cache: unknown
  provider: { id: string; model: string }
  usage?: InspectorUsageDto
  warnings: Diagnostic[]
  diagnostics: Diagnostic[]
  events: InspectorEventDto[]
}

export type DebugExportPolicyDto = Partial<RedactionPolicy>
export type DebugExportBundleDto = DebugExportBundle

// ===== §33 遥测与缓存诊断(S20/WP2.5)=====

/** 单轮遥测记录(§41 CacheRoundMetric 落地 + 缓存计划投影) */
export type TelemetryRoundDto = {
  round: number
  runId: string
  createdAt: string
  status: string
  /** provider prompt_tokens(§2.2 token 计) */
  promptTokens: number
  /** provider cached_tokens(§2.2) */
  cachedTokens: number
  outputTokens: number
  usageSource: string
  stablePrefixTokens: number
  freshTokens: number
  volatileTokens: number
  /** §5 前缀过小数据(core 判定;S20 遥测消费) */
  prefixTooSmall?: { threshold: number; actualTokens: number; zone: string }
  breakReasons: string[]
  invalidationRisk: 'low' | 'medium' | 'high'
  /** 每轮**实际发送内容**(serialized.parts 投影;role=null 表示无角色块) */
  sentParts: { role: string | null; content: string }[]
  sentTokenCount: number
  /** serialized 全量哈希(跨轮字节前缀比对的锚点,§57/§65) */
  sentHash: string
  segmentCount: number
}

/**
 * §41 aggregate —— 状态量分层(plan 计 = 理论可缓存面;provider 计 = 实际回传面)。
 * `estimatedCost`(货币化)暂缺:仓库无 provider 价格表,§2.2 token 计是唯一权威。
 */
export type TelemetryAggregateDto = {
  /** Σ plan 计稳定前缀 token(理论可缓存基线) */
  stableTokens: number
  /** Σ plan 计输入 token(可参与缓存判定的总量) */
  eligibleTokens: number
  /** Σ provider cached_tokens(实际层) */
  cachedTokens: number
  /** Σ provider (prompt − cached)(实际层) */
  freshTokens: number
  /** 理论缓存率(plan 计;= simulator.theoreticalHitRatio) */
  theoreticalHitRate: number
  /** 实际命中率(provider 计;无 reported 轮 → undefined) */
  actualHitRate?: number
  reportedHitRate?: number
  overallHitRate?: number
}

/** §33.3 CacheBreak 事件 */
export type TelemetryCacheBreakDto = {
  round: number
  runId: string
  reasons: string[]
  stablePrefixTokens: number
}

/** §20 Cache Simulator 单轮结果(plan 计理论层 + provider 计实际层并列) */
export type TelemetrySimulatorRoundDto = {
  round: number
  theoreticalStableTokens: number
  theoreticalCachedTokens: number
  theoreticalFreshTokens: number
  planInputTokens: number
  providerInputTokens?: number
  actualCachedTokens?: number
  hitRatio: number
  actualHitRatio?: number
  cacheBreak: boolean
  breakReasons: string[]
  firstDivergenceSegment?: string
}

/**
 * §20 Cache Simulator 摘要(消费真实编译产物;理论缓存率/成本削减/Killer)。
 * §33.2 两套口径并列:理论层 = plan token 计,实际层 = provider 回传,严禁混算。
 */
export type TelemetrySimulatorDto = {
  /** 理论缓存率 = Σ 理论承接 / Σ 计划输入(plan token 计) */
  theoreticalHitRatio: number
  /** 实际命中率 = Σ provider cached / Σ provider prompt(仅实际层齐全轮次) */
  actualHitRatio?: number
  /** 无缓存基线 = Σ 计划输入 token */
  baselineInputTokens: number
  /** 需全价处理 = Σ 理论新鲜 token */
  uncachedInputTokens: number
  inputCostReduction: number
  topCacheKillers: { reason: string; count: number }[]
  rounds: TelemetrySimulatorRoundDto[]
}

/** §41 Cache Telemetry 响应 */
export type ChatTelemetryDto = {
  rounds: TelemetryRoundDto[]
  aggregate: TelemetryAggregateDto
  cacheBreaks: TelemetryCacheBreakDto[]
  simulator: TelemetrySimulatorDto
}

/** §42 Cache Break Diagnosis(二分定位"谁毁了缓存") */
export type CacheBreakDiagnosisDto = {
  broken: boolean
  firstDivergence?: {
    previousSnapshot: string
    currentSnapshot: string
    segmentId: string
    /** 段 content 内首个分歧字节的 UTF-8 偏移(S20 补齐) */
    byteOffset: number
    sourceId?: string
    reason: string
    /** 裁剪归因:该段被 §49 Budget Manager 标记 enabled=false,S20 显式标注(§58 暂无 BUDGET_TRIM 原因码) */
    trimReason?: 'BUDGET_TRIM'
  }
  affectedTokens: number
  suggestions: string[]
}

/** §44 Cache Simulation Result(零 API 成本;不调 Provider) */
export type CacheSimulationResultDto = {
  rounds: {
    round: number
    stableTokens: number
    freshTokens: number
    volatileTokens: number
    prefixHash: string
    theoreticalCachedTokens: number
    cacheBreak?: string
  }[]
  aggregate: {
    expectedCacheRatio: number
    totalInvalidatedTokens: number
  }
  simulator: TelemetrySimulatorDto
  /** §43 scenarios 属确定性回放,S21 WP2.6 交付;此处回显未支持项 */
  unsupportedScenarios: string[]
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

// ===== P3 Agent API(§154;Dto 按 §62/§64/§66/§76/§79 线格式投影)=====

/** §62 Agent Definition 投影(§154 GET/POST /agents) */
export type AgentDefinitionDto = {
  id: string
  version: number
  name: string
  description?: string
  type: string
  instructions: string
  contextPolicy: Record<string, unknown>
  memoryPolicy: Record<string, unknown>
  toolPolicy: Record<string, unknown>
  modelPolicy: Record<string, unknown>
  runtimePolicy: {
    maxTurns: number
    maxToolCalls: number
    maxExecutionTimeMs: number
  } & Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type CreateAgentRequest = {
  name: string
  description?: string
  type?: string
  instructions?: string
  contextPolicy?: Record<string, unknown>
  memoryPolicy?: Record<string, unknown>
  toolPolicy?: Record<string, unknown>
  modelPolicy?: Record<string, unknown>
  runtimePolicy?: AgentDefinitionDto['runtimePolicy']
  metadata?: Record<string, unknown>
}

/** §64 启动 Agent Run(POST /agents/{agentId}/runs) */
export type AgentRunRequest = {
  input: string
  chatId?: string
  parentRunId?: string
  context?: Record<string, unknown>
  /** §70 AgentBudget 子树(§39 四护栏字段在 delegate/handoff 消费) */
  budget?: Partial<{
    maxTurns: number
    maxToolCalls: number
    maxExecutionTimeMs: number
    maxDepth: number
    maxChildren: number
    maxTotalAgents: number
    maxRuntimeMs: number
  }>
}

export type AgentRunStartDto = {
  runId: string
  chatId: string
  agentId: string
  status: string
}

/** §66 Agent Run 状态(§65 AgentRunState 的 §4.3 投影) */
export type AgentRunStateDto = {
  runId: string
  chatId: string
  agentId: string
  agentVersion: number
  status: string
  mode: string
  provider?: string
  model?: string
  parentRunId?: string
  createdAt: string
  updatedAt: string
  error?: string
}

/** §76 ToolDefinition 投影(§154 GET /tools) */
export type ToolDefinitionDto = {
  id: string
  name: string
  description: string
  inputSchema: unknown
  permission: string
  source: 'core' | 'plugin'
}

/** §79 Skill 投影(§154 GET /skills) */
export type SkillDefinitionDto = {
  id: string
  name: string
  description?: string
}

/** §71 Delegate(POST /agent-runs/{runId}/delegate) */
export type DelegateRequest = {
  agentId: string
  task: string
  context?: Record<string, unknown>
  budget?: AgentRunRequest['budget']
}

/** §73 Handoff(POST /agent-runs/{runId}/handoff) */
export type HandoffRequest = {
  targetAgentId: string
  reason: string
  findings?: string
  artifacts?: string[]
}

// ===== S31(WP4.2b)Memory HTTP 面 DTO(api-spec §88–§92 / §155;DTO = 线格式投影,语义不漂移)=====

/** §89 Memory(api-spec §89;跨层统一投影,kind 区分四层) */
export type MemoryDto = {
  id: string
  chatId: string
  kind: 'summary' | 'dossier' | 'timeline' | 'document'
  entity?: string
  content: string
  importance?: number
  sourceMessageIds?: string[]
  embedding?: { model: string }
  /** §88 Search Memory 检索命中投影才携带:跨层可比相关度(0..1) */
  score?: number
  createdAt: string
  updatedAt: string
}

/** §90 Summary Block(api-spec §90;冻结后不可回写) */
export type SummaryBlockDto = {
  id: string
  seq: number
  content: string
  coversMessageRange: { from: string; to: string }
  frozenAt: string
  tokenCount?: number
}

/** §90 POST /chats/:id/summaries 请求 */
export type CreateSummaryRequest = {
  content: string
  coversMessageRange: { from: string; to: string }
  tokenCount?: number
}

/** §91 Dossier 实体卡(api-spec §91;Scribe 维护的事实卡) */
export type DossierEntityDto = {
  id: string
  chatId: string
  entity: string
  content: string
  importance?: number
  confidence?: number
  version: number
  sourceMessageIds?: string[]
  createdAt: string
  updatedAt: string
}

/** §91 POST /chats/:id/dossier/entities 请求 */
export type CreateDossierEntityRequest = {
  entity: string
  content: string
  importance?: number
  confidence?: number
  sourceMessageIds?: string[]
}

/** §92 Timeline 事件(api-spec §92;只追加) */
export type TimelineEventDto = {
  id: string
  chatId: string
  eventType: string
  summary: string
  participants?: string[]
  location?: string
  consequences?: string
  sourceMessageId?: string
  importance?: number
  emotionalWeight?: number
  createdAt: string
}

/** §92 POST /chats/:id/timeline 请求 */
export type CreateTimelineEventRequest = {
  eventType: string
  summary: string
  participants?: string[]
  location?: string
  consequences?: string
  sourceMessageId?: string
  importance?: number
  emotionalWeight?: number
}

/** §88 POST /chats/:id/memory/search 请求 */
export type SearchMemoryRequest = {
  query: string
  limit?: number
  kinds?: ('summary' | 'dossier' | 'timeline' | 'document')[]
}

/** §88 POST /chats/:id/memory/search 响应 */
export type SearchMemoryResultDto = {
  items: MemoryDto[]
  total: number
}

/** wp4.2b Scribe 触发(POST /chats/:id/memory/scribe;§143 长任务先track后异步) */
export type ScribeTriggerRequest = {
  providerId?: string
  model?: string
  fromMessageId?: string
  toMessageId?: string
  budget?: AgentRunRequest['budget']
}

export type ScribeTriggerStartDto = {
  runId: string
  chatId: string
  scribeChatId: string
  status: string
}
