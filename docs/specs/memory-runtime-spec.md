# WhisperTavern V2 — Memory Runtime Specification

> 版本：V0.3（2026-09-28 S31/WP4.2b：Scribe Agent 落地 + Memory HTTP 面 + 跨四层检索）
> **本次更新（V0.3）**：§4 Scribe **由语义骨架转为已实现编排**——`runScribe`（agent/src/memory/scribe.ts）以**影子会话**隔离实现「不直接修改原始聊天记录」（不变量 1 的落地载体），记忆写入经三个 memory 工具（`memory.upsert_dossier`/`memory.append_timeline`/`memory.append_summary`）落 `tool_calls` 行 + `memory.created/updated` durable 事件 + 四层表行，即 p4-plan §6 验收「Scribe 写入经 tool_calls / artifacts 落账」；§4.2 补触发/区间/写后核对口径；§2.1 补 `sourceMessageIds` 行级投影与 Dossier `version` 计数（MemoryHit 时间戳/版本投影）；§3.1 补 FTS5 对无空格语系（中文）的 **LIKE 子串兜底**（`searchMemory` dossier 分支 FTS ∪ LIKE）；§6 维持两事件名不变（不发明新名）；§8 里程碑 S31 ✅。**表结构真相源不变 = [database-schema.md](./database-schema.md) §23 / §25 / §25.1–§25.5 / §26**。api-spec V2.7 已把 §88–§92/§155 Memory 面转已实现契约。
> 版本：V0.2（2026-09-27 S30/WP4.2a：四层记忆 Runtime + 双检索引擎 + Summary 链实现 + tail 注入接线 + agent Memory Policy 兑现 R-P3-9）
> **本次更新（V0.2）**：将 V0.1 骨架的"待填充"锚点转**已实现契约**——§7 Repository 接口契约扩充为完整读写面（Summary 链 `appendSummaryBlock`/`listSummaryChain`、四层读取 `getMemory`/`listMemories`/`listTimelineEvents`/`getDocument`/`listDocumentChunks`、Data Bank 写入 `insertDocument`/`appendChunks`、删除语义 `softDeleteMemory`、`searchChunks` 关键词检索）；§5 zone 约束补实现口径（`resolveMemoryPolicy` 检索编排 + `runAgent` 接线）；§2.1.1 Summary 补贡献构造器 `buildSummaryContributions`（zone='summary'）。**表结构真相源不变 = [database-schema.md](./database-schema.md) §23 / §25 / §25.1–§25.5 / §26**。S31（WP4.2b）Scribe Agent + Memory HTTP 面（§155）仍待填充。
> 状态：Implemented（P4 WP4.2a / WP4.2b）
> 文档层级：[technical-design.md](../technical-design.md) §25（Memory System）之下的**模块解释规格**（"怎么用"层）。
> 上游锚点：总设计 §25（四层记忆）/ §41.1（双检索引擎采纳）/ §10.1（Summary 冻结块）；database-schema §23/§25/§25.1–§25.5/§26；prompt-compiler-spec §32/§33（summary 区与冻结块）/ §10（zone 布局）；agent-runtime-spec §155（ContextSource / memory provenance）；p4-plan R-P4-1/R-P4-3/R-P4-4 与横切纪律 X13/X16/X17。

---

# 1. 目的与范围

Memory Runtime 把"每次生成都要注入的整表记忆"改成**档案化写入 + 按需检索 + tail 注入**（总设计 §25：替代 MVU/表格插件"每轮整表挥发注入"的模式，既省 token 又护缓存）。落点在 `packages/runtime/src/memory/`（持久化层，Repository 模式）与 `packages/agent/src/memory/`（Memory Policy 编排，R-P3-9 兑现，S30）。

本 spec 覆盖：

