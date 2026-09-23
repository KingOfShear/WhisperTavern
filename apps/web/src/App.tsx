import { useEffect, useState, type ReactElement } from 'react'
import { ChatSidebar } from './components/ChatSidebar'
import { MessageInput } from './components/MessageInput'
import { MessageList } from './components/MessageList'
import { PromptInspector } from './components/PromptInspector'
import { ProviderSettings } from './components/ProviderSettings'
import { CacheTelemetry } from './components/CacheTelemetry'
import { useChatStore } from './stores/chat'

/**
 * 聊天工作台精简版(ui-design §4.1):会话列表 / 消息流 / 输入框 / 流式渲染 /
 * 停止生成 / swipe 切换(变体激活)/ 设置页(provider/密钥)/ Prompt Inspector /
 * 缓存遥测面板(S20,ui-design §4.6)。
 */
export function App(): ReactElement {
  const loadChats = useChatStore((s) => s.loadChats)
  const loadProviders = useChatStore((s) => s.loadProviders)
  const error = useChatStore((s) => s.error)
  const clearError = useChatStore((s) => s.clearError)
  const settingsOpen = useChatStore((s) => s.settingsOpen)
  const setSettingsOpen = useChatStore((s) => s.setSettingsOpen)
  const [telemetryOpen, setTelemetryOpen] = useState(false)

  useEffect(() => {
    void loadChats()
    void loadProviders()
  }, [loadChats, loadProviders])

  return (
    <div className="flex h-screen bg-[var(--background)] text-[var(--foreground)]">
      <ChatSidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
          <span className="text-sm text-[var(--muted-foreground)]">WhisperTavern · P0 工作台</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded px-3 py-1 text-sm hover:bg-[var(--muted)]"
              onClick={() => setTelemetryOpen(!telemetryOpen)}
            >
              遥测
            </button>
            <button
              type="button"
              className="rounded px-3 py-1 text-sm hover:bg-[var(--muted)]"
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              设置
            </button>
          </div>
        </header>
        {error !== null && (
          <div className="flex items-center justify-between bg-red-900/40 px-4 py-2 text-sm">
            <span>{error}</span>
            <button type="button" onClick={clearError} className="ml-2 text-[var(--muted-foreground)]">
              ✕
            </button>
          </div>
        )}
        <MessageList />
        <MessageInput />
      </main>
      {settingsOpen && <ProviderSettings />}
      {telemetryOpen && <CacheTelemetry />}
      <PromptInspector />
    </div>
  )
}
