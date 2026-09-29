/**
 * Memory 持久化层 —— 对外类型契约(memory-runtime-spec §7)。
 *
 * 双检索语义(memory-runtime-spec §3):FTS5 关键词兜底 + sqlite-vec 语义。
 * S29 语义路径 = embedding BLOB(float32 序列化)的 Repository 层余弦扫描,
 * **零外部依赖、不要求 sqlite-vec 扩展可用**(vec0 = 可用时的加速面,database-schema §25.5;
 * X16:FTS5/sqlite-vec 只在 Repository 层,不扩散进 core 纯函数包)。
 */

/** 记忆命中(内存侧投影;表结构见 database-schema §25) */
export interface MemoryHit {
  memoryId: string
  type: 'fact' | 'preference' | 'relationship' | 'event' | 'world' | 'instruction' | 'other'
  content: string
  contentHash: string
  chatId?: string
  entity?: string
  importance?: number
  confidence?: number
  /** 合并后的归一化相关度(§3.3:关键词 rank 归一 / 语义 cosine / 双命中取较高分) */
  score: number
  /** 命中通道:keywords | semantic | both */
  via: 'keywords' | 'semantic' | 'both'
  /** S31:行级时间戳投影(Memory HTTP 面 §89 Memory.createdAt/updatedAt 需携带) */
  createdAt: string
  updatedAt: string
  /** S31:Dossier 实体版本化计数(§2.1.2;Dossier 卡投影显示 version) */
  version: number
  /** 来源消息 id(Dossier 卡可回溯;JSON 列投影) */
  sourceMessageIds?: string[]
}

export interface KeywordSearchQuery {
  query: string
  chatId?: string
  limit?: number
}

export interface SemanticSearchQuery {
  /** float32 归一向量 */
  embedding: Float32Array
  chatId?: string
  type?: string
  limit?: number
  /** 低于此 cosine 的命中丢弃;缺省 0 */
  minScore?: number
}

export interface MemoryRepository {
  /** FTS5 关键词兜底(§3.1;命中经 content_hash 校验剔除陈旧/漂移词条) */
  searchKeywords(q: KeywordSearchQuery): Promise<MemoryHit[]>
  /** 语义检索(§3.2;embedding BLOB 余弦扫描;sqlite-vec 可用时加速) */
  searchSemantic(q: SemanticSearchQuery): Promise<MemoryHit[]>
  /** 双检索合并(§3.3:keywords ∪ semantic,去重后按 score 降序) */
  search(q: KeywordSearchQuery, semantic?: SemanticSearchQuery): Promise<MemoryHit[]>
}

/** 写入面形状(S29 落签名;S30 补 Summary / Data Bank 写入 + 读取面) */
export interface MemoryWriter {
  /** Dossier 新增/更新事实;更新 = version+1 + memory_versions 快照行(memory-runtime-spec §4.1) */
  upsertMemory(input: UpsertMemoryInput): Promise<string>
  /** Timeline 追加事件(只追加不 UPDATE;§4.1.3) */
  appendTimelineEvent(input: AppendTimelineEventInput): Promise<string>
  /** Summary 冻结块追加(database-schema §23/§24 Checkpoint 语义;sequence 单调,旧块不可变) */
  appendSummaryBlock(input: AppendSummaryBlockInput): Promise<SummaryBlock>
  /** Data Bank:文档元数据入表(database-schema §25.3) */
  insertDocument(input: InsertDocumentInput): Promise<string>
  /** Data Bank:分块追加入表(S30 任务 2;document.total_chunks 同步) */
  appendChunks(input: AppendChunksInput): Promise<number>
  /** memories 软删除(deleted_at;检索面自动剔除,FTS cleanup 语句同 §3.1) */
  softDeleteMemory(memoryId: string): Promise<void>
}

/** 只读面(S30 补全:四层记忆 Runtime 的读取唯一入口) */
export interface MemoryReader {
  getMemory(memoryId: string): Promise<MemoryHit | undefined>
  /** Dossier / 记忆列表查询(可选 chat/type/entity 过滤,按 updated_at 降序) */
  listMemories(query: ListMemoriesQuery): Promise<MemoryHit[]>
  /** Timeline 追加式事件流读取(chat + event_type + 排序;§3.3 结构化查询) */
  listTimelineEvents(query: ListTimelineEventsQuery): Promise<TimelineEventRecord[]>
  /** Summary 链读取:按 sequence 升序返回冻结块(§2.1.1) */
  listSummaryChain(chatId: string): Promise<SummaryBlock[]>
  /** Data Bank:文档读取 */
  getDocument(documentId: string): Promise<DocumentRecord | undefined>
  /** Data Bank:文档分块读取(chunk_index 升序) */
  listDocumentChunks(documentId: string): Promise<ChunkRecord[]>
  /** Data Bank:chunks FTS5 关键词检索(§25.4;命中经 content_hash 校验) */
  searchChunks(q: { query: string; documentId?: string; limit?: number }): Promise<ChunkHit[]>
}

