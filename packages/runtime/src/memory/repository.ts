import type BetterSqlite3 from 'better-sqlite3'
import { sha256Hex, uuidv7 } from '../util/id'
import type {
  AppendChunksInput,
  AppendSummaryBlockInput,
  ChunkHit,
  ChunkRecord,
  DocumentRecord,
  InsertDocumentInput,
  KeywordSearchQuery,
  ListMemoriesQuery,
  ListTimelineEventsQuery,
  MemoryHit,
  MemoryReader,
  MemoryRepository,
  MemoryWriter,
  SemanticSearchQuery,
  SummaryBlock,
  TimelineEventRecord,
  UpsertMemoryInput,
  AppendTimelineEventInput,
} from './types'

/**
 * Memory Repository(持久化层)——memory-runtime-spec §7 的 SQLite 实现。
 *
 * 双检索语义见 memory-runtime-spec §3:
 * - searchKeywords:FTS5 关键词兜底(§3.1),命中后按 content_hash 比对剔陈旧词条,
 *   软删行不触发 FTS 物理删除 → 每次检索前先跑 cleanup(定期/按需同一条语句);
 * - searchSemantic:embedding BLOB(float32 序列化)余弦扫描(§3.2),零外部依赖;
 *   语义向量 = `Float32Array` ↔ BLOB 的定长序列化(见 serializeEmbedding/parseEmbedding)。
 *
 * X16:FTS5 只在本 Repository 层封装,不扩散进 core 纯函数包。
 * 归属:四层记忆的**写入/读取唯一入口**;Scribe 与 Agent Memory Policy 经此访问
 * (memory-runtime-spec §4/§7)。
 */

const DEFAULT_LIMIT = 20
const FLOAT32_BYTES = 4

/** float32 向量序列化 → BLOB(4 字节/元素,小端) */
export function serializeEmbedding(v: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(v.length * FLOAT32_BYTES)
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * FLOAT32_BYTES)
  return buf
}

/** BLOB → float32 向量 */
export function parseEmbedding(buf: Uint8Array): Float32Array {
  const len = Math.floor(buf.byteLength / FLOAT32_BYTES)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) out[i] = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat32(i * FLOAT32_BYTES, true)
  return out
}

/** 余弦相似度(输入未归一化也可,返回 [-1,1]) */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

interface MemoryRow {
  id: string
  chat_id: string | null
  type: string
  entity: string | null
  content: string
  content_hash: string
  importance: number | null
  confidence: number | null
  embedding: Uint8Array | null
  source_message_ids: string | null
  version: number
  created_at: string
  updated_at: string
}

function toHit(row: MemoryRow, score: number, via: MemoryHit['via']): MemoryHit {
  return {
    memoryId: row.id,
    type: row.type as MemoryHit['type'],
    content: row.content,
    contentHash: row.content_hash,
    chatId: row.chat_id ?? undefined,
    entity: row.entity ?? undefined,
    importance: row.importance ?? undefined,
    confidence: row.confidence ?? undefined,
    score,
    via,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    ...(row.source_message_ids === null || row.source_message_ids === '[]' ? {} : { sourceMessageIds: JSON.parse(row.source_message_ids) as string[] }),
  }
}

const MEMORY_TYPE_SET = new Set(['fact', 'preference', 'relationship', 'event', 'world', 'instruction', 'other'])

export function createMemoryRepository(sqlite: BetterSqlite3.Database): MemoryRepository & MemoryWriter & MemoryReader {
  return new SqliteMemoryRepository(sqlite)
}

class SqliteMemoryRepository implements MemoryRepository, MemoryWriter, MemoryReader {
  constructor(private readonly sqlite: BetterSqlite3.Database) {}

  // —— 检索(§3)——