1. 四层记忆的职责边界与数据形状（§2）
2. 双检索语义：FTS5 关键词兜底 + sqlite-vec 语义（§3）
3. Scribe Agent 写入语义（§4）
4. 检索结果 → PromptContribution 的 zone 约束（§5）
5. memory.* 事件域登记（§6，X13）
6. Repository 接口契约（§7，S29 验收：双检索接口有类型契约）

---

# 2. 四层记忆职责边界与数据形状

四层记忆（总设计 §25）各司其职，写入/检索口径互不相同。底层表结构见 database-schema（引用即真相源），本节点明各层"怎么用"：

| 层 | 职责（总设计 §25） | 表（database-schema） | 写入主体 | 检索方式 |
|---|---|---|---|---|
| Summary | 剧情压缩；冻结块追加 | `summary_blocks`（§23）| Scribe / 显式 Checkpoint | 不检索——整链位于 stable zone（compiler-spec §32/§33）|
| Dossier | 人物/地点/组织/物品/关系/状态的结构化事实卡 | `memories` 中 type='fact' + `entity` 列（§25）| Scribe（发现事实→更新）| FTS5 关键词 + sqlite-vec 语义（§3）|
| Timeline | Event / Timestamp / Participants / Location / Consequences | `timeline_events`（§25.2）| Scribe（追加）| 按 chat_id + event_type + created_at 查询（§3.3）|
| Data Bank / RAG | 导入文档（txt/md/pdf/epub）→ 分块 → 检索 | `documents` / `chunks`（§25.3/§25.4）| 文档导入管线（S30）| FTS5 关键词 + sqlite-vec 语义（§3）|

## 2.1 各层数据形状要点（"怎么用"口径）

### 2.1.1 Summary（`summary_blocks`）
- **只追加冻结块**：新增 = 插入一条 `frozen=TRUE` 的块；旧的冻结块永不回写（database-schema §24 Checkpoint 语义；R-P4-4）。
- 追加即显式 CacheBreak（`SUMMARY_CHECKPOINT`，compiler-spec §32）；禁止"摘要替换历史"。
- `from_message_id..to_message_id` + `sequence` 单调（`UNIQUE(chat_id, sequence)`）。
- 供 Compiler 组装 summary 区（compiler-spec §10 布局：header → stableWB → freshWB → summary → history → injection → tail）。

### 2.1.2 Dossier（`memories`，type='fact' + `entity`）
- `entity` 承载实体维度（人物/地点/组织/物品/关系），**type='fact' 时非空**（database-schema §25 列注）。
- `content` = 单条事实的自然语言陈述；`content_hash` 指纹用于 FTS5 命中校验（剔除脏词条/版本漂移）。
- `embedding` BLOB = float32 序列化向量（§25.5 note；S29 以 BLOB 原始列承载，sqlite-vec `vec0` 加速度面 S30 视扩展可用性启用，见 [database-schema §25.5]）。
- `version` / `memory_versions`（§26）：更新 = 新版本行，`memories.version` 单调递增；`memory.updated` 事件随版本变更发出。

### 2.1.3 Timeline（`timeline_events`）
- **追加式**事件流：Scribe 把对话流转成事件序列（谁、何时、何地、做了什么、什么后果）。
- `importance`（纳入 revisit_probability 排序）与 `emotional_weight`（Emotion Transition 使用，database-schema §25.2 注）。
- 检索 = 结构化查询（chat + event_type + 时间窗/importance 排序），非全文检索。

### 2.1.4 Data Bank（`documents` / `chunks`）
- `documents`：导入文档元数据（title/source_type/source_uri/mime_type/file_size/metadata/total_chunks/indexed_at）。
- `chunks`：**追加式**分块（重写 = 新增一条，不 UPDATE 旧行）；`content_hash` 指纹去重。
- `chunks_fts`：insert/delete 触发器（无 update——追加式，database-schema §25.4）。

---

# 3. 双检索语义（FTS5 关键词兜底 + sqlite-vec 语义）

