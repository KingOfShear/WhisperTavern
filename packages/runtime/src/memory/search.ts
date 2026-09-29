import type BetterSqlite3 from 'better-sqlite3'
import { createMemoryRepository } from './repository'
import type { MemorySearchHit, SearchMemoryQuery } from './types'

/**
 * 跨四层记忆检索(api-spec §88 Search Memory / memory-runtime-spec §2)。
 *
 * S31(Memory HTTP 面):HTTP 层把 kinds 拆开逐层检索,再按 §89 Memory 投影合并返回。
 * - `dossier` → Repository FTS5 关键词兜底(§3.1,命中经 content_hash 校验);
 * - `document` → Repository chunks_fts 检索(§25.4),随后按 documents.chat_id 收敛到会话;
 * - `summary` / `timeline` → 无全文索引(§2.1.1/§2.1.3:结构化查询),本层以参数化
 *   LIKE 子串过滤兜底(小表,冻结块/事件流规模有限;不引 FTS 复杂度)。
 *
 * 排序:按 kind 分组后各自截断 limit,再按 (score desc, updated_at desc) 全局合并
 * (dossier/document 有相关度分,summary/timeline 缺省按 updated_at 倒序,score=…)。
 */
export async function searchMemory(
  sqlite: BetterSqlite3.Database,
  q: SearchMemoryQuery,
): Promise<MemorySearchHit[]> {
  const limit = q.limit ?? 20
  const kinds = q.kinds ?? ['dossier', 'summary', 'timeline', 'document']
  const repo = createMemoryRepository(sqlite)
  const out: MemorySearchHit[] = []

  for (const kind of kinds) {
    if (kind === 'dossier') {
      // FTS5 关键词(拉丁/分词友好) ∪ LIKE 子串兜底(中文等无空格语系;§88 query 语义 = 子串匹配)
      const hits = await repo.searchKeywords({ query: q.query, chatId: q.chatId, limit: limit * 2 })
      const byId = new Map<string, MemorySearchHit>()
      for (const h of hits) {
        byId.set(h.memoryId, {
          id: h.memoryId,
          chatId: q.chatId,
          kind: 'dossier',
          entity: h.entity,
          content: h.content,
          importance: h.importance,
          score: h.score,
          createdAt: h.createdAt,
          updatedAt: h.updatedAt,
        })
      }
      const likeRows = sqlite
        .prepare(
          `SELECT id, chat_id, type, entity, content, importance, confidence, source_message_ids, version, created_at, updated_at
           FROM memories
           WHERE deleted_at IS NULL
             AND chat_id = ?
             AND (content LIKE ? OR entity LIKE ?)
           ORDER BY updated_at DESC
           LIMIT ?`
        )
        .all(q.chatId, `%${q.query}%`, `%${q.query}%`, limit * 2) as {
        id: string
        chat_id: string
        entity: string | null
        content: string
        importance: number | null
        created_at: string
        updated_at: string
      }[]
      for (const r of likeRows) {
        if (byId.has(r.id)) continue
        byId.set(r.id, {
          id: r.id,
          chatId: q.chatId,
          kind: 'dossier',
          entity: r.entity ?? undefined,
          content: r.content,
          importance: r.importance ?? undefined,
          score: 0.4,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })
      }
      for (const hit of byId.values()) out.push(hit)
    } else if (kind === 'document') {
      const chunkHits = await repo.searchChunks({ query: q.query, limit: limit * 2 })
      const seen = new Set<string>()
      for (const c of chunkHits) {
        if (seen.has(c.chunkId)) continue
        seen.add(c.chunkId)
        const doc = await repo.getDocument(c.documentId)
        // 收敛到会话内的文档分块(§155 /chats/:id/memory/search 语义)
        if (doc === undefined || doc.chatId !== q.chatId) continue
        out.push({
          id: c.chunkId,
          chatId: q.chatId,
          kind: 'document',
          content: c.content,
          importance: undefined,
          score: c.score,
          createdAt: doc.createdAt,
          updatedAt: doc.indexedAt ?? doc.createdAt,
        })
      }
    } else if (kind === 'summary') {
      const rows = sqlite
        .prepare(
          `SELECT id, chat_id, sequence, content, from_message_id, to_message_id, frozen, created_at
           FROM summary_blocks
           WHERE chat_id = ? AND content LIKE ?
           ORDER BY sequence ASC
           LIMIT ?`
        )
        .all(q.chatId, `%${q.query}%`, limit) as {
        id: string
        chat_id: string
        content: string
        created_at: string
      }[]
      for (const r of rows) {
        out.push({
          id: r.id,
          chatId: q.chatId,
          kind: 'summary',
          content: r.content,
          createdAt: r.created_at,
          updatedAt: r.created_at,
          score: 0.5,
        })
      }
    } else if (kind === 'timeline') {
      const rows = sqlite
        .prepare(
          `SELECT id, chat_id, event_type, summary, participants, location, consequences,
                  source_message_id, importance, emotional_weight, created_at
           FROM timeline_events
           WHERE chat_id = ? AND summary LIKE ?
           ORDER BY created_at DESC, id ASC
           LIMIT ?`
        )
        .all(q.chatId, `%${q.query}%`, limit) as {
        id: string
        chat_id: string
        summary: string
        importance: number | null
        created_at: string
      }[]
      for (const r of rows) {
        out.push({
          id: r.id,
          chatId: q.chatId,
          kind: 'timeline',
          content: r.summary,
          importance: r.importance ?? undefined,
          createdAt: r.created_at,
          updatedAt: r.created_at,
          score: 0.5,
        })
      }
    }
  }

  // 全局合并:按 kind 分组截断已做(每 kind ≤ limit),合并排序取整体 topN——
  // 跨 kind 可比的分 = 相关度(dossier/document 有真实 score;summary/timeline 0.5 恒定),
  // 再按 updated_at 倒序稳定排序;最终截断 limit。
  return out
    .sort((a, b) => (b.score ?? 0.5) - (a.score ?? 0.5) || (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0))
    .slice(0, limit)
}
