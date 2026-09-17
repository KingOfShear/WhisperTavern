import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useChatStore } from '../stores/chat'
import type { MessageDtoLite } from '../api/client'

/**
 * 消息流:角色气泡 + 流式渲染 + S13(WP1.4)消息树交互面:
 * - 变体 ◀▶(§22 切换兄弟,n/m 计数,数据面 = §16 variants 兄弟链投影)
 * - 重摇(§20 swipe:建壳 + 生成填充,进度走流式气泡)/ 编辑(§19 新建变体)
 * - 删除(软删)/ 分支(§21 从此消息 fork)
 */
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

function MessageBubble({ message }: { message: MessageDtoLite }): ReactElement {
  const streaming = useChatStore((s) => s.streaming)
  const switchVariant = useChatStore((s) => s.switchVariant)
  const swipe = useChatStore((s) => s.swipe)
  const editMessage = useChatStore((s) => s.editMessage)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const branchFrom = useChatStore((s) => s.branchFrom)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const isUser = message.role === 'user'
  const isReply = message.role === 'character' || message.role === 'assistant'
  const variants = message.variants ?? []
  const index = message.variantIndex ?? 0
  const prev = index > 0 ? variants[index - 1] : undefined
  const next = index < variants.length - 1 ? variants[index + 1] : undefined
  const busy = streaming !== null

  const align = isUser
    ? 'ml-auto bg-[var(--user-bubble)]'
    : message.role === 'system'
      ? 'mx-auto bg-transparent text-[var(--muted-foreground)] text-xs'
      : 'mr-auto bg-[var(--muted)]'

  return (
    <div className={`group my-2 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-lg px-4 py-2 text-sm ${align}`}>
        {editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.max(2, Math.ceil(draft.length / 40))}
              className="w-72 resize-y rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 outline-none focus:border-[var(--primary)]"
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="text-xs text-[var(--muted-foreground)]" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                type="button"
                className="rounded bg-[var(--primary)] px-2 py-1 text-xs text-[var(--primary-foreground)] disabled:opacity-40"
                disabled={draft.trim() === ''}
                onClick={() => {
                  setEditing(false)
                  void editMessage(message.id, draft)
                }}
              >
                保存为新变体
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="whitespace-pre-wrap">
              {message.content === '' ? <span className="text-[var(--muted-foreground)]">(生成中…)</span> : message.content}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover:opacity-100">
              {variants.length > 1 && (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={prev === undefined || busy}
                    onClick={() => prev !== undefined && void switchVariant(prev.id)}
                    className="disabled:opacity-30"
                  >
                    ◀
                  </button>
                  <span>
                    {index + 1}/{variants.length}
                  </span>
                  <button
                    type="button"
                    disabled={next === undefined || busy}
                    onClick={() => next !== undefined && void switchVariant(next.id)}
                    className="disabled:opacity-30"
                  >
                    ▶
                  </button>
                </span>
              )}
              {isReply && (
                <button type="button" disabled={busy} onClick={() => void swipe(message.id)} className="disabled:opacity-30">
                  重摇
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraft(message.content)
                  setEditing(true)
                }}
              >
                编辑
              </button>
              <span className="relative">
                <button type="button" onClick={() => setMenuOpen(!menuOpen)}>
                  ⋯
                </button>
                {menuOpen && (
                  <span className="absolute bottom-full right-0 z-10 mb-1 flex flex-col rounded border border-[var(--border)] bg-[var(--background)] py-1 shadow">
                    <button
                      type="button"
                      className="px-3 py-1 text-left hover:bg-[var(--muted)]"
                      onClick={() => {
                        setMenuOpen(false)
                        void branchFrom(message.id)
                      }}
                    >
                      从此分支
                    </button>
                    <button
                      type="button"
                      className="px-3 py-1 text-left text-red-400 hover:bg-[var(--muted)]"
                      onClick={() => {
                        setMenuOpen(false)
                        void deleteMessage(message.id)
                      }}
                    >
                      删除
                    </button>
                  </span>
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