采用 41.1 双检索引擎（总设计 §41.1）：FTS5 作**零成本关键词兜底**，sqlite-vec 作**语义检索**，二者并行。建表/触发器骨架以 database-schema §25.1（memories_fts 三触发器）/ §25.4（chunks_fts 两触发器）/ §25.5（vec0 虚拟表 + chunks_embeddings 映射）为准，**本 spec 只定义检索语义与合并规则**。

## 3.1 关键词检索（FTS5 兜底）

- 配置：`unicode61 remove_diacritics 2` + `prefix '3 4'`（database-schema §25.1）。
- 命中后**必须**用 `content_hash`（或 `EXISTS ... content_hash` 比对）剔除陈旧/漂移词条（§25.1 检索示例）。
- 软删清理：`memories`/`chunks` 软删除不触发物理 DELETE，需定期 `DELETE FROM memories_fts WHERE memory_id IN (SELECT id FROM memories WHERE deleted_at IS NOT NULL)`（与 chunks_fts 同形）。
- 接口形状见 §7 `searchKeywords`。
- **无空格语系（中文）兜底（S31）**：FTS5 unicode61 对 CJK 不按字分词，连续汉字被当单一 token，子串查询（如 `狐神`）命不中 `狐神琥珀色的眼睛`——`searchMemory` 的 dossier 分支以参数化 `content LIKE %q% OR entity LIKE %q%` **并集**召回（FTS 命中 score=bm25 归一，仅 LIKE 命中 score=0.4），保证 §88 Search Memory 中文子串语义不落空。纯 Repository 层（X16）。

## 3.2 语义检索（sqlite-vec / embedding BLOB）

- S29：`memories.embedding BLOB`（float32 序列化）为真相源；语义检索 = Repository 层内对候选集做 **cosine（或内积）扫描**。该路径零外部依赖、可单测（**不要求 sqlite-vec 扩展可用**）。
- sqlite-vec `vec0` 虚拟表（database-schema §25.5）为加速面，仅当扩展可加载时在 Repository 层启用（X16：FTS5/sqlite-vec 只在 Repository 层，不扩散进 core 纯函数包 / Compiler）。
- 接口形状见 §7 `searchSemantic`。

## 3.3 合并规则（关键词 ∪ 语义）

检索结果合并 = 去重（by memory_id）后按 `relevanceScore` 降序取 topN：
- 关键词命中分 = FTS5 `rank` 归一化；
- 语义命中分 = cosine（或内积）；
- 双命中取较高分（不叠加，避免关键词强化的词面偏差）。

检索范围参数：`chatId?`（会话内）/ `global`（跨会话）+ `type?`（层过滤）+ `limit`。

---

# 4. Scribe Agent 写入语义

Scribe 是**唯一**的记忆写入主体（总设计 §25）：

```text
读新剧情 → 发现重要事实 → 更新 Dossier → 追加 Timeline
```

> **▲ 已实现（S31/WP4.2b）**：编排 = `runScribe(deps: AgentRunDeps, input: RunScribeInput)`（`agent/src/memory/scribe.ts`）。契约测试：`agent/src/memory/scribe.test.ts` 3 条（读剧情→三工具写入 + 原聊天树零变化 + 落库投影；空链 → skipped）。

## 4.1 写入不变量

1. **Scribe 不直接修改原始聊天记录**（原始消息永久保留，可回溯重摘要——总设计 §25 铁律）。
   - **落地载体（S31）**：Scribe 的整个对话在**影子会话** `scribe:<targetChatId>`（标题）运行——目标 chat 的消息树由契约测试断言**一行不动**；记忆工具经 `chatId` 入参把写入落到目标会话的四层表（记忆归属 ≠ 对话发生地）。