  async searchKeywords(q: KeywordSearchQuery): Promise<MemoryHit[]> {
    const limit = q.limit ?? DEFAULT_LIMIT
    const terms = q.query
      .split(/\s+/)
      .filter((t) => t.length > 0)
      // FTS5 phrase 防语法注入:每个词包成双引号 + AND 连接(§3.1 关键词"兜底"语义)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' AND ')
    if (terms.length === 0) return []

    // 先清理软删行(软删不触发 FTS 物理 DELETE;memory-runtime-spec §3.1)
    this.cleanupFts()

    // FTS5 bm25() 返回负值,越相关越负(内置 rank = -bm25 越大越相关):
    // 取 bm25 分映射到 (0,1),与语义 cosine 合并时量级对齐(§3.3 关键词命中分 = rank 归一化)。
    const bind: (string | number)[] = [terms]
    if (q.chatId) bind.push(q.chatId)
    bind.push(limit)
    const rows = this.sqlite
      .prepare(
        `SELECT m.id, m.chat_id, m.type, m.entity, m.content, m.content_hash,
                m.importance, m.confidence, m.embedding, m.source_message_ids, m.version, m.created_at, m.updated_at,
                bm25(memories_fts) AS bm25score
         FROM memories_fts f
         JOIN memories m ON m.id = f.memory_id
         WHERE memories_fts MATCH ?
           AND m.deleted_at IS NULL
           AND m.content_hash = f.content_hash
         ${q.chatId ? 'AND m.chat_id = ?' : ''}
         ORDER BY bm25(memories_fts) ASC
         LIMIT ?`
      )
      .all(...bind) as unknown[]

    return (rows as (MemoryRow & { bm25score: number })[]).map((r) =>
      toHit(r, keywordsScore(r.bm25score), 'keywords')
    )
  }

