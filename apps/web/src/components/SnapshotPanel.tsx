import type { ReactElement } from 'react'
import { useChatStore } from '../stores/chat'

/** 快照最简查看(p0-plan S7 任务 6):最近一轮模型可见原文(serialized.parts) */
export function SnapshotPanel(): ReactElement {
  const snapshot = useChatStore((s) => s.snapshot)
  const snapshotOpen = useChatStore((s) => s.snapshotOpen)
  const toggleSnapshot = useChatStore((s) => s.toggleSnapshot)

  if (!snapshotOpen) {
    return (
      <button
        type="button"
        onClick={() => void toggleSnapshot()}
        className="absolute bottom-20 right-4 rounded border border-[var(--border)] bg-[var(--muted)] px-3 py-1 text-xs hover:border-[var(--primary)]"
      >
        查看快照
      </button>
    )
  }

  return (
    <div className="absolute bottom-16 right-4 z-10 max-h-[60%] w-[32rem] overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)] p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold">最近一轮 Prompt 快照(模型可见原文)</h3>
        <button type="button" onClick={() => void toggleSnapshot()} className="text-[var(--muted-foreground)]">
          ✕
        </button>
      </div>
      {snapshot === null ? (
        <p className="text-xs text-[var(--muted-foreground)]">尚无快照——先完成一轮生成</p>
      ) : (
        <div className="space-y-2 text-xs">
          <div className="text-[var(--muted-foreground)]">
            {snapshot.provider}/{snapshot.model} · compiler {snapshot.compilerVersion}
          </div>
          {snapshot.serialized.parts.map((part, index) => (
            <div key={index} className="rounded bg-[var(--muted)] px-2 py-1.5">
              <span className="mr-2 text-[var(--primary)]">{part.role ?? '?'}</span>
              <span className="whitespace-pre-wrap">{part.content ?? ''}</span>
            </div>
          ))}
          <div className="text-[var(--muted-foreground)]">
            final hash: {snapshot.hashes.final.slice(0, 16)}… · diagnostics: {snapshot.diagnostics.length}
          </div>
        </div>
      )}
    </div>
  )
}