2. **Dossier 更新 = 版本化**：改内容 = `memories.updated_at` + `version+1` + `memory_versions` 快照行 + `memory.updated` 事件（deferred-durable）。
3. **Timeline 只追加**：新事件插入 `timeline_events`（`timeline` 不 UPDATE 旧行）。
4. **Data Bank 只追加**：文档重读 = 新 chunk 追加 + 旧 chunk 标记 deleted（database-schema §25.4）。
5. **Summary 只追加冻结块**（§2.1.1；R-P4-4）。

## 4.2 触发与频度（S31 细化）

Scribe 不在每轮同步调用（P4 出场约束：RP Fast 每轮恰 1 次调用）。触发点 = 显式 Checkpoint / Summary 冻结 / 用户指令（S31 已落 Memory HTTP 面 §155：`POST /api/v2/chats/:id/memory/scribe`）。

实现口径（S31）：

- **区间判定**：`fromMessageId` 缺省 = 最后一个冻结 Summary 块的 `toMessageId` 之后（无摘要则链首）；`toMessageId` 缺省 = 活跃叶。区间为空 → 返回 `skipped`（零写入、零模型调用）。
- **剧情节选**：`slicePlot` 沿活跃链截取区间消息（`serializePlot` 进 Scribe 任务消息正文；`plotMessages` 计数回传）。
- **Agent 定义**：`type: 'custom'` + `metadata.role: 'scribe'` + 固定 name `__builtin_scribe`（**不新增 `AGENT_TYPES` 公共枚举**——决策协议 b：Scribe 是内置角色的 custom 变体，不是新契约类型）；runtimePolicy 上限 `maxTurns:4 / maxToolCalls:12 / maxExecutionTimeMs:300_000`。
- **工具面**：runAgent 传入三个 memory 写入工具（`memoryWriterWireTools`，权限集 `{'memory.read','memory.write'}`）；写入全部经 ToolRegistry 五段流水线 → `tool_calls` 行 + `tool.call.*` durable 事件（=「经 tool_calls / artifacts 落账」）。
- **写后核对**：run 完成后按 `(chatId, type)` 计数 Dossier/Timeline/Summary 增量记入 `RunScribeResult.writes`；skipped/空链也计入（0）。
- **唯一写入主体口子**：HTTP 面（POST Dossier/Timeline/Summary）只是同一 Repository 契约的线格式投影（api-spec §90–§92），不绕过不变量（Dossier 同 entity 版本化、Timeline 只追加、Summary 冻结追加）。

---

# 5. 检索结果 → PromptContribution 的 zone 约束

记忆检索结果一律以 `PromptContribution` 形态进入编译（agent-runtime-spec §152–§155 的 provenance 形状，`ContextSource = { type: 'memory', memoryId }`）：

1. **zone = tail**：检索命中注入 **tail 区**，绝不进稳定前缀（header/stableWB/freshWB/summary 全禁）。
2. **不进 stable zone 的推论**（R4/C2 延续）：记忆内容变化**不得**改变稳定前缀字节 —— 即记忆写入引发的缓存影响只发生在 tail。
3. **Summary 是唯一例外**：`summary_blocks` 冻结链本身位于 stable zone 的 summary 区（compiler-spec §32/§33），但**其更新只能经显式 `SUMMARY_CHECKPOINT` CacheBreak**（R-P4-1 铁律），禁止无事件语义的摘要回写。
4. 注入后必须带 `source: ContextSource(memory)` 供 Inspector/审计追溯来源（agent-runtime-spec §155）。

## 5.1 实现口径（S30：agent/src/memory/policy.ts 检索编排）

- **检索编排** `resolveMemoryPolicy({ policy, repository, chatId, query?, embedding? })`：按 `MemoryContextPolicy.retrievalStrategy` 选路——
  - `recent`：`listMemories({chatId})`（最近更新取样）；
  - `importance`：`listMemories` 宽取后按 `importance` 降序截断；
  - `semantic`：有 `embedding` → `searchSemantic`，缺 → **回退 recent**（记录注：SQLite 库内无 embedding 编码器，查询向量由外部服务/调用方供给）；
  - `hybrid`：query+embedding 双路 `search`（合并去重）→ 仅 query → `searchKeywords` → 皆缺回退 recent。
