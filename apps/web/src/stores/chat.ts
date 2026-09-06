import { ApiClientError, api } from '../api/client'
import { openRunStream, validateSequence } from '../api/sse'
import { create } from 'zustand'
import type { ChatSummaryDto, PromptSnapshotDto, ProviderDto } from '@whispertavern/api-types'
import type { MessageDtoLite } from '../api/client'

/**
 * 聊天工作台状态(zustand)。流式生命周期:
 * POST message(用户输入入树)→ POST generate(立即返回 ids)→ openRunStream(SSE)
 * → generation.delta 增量渲染 → 终态后重拉消息树(回复已由服务端入树)。
 */

export interface ChatStore {
  chats: ChatSummaryDto[]
  currentChatId: string | null
  messages: MessageDtoLite[]
  /** 活跃变体兄弟组(§22 swipe 切换面):groupId → 兄弟消息 */
  streaming: { runId: string; text: string } | null
  error: string | null
  providers: ProviderDto[]
  snapshot: PromptSnapshotDto | null
  snapshotOpen: boolean
  settingsOpen: boolean

  loadChats(): Promise<void>
  createChat(): Promise<void>
  openChat(id: string): Promise<void>
  sendMessage(content: string): Promise<void>
  stop(): Promise<void>
  loadProviders(): Promise<void>
  createProvider(body: Parameters<typeof api.createProvider>[0]): Promise<void>
  toggleSnapshot(): void
  switchVariant(messageId: string): Promise<void>
  clearError(): void
  setSettingsOpen(open: boolean): void
}

export const useChatStore = create<ChatStore>((set, get) => ({
  chats: [],
  currentChatId: null,
  messages: [],
  streaming: null,
  error: null,
  providers: [],
  snapshot: null,
  snapshotOpen: false,
  settingsOpen: false,

  loadChats: async () => {
    try {
      set({ chats: (await api.listChats()) as ChatSummaryDto[] })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  createChat: async () => {
    try {
      const chat = await api.createChat({ title: `会话 ${new Date().toLocaleTimeString()}` })
      await get().loadChats()
      await get().openChat(chat.id)
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  openChat: async (id) => {
    set({ currentChatId: id, messages: [], streaming: null, snapshot: null, snapshotOpen: false })
    try {
      set({ messages: await api.listMessages(id) })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  sendMessage: async (content) => {
    const chatId = get().currentChatId
    if (chatId === null || get().streaming !== null) return
    try {
      await api.createMessage(chatId, { role: 'user', content })
      const provider = get().providers[0]
      const started = await api.generate(chatId, {
        providerId: provider?.id,
        model: provider?.config.models[0],
        sampling: { maxOutputTokens: 1024 },
      })
      set({ streaming: { runId: started.runId, text: '' }, error: null })
      openRunStream(started.runId, {
        onEvent: (envelope) => {
          if (envelope.type === 'generation.delta') {
            const data = envelope.data as { text?: string }
            const current = get().streaming
            if (current !== null) set({ streaming: { ...current, text: current.text + (data.text ?? '') } })
          }
        },
        onDone: () => {
          void refreshAfterGeneration(chatId, started.snapshotId)
        },
        onError: (err) => {
          set({ error: `SSE 断流:${String(err)}`, streaming: null })
        },
      })
      // 用户消息即时入列(重拉对齐服务端事实)
      set({ messages: await api.listMessages(chatId) })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  stop: async () => {
    const runId = get().streaming?.runId
    if (runId === undefined) return
    try {
      await api.cancel(runId) // PV6:partial 已由服务端记录;终态事件关流
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  loadProviders: async () => {
    try {
      set({ providers: (await api.listProviders()) as ProviderDto[] })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  createProvider: async (body) => {
    await api.createProvider(body)
    await get().loadProviders()
  },



  switchVariant: async (messageId) => {
    const chatId = get().currentChatId
    if (chatId === null) return
    try {
      await api.activateLeaf(chatId, messageId)
      set({ messages: await api.listMessages(chatId) })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  toggleSnapshot: () => set((state) => ({ snapshotOpen: !state.snapshotOpen })),
  clearError: () => set({ error: null }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}))

async function refreshAfterGeneration(chatId: string, snapshotId: string): Promise<void> {
  try {
    const [messages, snapshot] = await Promise.all([
      api.listMessages(chatId),
      api.getSnapshot(snapshotId).catch(() => null),
    ])
    useChatStore.setState({ streaming: null, messages, snapshot })
  } catch (error) {
    useChatStore.setState({ streaming: null, error: describe(error) })
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiClientError) return `${error.code}: ${error.message}`
  return String(error)
}

// —— SSE 与变体工具(导出供组件/测试复用)——
export { openRunStream, validateSequence, ApiClientError, api }
