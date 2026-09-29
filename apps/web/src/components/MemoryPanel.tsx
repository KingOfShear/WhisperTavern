import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { api } from '../api/client'
import type { DossierEntityDto, MemoryDto, SummaryBlockDto, TimelineEventDto } from '@whispertavern/api-types'

/**
 * 记忆管理面板(S31/WP4.2b;ui-design §4.7 memory 区)——四块:
 * ① Summary 链浏览(冻结块,每块覆盖的消息区间 §90);
 * ② Dossier 实体卡(Scribe 维护的事实卡,§91);
 * ③ Timeline 事件流(只追加,§92);
 * ④ 检索测试(§88 跨四层子串检索) + Scribe 触发按钮(§143 长任务)。
 * 全部走 Memory HTTP 面(api-spec §88–§92),无任何本地状态旁路。
 */

type Tab = 'summaries' | 'dossier' | 'timeline' | 'search'

export function MemoryPanel({ chatId, onClose }: { chatId: string; onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<Tab>('summaries')
  const [summaries, setSummaries] = useState<SummaryBlockDto[]>([])
  const [dossier, setDossier] = useState<DossierEntityDto[]>([])
  const [timeline, setTimeline] = useState<TimelineEventDto[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryDto[]>([])
  const [error, setError] = useState<string | null>(null)

  const refreshAll = useCallback(async () => {
    try {
      const [s, d, t] = await Promise.all([api.getSummaries(chatId), api.getDossier(chatId), api.getTimeline(chatId)])
      setSummaries(s)
      setDossier(d)
      setTimeline(t)
      setError(null)
    } catch (e) {
      setError(String((e as Error).message))
    }
  }, [chatId])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  async function runSearch(): Promise<void> {
    const q = query.trim()
    if (q === '') return
    try {
      const res = await api.searchMemory(chatId, { query: q, limit: 20 })
      setHits(res.items)
      setError(null)
    } catch (e) {
      setError(String((e as Error).message))
    }
  }

  async function triggerScribe(): Promise<void> {
    try {
      await api.triggerScribe(chatId)
      setError(null)
    } catch (e) {
      setError(String((e as Error).message))
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'summaries', label: '摘要链' },
    { id: 'dossier', label: 'Dossier' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'search', label: '检索测试' },
  ]

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-[480px] flex-col border-l border-[var(--border)] bg-[var(--background)] shadow-2xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <span className="text-sm font-semibold">记忆管理(S31)</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded bg-[var(--primary)] px-3 py-1 text-xs text-white hover:opacity-90"
            onClick={() => void triggerScribe()}
            title="触发 Scribe Agent 读新剧情 → 更新 Dossier/Timeline/Summary(memory-runtime-spec §4)"
          >
            ▶ Scribe
          </button>
          <button type="button" className="rounded px-3 py-1 text-xs hover:bg-[var(--muted)]" onClick={() => void refreshAll()}>
            刷新
          </button>
          <button type="button" className="rounded px-2 py-1 text-xs hover:bg-[var(--muted)]" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      <div className="flex border-b border-[var(--border)] px-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`px-3 py-2 text-xs ${tab === t.id ? 'border-b-2 border-[var(--primary)] font-semibold' : 'text-[var(--muted-foreground)]'}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error !== null && (
        <div className="border-b border-red-900/40 bg-red-900/40 px-4 py-2 text-xs">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'summaries' && <SummaryChain summaries={summaries} />}
        {tab === 'dossier' && <DossierCards dossier={dossier} />}
        {tab === 'timeline' && <TimelineList events={timeline} />}
        {tab === 'search' && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                className="flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm outline-none focus:border-[var(--primary)]"
                placeholder="跨四层检索(如:狐神 / 谎言)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void runSearch() }}
              />
              <button
                type="button"
                className="rounded bg-[var(--primary)] px-3 py-1.5 text-xs text-white hover:opacity-90"
                onClick={() => void runSearch()}
              >
                检索
              </button>
            </div>
            {hits.length === 0 ? (
              <div className="text-xs text-[var(--muted-foreground)]">无结果——Scribe 写入或手动导入后可见</div>
            ) : (
              <ul className="space-y-2">
                {hits.map((h) => (
                  <li key={h.id} className="rounded border border-[var(--border)] p-2 text-xs">
                    <div className="mb-0.5 flex items-center justify-between">
                      <span className="font-semibold">[{h.kind}]</span>
                      <span className="text-[10px] text-[var(--muted-foreground)]">score {h.score?.toFixed(3)}</span>
                    </div>
                    <div className="text-[var(--foreground)]">{h.content}</div>
                    {h.entity !== undefined && <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">实体: {h.entity}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** ① 摘要链:冻结块逐块浏览(sequence 升序;每块自含 covers 区间) */
function SummaryChain({ summaries }: { summaries: SummaryBlockDto[] }): ReactElement {
  if (summaries.length === 0) return <EmptyHint text="尚无冻结摘要块——点击 ▶ Scribe 或 POST /summaries 追加" />
  return (
    <ul className="space-y-2">
      {summaries.map((s) => (
        <li key={s.id} className="rounded border border-[var(--border)] p-2">
          <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
            <span className="font-semibold text-[var(--foreground)]">#{s.seq}</span>
            <span>covers {s.coversMessageRange.from.slice(0, 8)}… → {s.coversMessageRange.to.slice(0, 8)}…</span>
          </div>
          <div className="text-xs">{s.content}</div>
          <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">冻结于 {new Date(s.frozenAt).toLocaleString()}</div>
        </li>
      ))}
    </ul>
  )
}

/** ② Dossier 实体卡:事实卡列表(importance/confidence/version 徽标) */
function DossierCards({ dossier }: { dossier: DossierEntityDto[] }): ReactElement {
  if (dossier.length === 0) return <EmptyHint text="尚无实体卡——Scribe 发现重要事实后写入" />
  return (
    <ul className="space-y-2">
      {dossier.map((d) => (
        <li key={d.id} className="rounded border border-[var(--border)] p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold">{d.entity}</span>
            <span className="text-[10px] text-[var(--muted-foreground)]">
              v{d.version} · imp {d.importance?.toFixed(2) ?? '—'} · conf {d.confidence?.toFixed(2) ?? '—'}
            </span>
          </div>
          <div className="text-xs">{d.content}</div>
          <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">更新于 {new Date(d.updatedAt).toLocaleString()}</div>
        </li>
      ))}
    </ul>
  )
}

/** ③ Timeline 事件流(只追加;最新在前) */
function TimelineList({ events }: { events: TimelineEventDto[] }): ReactElement {
  if (events.length === 0) return <EmptyHint text="尚无 Timeline 事件——Scribe 追加剧情事件后可见" />
  return (
    <ul className="space-y-2">
      {events.map((e) => (
        <li key={e.id} className="rounded border border-[var(--border)] p-2">
          <div className="mb-1 flex items-center justify-between text-[10px]">
            <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 font-semibold">{e.eventType}</span>
            {e.importance !== undefined && <span className="text-[var(--muted-foreground)]">imp {e.importance.toFixed(2)}</span>}
          </div>
          <div className="text-xs">{e.summary}</div>
          <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">{new Date(e.createdAt).toLocaleString()}</div>
        </li>
      ))}
    </ul>
  )
}

function EmptyHint({ text }: { text: string }): ReactElement {
  return <div className="py-8 text-center text-xs text-[var(--muted-foreground)]">{text}</div>
}