- 命中先过 `resolveMemoryItems`（纯过滤：`enabled=false` 恒空 / `minImportance` / `minConfidence` / `maxItems` 截断 + 审计 note），再**一律投影 zone='tail'** + `semanticPlacement: {type:'tail', order:i}`。
- **runAgent 接线**：`RunAgentInput.memoryRetrieval?: { query?; embedding? }`；每轮（首轮与后续轮都重查——记忆随会话增长）`resolveMemoryPolicy` 后经 `filterContributions` 追加在 Context Policy 过滤结果之后（S30 同时修复 S26 缺口：`prepareIteration` 的 `filterContributions` 此前已声明但从未被消费，现于 compile 前应用）。
- **Summary 贡献构造器** `buildSummaryContributions(store, chatId)`：冻结块链 → `PromptContribution[]`，`zone='summary'` + `semanticPlacement: {type:'history', order: sequence}`（semanticPlacement 无 summary 变体，zone 才是分区真相；§13 双 Placement 分离，与 core cache-scenarios 同款）。追加 = 显式 `SUMMARY_CHECKPOINT` CacheBreak（compiler-spec §33），构造器本身不做注入（纯读）。

---

# 6. 事件域登记（memory.*，X13）

逐条登记 [technical-design.md](../technical-design.md) §5.4 权威表。S29 只登记权威表**已有**的事件名（决策协议 b：不发明 §5.4 未列事件）：

| 事件名 | durability | 语义 |
|---|---|---|
| `memory.created` | deferred-durable | Dossier 新事实 / 新 Timeline 事件持久化入库 |
| `memory.updated` | deferred-durable | Dossier 版本化更新（版本快照落 `memory_versions`）|

- 分档判据（§5.4 硬约束）：重启后**账目/一致性校验**是否需要它 → 是 deferred-durable（允许延迟不允许丢）；检索行为本身可重建，**不**发事件（不发明 `memory.searched`）。
- `memory.deleted`：soft-delete 的账目意义由 `deleted_at` 列承载，权威表无此事件名 → **不登记**。若 S31 发现审计确需删除事件，回 §5.4 补名再登记（先改 spec 再改代码）。
- **A1/A2 守卫一致性**：catalog.ts（`EVENT_CATALOG`）登记必须与 §5.4 逐字对齐；本表即该登记的 spec 侧来源。codes 目录出现 `type: 'memory.*'` 字符串前，必须先登记于 catalog.ts（A3）。

---

# 7. Repository 接口契约（packages/runtime/src/memory/）

> V0.1：S29 验收 = **双检索接口有类型契约**。V0.2（S30）：契约**扩充为四层完整读写面**——检索三件套 + 读取面（getMemory/listMemories/listTimelineEvents/listSummaryChain/getDocument/listDocumentChunks）+ 写入面（upsertMemory/appendTimelineEvent/appendSummaryBlock/insertDocument/appendChunks/softDeleteMemory）。V0.3（S31）：MemoryHit 补行级时间戳/版本/来源投影（`createdAt`/`updatedAt`/`version`/`sourceMessageIds`——api-spec §89/§91 Dossier DTO 需要）；新增跨四层检索面 `searchMemory(sqlite, SearchMemoryQuery)`（§88 HTTP 面的运行时侧，dossier 分支 FTS ∪ LIKE 兜底，§3.1）。实现 = `SqliteMemoryRepository`，工厂 `createMemoryRepository(sqlite)` 返回 `MemoryRepository & MemoryWriter & MemoryReader`。纯 TS 类型契约，不依赖 sqlite-vec 扩展可用性。

