import type {
  ApiErrorBody,
  ApiEnvelope,
  MessageWithVariantsDto,
  PromptSnapshotDto,
  ProviderDto,
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
}

/** 列表面(裁剪自 MessageDto;完整形状见 api-types) */
export type MessageDtoLite = Pick<
  MessageWithVariantsDto,
  'id' | 'chatId' | 'role' | 'content' | 'variantGroupId' | 'variantIndex' | 'variants'
>
