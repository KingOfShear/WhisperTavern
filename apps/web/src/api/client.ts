import type {
  ApiErrorBody,
  ApiEnvelope,
  CacheBreakDiagnosisDto,
  CacheSimulationResultDto,
  ChatSnapshotSummaryDto,
  ChatTelemetryDto,
  CreateDossierEntityRequest,
  CreateSummaryRequest,
  CreateTimelineEventRequest,
  DebugExportBundleDto,
  DebugExportPolicyDto,
  DossierEntityDto,
  MessageWithVariantsDto,
  PromptDiffDto,
  PromptSnapshotDto,
  ProviderDto,
  SearchMemoryResultDto,
  ScribeTriggerRequest,
  ScribeTriggerStartDto,
  SummaryBlockDto,
  TimelineEventDto,
} from '@whispertavern/api-types'

/**
 * HTTP 客户端薄壳(api-spec §6/§7):信封解包 + 错误归一。
 * 字段形状全部来自 @whispertavern/api-types(禁止手写线格式,S7 任务 2)。
 */

export class ApiClientError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly requestId: string
  readonly details?: unknown

  constructor(body: ApiErrorBody['error']) {
    super(body.message)
    this.name = 'ApiClientError'
    this.code = body.code
    this.retryable = body.retryable
    this.requestId = body.requestId
    this.details = body.details
  }
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await res.json()) as ApiEnvelope<T> | ApiErrorBody
  if ('error' in body) throw new ApiClientError(body.error)
  return body.data
}

