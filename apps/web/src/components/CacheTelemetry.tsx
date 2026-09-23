import { useEffect, useState, type ReactElement } from 'react'
import { useChatStore } from '../stores/chat'
import { CacheBinaryDiff } from './CacheBinaryDiff'
import type { ChatTelemetryDto } from '@whispertavern/api-types'

/**
 * 缓存遥测面板(S20/WP2.5;ui-design §4.6 / 总设计 §33)——
 * 命中率仪表(§33.2 四层口径)+ 逐轮曲线 + CacheBreak 事件(§33.3)+
 * Cache Simulator 摘要(§20)+ 前缀过小提示(§5)。
 * 无障碍第二通道(ui-design §5):红绿永配文字标签,不单靠颜色。
 */

function pct(ratio: number | undefined): string {
  if (ratio === undefined) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 命中率仪表:四层口径(§33.2)——理论稳定前缀 → 实际命中 → 新鲜 */
function HitRateGauge({ telemetry }: { telemetry: ChatTelemetryDto }): ReactElement {
  const aggregate = telemetry.aggregate
  const total = aggregate.eligibleTokens
  const cached = aggregate.cachedTokens
  const fresh = aggregate.freshTokens
  const hitRate = aggregate.theoreticalHitRate
  const cachedPct = total === 0 ? 0 : (cached / total) * 100
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold">本会话累计(§33.2)</span>
        <span className="text-[10px] text-[var(--muted-foreground)]">
          新鲜 {fmt(fresh)} tok · 命中 {fmt(cached)} tok (实际 {pct(aggregate.actualHitRate)})
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded bg-[var(--muted)]" role="img" aria-label={`命中率 ${pct(aggregate.actualHitRate)}`}>
        <div className="bg-[#22c55e]" style={{ width: `${cachedPct}%` }} />
        <div className="bg-[#f97316]" style={{ width: `${100 - cachedPct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-[var(--muted-foreground)]">
        <span>实际命中(绿) {pct(aggregate.actualHitRate)}</span>
        <span>理论缓存率(plan 计) {pct(hitRate)}</span>
      </div>
    </div>
  )
}

/** 逐轮命中率曲线(纯 CSS 柱状;无图表库依赖) */
function HitRateCurve({ telemetry }: { telemetry: ChatTelemetryDto }): ReactElement {
  const rounds = telemetry.rounds
  if (rounds.length === 0) return <div className="text-[10px] text-[var(--muted-foreground)]">尚无生成轮次</div>
  const max = Math.max(...rounds.map((r) => r.promptTokens), 1)
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold">命中率曲线(逐轮)</h4>
      <div className="flex h-16 items-end gap-0.5">
        {rounds.map((r) => {
          const hitPct = r.promptTokens === 0 ? 0 : (r.cachedTokens / r.promptTokens) * 100
          const height = (r.promptTokens / max) * 100
          return (
            <div key={r.round} className="flex flex-1 flex-col items-center gap-0.5" title={`轮${r.round}: prompt ${r.promptTokens} · 命中 ${r.cachedTokens} (${pct(r.cachedTokens / Math.max(r.promptTokens, 1))})`}>
              <div className="flex w-full flex-col justify-end rounded-sm" style={{ height: `${height}%` }}>
                <div className="w-full bg-[#22c55e]" style={{ height: `${hitPct}%` }} />
                <div className="w-full bg-[#f97316]" style={{ height: `${100 - hitPct}%` }} />
              </div>
              <span className="text-[8px] text-[var(--muted-foreground)]">{r.round}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** CacheBreak 事件列表(§33.3) */
function CacheBreakList({ telemetry }: { telemetry: ChatTelemetryDto }): ReactElement {
  const breaks = telemetry.cacheBreaks
  if (breaks.length === 0) return <div className="text-[10px] text-[var(--muted-foreground)]">无失效事件</div>
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold">失效事件(§33.3)</h4>
      {breaks.map((b) => (
        <div key={b.round} className="rounded bg-yellow-900/30 px-2 py-1 text-[10px]">
          <span className="font-semibold">轮{b.round}</span> {b.reasons.join(' / ')}
          <span className="text-[var(--muted-foreground)]"> · 稳定前缀 {fmt(b.stablePrefixTokens)} tok</span>
        </div>
      ))}
    </div>
  )
}

/** Cache Simulator 摘要(§20) */
function SimulatorSummary({ telemetry }: { telemetry: ChatTelemetryDto }): ReactElement {
  const s = telemetry.simulator
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold">Cache Simulator(§20)</h4>
      <div className="grid grid-cols-2 gap-1 text-[10px]">
        <span className="text-[var(--muted-foreground)]">理论缓存率</span>
        <span>{pct(s.theoreticalHitRatio)}</span>
        <span className="text-[var(--muted-foreground)]">实际命中率</span>
        <span>{pct(s.actualHitRatio)}</span>
        <span className="text-[var(--muted-foreground)]">输入成本削减</span>
        <span className="text-[#22c55e]">{pct(s.inputCostReduction)}</span>
        <span className="text-[var(--muted-foreground)]">无缓存基线</span>
        <span>{fmt(s.baselineInputTokens)} tok</span>
      </div>
      {s.topCacheKillers.length > 0 && (
        <div className="text-[10px]">
          <span className="text-[var(--muted-foreground)]">最常见 Cache Killer: </span>
          {s.topCacheKillers.map((k) => `${k.reason}×${k.count}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

/** 每轮实际发送内容(§7 任务 1):serialized.parts = 本轮真正上 wire 的消息序列 */
function SentContentList({ telemetry }: { telemetry: ChatTelemetryDto }): ReactElement {
  if (telemetry.rounds.length === 0) return <div className="text-[10px] text-[var(--muted-foreground)]">尚无发送记录</div>
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold">每轮实际发送内容</h4>
      {telemetry.rounds.map((r) => (
        <details key={r.round} className="text-[10px]">
          <summary className="cursor-pointer">
            轮{r.round} · {r.sentParts.length} 块 · {fmt(r.sentTokenCount)} tok
            <span className="ml-1 text-[var(--muted-foreground)]">hash {r.sentHash.slice(0, 8)}</span>
          </summary>
          <div className="mt-1 space-y-0.5">
            {r.sentParts.map((part, index) => (
              <div key={index} className="rounded bg-[var(--muted)]/50 px-1.5 py-1">
                <span className="mr-1 text-[var(--primary)]">{part.role ?? '?'}</span>
                <span className="whitespace-pre-wrap break-all text-[var(--muted-foreground)]">
                  {part.content.length > 240 ? `${part.content.slice(0, 240)}…` : part.content}
                </span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}

/** 前缀过小提示(§5:stableZoneTokens < MIN_PREFIX_TOKENS → 缓存不激活) */
function PrefixTooSmall({ telemetry }: { telemetry: ChatTelemetryDto }): ReactElement {
  const flagged = telemetry.rounds.filter((r) => r.prefixTooSmall !== undefined)
  if (flagged.length === 0) return <></>
  return (
    <div className="rounded bg-red-900/30 px-2 py-1 text-[10px]">
      ⚠ 前缀过小(§5):{flagged.map((r) => `轮${r.round} ${r.prefixTooSmall?.actualTokens}/${r.prefixTooSmall?.threshold}`).join(' · ')}
      —— 稳定前缀未达 provider 最小缓存阈值,缓存未激活
    </div>
  )
}

export function CacheTelemetry(): ReactElement | null {
  const currentChatId = useChatStore((s) => s.currentChatId)
  const telemetry = useChatStore((s) => s.telemetry)
  const loadTelemetry = useChatStore((s) => s.loadTelemetry)
  const [binaryOpen, setBinaryOpen] = useState(false)

  useEffect(() => {
    if (currentChatId !== null) void loadTelemetry()
  }, [currentChatId, loadTelemetry])

  if (currentChatId === null) return null
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--background)] p-3">
      <div className="mb-2 flex items-center justify-between gap-1">
        <h3 className="text-sm font-semibold">缓存遥测</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[10px] hover:bg-[var(--muted)]"
            onClick={() => setBinaryOpen(true)}
          >
            二分定位
          </button>
          <button type="button" className="rounded px-2 py-0.5 text-[10px] hover:bg-[var(--muted)]" onClick={() => void loadTelemetry()}>
            刷新
          </button>
        </div>
      </div>
      {telemetry === null ? (
        <div className="text-[10px] text-[var(--muted-foreground)]">加载中…</div>
      ) : (
        <div className="space-y-3">
          <HitRateGauge telemetry={telemetry} />
          <PrefixTooSmall telemetry={telemetry} />
          <HitRateCurve telemetry={telemetry} />
          <CacheBreakList telemetry={telemetry} />
          <SimulatorSummary telemetry={telemetry} />
          <SentContentList telemetry={telemetry} />
        </div>
      )}
      {binaryOpen && <CacheBinaryDiff onClose={() => setBinaryOpen(false)} />}
    </aside>
  )
}