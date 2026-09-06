import type { ApiErrorBody, ApiEnvelope, MessageDto, PromptSnapshotDto, ProviderDto } from '@whispertavern/api-types'

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

  listMessages: (chatId: string) =>
    apiRequest<MessageDtoLite[]>(`/api/v2/chats/${chatId}/messages`),

  createMessage: (chatId: string, body: { parentId?: string; role: 'user' | 'system' | 'narrator'; content: string }) =>
    apiRequest<{ message: MessageDtoLite; activeLeaf: string }>(`/api/v2/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
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

  swipe: (messageId: string) =>
    apiRequest<{ message: MessageDtoLite }>(`/api/v2/messages/${messageId}/swipe`, { method: 'POST' }),
}

/** 列表面(裁剪自 MessageDto;完整形状见 api-types) */
export type MessageDtoLite = Pick<MessageDto, 'id' | 'chatId' | 'role' | 'content' | 'variantGroupId' | 'variantIndex'>