```ts
/** 记忆检索命中（内存侧投影；表结构见 database-schema §25） */
interface MemoryHit {
  memoryId: string
  type: 'fact' | 'preference' | 'relationship' | 'event' | 'world' | 'instruction' | 'other'
  content: string
  contentHash: string
  chatId?: string
  entity?: string
  importance?: number
  confidence?: number
  score: number        // 合并后的归一化相关度（§3.3）
  via: 'keywords' | 'semantic' | 'both'
  // S31 行级投影（api-spec §89；Dossier DTO 直接消费）
  createdAt: string
  updatedAt: string
  version: number      // Dossier 版本化计数（§4.1 不变量 2）
  sourceMessageIds?: string[]
}

/** S31 跨四层检索（api-spec §88 Search Memory；建议由 HTTP 层调用） */
interface SearchMemoryQuery {
  chatId: string
  query: string
  limit?: number
  kinds?: ('summary' | 'dossier' | 'timeline' | 'document')[]
}

interface MemorySearchHit {
  id: string
  chatId: string
  kind: 'summary' | 'dossier' | 'timeline' | 'document'
  entity?: string
  content: string
  importance?: number
  sourceMessageIds?: string[]
  score: number        // dossier/document 真实相关度;summary/timeline 恒定 0.5
  createdAt: string
  updatedAt: string
}

interface KeywordSearchQuery {
  query: string
  chatId?: string
  limit?: number
}

interface SemanticSearchQuery {
  embedding: Float32Array        // float32 归一向量
  chatId?: string
  type?: string                  // 层过滤（可选）
  limit?: number
  /** 阈值：低于此 cosine 的命中丢弃；缺省 0 */
  minScore?: number
}

/** §3 双检索 + §2 四层读取（S30 落全；`searchChunks` = Data Bank 关键词面） */
interface MemoryRepository {
  searchKeywords(q: KeywordSearchQuery): Promise<MemoryHit[]>
  searchSemantic(q: SemanticSearchQuery): Promise<MemoryHit[]>
  search(q: KeywordSearchQuery, semantic?: SemanticSearchQuery): Promise<MemoryHit[]>
}

/** §2 四层记忆读取面（S30） */
interface MemoryReader {
  getMemory(memoryId: string): Promise<MemoryHit | undefined>
  listMemories(query: ListMemoriesQuery): Promise<MemoryHit[]>       // chat/type/entity 过滤
  listTimelineEvents(query: ListTimelineEventsQuery): Promise<TimelineEventRecord[]>
  listSummaryChain(chatId: string): Promise<SummaryBlock[]>          // sequence 升序冻结块链
  getDocument(documentId: string): Promise<DocumentRecord | undefined>
  listDocumentChunks(documentId: string): Promise<ChunkRecord[]>     // chunk_index 升序
  searchChunks(q: { query: string; documentId?: string; limit?: number }): Promise<ChunkHit[]>
}

/** §2/+§4 写入面：Scribe 写入不变量（§4.1）的执行点 */
interface MemoryWriter {
  upsertMemory(input: UpsertMemoryInput): Promise<string>            // 版本化更新（§26）
  appendTimelineEvent(input: AppendTimelineEventInput): Promise<string>  // 只追加（§25.2）
  appendSummaryBlock(input: AppendSummaryBlockInput): Promise<SummaryBlock>  // 冻结块追加（§24）
  insertDocument(input: InsertDocumentInput): Promise<string>        // Data Bank 元数据
  appendChunks(input: AppendChunksInput): Promise<number>            // 分块追加（§25.4）
  softDeleteMemory(memoryId: string): Promise<void>                  // 软删 + FTS cleanup（§3.1）
}
```

- **Dossier 实体约束**：`upsertMemory` 对 `type='fact'` 强制 `entity` 非空（database-schema §25 列注），违反抛 `VALIDATION_ERROR`。
- **Summary 冻结块**：`appendSummaryBlock` 计算 `sequence = MAX(sequence)+1` 单调递增、`frozen` 默认 TRUE（§24 Checkpoint）；**不提供 UPDATE 路径**（结构上只追加，R-P4-4）。
- **FTS5 关键词**：命中经 `content_hash` 校验剔除漂移词条；软删经 `softDeleteMemory` 触发同步 cleanup（§3.1 SQL）。
- **Data Bank chunks**：`appendChunks` 在 `documents.total_chunks` 聚合上续写 `chunk_index`（重写 = 新 chunk 追加，不 UPDATE 旧行，database-schema §25.4）。

