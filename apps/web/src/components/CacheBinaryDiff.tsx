import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { api } from '../api/client'
import { useChatStore } from '../stores/chat'
import type { PromptDiffDto, PromptSnapshotDto, SegmentDiffDto } from '@whispertavern/api-types'

/**
 * 缓存二分工具(ui-design §4.5 两级形态;S20/WP2.5 交付面 2 + 4)——
 * 全屏覆盖层,分屏展开(形态依据:二分是**对齐诊断**而非改动审阅,沿中缝扫视定位错位最快)。
 *
 * - 第一层 **段级哈希对齐条带**:两轮 prompt 按段哈希左右两列对齐,绿 = 一致 / 红 = 分歧,
 *   第一处红块即首个分歧段(数据 = S14 `diffSnapshots` 的 segments,复用不重算);
 * - 第二层 **下钻分屏字节级 diff**:点红块 → 左第 k 轮 / 右第 k+1 轮逐段对齐 + 首个分歧
 *   **字节**偏移高亮 + 归因(被编辑的消息 / 世界书条目变化 / 新毕业条目 …)。
 * 无障碍第二通道(ui-design §5):颜色永配 kind 文字标签与字节偏移数字。
 */

const KIND_LABELS: Record<SegmentDiffDto['kind'], { label: string; bg: string; dot: string }> = {
  same: { label: '一致', bg: 'bg-[var(--muted)]/40', dot: '#22c55e' },
  changed: { label: '分歧', bg: 'bg-yellow-900/40', dot: '#ef4444' },
  added: { label: '新增', bg: 'bg-green-900/40', dot: '#3b82f6' },
  removed: { label: '移除', bg: 'bg-red-900/40', dot: '#ef4444' },
}

/** 归因文案(§58 精确归因属 Cache Planner;此处展示"疑似"+ 段来源族) */
function reasonText(segment: SegmentDiffDto): string {
  if (segment.kind === 'added') return '新增段(新毕业条目 / 新消息)'
  if (segment.kind === 'removed') return '移除段(预算裁剪 / 删除)'
  const source = segment.after?.source ?? segment.before?.source
  switch (source?.type) {
    case 'message':
      return '被编辑的消息'
    case 'worldbook':
      return '世界书条目内容变化'
    case 'preset':
      return '预设段变化'
    case 'persona':
      return 'Persona 变化'
    case 'character':
      return '角色卡变化'
    default:
      return '段内容变化'
  }
}

/** 按 UTF-8 字节偏移取字符前缀长度(展示用;绕过"字节偏移 ≠ 字符下标") */
function charPrefixForBytes(text: string, byteOffset: number): number {
  const encoder = new TextEncoder()
  let bytes = 0
  let chars = 0
  for (const ch of text) {
    const size = encoder.encode(ch).length
    if (bytes + size > byteOffset) break
    bytes += size
    chars += 1
  }
  return chars
}

/** 第二层:分屏字节级 diff(左 A 段 / 右 B 段,首个分歧字节起高亮) */
function SplitDiff({
  segment,
  byteOffset,
  before,
  after,
}: {
  segment: SegmentDiffDto
  byteOffset: number
  before: string | undefined
  after: string | undefined
}): ReactElement {
  const beforeText = before ?? ''
  const afterText = after ?? ''
  const beforeChars = before === undefined ? 0 : charPrefixForBytes(beforeText, byteOffset)
  const afterChars = after === undefined ? 0 : charPrefixForBytes(afterText, byteOffset)
  const pane = (text: string, prefixChars: number): ReactElement => (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--muted)]/40 p-2 text-[10px]">
      <span className="text-[var(--muted-foreground)]">{text.slice(0, prefixChars)}</span>
      <span className="bg-red-900/50">{text.slice(prefixChars)}</span>
    </pre>
  )
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[10px]">
        <span className="rounded bg-yellow-900/40 px-1.5 py-0.5">
          首个分歧字节 @ {byteOffset}
        </span>
        <span className="text-[var(--muted-foreground)]">
          {KIND_LABELS[segment.kind].label} · {reasonText(segment)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="mb-0.5 text-[10px] text-[var(--muted-foreground)]">
            左 · 上一轮{segment.before === undefined ? '(无此段)' : ` · ${segment.before.tokenCount} tok`}
          </div>
          {before === undefined ? <div className="text-[10px]">—</div> : pane(beforeText, beforeChars)}
        </div>
        <div>
          <div className="mb-0.5 text-[10px] text-[var(--muted-foreground)]">
            右 · 当前轮{segment.after === undefined ? '(无此段)' : ` · ${segment.after.tokenCount} tok`}
          </div>
          {after === undefined ? <div className="text-[10px]">—</div> : pane(afterText, afterChars)}
        </div>
      </div>
    </div>
  )
}