export const api = {
  listChats: () => apiRequest('/api/v2/chats'),

  createChat: (body: { title?: string; systemPrompt?: string }) =>
    apiRequest<{ id: string; title: string | null }>('/api/v2/chats', { method: 'POST', body: JSON.stringify(body) }),

  listMessages: (chatId: string, query = '') =>
    apiRequest<MessageWithVariantsDto[]>(`/api/v2/chats/${chatId}/messages${query}`),

  createMessage: (chatId: string, body: { parentId?: string; role: 'user' | 'system' | 'narrator'; content: string }) =>
    apiRequest<{ message: MessageDtoLite; activeLeaf: string }>(`/api/v2/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** §19 编辑:新建变体,原消息内容永不动 */
  editMessage: (messageId: string, content: string) =>
    apiRequest<MessageDtoLite>(`/api/v2/messages/${messageId}/edit`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  /** 软删 + message.deleted;活跃指针回退最近未删祖先 */
  deleteMessage: (messageId: string) =>
    apiRequest<{ messageId: string; deletedAt: string; activeLeaf: string | null }>(`/api/v2/messages/${messageId}`, {
      method: 'DELETE',
    }),

  /** §21 分支:不复制聊天,只记录血缘位并切活跃指针 */
  createBranch: (chatId: string, fromMessageId: string) =>
    apiRequest<{ branchId: string; activeLeafId: string | null }>(`/api/v2/chats/${chatId}/branch`, {
      method: 'POST',
      body: JSON.stringify({ fromMessageId }),
    }),

  generate: (chatId: string, body: { providerId?: string; model?: string; sampling?: { maxOutputTokens: number } }) =>
    apiRequest<{ runId: string; generationId: string; messageId: string; snapshotId: string }>(
      `/api/v2/chats/${chatId}/generate`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  cancel: (runId: string) => apiRequest<{ cancelled: boolean }>(`/api/v2/runs/${runId}/cancel`, { method: 'POST' }),

  listProviders: () => apiRequest<ProviderDto[]>('/api/v2/providers'),

  createProvider: (body: {
    name: string
    type: string
    baseUrl?: string
    apiKey?: string
    models?: string[]
    fakeTurns?: { text: string }[]
  }) => apiRequest<ProviderDto>('/api/v2/providers', { method: 'POST', body: JSON.stringify(body) }),

  saveSecret: (providerId: string, secret: string) =>
    apiRequest<{ stored: boolean }>(`/api/v2/providers/${providerId}/secret`, {
      method: 'POST',
      body: JSON.stringify({ secret }),
    }),

  compile: (chatId: string, body: { providerId?: string; model?: string }) =>
    apiRequest('/api/v2/chats/' + chatId + '/prompt/compile', { method: 'POST', body: JSON.stringify(body) }),

  getSnapshot: (snapshotId: string) =>
    apiRequest<PromptSnapshotDto>('/api/v2/prompt-snapshots/' + snapshotId),

  /** §36 修订:会话快照列表(createdAt 降序;Inspector 相邻两轮 diff 的枚举面) */
  listChatSnapshots: (chatId: string) =>
    apiRequest<ChatSnapshotSummaryDto[]>(`/api/v2/chats/${chatId}/prompt-snapshots`),

  /** §38 Prompt Diff:相邻两轮对比(a = 上一轮,b = 当前轮) */
  getDiff: (snapshotAId: string, snapshotBId: string) =>
    apiRequest<PromptDiffDto>(`/api/v2/prompt-snapshots/${snapshotAId}/diff/${snapshotBId}`),

  /** §41 Cache Telemetry(S20):命中率曲线 + cached/prompt 口径 + 前缀过小 + Simulator */
  getTelemetry: (chatId: string) =>
    apiRequest<ChatTelemetryDto>(`/api/v2/chats/${chatId}/cache/telemetry`),

  /** §43/§44 Cache Simulation(S20):零 API 成本——只消费已编译快照,不调 Provider */
  simulateCache: (body: { chatId: string; rounds?: number; scenarios?: string[] }) =>
    apiRequest<CacheSimulationResultDto>('/api/v2/cache/simulate', { method: 'POST', body: JSON.stringify(body) }),

  /** §42 Cache Break Diagnosis(S20):二分层定位 CacheBreak 源 + 影响 token + 建议 */
  getCacheBreak: (runId: string) => apiRequest<CacheBreakDiagnosisDto>(`/api/v2/runs/${runId}/cache-break`),

  /** §60 debug 导出(还账 #15):默认 sanitized;full 需显式声明 */
  exportDebugBundle: (body: { resourceType: 'snapshot'; resourceId: string; policy?: DebugExportPolicyDto }) =>
    apiRequest<DebugExportBundleDto>('/api/v2/debug/export', { method: 'POST', body: JSON.stringify(body) }),

  activateLeaf: (chatId: string, messageId: string) =>
    apiRequest<{ branchId: string; activeLeafId: string }>(`/api/v2/chats/${chatId}/active-leaf`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),

  /** §20 swipe:建壳 + 触发生成填充变体(S13);返回 runId/messageId,流走 SSE */
  swipe: (messageId: string, body: { providerId?: string; model?: string } = {}) =>
    apiRequest<{ runId: string; messageId: string }>(`/api/v2/messages/${messageId}/swipe`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ===== S31 Memory HTTP 面(api-spec §88–§92)=====

  /** §88 Search Memory:跨四层(dossier/document/summary/timeline)子串检索 */
  searchMemory: (chatId: string, body: { query: string; limit?: number; kinds?: ('summary' | 'dossier' | 'timeline' | 'document')[] }) =>
    apiRequest<SearchMemoryResultDto>(`/api/v2/chats/${chatId}/memory/search`, { method: 'POST', body: JSON.stringify(body) }),

  /** §90 Summary 链(冻结块按 seq 升序) */
  getSummaries: (chatId: string) => apiRequest<SummaryBlockDto[]>(`/api/v2/chats/${chatId}/summaries`),

  /** §90 显式 Checkpoint:追加一个冻结摘要块 */
  createSummary: (chatId: string, body: CreateSummaryRequest) =>
    apiRequest<SummaryBlockDto>(`/api/v2/chats/${chatId}/summaries`, { method: 'POST', body: JSON.stringify(body) }),

  /** §91 Dossier 实体卡列表 */
  getDossier: (chatId: string) => apiRequest<DossierEntityDto[]>(`/api/v2/chats/${chatId}/dossier`),

  /** §91 建/更新实体卡(同 entity = 版本化更新) */
  createDossierEntity: (chatId: string, body: CreateDossierEntityRequest) =>
    apiRequest<DossierEntityDto>(`/api/v2/chats/${chatId}/dossier/entities`, { method: 'POST', body: JSON.stringify(body) }),

  /** §91 更新既有实体卡(保持 entity 名,内容/重要度/置信度版本化) */
  patchDossierEntity: (id: string, body: Partial<Pick<DossierEntityDto, 'content' | 'importance' | 'confidence' | 'sourceMessageIds'>>) =>
    apiRequest<DossierEntityDto>(`/api/v2/dossier/entities/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  /** §92 Timeline 事件流(只追加;GET 按 createdAt 降序最新在前) */
  getTimeline: (chatId: string) => apiRequest<TimelineEventDto[]>(`/api/v2/chats/${chatId}/timeline`),

  /** §92 追加 Timeline 事件 */
  createTimelineEvent: (chatId: string, body: CreateTimelineEventRequest) =>
    apiRequest<TimelineEventDto>(`/api/v2/chats/${chatId}/timeline`, { method: 'POST', body: JSON.stringify(body) }),

  /** wp4.2b Scribe 触发(§143 长任务:202 + runId,写入经 tool_calls/artifacts 落账) */
  triggerScribe: (chatId: string, body: ScribeTriggerRequest = {}) =>
    apiRequest<ScribeTriggerStartDto>(`/api/v2/chats/${chatId}/memory/scribe`, { method: 'POST', body: JSON.stringify(body) }),
}

/** 列表面(裁剪自 MessageDto;完整形状见 api-types) */
export type MessageDtoLite = Pick<
  MessageWithVariantsDto,
  'id' | 'chatId' | 'role' | 'content' | 'variantGroupId' | 'variantIndex' | 'variants'
>