export interface UpsertMemoryInput {
  memoryId?: string
  ownerId: string
  chatId?: string
  /** type='fact' 时 entity 必填(database-schema §25 列注:Dossier 实体维度) */
  type: MemoryHit['type']
  entity?: string
  content: string
  importance?: number
  confidence?: number
  sourceMessageIds?: string[]
  tags?: string[]
  metadata?: Record<string, unknown>
  embedding?: Float32Array
}

export interface AppendTimelineEventInput {
  chatId: string
  eventType: string
  summary: string
  participants?: string[]
  location?: string
  consequences?: string
  sourceMessageId?: string
  importance?: number
  emotionalWeight?: number
}

/** §2.1.1 Summary 冻结块(database-schema §23 行投影) */
export interface SummaryBlock {
  id: string
  chatId: string
  sequence: number
  content: string
  fromMessageId: string
  toMessageId: string
  frozen: boolean
  contentHash: string
  tokenCount?: number
  createdAt: string
}

export interface AppendSummaryBlockInput {
  chatId: string
  content: string
  fromMessageId: string
  toMessageId: string
  /** 冻结块语义:追加即 frozen=TRUE(§24 Checkpoint;禁止回写) */
  frozen?: boolean
  tokenCount?: number
}

export interface InsertDocumentInput {
  chatId?: string
  ownerId: string
  title: string
  sourceType: 'file' | 'url' | 'pasted'
  sourceUri?: string
  mimeType?: string
  fileSizeBytes?: number
  metadata?: Record<string, unknown>
}

export interface AppendChunksInput {
  documentId: string
  /** chunk 内容(追加式;重写 = 新 chunk_id 追加,不 UPDATE 旧行——§25.4) */
  chunks: { content: string; metadata?: Record<string, unknown>; tokenCount?: number }[]
}

export interface ListMemoriesQuery {
  chatId?: string
  type?: MemoryHit['type']
  entity?: string
  limit?: number
}

export interface ListTimelineEventsQuery {
  chatId: string
  eventType?: string
  limit?: number
  /** 升序为事件发生序;缺省 created_at 降序(最新在前) */
  order?: 'asc' | 'desc'
}

export interface TimelineEventRecord {
  id: string
  chatId: string
  eventType: string
  summary: string
  participants: string[]
  location?: string
  consequences?: string
  sourceMessageId?: string
  importance?: number
  emotionalWeight?: number
  createdAt: string
}

export interface DocumentRecord {
  id: string
  chatId?: string
  ownerId: string
  title: string
  sourceType: string
  sourceUri?: string
  mimeType?: string
  fileSizeBytes?: number
  metadata: Record<string, unknown>
  totalChunks: number
  indexedAt?: string
  createdAt: string
  deletedAt?: string
}

export interface ChunkRecord {
  id: string
  documentId: string
  chunkIndex: number
  content: string
  tokenCount?: number
  contentHash: string
  metadata: Record<string, unknown>
  createdAt: string
}

/** chunks_fts 关键词命中(§25.4 检索投影) */
export interface ChunkHit {
  chunkId: string
  documentId: string
  content: string
  contentHash: string
  score: number
}

/** S31 §88 Search Memory:跨四层检索的 kind 过滤清单(api-spec §88) */
export type MemorySearchKind = 'summary' | 'dossier' | 'timeline' | 'document'

/** S31 §88 Search Memory 请求(api-spec §88;query 必填,kinds 缺省全层) */
export interface SearchMemoryQuery {
  chatId: string
  query: string
  limit?: number
  kinds?: MemorySearchKind[]
}

/** S31 §89 Memory 投影(api-spec §89 Memory 的 runtime 侧来源;score 为合并排序依据) */
export interface MemorySearchHit {
  id: string
  chatId: string
  kind: MemorySearchKind
  entity?: string
  content: string
  importance?: number
  sourceMessageIds?: string[]
  /** 合并相关度(dossier/document 为检索分;summary/timeline 恒定 0.5) */
  score: number
  createdAt: string
  updatedAt: string
}