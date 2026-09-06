import type { ReactElement } from 'react'
import { useChatStore } from '../stores/chat'

/** 会话列表(ui-design §4.1 左栏) */
export function ChatSidebar(): ReactElement {
  const chats = useChatStore((s) => s.chats)
  const currentChatId = useChatStore((s) => s.currentChatId)
  const openChat = useChatStore((s) => s.openChat)
  const createChat = useChatStore((s) => s.createChat)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border)]">
      <button
        type="button"
        onClick={() => void createChat()}
        className="m-2 rounded bg-[var(--primary)] px-3 py-2 text-sm text-[var(--primary-foreground)] hover:opacity-90"
      >
        + 新建会话
      </button>
      <nav className="flex-1 overflow-y-auto">
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            onClick={() => void openChat(chat.id)}
            className={`block w-full truncate px-4 py-2 text-left text-sm hover:bg-[var(--muted)] ${
              chat.id === currentChatId ? 'bg-[var(--muted)]' : ''
            }`}
          >
            {chat.title ?? '未命名会话'}
          </button>
        ))}
      </nav>
    </aside>
  )
}
