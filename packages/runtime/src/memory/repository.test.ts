import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/database'
import { cosine, createMemoryRepository, parseEmbedding, serializeEmbedding } from './repository'

/** FTS5 unicode61 无 CJK 分词:关键词用例用空格分词内容,database-schema §25.1 口径 */
const EN_CONTENT_A = 'the fox spirit likes hot springs at the mountain shrine'
const EN_CONTENT_B = 'the crow spirit guards the old forest gate'

const dirs: string[] = []
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dg-mem-'))
  dirs.push(dir)
  const store = createDatabase(join(dir, 'mem.sqlite'))
  return store
}

/** Summary 测试需真实 chat + messages 行(summary_blocks.from/to REFERENCES messages) */
function seedChatAndMessages(store: ReturnType<typeof tempDb>, chatId: string, messageIds: string[]) {
  const now = '2026-09-27T12:00:00.000Z'
  store.sqlite
    .prepare(
      'INSERT INTO chats (id, settings, runtime_state, message_sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(chatId, '{}', '{}', messageIds.length, now, now)
  const ins = store.sqlite.prepare(
    'INSERT INTO messages (id, chat_id, sequence, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  messageIds.forEach((m, i) => ins.run(m, chatId, i + 1, 'user', 'm', now, now))
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('memory 持久化层(memory-runtime-spec §7)', () => {
  describe('向量编解码与余弦(memory-runtime-spec §3.2)', () => {
    it('embedding BLOB:Float32Array ↔ 序列化往返无损', () => {
      const v = new Float32Array([1, -2.5, 3.125, 0])
      const buf = serializeEmbedding(v)
      expect(buf.byteLength).toBe(16)
      const back = parseEmbedding(buf)
      expect(Array.from(back)).toEqual([1, -2.5, 3.125, 0])
    })

    it('cosine:平行向量 ≈ 1,正交 ≈ 0,反平行 ≈ -1', () => {
      expect(cosine(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1)
      expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0)
      expect(cosine(new Float32Array([1, 0]), new Float32Array([-3, 0]))).toBeCloseTo(-1)
      expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0) // 维数不符 = 0
    })
  })

  describe('写入面(Scribe 语义 §4;S29 签名+行为)', () => {
    it('upsertMemory:新增落表 + FTS5 关键词命中 + embedding 可检索', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const id = await repo.upsertMemory({
          ownerId: 'owner-1',
          chatId: 'chat-1',
          type: 'fact',
          entity: 'forest-spirit',
          content: EN_CONTENT_A,
          importance: 0.8,
          confidence: 0.9,
          tags: ['nature'],
          embedding: new Float32Array([1, 0.2, 0]),
        })
        expect(id).toBeTruthy()

        const hits = await repo.searchKeywords({ query: 'fox spirit springs', chatId: 'chat-1' })
        expect(hits).toHaveLength(1)
        expect(hits[0]).toMatchObject({ memoryId: id, type: 'fact', entity: 'forest-spirit', via: 'keywords' })

        // chatId 过滤:别的 chat 查不到
        const otherChat = await repo.searchKeywords({ query: 'fox spirit', chatId: 'chat-9' })
        expect(otherChat).toHaveLength(0)
      } finally {
        store.close()
      }
    })

    it('upsertMemory:更新 = 版本化(version+1 + memory_versions 快照),关键词检索返回新内容', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const id = await repo.upsertMemory({
          ownerId: 'owner-1',
          chatId: 'chat-1',
          type: 'fact',
          entity: 'fox',
          content: EN_CONTENT_A,
        })
        await repo.upsertMemory({
          memoryId: id,
          ownerId: 'owner-1',
          chatId: 'chat-1',
          type: 'fact',
          entity: 'fox',
          content: EN_CONTENT_B,
        })

        const row = store.sqlite.prepare('SELECT version, content FROM memories WHERE id = ?').get(id) as {
          version: number
          content: string
        }
        expect(row.version).toBe(2)
        expect(row.content).toBe(EN_CONTENT_B)

        // 版本快照:旧值完整保留
        const snap = store.sqlite
          .prepare('SELECT version, content, content_hash FROM memory_versions WHERE memory_id = ? ORDER BY version')
          .all(id) as { version: number; content: string; content_hash: string }[]
        expect(snap).toHaveLength(1)
        expect(snap[0]).toMatchObject({ version: 1, content: EN_CONTENT_A })

        // FTS5 同步:新内容可命中、旧内容(fox+springs 只在新内容出现一部分)不再命中
        const hits = await repo.searchKeywords({ query: 'crow forest gate' })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.content).toBe(EN_CONTENT_B)
      } finally {
        store.close()
      }
    })

    it('appendTimelineEvent:只追加不 UPDATE,参与者 JSON 落库', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const id = await repo.appendTimelineEvent({
          chatId: 'chat-1',
          eventType: 'discovery',
          summary: '狐神发现山巅神社被乌鸦占领',
          participants: ['fox', 'crow'],
          location: '神社',
          importance: 0.6,
          emotionalWeight: 0.4,
        })
        const row = store.sqlite.prepare('SELECT * FROM timeline_events WHERE id = ?').get(id) as {
          event_type: string
          participants: string
          summary: string
        }
        expect(row.event_type).toBe('discovery')
        expect(JSON.parse(row.participants)).toEqual(['fox', 'crow'])
      } finally {
        store.close()
      }
    })
  })

  describe('语义检索(memory-runtime-spec §3.2)', () => {
    it('searchSemantic:按 cosine 降序 + minScore 过滤 + type 过滤', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const near = await repo.upsertMemory({
          ownerId: 'o', chatId: 'chat-1', type: 'fact', entity: 'fox', content: EN_CONTENT_A,
          embedding: new Float32Array([1, 0, 0]),
        })
        const far = await repo.upsertMemory({
          ownerId: 'o', chatId: 'chat-1', type: 'fact', entity: 'crow', content: EN_CONTENT_B,
          embedding: new Float32Array([0, 1, 0]),
        })
        // 与 near 完全同向 → near 在前
        const hits = await repo.searchSemantic({ embedding: new Float32Array([0.9, 0.1, 0]), chatId: 'chat-1' })
        expect(hits.map((h) => h.memoryId)).toEqual([near, far])
        expect(hits[0]!.score).toBeCloseTo(cosine(new Float32Array([0.9, 0.1, 0]), new Float32Array([1, 0, 0])), 5)

        // minScore 过滤:far 低于阈值被剔除
        const filtered = await repo.searchSemantic({
          embedding: new Float32Array([0.9, 0.1, 0]),
          minScore: 0.5,
        })
        expect(filtered.map((h) => h.memoryId)).toEqual([near])

        // type 过滤
        await repo.upsertMemory({
          ownerId: 'o', chatId: 'chat-1', type: 'preference', entity: 'fox', content: 'fox likes tea',
          embedding: new Float32Array([1, 0, 0]),
        })
        const facts = await repo.searchSemantic({ embedding: new Float32Array([1, 0, 0]), type: 'fact' })
        expect(facts.every((h) => h.type === 'fact')).toBe(true)
      } finally {
        store.close()
      }
    })
  })

  describe('双检索合并(memory-runtime-spec §3.3)', () => {
    it('keywords ∪ semantic 去重合并:双命中 via=both 取高分,整体按 score 降序', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const kw = await repo.upsertMemory({
          ownerId: 'o', chatId: 'chat-1', type: 'fact', entity: 'fox', content: EN_CONTENT_A,
          embedding: new Float32Array([0, 1, 0]), // 与查询语义正交 → 主要靠关键词
        })
        const sem = await repo.upsertMemory({
          ownerId: 'o', chatId: 'chat-1', type: 'fact', entity: 'crow', content: EN_CONTENT_B,
          embedding: new Float32Array([1, 0, 0]), // 与查询同向 → 主要靠语义
        })

        const hits = await repo.search(
          { query: 'fox springs', chatId: 'chat-1', limit: 5 },
          { embedding: new Float32Array([1, 0, 0]), chatId: 'chat-1', limit: 5 },
        )
        expect(hits).toHaveLength(2)
        // sem(语义高)在前,kw(关键词标记)在后;kw 双通道时 via=both
        expect(hits.map((h) => h.memoryId)).toEqual([sem, kw])
        const kwHit = hits.find((h) => h.memoryId === kw)
        expect(kwHit?.via).toBe('both')
        expect(kwHit!.score).toBeGreaterThanOrEqual(0)
      } finally {
        store.close()
      }
    })
  })

  describe('软删与 FTS 清理(memory-runtime-spec §3.1)', () => {
    it('softDeleteMemory:软删行双检索不返回 + FTS cleanup 同步剔除', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const id = await repo.upsertMemory({
          ownerId: 'o', chatId: 'chat-1', type: 'fact', entity: 'fox', content: EN_CONTENT_A,
          embedding: new Float32Array([1, 0, 0]),
        })
        expect(await repo.searchKeywords({ query: 'fox springs' })).toHaveLength(1)

        // S30 删除语义:softDeleteMemory 置 deleted_at + cleanup FTS(§3.1)
        await repo.softDeleteMemory(id)
        expect(await repo.searchKeywords({ query: 'fox springs' })).toHaveLength(0)
        expect(await repo.searchSemantic({ embedding: new Float32Array([1, 0, 0]) })).toHaveLength(0)
        expect(await repo.getMemory(id)).toBeUndefined()
        const ftsLeft = store.sqlite.prepare('SELECT memory_id FROM memories_fts').all() as { memory_id: string }[]
        expect(ftsLeft).toHaveLength(0)
      } finally {
        store.close()
      }
    })
  })

  describe('Summary 链(§2.1.1 Checkpoint 语义;S30)', () => {
    it('appendSummaryBlock:sequence 单调递增 + frozen 默认 TRUE + 追加式(旧块不回写)', async () => {
      const store = tempDb()
      try {
        seedChatAndMessages(store, 'chat-1', ['m-1', 'm-20', 'm-21', 'm-40', 'm-41', 'm-60'])
        const repo = createMemoryRepository(store.sqlite)
        const a = await repo.appendSummaryBlock({
          chatId: 'chat-1', content: '第 1 章:狐神苏醒于温泉', fromMessageId: 'm-1', toMessageId: 'm-20',
        })
        const b = await repo.appendSummaryBlock({
          chatId: 'chat-1', content: '第 2 章:乌鸦占领神社', fromMessageId: 'm-21', toMessageId: 'm-40',
        })
        expect(a.sequence).toBe(1)
        expect(b.sequence).toBe(2)
        expect(a.frozen).toBe(true)
        expect(b.frozen).toBe(true)
        expect(a.contentHash).toBeTruthy()

        // 链读取:sequence 升序,内容不变
        const chain = await repo.listSummaryChain('chat-1')
        expect(chain.map((s) => s.sequence)).toEqual([1, 2])
        expect(chain.map((s) => s.content)).toEqual(['第 1 章:狐神苏醒于温泉', '第 2 章:乌鸦占领神社'])

        // 不提供 UPDATE 路径:冻结块结构上只追加(frozen 语义 by §24 Checkpoint)
        const c = await repo.appendSummaryBlock({
          chatId: 'chat-1', content: '第 3 章:远古封禁之谜', fromMessageId: 'm-41', toMessageId: 'm-60',
        })
        expect(c.sequence).toBe(3)
      } finally {
        store.close()
      }
    })

    it('Summary 链读出的内容自含 covers(from..to)+frozen(compiler-spec §33 形状)', async () => {
      const store = tempDb()
      try {
        seedChatAndMessages(store, 'chat-1', ['m-00000001', 'm-00000020'])
        const repo = createMemoryRepository(store.sqlite)
        await repo.appendSummaryBlock({
          chatId: 'chat-1', content: 'H1-H20', fromMessageId: 'm-00000001', toMessageId: 'm-00000020', tokenCount: 128,
        })
        const [block] = await repo.listSummaryChain('chat-1')
        expect(block).toMatchObject({
          chatId: 'chat-1', frozen: true,
          fromMessageId: 'm-00000001', toMessageId: 'm-00000020', tokenCount: 128,
        })
      } finally {
        store.close()
      }
    })
  })

  describe('Data Bank(documents/chunks,§25.3/§25.4;S30)', () => {
    it('insertDocument + appendChunks:chunk_index 连续 + total_chunks 聚合 + chunk 关键词可命中', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const docId = await repo.insertDocument({
          ownerId: 'owner-1', chatId: 'chat-1', title: '山巅神社沿革', sourceType: 'pasted', mimeType: 'text/plain',
        })
        const n = await repo.appendChunks({
          documentId: docId,
          chunks: [
            { content: 'the shrine stands on the mountain peak', tokenCount: 9 },
            { content: 'the fox spirit guards the sacred gate', tokenCount: 9 },
          ],
        })
        expect(n).toBe(2)

        const doc = await repo.getDocument(docId)
        expect(doc?.totalChunks).toBe(2)
        expect(doc?.title).toBe('山巅神社沿革')

        const chunks = await repo.listDocumentChunks(docId)
        expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1])

        // chunks_fts 关键词命中(§25.4):命中校验走 content_hash 且过滤软删
        const hits = await repo.searchChunks({ query: 'shrine', documentId: docId })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.content).toContain('mountain peak')
      } finally {
        store.close()
      }
    })

    it('appendChunks:分块继续追加(重写 = 新块追加,不 UPDATE 旧行——§25.4 append-only)', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const docId = await repo.insertDocument({ ownerId: 'o', title: '补遗', sourceType: 'pasted' })
        await repo.appendChunks({ documentId: docId, chunks: [{ content: 'first block' }] })
        await repo.appendChunks({ documentId: docId, chunks: [{ content: 'second block' }] })
        const chunks = await repo.listDocumentChunks(docId)
        expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1])
        expect(chunks.some((c) => c.content === 'first block')).toBe(true)
      } finally {
        store.close()
      }
    })
  })

  describe('读取面与 Dossier 实体约束(§2;S30)', () => {
    it("type='fact' 必携 entity(Database-schema §25 列注:Dossier 实体维度)", async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        await expect(
          repo.upsertMemory({ ownerId: 'o', chatId: 'chat-1', type: 'fact', content: EN_CONTENT_A }),
        ).rejects.toThrow(/entity/)
        // 非 fact 类型可不带 entity
        const ok = await repo.upsertMemory({ ownerId: 'o', chatId: 'chat-1', type: 'preference', content: 'likes tea' })
        expect(ok).toBeTruthy()
      } finally {
        store.close()
      }
    })

    it('listMemories:chat/type/entity 过滤 + 软删剔除;timeline 读取面', async () => {
      const store = tempDb()
      try {
        const repo = createMemoryRepository(store.sqlite)
        const fox = await repo.upsertMemory({ ownerId: 'o', chatId: 'chat-1', type: 'fact', entity: 'fox', content: EN_CONTENT_A })
        const crow = await repo.upsertMemory({ ownerId: 'o', chatId: 'chat-1', type: 'fact', entity: 'crow', content: EN_CONTENT_B })
        await repo.upsertMemory({ ownerId: 'o', chatId: 'chat-9', type: 'fact', entity: 'fox', content: 'other chat fact' })

        // chat 过滤:chat-1 两条都在,chat-9 的被排除
        const c1 = await repo.listMemories({ chatId: 'chat-1' })
        expect(c1.map((m) => m.memoryId).sort()).toEqual([crow, fox].sort())
        expect(c1.every((m) => m.chatId === 'chat-1')).toBe(true)
        expect((await repo.listMemories({ chatId: 'chat-1', entity: 'crow' }))).toHaveLength(1)
        expect((await repo.listMemories({ chatId: 'chat-1', type: 'preference' }))).toHaveLength(0)

        // timeline 读取:追加序 + event_type 过滤
        const e1 = await repo.appendTimelineEvent({ chatId: 'chat-1', eventType: 'discovery', summary: '发现神社' })
        await repo.appendTimelineEvent({ chatId: 'chat-1', eventType: 'plot_event', summary: '乌鸦集结' })
        const asc = await repo.listTimelineEvents({ chatId: 'chat-1', order: 'asc' })
        expect(asc.map((t) => t.id)).toEqual([e1, expect.any(String)])
        expect((await repo.listTimelineEvents({ chatId: 'chat-1', eventType: 'discovery' }))).toHaveLength(1)
      } finally {
        store.close()
      }
    })
  })
})