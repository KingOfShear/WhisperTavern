import { useEffect, useRef, type ReactElement } from 'react'
import { useChatStore } from '../stores/chat'

/** 消息流:角色气泡 + 流式渲染 + 变体切换(§22;有兄弟变体时显示 ◀▶) */
export function MessageList(): ReactElement {
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming?.text])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {streaming !== null && (
        <div className="my-2 max-w-[75%] rounded-lg bg-[var(--user-bubble)] px-4 py-2 text-sm opacity-80">
          {streaming.text === '' ? '…' : streaming.text}
          <span className="ml-1 animate-pulse">▍</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function MessageBubble({ message }: { message: { id: string; role: string; content: string } }): ReactElement {
  const align =
    message.role === 'user'
      ? 'ml-auto bg-[var(--user-bubble)]'
      : message.role === 'system'
        ? 'mx-auto bg-transparent text-[var(--muted-foreground)] text-xs'
        : 'mr-auto bg-[var(--muted)]'
  return (
    <div className={`group my-2 flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap ${align}`}>
        {message.content === '' ? <span className="text-[var(--muted-foreground)]">(空)</span> : message.content}
      </div>
    </div>
  )
}
