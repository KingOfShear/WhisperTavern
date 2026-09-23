import { ApiClientError, api } from '../api/client'
import { openRunStream, validateSequence } from '../api/sse'
import { create } from 'zustand'
import type {
  ChatSnapshotSummaryDto,
  ChatSummaryDto,
  ChatTelemetryDto,
  DebugExportPolicyDto,
  PromptDiffDto,
  PromptSnapshotDto,
  ProviderDto,
} from '@whispertavern/api-types'
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
  /** §36 快照列表(createdAt 降序)——Inspector 相邻 diff 的枚举面 */
  snapshotList: ChatSnapshotSummaryDto[]
  /** §38 相邻两轮 diff(prev → current;无上一轮时为 null) */
  diff: PromptDiffDto | null
  /** §33 遥测(S20):命中率曲线 + 成本 + CacheBreak + Simulator */
  telemetry: ChatTelemetryDto | null
  settingsOpen: boolean

  loadChats(): Promise<void>
  createChat(): Promise<void>
  openChat(id: string): Promise<void>
  sendMessage(content: string): Promise<void>
  stop(): Promise<void>
  loadProviders(): Promise<void>
  createProvider(body: Parameters<typeof api.createProvider>[0]): Promise<void>
  toggleSnapshot(): void
  /** §33 遥测(S20):拉取命中率曲线/成本/CacheBreak */
  loadTelemetry(): Promise<void>
  /** §60 debug 导出下载(默认 sanitized;full 需显式传 mode) */
  exportBundle(policy?: DebugExportPolicyDto): Promise<void>
  switchVariant(messageId: string): Promise<void>
  /** §20 swipe:建壳 + 触发生成填充变体(S13);流式进度走 streaming 气泡 */
  swipe(messageId: string): Promise<void>
  /** §19 编辑:新建变体,原消息内容永不动 */
  editMessage(messageId: string, content: string): Promise<void>
  /** 软删消息(活跃指针回退最近未删祖先) */
  deleteMessage(messageId: string): Promise<void>
  /** §21 从某消息 fork 新分支(不复制聊天) */
  branchFrom(messageId: string): Promise<void>
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
  snapshotList: [],
  diff: null,
  telemetry: null,
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
    set({ currentChatId: id, messages: [], streaming: null, snapshot: null, snapshotOpen: false, snapshotList: [], diff: null, telemetry: null })
    try {
      set({ messages: await api.listMessages(id) })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  loadTelemetry: async () => {
    const chatId = get().currentChatId
    if (chatId === null) return
    try {
      set({ telemetry: await api.getTelemetry(chatId) })
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

  swipe: async (messageId) => {
    const chatId = get().currentChatId
    if (chatId === null || get().streaming !== null) return
    try {
      const provider = get().providers[0]
      const started = await api.swipe(messageId, { providerId: provider?.id, model: provider?.config.models[0] })
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
          void refreshAfterGeneration(chatId)
        },
        onError: (err) => {
          set({ error: `SSE 断流:${String(err)}`, streaming: null })
        },
      })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  editMessage: async (messageId, content) => {
    const chatId = get().currentChatId
    if (chatId === null) return
    try {
      await api.editMessage(messageId, content)
      set({ messages: await api.listMessages(chatId) })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  deleteMessage: async (messageId) => {
    const chatId = get().currentChatId
    if (chatId === null) return
    try {
      await api.deleteMessage(messageId)
      set({ messages: await api.listMessages(chatId) })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  branchFrom: async (messageId) => {
    const chatId = get().currentChatId
    if (chatId === null) return
    try {
      await api.createBranch(chatId, messageId)
      set({ messages: await api.listMessages(chatId) })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  toggleSnapshot: () => set((state) => ({ snapshotOpen: !state.snapshotOpen })),

  exportBundle: async (policy) => {
    const snapshot = get().snapshot
    if (snapshot === null) return
    try {
      const bundle = await api.exportDebugBundle({ resourceType: 'snapshot', resourceId: snapshot.id, policy })
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `wt-debug-${bundle.policy.mode}-${snapshot.id.slice(0, 12)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  clearError: () => set({ error: null }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}))

async function refreshAfterGeneration(chatId: string, snapshotId?: string): Promise<void> {
  try {
    const [messages, snapshotList] = await Promise.all([
      api.listMessages(chatId),
      api.listChatSnapshots(chatId).catch(() => [] as ChatSnapshotSummaryDto[]),
    ])
    // 当前快照:显式传入优先(sendMessage);swipe 路径客户端不返回 snapshotId,
    // 退而取列表降序首条 = 当前轮(§36),避免 Inspector 面板快照陈旧却显示 diff
    const currentSnapshotId = snapshotId ?? snapshotList[0]?.id
    const snapshot = currentSnapshotId === undefined ? null : await api.getSnapshot(currentSnapshotId).catch(() => null)
    useChatStore.setState({ streaming: null, messages, snapshot, snapshotList })
    // 相邻两轮 diff(§38):list[1] = 上一轮,list[0] = 当前轮(降序)
    const diff =
      snapshotList.length >= 2
        ? await api.getDiff(snapshotList[1]!.id, snapshotList[0]!.id).catch(() => null)
        : null
    useChatStore.setState({ diff })
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
