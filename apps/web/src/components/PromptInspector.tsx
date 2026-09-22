import { useState, type ReactElement } from 'react'
import { useChatStore } from '../stores/chat'
import type { PromptDiffDto, PromptSnapshotDto, SegmentDiffDto } from '@whispertavern/api-types'

/**
 * Prompt Inspector v1(p1-plan §8 S14;ui-design §4.5 精简版)——
 * 段列表(来源/角色/区/stability)、八区哈希条、诊断、serialized 原文切换、
 * 相邻两轮 diff(内联红绿)、debug 导出(sanitized 默认)。
 * 无障碍第二通道(ui-design §5):区色永配区名文字,红绿永配 kind 文字标签。
 */

/** 八区展示序与配色(ui-design §5;语义权威 = compiler-spec §67 Zone) */
const ZONES: { key: 'header' | 'stableWB' | 'freshWB' | 'summary' | 'history' | 'injection' | 'tail'; label: string; color: string }[] = [
  { key: 'header', label: 'header', color: '#22c55e' },
  { key: 'stableWB', label: 'stableWB', color: '#3b82f6' },
  { key: 'freshWB', label: 'freshWB', color: '#f97316' },
  { key: 'summary', label: 'summary', color: '#a855f7' },
  { key: 'history', label: 'history', color: '#a1a1aa' },
  { key: 'injection', label: 'injection', color: '#eab308' },
  { key: 'tail', label: 'tail', color: '#ef4444' },
]

const SOURCE_LABELS: Record<string, string> = {
  character: '角色卡', persona: 'Persona', preset: '预设', worldbook: '世界书',
  summary: '摘要', message: '消息', memory: '记忆', agent: 'Agent',
  workflow: '工作流', artifact: '产物', toolResult: '工具结果', plugin: '插件', runtime: '运行时',
}

/** §35 修订三值投影:stable←static/session,appended←message,volatile←request/volatile */
function stabilityBadge(stability: string): { label: string; color: string } {
  if (stability === 'static' || stability === 'session') return { label: '稳定', color: '#22c55e' }
  if (stability === 'message') return { label: '追加', color: '#3b82f6' }
  return { label: '易变', color: '#f59e0b' }
}

const DIFF_KIND_LABELS: Record<SegmentDiffDto['kind'], { label: string; bg: string }> = {
  same: { label: '相同', bg: 'bg-[var(--muted)]/40 opacity-60' },
  changed: { label: '变更', bg: 'bg-yellow-900/30' },
  added: { label: '新增', bg: 'bg-green-900/30' },
  removed: { label: '移除', bg: 'bg-red-900/30' },
}

function HashStrip({ snapshot }: { snapshot: PromptSnapshotDto }): ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {ZONES.map((zone) => {
        const value = snapshot.hashes[zone.key]
        if (value === undefined) return null
        return (
          <span
            key={zone.key}
            title={`${zone.label}: ${value}`}
            className="flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px]"
          >
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: zone.color }} />
            {zone.label}
            <span className="text-[var(--muted-foreground)]">{value.slice(0, 6)}</span>
          </span>
        )
      })}
      <span className="rounded bg-[var(--primary)]/20 px-1.5 py-0.5 text-[10px]">
        final <span className="text-[var(--muted-foreground)]">{snapshot.hashes.final.slice(0, 6)}</span>
      </span>
    </div>
  )
}

function DiffSection({ diff }: { diff: PromptDiffDto }): ReactElement {
  const sameCount = diff.segments.filter((s) => s.kind === 'same').length
  return (
    <section className="space-y-1">
      <h4 className="text-[11px] font-semibold">与上一轮 diff(§38)</h4>
      <div className="flex flex-wrap gap-2 text-[10px] text-[var(--muted-foreground)]">
        <span>输入 {diff.tokenDelta.input >= 0 ? `+${diff.tokenDelta.input}` : diff.tokenDelta.input}</span>
        <span>可缓存 {diff.tokenDelta.cached}</span>
        <span>新鲜 {diff.tokenDelta.fresh}</span>
        {diff.cacheBreak !== undefined && (
          <span className="rounded bg-yellow-900/40 px-1">缓存疑似失效:{diff.cacheBreak.type}</span>
        )}
      </div>
      {diff.firstDivergence !== undefined && (
        <div className="text-[10px] text-yellow-500">首分歧段:{diff.firstDivergence.segmentId}</div>
      )}
      <div className="space-y-0.5">
        {diff.segments
          .filter((s) => s.kind !== 'same')
          .map((s) => {
            const badge = DIFF_KIND_LABELS[s.kind]
            return (
              <div key={`${s.kind}:${s.segmentId}`} className={`rounded px-2 py-1 text-[10px] ${badge.bg}`}>
                <span className="mr-2 font-medium">{badge.label}</span>
                <span className="break-all">{s.segmentId}</span>
                {s.after !== undefined && <span className="ml-1 text-[var(--muted-foreground)]">· {s.after.tokenCount} tok</span>}
              </div>
            )
          })}
        <div className="text-[10px] text-[var(--muted-foreground)]">未变化段 × {sameCount}(折叠)</div>
      </div>
    </section>
  )
}

