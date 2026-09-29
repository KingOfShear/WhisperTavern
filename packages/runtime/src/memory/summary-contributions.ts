/**
 * Summary 链 → PromptContribution(compiler-spec §32/§33 / memory-runtime-spec §2.1.1)。
 *
 * 布局:S30 任务 1——冻结块链位于 summary 区(header → stableWB → freshWB →
 * **summary** → history → injection → tail);每一块 = 一条贡献,zone='summary'
 * (稳定区挂成员,§43 稳定区枚举),semanticPlacement 用 history 变体(order = sequence)
 * 承载块序——与 core/compiler/cache-scenarios.ts 的 summary 构造同款
 * (semanticPlacement 无 'summary' 变体,zone 才是分区真相;§13 双 Placement 分离)。
 *
 * 追加语义:R-P4-4——新块只能追加(frozen),旧块永不回写;追加 = 显式
 * SUMMARY_CHECKPOINT CacheBreak(compiler-spec §33),由调用方(Scribe / 显式 Checkpoint)
 * 在触发时注入 cacheInvalidations。本模块不做注入,只构造贡献(纯读)。
 */
import type { PromptContribution } from '@whispertavern/contracts'
import type { WhisperTavernDb } from '../db/database'

export interface BuildSummaryResult {
  contributions: PromptContribution[]
  diagnostics: { code: string; message: string; level: 'info' | 'warning' }[]
}

/** summary 区默认序起点(块 1 从 0 起;与 cache-scenarios 的 summary 构造对齐) */
const SUMMARY_ORDER_BASE = 0

export function buildSummaryContributions(store: WhisperTavernDb, chatId: string): BuildSummaryResult {
  const rows = store.sqlite
    .prepare(
      `SELECT id, chat_id, sequence, content, from_message_id, to_message_id, frozen, content_hash, token_count
       FROM summary_blocks
       WHERE chat_id = ?
       ORDER BY sequence ASC`
    )
    .all(chatId) as (Record<string, unknown> & {
    id: string
    chat_id: string
    sequence: number
    content: string
    from_message_id: string
    to_message_id: string
    frozen: number
    content_hash: string
    token_count: number | null
  })[]

  const contributions: PromptContribution[] = rows.map((row) => ({
    id: `summary:${row.id}`,
    source: { type: 'summary', summaryId: row.id },
    segment: {
      role: 'system',
      content: row.content,
      zone: 'summary',
    },
    priority: 0,
    semanticPlacement: { type: 'history', order: SUMMARY_ORDER_BASE + row.sequence },
  }))
  return { contributions, diagnostics: [] }
}