export function CacheBinaryDiff({ onClose }: { onClose: () => void }): ReactElement {
  const snapshotList = useChatStore((s) => s.snapshotList)
  const [diff, setDiff] = useState<PromptDiffDto | null>(null)
  const [snapshots, setSnapshots] = useState<{ a: PromptSnapshotDto; b: PromptSnapshotDto } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 降序列表:index 0 = 当前轮,1 = 上一轮
  const bId = snapshotList[0]?.id
  const aId = snapshotList[1]?.id

  useEffect(() => {
    if (aId === undefined || bId === undefined) return
    let cancelled = false
    void (async () => {
      const [d, a, b] = await Promise.all([
        api.getDiff(aId, bId).catch(() => null),
        api.getSnapshot(aId).catch(() => null),
        api.getSnapshot(bId).catch(() => null),
      ])
      if (cancelled) return
      setDiff(d)
      setSnapshots(a !== null && b !== null ? { a, b } : null)
      setSelected(d?.firstDivergence?.segmentId ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [aId, bId])

  const divergences = useMemo(() => (diff?.segments ?? []).filter((s) => s.kind !== 'same'), [diff])
  const selectedSegment = divergences.find((s) => s.segmentId === selected) ?? divergences[0]
  const byteOffset = diff?.firstDivergence?.segmentId === selectedSegment?.segmentId ? (diff?.firstDivergence?.byteOffset ?? 0) : 0
  // 段内容按 id 从两轮快照取(diff 投影只带哈希/元数据,不带正文——§38 载荷最简)
  const contentById = (snapshot: PromptSnapshotDto | undefined, id: string | undefined): string | undefined => {
    if (snapshot === undefined || id === undefined) return undefined
    return snapshot.ir.segments.find((s) => s.id === id)?.content
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--background)]/95 p-4 backdrop-blur">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">缓存二分定位(§4.5 两级形态)</h3>
          <p className="text-[10px] text-[var(--muted-foreground)]">
            第一层对齐条带定位首个分歧段 → 第二层分屏字节级 diff 定位分歧字节与归因
          </p>
        </div>
        <button type="button" className="rounded px-3 py-1 text-sm hover:bg-[var(--muted)]" onClick={onClose}>
          关闭
        </button>
      </header>

      {aId === undefined || bId === undefined ? (
        <div className="text-[11px] text-[var(--muted-foreground)]">至少需要两轮生成才能二分比较。</div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
          {/* ── 第一层:段级哈希对齐条带 ── */}
          <section className="min-h-0 space-y-1 overflow-y-auto pr-1">
            <h4 className="text-[11px] font-semibold">段级哈希对齐条带</h4>
            <div className="flex gap-2 text-[10px] text-[var(--muted-foreground)]">
              <span>左 {snapshots?.a.serialized.tokenCount ?? '—'} tok</span>
              <span>右 {snapshots?.b.serialized.tokenCount ?? '—'} tok</span>
              {diff?.cacheBreak !== undefined && (
                <span className="rounded bg-yellow-900/40 px-1">疑似:{diff.cacheBreak.type}</span>
              )}
            </div>
            {diff === null ? (
              <div className="text-[11px] text-[var(--muted-foreground)]">diff 加载中…</div>
            ) : (
              diff.segments.map((s) => {
                const meta = KIND_LABELS[s.kind]
                const isSelected = selectedSegment?.segmentId === s.segmentId
                return (
                  <button
                    key={`${s.kind}:${s.segmentId}`}
                    type="button"
                    disabled={s.kind === 'same'}
                    onClick={() => setSelected(s.segmentId)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[10px] ${meta.bg} ${
                      isSelected ? 'ring-1 ring-[var(--primary)]' : ''
                    }`}
                  >
                    <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: meta.dot }} />
                    <span className="shrink-0 font-medium">{meta.label}</span>
                    <span className="truncate">{s.segmentId}</span>
                    <span className="ml-auto shrink-0 text-[var(--muted-foreground)]">
                      {s.after?.tokenCount ?? s.before?.tokenCount ?? 0} tok
                    </span>
                  </button>
                )
              })
            )}
            <div className="text-[10px] text-[var(--muted-foreground)]">
              一致段 × {diff?.segments.filter((s) => s.kind === 'same').length ?? 0}(折叠)
            </div>
          </section>

          {/* ── 第二层:下钻分屏 ── */}
          <section className="min-h-0 space-y-2 overflow-y-auto pr-1">
            <h4 className="text-[11px] font-semibold">下钻:分屏字节级 diff</h4>
            {selectedSegment === undefined ? (
              <div className="text-[11px] text-[var(--muted-foreground)]">
                两轮段哈希完全一致 —— 无 CacheBreak 源(前缀逐字节稳定)。
              </div>
            ) : (
              <>
                <SplitDiff
                  segment={selectedSegment}
                  byteOffset={byteOffset}
                  before={contentById(snapshots?.a, selectedSegment.segmentId)}
                  after={contentById(snapshots?.b, selectedSegment.segmentId)}
                />
                <div className="text-[10px] text-[var(--muted-foreground)]">
                  段 ID <span className="break-all">{selectedSegment.segmentId}</span> · 区{' '}
                  {selectedSegment.after?.zone ?? selectedSegment.before?.zone ?? '—'} · 稳定性{' '}
                  {selectedSegment.after?.stability ?? selectedSegment.before?.stability ?? '—'}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}