export function PromptInspector(): ReactElement {
  const snapshot = useChatStore((s) => s.snapshot)
  const snapshotOpen = useChatStore((s) => s.snapshotOpen)
  const diff = useChatStore((s) => s.diff)
  const toggleSnapshot = useChatStore((s) => s.toggleSnapshot)
  const exportBundle = useChatStore((s) => s.exportBundle)
  const [rawOpen, setRawOpen] = useState(false)

  if (!snapshotOpen) {
    return (
      <button
        type="button"
        onClick={() => void toggleSnapshot()}
        className="absolute bottom-20 right-4 rounded border border-[var(--border)] bg-[var(--muted)] px-3 py-1 text-xs hover:border-[var(--primary)]"
      >
        Prompt Inspector
      </button>
    )
  }

  return (
    <div className="absolute bottom-16 right-4 z-10 max-h-[70%] w-[34rem] overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)] p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold">Prompt Inspector(§107)</h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void exportBundle()} className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] hover:border-[var(--primary)]" title="导出 sanitized bundle(默认脱敏)">
            导出 sanitized
          </button>
          <button type="button" onClick={() => void exportBundle({ mode: 'full' })} className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] hover:border-[var(--primary)]" title="导出 full bundle(保留原文,密钥仍脱敏)">
            导出 full
          </button>
          <button type="button" onClick={() => void toggleSnapshot()} className="text-[var(--muted-foreground)]">✕</button>
        </div>
      </div>

      {snapshot === null ? (
        <p className="text-xs text-[var(--muted-foreground)]">尚无快照——先完成一轮生成</p>
      ) : (
        <div className="space-y-3 text-xs">
          <div className="flex items-center justify-between text-[var(--muted-foreground)]">
            <span>{snapshot.provider}/{snapshot.model} · compiler {snapshot.compilerVersion}</span>
            <span>{snapshot.serialized.tokenCount} tok</span>
          </div>

          <HashStrip snapshot={snapshot} />

          {diff !== null && <DiffSection diff={diff} />}

          <section className="space-y-0.5">
            <h4 className="text-[11px] font-semibold">段列表(发送序,{snapshot.ir.segments.length} 段)</h4>
            {snapshot.ir.segments.map((segment, index) => {
              const badge = stabilityBadge(segment.stability)
              const zone = ZONES.find((z) => z.key === segment.cachePlacement.zone)
              return (
                <details key={segment.id} className="rounded bg-[var(--muted)]/50 px-2 py-1">
                  <summary className="flex cursor-pointer items-center gap-2 text-[10px]">
                    <span className="text-[var(--muted-foreground)]">{index + 1}.</span>
                    <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: zone?.color ?? '#a1a1aa' }} />
                    <span className="text-[var(--muted-foreground)]">{zone?.label ?? segment.cachePlacement.zone}</span>
                    <span className="rounded bg-[var(--background)] px-1">{segment.role}</span>
                    <span className="text-[var(--muted-foreground)]">{SOURCE_LABELS[segment.source.type] ?? segment.source.type}</span>
                    <span className="rounded px-1" style={{ backgroundColor: `${badge.color}33`, color: badge.color }}>{badge.label}</span>
                    <span className="ml-auto text-[var(--muted-foreground)]">{segment.tokenCount} tok</span>
                  </summary>
                  <div className="mt-1 whitespace-pre-wrap break-all border-l-2 border-[var(--border)] pl-2 text-[10px] text-[var(--muted-foreground)]">
                    {segment.content}
                  </div>
                </details>
              )
            })}
          </section>

          <details className="text-[11px]">
            <summary className="cursor-pointer font-semibold">诊断({snapshot.diagnostics.length})</summary>
            <div className="mt-1 space-y-0.5">
              {snapshot.diagnostics.length === 0 && <div className="text-[10px] text-[var(--muted-foreground)]">无诊断</div>}
              {snapshot.diagnostics.map((d, index) => (
                <div key={index} className="rounded bg-[var(--muted)]/50 px-2 py-1 text-[10px]">
                  <span className={d.level === 'error' ? 'text-red-400' : d.level === 'warning' ? 'text-yellow-500' : 'text-[var(--muted-foreground)]'}>
                    [{d.level}]
                  </span>{' '}
                  <span className="font-mono">{d.code}</span> · {d.message}
                </div>
              ))}
            </div>
          </details>

          <details open={rawOpen} onToggle={(e) => setRawOpen((e.target as HTMLDetailsElement).open)} className="text-[11px]">
            <summary className="cursor-pointer font-semibold">serialized 原文(模型可见)</summary>
            <div className="mt-1 space-y-1">
              {snapshot.serialized.parts.map((part, index) => (
                <div key={index} className="rounded bg-[var(--muted)] px-2 py-1.5 text-[10px]">
                  <span className="mr-2 text-[var(--primary)]">{part.role ?? '?'}</span>
                  <span className="whitespace-pre-wrap break-all">{part.content ?? ''}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