  async searchSemantic(q: SemanticSearchQuery): Promise<MemoryHit[]> {
    const limit = q.limit ?? DEFAULT_LIMIT
    const minScore = q.minScore ?? 0
    const rows = this.sqlite
      .prepare(
        `SELECT id, chat_id, type, entity, content, content_hash, importance, confidence, embedding, source_message_ids, version, created_at, updated_at
         FROM memories
         WHERE deleted_at IS NULL
           AND embedding IS NOT NULL
         ${q.chatId ? 'AND chat_id = ?' : ''}
         ${q.type ? 'AND type = ?' : ''}`
      )
      .all(...(q.chatId ? [q.chatId] : []).concat(q.type ? [q.type] : [])) as unknown[]

    const hitMap = new Map<string, MemoryHit>()
    for (const raw of rows as MemoryRow[]) {
      if (!raw.embedding) continue
      const score = cosine(q.embedding, parseEmbedding(raw.embedding))
      if (score < minScore) continue
      const hit = toHit(raw, score, 'semantic')
      hitMap.set(hit.memoryId, hit)
    }
    return [...hitMap.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  async search(q: KeywordSearchQuery, semantic?: SemanticSearchQuery): Promise<MemoryHit[]> {
    const [kw, sem] = await Promise.all([this.searchKeywords(q), semantic ? this.searchSemantic(semantic) : []])
    const merged = new Map<string, MemoryHit>()
    for (const h of [...kw, ...sem]) {
      const prev = merged.get(h.memoryId)
      if (!prev) {
        merged.set(h.memoryId, h)
      } else {
        // §3.3:双命中取较高分,via 标记 both
        merged.set(h.memoryId, {
          ...(prev.score >= h.score ? prev : h),
          via: 'both',
          score: Math.max(prev.score, h.score),
        })
      }
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, q.limit ?? DEFAULT_LIMIT)
  }

  // —— 写入(§4 Scribe 语义;S29 先落签名保证调用点不空悬)——

  async upsertMemory(input: UpsertMemoryInput): Promise<string> {
    // Dossier 实体维度(database-schema §25 列注:type='fact' 时 entity 非空)
    if (input.type === 'fact' && (input.entity === undefined || input.entity === '')) {
      throw new Error('VALIDATION_ERROR: type=fact 的 memory 必须携带 entity(Dossier 实体维度,database-schema §25)')
    }
    const now = new Date().toISOString()
    const embedding = input.embedding ? serializeEmbedding(input.embedding) : null
    const contentHash = sha256Hex(input.content)

    if (!input.memoryId) {
      const id = uuidv7()
      this.sqlite
        .prepare(
          `INSERT INTO memories
             (id, owner_id, chat_id, type, entity, content, importance, confidence,
              source_message_ids, tags, metadata, content_hash, embedding, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          id,
          input.ownerId,
          input.chatId ?? null,
          input.type,
          input.entity ?? null,
          input.content,
          input.importance ?? null,
          input.confidence ?? null,
          JSON.stringify(input.sourceMessageIds ?? []),
          JSON.stringify(input.tags ?? []),
          JSON.stringify(input.metadata ?? {}),
          contentHash,
          embedding,
          now,
          now,
        )
      return id
    }

    // 更新 = 版本化(memory-runtime-spec §4.1 in invariant 2):memory_versions 快照旧值 + version+1
    const existing = this.sqlite
      .prepare('SELECT id, version, content, content_hash, metadata FROM memories WHERE id = ? AND deleted_at IS NULL')
      .get(input.memoryId) as { id: string; version: number; content: string; content_hash: string; metadata: string } | undefined
    if (!existing) throw new Error(`MEMORY_NOT_FOUND: ${input.memoryId}`)

    this.sqlite
      .prepare(
        `INSERT INTO memory_versions (id, memory_id, version, content, snapshot, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uuidv7(),
        input.memoryId,
        existing.version,
        existing.content,
        JSON.stringify({
          content: existing.content,
          contentHash: existing.content_hash,
          metadata: JSON.parse(existing.metadata) as unknown,
        }),
        existing.content_hash,
        now,
      )

    this.sqlite
      .prepare(
        `UPDATE memories
         SET type = ?, entity = ?, content = ?, importance = ?, confidence = ?,
             source_message_ids = ?, tags = ?, metadata = ?, content_hash = ?,
             embedding = ?, version = version + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.type,
        input.entity ?? null,
        input.content,
        input.importance ?? null,
        input.confidence ?? null,
        JSON.stringify(input.sourceMessageIds ?? []),
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.metadata ?? {}),
        contentHash,
        embedding,
        now,
        input.memoryId,
      )
    return input.memoryId
  }

  async appendTimelineEvent(input: AppendTimelineEventInput): Promise<string> {
    const id = uuidv7()
    this.sqlite
      .prepare(
        `INSERT INTO timeline_events
           (id, chat_id, event_type, summary, participants, location, consequences,
            source_message_id, importance, emotional_weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.chatId,
        input.eventType,
        input.summary,
        JSON.stringify(input.participants ?? []),
        input.location ?? null,
        input.consequences ?? null,
        input.sourceMessageId ?? null,
        input.importance ?? null,
        input.emotionalWeight ?? null,
        new Date().toISOString(),
      )
    return id
  }

  // —— S30 四层记忆 Runtime(§2)——

  async getMemory(memoryId: string): Promise<MemoryHit | undefined> {
    const row = this.sqlite
      .prepare(
        `SELECT id, chat_id, type, entity, content, content_hash, importance, confidence, embedding, source_message_ids, version, created_at, updated_at
         FROM memories WHERE id = ? AND deleted_at IS NULL`
      )
      .get(memoryId) as MemoryRow | undefined
    if (!row) return undefined
    return toHit(row, 1, 'both')
  }

  async listMemories(query: ListMemoriesQuery): Promise<MemoryHit[]> {
    const limit = query.limit ?? DEFAULT_LIMIT
    const rows = this.sqlite
      .prepare(
        `SELECT id, chat_id, type, entity, content, content_hash, importance, confidence, embedding, source_message_ids, version, created_at, updated_at
         FROM memories
         WHERE deleted_at IS NULL
           ${query.chatId ? 'AND chat_id = ?' : ''}
           ${query.type ? 'AND type = ?' : ''}
           ${query.entity ? 'AND entity = ?' : ''}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(
        ...([...(query.chatId ? [query.chatId] : []), ...(query.type ? [query.type] : []), ...(query.entity ? [query.entity] : []), limit] as (string | number)[]),
      ) as unknown[]
    return (rows as MemoryRow[]).map((r) => toHit(r, 1, 'both'))
  }

  async listTimelineEvents(query: ListTimelineEventsQuery): Promise<TimelineEventRecord[]> {
    const limit = query.limit ?? DEFAULT_LIMIT
    const order = query.order ?? 'desc'
    const rows = this.sqlite
      .prepare(
        `SELECT id, chat_id, event_type, summary, participants, location, consequences,
                source_message_id, importance, emotional_weight, created_at
         FROM timeline_events
         WHERE chat_id = ?
           ${query.eventType ? 'AND event_type = ?' : ''}
         ORDER BY created_at ${order === 'asc' ? 'ASC' : 'DESC'}, rowid ASC
         LIMIT ?`
      )
      .all(...([query.chatId, ...(query.eventType ? [query.eventType] : []), limit] as (string | number)[])) as unknown[]
    return (rows as (Record<string, unknown> & {
      id: string
      chat_id: string
      event_type: string
      summary: string
      participants: string
      location: string | null
      consequences: string | null
      source_message_id: string | null
      importance: number | null
      emotional_weight: number | null
      created_at: string
    })[]).map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      eventType: r.event_type,
      summary: r.summary,
      participants: JSON.parse(r.participants) as string[],
      location: r.location ?? undefined,
      consequences: r.consequences ?? undefined,
      sourceMessageId: r.source_message_id ?? undefined,
      importance: r.importance ?? undefined,
      emotionalWeight: r.emotional_weight ?? undefined,
      createdAt: r.created_at,
    }))
  }

  async appendSummaryBlock(input: AppendSummaryBlockInput): Promise<SummaryBlock> {
    // 冻结块追加式(database-schema §24 Checkpoint):sequence 单调递增,旧块永不回写
    const last = this.sqlite.prepare('SELECT MAX(sequence) AS m FROM summary_blocks WHERE chat_id = ?').get(input.chatId) as
      | { m: number | null }
      | undefined
    const sequence = (last?.m ?? 0) + 1
    const id = uuidv7()
    const now = new Date().toISOString()
    const frozen = input.frozen ?? true
    const tokenCount = input.tokenCount
    this.sqlite
      .prepare(
        `INSERT INTO summary_blocks
           (id, chat_id, sequence, content, from_message_id, to_message_id, frozen, content_hash, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.chatId, sequence, input.content, input.fromMessageId, input.toMessageId, frozen ? 1 : 0, sha256Hex(input.content), tokenCount ?? null, now)
    return {
      id,
      chatId: input.chatId,
      sequence,
      content: input.content,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
      frozen,
      contentHash: sha256Hex(input.content),
      tokenCount,
      createdAt: now,
    }
  }

  async listSummaryChain(chatId: string): Promise<SummaryBlock[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT id, chat_id, sequence, content, from_message_id, to_message_id, frozen, content_hash, token_count, created_at
         FROM summary_blocks
         WHERE chat_id = ?
         ORDER BY sequence ASC`
      )
      .all(chatId) as unknown[]
    return (rows as (Record<string, unknown> & {
      id: string
      chat_id: string
      sequence: number
      content: string
      from_message_id: string
      to_message_id: string
      frozen: number
      content_hash: string
      token_count: number | null
      created_at: string
    })[]).map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      sequence: r.sequence,
      content: r.content,
      fromMessageId: r.from_message_id,
      toMessageId: r.to_message_id,
      frozen: r.frozen !== 0,
      contentHash: r.content_hash,
      tokenCount: r.token_count ?? undefined,
      createdAt: r.created_at,
    }))
  }

  async insertDocument(input: InsertDocumentInput): Promise<string> {
    const id = uuidv7()
    this.sqlite
      .prepare(
        `INSERT INTO documents
           (id, chat_id, owner_id, title, source_type, source_uri, mime_type, file_size_bytes, metadata, total_chunks, indexed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
      )
      .run(id, input.chatId ?? null, input.ownerId, input.title, input.sourceType, input.sourceUri ?? null, input.mimeType ?? null, input.fileSizeBytes ?? null, JSON.stringify(input.metadata ?? {}), new Date().toISOString())
    return id
  }

  async appendChunks(input: AppendChunksInput): Promise<number> {
    const doc = this.sqlite.prepare('SELECT id, total_chunks FROM documents WHERE id = ? AND deleted_at IS NULL').get(input.documentId) as
      | { id: string; total_chunks: number }
      | undefined
    if (!doc) throw new Error(`DOCUMENT_NOT_FOUND: ${input.documentId}`)
    if (input.chunks.length === 0) return 0

    const now = new Date().toISOString()
    const insert = this.sqlite.prepare(
      `INSERT INTO chunks
         (id, document_id, chat_id, chunk_index, content, token_count, content_hash, metadata, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    )
    let next = doc.total_chunks
    for (const c of input.chunks) {
      insert.run(uuidv7(), input.documentId, next, c.content, c.tokenCount ?? null, sha256Hex(c.content), JSON.stringify(c.metadata ?? {}), now)
      next += 1
    }
    this.sqlite.prepare('UPDATE documents SET total_chunks = ?, indexed_at = ? WHERE id = ?').run(next, now, input.documentId)
    return input.chunks.length
  }

  async softDeleteMemory(memoryId: string): Promise<void> {
    this.sqlite.prepare('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), new Date().toISOString(), memoryId)
    this.cleanupFts()
  }

  async getDocument(documentId: string): Promise<DocumentRecord | undefined> {
    const row = this.sqlite
      .prepare(
        `SELECT id, chat_id, owner_id, title, source_type, source_uri, mime_type, file_size_bytes, metadata, total_chunks, indexed_at, created_at, deleted_at
         FROM documents WHERE id = ? AND deleted_at IS NULL`
      )
      .get(documentId) as
      | (Record<string, unknown> & {
          id: string
          chat_id: string | null
          owner_id: string
          title: string
          source_type: string
          source_uri: string | null
          mime_type: string | null
          file_size_bytes: number | null
          metadata: string
          total_chunks: number
          indexed_at: string | null
          created_at: string
          deleted_at: string | null
        })
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      chatId: row.chat_id ?? undefined,
      ownerId: row.owner_id,
      title: row.title,
      sourceType: row.source_type,
      sourceUri: row.source_uri ?? undefined,
      mimeType: row.mime_type ?? undefined,
      fileSizeBytes: row.file_size_bytes ?? undefined,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      totalChunks: row.total_chunks,
      indexedAt: row.indexed_at ?? undefined,
      createdAt: row.created_at,
      deletedAt: row.deleted_at ?? undefined,
    }
  }

  async listDocumentChunks(documentId: string): Promise<ChunkRecord[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT id, document_id, chunk_index, content, token_count, content_hash, metadata, created_at
         FROM chunks
         WHERE document_id = ? AND deleted_at IS NULL
         ORDER BY chunk_index ASC`
      )
      .all(documentId) as unknown[]
    return (rows as (Record<string, unknown> & {
      id: string
      document_id: string
      chunk_index: number
      content: string
      token_count: number | null
      content_hash: string
      metadata: string
      created_at: string
    })[]).map((r) => ({
      id: r.id,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      tokenCount: r.token_count ?? undefined,
      contentHash: r.content_hash,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      createdAt: r.created_at,
    }))
  }

  async searchChunks(q: { query: string; documentId?: string; limit?: number }): Promise<ChunkHit[]> {
    const limit = q.limit ?? DEFAULT_LIMIT
    const terms = q.query
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' AND ')
    if (terms.length === 0) return []

    const rows = this.sqlite
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id, c.content, c.content_hash,
                bm25(chunks_fts) AS bm25score
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.chunk_id
         WHERE chunks_fts MATCH ?
           AND c.deleted_at IS NULL
           AND c.content_hash = f.content_hash
           ${q.documentId ? 'AND c.document_id = ?' : ''}
         ORDER BY bm25(chunks_fts) ASC
         LIMIT ?`
      )
      .all(...([terms, ...(q.documentId ? [q.documentId] : []), limit] as (string | number)[])) as unknown[]

    return (rows as { chunk_id: string; document_id: string; content: string; content_hash: string; bm25score: number }[]).map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      content: r.content,
      contentHash: r.content_hash,
      score: 1 - 1 / (1 + Math.abs(r.bm25score)),
    }))
  }

  /** 软删行 → FTS 兜底索引清理(软删不触发物理 DELETE;memory-runtime-spec §3.1 同款) */
  private cleanupFts(): void {
    this.sqlite
      .prepare(
        `DELETE FROM memories_fts
         WHERE memory_id IN (SELECT id FROM memories WHERE deleted_at IS NOT NULL)`
      )
      .run()
  }
}

/** Memory 类型收口(§25 类型清单) */
export function assertMemoryType(t: string): asserts t is MemoryHit['type'] {
  if (!MEMORY_TYPE_SET.has(t)) throw new Error(`VALIDATION_ERROR: 未知 memory type: ${t}`)
}

/**
 * FTS5 bm25()(负值,越相关越负) → (0,1) 归一分(越相关越大),
 * 与语义 cosine 合并时量级对齐;bm25 = 0(无匹配 rank)记最小分。
 */
function keywordsScore(bm25: number): number {
  if (bm25 >= 0) return 0.01
  return 1 - 1 / (1 + Math.abs(bm25))
}