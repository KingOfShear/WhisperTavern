import { useState, type ReactElement } from 'react'
import { useChatStore } from '../stores/chat'

/** 输入框(§18)+ 停止生成(PV6 取消闸口的 UI 面) */
export function MessageInput(): ReactElement {
  const [draft, setDraft] = useState('')
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stop = useChatStore((s) => s.stop)
  const streaming = useChatStore((s) => s.streaming)
  const currentChatId = useChatStore((s) => s.currentChatId)

  const submit = (): void => {
    const content = draft.trim()
    if (content === '' || currentChatId === null) return
    setDraft('')
    void sendMessage(content)
  }

  return (
    <div className="flex items-end gap-2 border-t border-[var(--border)] p-3">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={currentChatId === null ? '先新建或选择会话' : '输入消息…(Enter 发送,Shift+Enter 换行)'}
        rows={2}
        disabled={currentChatId === null}
        className="flex-1 resize-none rounded border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm outline-none focus:border-[var(--primary)] disabled:opacity-50"
      />
      {streaming !== null ? (
        <button
          type="button"
          onClick={() => void stop()}
          className="rounded bg-red-800 px-4 py-2 text-sm hover:bg-red-700"
        >
          停止
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={currentChatId === null || draft.trim() === ''}
          className="rounded bg-[var(--primary)] px-4 py-2 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
        >
          发送
        </button>
      )}
    </div>
  )
}