---

# 8. 里程碑锚点

| 会话 | 填充内容 |
|---|---|
| S29（WP4.1）| spec 骨架 V0.1 + migration v10（八表/FTS5 触发器）+ `packages/runtime/src/memory/` Repository 检索三件套 + 写入面签名 + 单测 |
| S30（WP4.2a）✅ | **本会话收口**：四层 Memory Runtime（memories CRUD + timeline 读取 + Data Bank 分块入表）+ Summary 链（appendSummaryBlock 冻结块/sequence 单调 + buildSummaryContributions）+ chunks_fts 关键词检索 + `agent/src/memory/` Memory Policy 兑现（R-P3-9）+ runAgent tail 接线 + filterContributions 消费修复 + 全量门禁绿（534 测试）|
| S31（WP4.2b）✅ | **本会话收口**：Scribe Agent（`runScribe` 影子会话编排 + 三 memory 工具 + AgentBudget 约束）+ Memory HTTP 面（api-spec V2.7 §88–§92/§155：search/summaries/dossier/timeline/scribe 九路由）+ 跨四层 `searchMemory`（FTS ∪ LIKE 中文兜底）+ MemoryHit 行级时间戳/版本/来源投影 + web 记忆管理面板 + 还账 #8 勾销 + 全量门禁绿（544 测试）|

---

# 9. 修订说明

- **V0.3（2026-09-28，S31/WP4.2b）**：Scribe Agent + Memory HTTP 面落地，§4 由语义骨架**转已实现编排**（`runScribe` 影子会话隔离 + 三 memory 工具落账 + 写后核对 `writes` 计数；§4.2 补区间判定/Agent 定义/工具面口径）；§7 补 MemoryHit 行级投影（createdAt/updatedAt/version/sourceMessageIds）+ 新增跨四层 `SearchMemoryQuery`/`MemorySearchHit`；§3.1 补中文 LIKE 兜底；§6 事件域维持两事件名不变（不发明新名）；§8 里程碑 S31 勾 ✅；api-spec 已同步 V2.7。状态：Implemented（P4 WP4.2a/WP4.2b）。
- **V0.2（2026-09-27，S30/WP4.2a）**：四层 Memory Runtime + 双检索引擎 + Summary 链实现，骨架锚点**转已实现契约**——§7 Repository 契约扩充为完整读写面（`MemoryReader` 七读取 + `MemoryWriter` 六写入，`createMemoryRepository` 返回 `MemoryRepository & MemoryWriter & MemoryReader`）；§5 补 §5.1 实现口径（`resolveMemoryPolicy` 四策略编排 + 回退语义 + runAgent 接线 + `buildSummaryContributions` 的 zone/placement 形状）；§8 里程碑 S30 勾 ✅。同步修复：S26 `prepareIteration.filterContributions` 参数此前已声明但从未被消费（现于 compile 前应用）；`MemoryHitLike` 补 `via`（双检索合并通道）。状态：Skeleton → Implemented（P4 WP4.2a）。
- **V0.1（2026-09-27，S29/WP4.1）**：骨架落盘——四层职责/数据形状、双检索语义（FTS5+vec）、Scribe 写入不变量、zone 约束（tail）、memory.* 事件域登记、Repository 契约、里程碑锚点。表结构以 database-schema §23/§25/§25.1–§25.5/§26 为真相源（同步修订：§25.2 去冗余 UNIQUE / §25.3–§25.4 `metadata_`→`metadata` / §25.5 存储位置口径修正）。