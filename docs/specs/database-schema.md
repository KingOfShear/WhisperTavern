# WhisperTavern V2 — Database Schema Specification

> 版本：V2.7（2026-09-05 S5/WP0.6 实施：§51 `generations` 增 `usage_source` 列，§52 落实施注记）
> **本次补充（V2.7）**：§52 Token Accounting 实施定案——`generations` 表显式增 `usage_source TEXT`（`'reported' | 'estimated'`）列承载"估算方式必须标记"；原拟走 metadata,实施期改为专用列（可查询、可审计）；estimated 不参与缓存命中率分母（口径见总设计 §33.2）。
> 版本：V2.6（2026-09 Roleplay 持久化扩为折中 5 表：+ relationship_states / character_state_events）
> **本次补充（V2.6）**：收编 roleplay-runtime-spec V1.1（裁决 R6=折中 5 表持久化）后补 2 项——①新增 `relationship_states`（关系边表，群聊关系图，§29.4）；②新增 `character_state_events`（状态变更事件溯源：patch + prev/next version，支撑 Replay/Rollback/Audit，§29.5）；`roleplay_snapshots` 补 `state_hash`（规范化 JSON→SHA-256，§29.3）；DialogueDirective / QualityReport 存 `artifacts`（type='roleplay_directive' / 'roleplay_quality'）并绑定 run/attempt/step_run。
> **本次补充（V2.5）**：收编 [roleplay-runtime-spec.md](./roleplay-runtime-spec.md)（裁决 R1–R5）后补 3 项——①新增 `roleplay_states`（每 chat×character 动态角色状态：情绪/关系/意图/主动性/novelty/rhythm/expression_history，§29.1）；②新增 `story_threads`（未完成剧情线 open/dormant/resolved，§29.2）；③新增 `roleplay_snapshots`（每次 Run 的 RP 快照 + decision trace，支撑 Replay/Branch/Undo/Swipe，§29.3）；Quality Report 复用 `artifacts`（type='roleplay_quality'）。Rule R1=Fast 默认单调用、R2=Behavior Director 命名、R3=记忆集成、R4=缓存兼容（tail 白名单段按 C6/决策 24 复用）、R5=两层裁剪。RP 依赖 P3 Agent 执行四层与 Compiler PromptContribution，归 **P4**（Fast）；Deep 的 LLM Director/Critic 与 Benchmark 归 P5。
> **本次补充（V2.4）**：3 项——①`events.durability` 列（`durable` / `deferred-durable`，NOT NULL；`live` 档不落表），并把事件示例修正为总设计 §5.4 权威命名；②`approvals` 拆 `status`（审计配对进度）与 `outcome`（四值封闭枚举 `allowed_once / rejected / cancelled / unavailable`，fail-closed），增 `reason` / `policy_at_request`；③`chat_branches` 增分支血缘位 `fork_message_id` / `seed_length` / `is_seeded`（继承前缀 = 可复用缓存前缀，总设计 §38 决策 25）。
> **本次补充（V2.3）**：收编 agent-runtime-spec 裁决 C5（§4.1–4.6）后补 4 项——①新增 `attempts`（P3，Attempt 独立表，承接 `runs.attempt` 列）；②新增 `step_runs`（P3，agent 级步骤执行记录，`stepRevision` 钉住）；③新增 `execution_operations`（P3，设施级重试明细，默认不记录）；④同步总设计 §41 开源参照（Hermes）：`memories` 增 FTS5 关键词兜底检索、`providers` config 预留多 key 容错。P0–P2 维持最小集，见 §34.1–34.3、§81。
> **本次补充（V2.2）**：收编 [agent-runtime-spec.md](./agent-runtime-spec.md) 后补 6 项——①`runs` 加 parent_run_id / origin_run_id / attempt / agent_version / mode / budget_usage / dependency_manifest / last_heartbeat_at + `interrupted` 状态；②`agent_runtime_states` 加 agent_version / created_at / last_heartbeat_at + `queued`/`interrupted` 状态；③`workflow_runs` 加 workflow_version + `interrupted`；④`artifacts.frozen`（裁决 C2：冻结不提升缓存分区）；⑤新增 `runtime_checkpoints`；⑥新增 `approvals`。  
> 状态：Implementation Specification  
> 数据库：SQLite（V2 唯一目标库；Repository/Adapter 抽象仅为代码卫生）  
> 文档层级：[technical-design.md](../technical-design.md) 之下的 **Database Schema 模块详细规格**  
> 类型映射：下文 DDL 用通用方言表达类型意图，SQLite 落地：UUID→TEXT、TIMESTAMPTZ→TEXT(ISO-8601)、JSONB→TEXT(JSON)、BOOLEAN→INTEGER  
> ORM：可选  
> 主键：UUIDv7  
> 时间：UTC ISO-8601  
> JSON：JSON（SQLite TEXT 列）

---

# 1. 设计目标

WhisperTavern V2 的数据库不是单纯的“聊天记录数据库”。

数据库需要同时承担以下职责：

1. 保存用户资产
2. 保存 Chat / Message / Branch
3. 保存 Character / Persona / Preset
4. 保存 Worldbook 及其 Runtime State
5. 保存 Memory / Summary
6. 保存 Agent / Workflow / Run
7. 保存 Tool / Skill / Plugin 数据
8. 保存 Prompt Snapshot
9. 保存 Replay 所需的确定性输入
10. 保存 Cache Runtime State
11. 支持导入 / 导出
12. 支持版本化与迁移
13. 支持 Incremental Compilation
14. 支持 Debug / Inspector / Regression Test

核心原则：

> **数据库保存 Runtime State 和持久化 Asset，但不保存“最终 Prompt 字符串”作为唯一真相。**

**【2026-09 修订】资产混合存储**：角色卡/世界书/预设等可移植资产的**事实源是文件**（`data/cards/`、`data/worldbooks/`、`data/presets/` 下的 .dgcard/.dgworld/.dgpreset，可像酒馆生态一样分享与同步）。数据库只保存三类内容：①**注册索引**（id/名称/文件路径/当前版本，供查询与外键）；②**版本快照**（\*_versions 表——Chat 绑定时对文件内容拍摄，保障历史 Replay）；③**运行态**（Runtime State）。下文各资产表中的 content/source_data 列在此口径下是"索引与快照载体"，不是编辑的事实源。

最终 Prompt 必须由：

```text
Persistent State
        ↓
Runtime State
        ↓
Prompt Compiler
        ↓
Prompt IR
        ↓
Serialized Prompt
```

重新生成。

---

# 2. 数据分层

数据库中的数据分为五层。

```text
┌─────────────────────────────────────┐
│             User Data               │
│ Character / Persona / Preset        │
│ Worldbook / Chat / Memory           │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│          Runtime State              │
│ Worldbook State / Agent State       │
│ Workflow State / Branch State       │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│          Execution State            │
│ Run / Step / Tool Call / Event      │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│         Prompt State                │
│ Prompt Snapshot / Cache State       │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│          Infrastructure             │
│ Provider / Model / Plugin           │
│ Migration / Import / Export         │
└─────────────────────────────────────┘
```

---

# 3. ID 策略

所有核心实体使用 UUIDv7。

```text
id: UUID
```

原因：

- 全局唯一
- 时间有序
- 适合数据库索引
- 适合离线创建
- 方便同步
- 不依赖数据库自增 ID

对于需要稳定语义身份的对象：

```text
id ≠ semantic identifier
```

例如：

```text
worldbook entry:
id = 0198...
semanticId = "worldbook:book1:entry:183"
```

Prompt Compiler 使用稳定的 `semanticId` 作为 Prompt Segment ID。

---

# 4. 通用字段

大部分持久化实体包含：

```ts
interface BaseEntity {
  id: string
  createdAt: string
  updatedAt: string
}
```

如果实体需要软删除：

```ts
interface SoftDeleteEntity extends BaseEntity {
  deletedAt?: string
}
```

---

# 5. User

虽然 V2 可以支持单用户本地模式，但数据库仍保留 User 概念。

## users

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    username        TEXT,
    display_name    TEXT,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);
```

SQLite：

```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT,
    display_name TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

> 注：V2 为本地单用户（总设计 §3 非目标排除云端账号）。users 保留为**本地单行锚点**承载全局设置；各表 owner_id 一律指向本地用户，不做鉴权体系，仅为远期 LAN/多用户预留。

---

# 6. Character

Character 是长期存在的资产。

它不能直接等价于 Prompt。

## characters

```sql
CREATE TABLE characters (
    id                  UUID PRIMARY KEY,
    owner_id            UUID NOT NULL,
    name                TEXT NOT NULL,
    avatar              TEXT,
    description         TEXT,
    personality         TEXT,
    scenario             TEXT,
    first_message       TEXT,
    example_dialogues   TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}',
    source_format       TEXT,
    source_data         JSONB NOT NULL DEFAULT '{}',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,
    deleted_at          TIMESTAMPTZ
);
```

关系：

```text
User
 └── Character
```

存储口径（混合存储，见 §1 修订）：`.dgcard` 文件为事实源；本表为注册索引（展示字段冗余自文件），`source_data` 保留导入 compat。编辑写入文件并递增 version + 拍 `character_versions` 快照。`first_message` 之外的 V3 资产（alternates/groupOnly 问候、system_prompt/post_history、assets[] 结构化清单、内嵌书外置双向引用）按 .dgcard schema（[technical-plan.md](../technical-plan.md) §5.10）落文件，不入库展开。

---

# 7. Character Version

Character 修改后，不应该破坏旧 Chat 的历史可复现性。

因此 Character 需要版本。

## character_versions

```sql
CREATE TABLE character_versions (
    id                  UUID PRIMARY KEY,
    character_id        UUID NOT NULL,
    version             INTEGER NOT NULL,
    snapshot             JSONB NOT NULL,
    content_hash        TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(character_id, version)
);
```

例如：

```text
Character v1
Character v2
Character v3
```

Prompt Snapshot 保存实际使用的：

```text
characterVersion
```

这样即使用户之后修改角色，也不会影响历史 Replay。

---

# 8. Persona

Persona 是用户侧身份资产。

## personas

```sql
CREATE TABLE personas (
    id              UUID PRIMARY KEY,
    owner_id        UUID NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL,
    deleted_at      TIMESTAMPTZ
);
```

---

# 9. Persona Version

```sql
CREATE TABLE persona_versions (
    id              UUID PRIMARY KEY,
    persona_id      UUID NOT NULL,
    version         INTEGER NOT NULL,
    snapshot        JSONB NOT NULL,
    content_hash    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,

    UNIQUE(persona_id, version)
);
```

---

# 10. Preset

Preset 描述 Prompt 构造规则，而不是某一次最终 Prompt。

## presets

```sql
CREATE TABLE presets (
    id                  UUID PRIMARY KEY,
    owner_id            UUID NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    compiler_mode       TEXT NOT NULL DEFAULT 'compatibility',
    config              JSONB NOT NULL DEFAULT '{}',
    source_format       TEXT,
    source_data         JSONB NOT NULL DEFAULT '{}',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,
    deleted_at          TIMESTAMPTZ
);
```

Preset 中可以保存：

```json
{
  "promptOrder": [],
  "generationSettings": {},
  "contextSettings": {},
  "worldbookSettings": {},
  "summarySettings": {},
  "injectionSettings": {}
}
```

---

# 11. Preset Version

```sql
CREATE TABLE preset_versions (
    id              UUID PRIMARY KEY,
    preset_id       UUID NOT NULL,
    version         INTEGER NOT NULL,
    snapshot        JSONB NOT NULL,
    content_hash    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,

    UNIQUE(preset_id, version)
);
```

---

# 12. Worldbook

Worldbook 是独立资产。

## worldbooks

```sql
CREATE TABLE worldbooks (
    id                  UUID PRIMARY KEY,
    owner_id            UUID NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    scan_depth          INTEGER,
    recursive           BOOLEAN NOT NULL DEFAULT FALSE,
    metadata            JSONB NOT NULL DEFAULT '{}',
    source_format       TEXT,
    source_data         JSONB NOT NULL DEFAULT '{}',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,
    deleted_at           TIMESTAMPTZ
);
```

存储口径：`.dgworld` 文件为事实源，**书级触发配置随书走**（scan 块：scanDepth/caseSensitive/matchWholeWords/recursive/budget percent+cap，[technical-plan.md](../technical-plan.md) §5.3）；本表为注册索引，编辑写文件 + version 快照。

---

# 13. Worldbook Entry

每个 Entry 单独持久化。

## worldbook_entries

```sql
CREATE TABLE worldbook_entries (
    id                      UUID PRIMARY KEY,
    worldbook_id            UUID NOT NULL,

    entry_key               TEXT,        -- ST 数值 uid 原样保留（往返映射键，technical-plan §5.3）
    name                    TEXT,        -- ST comment 字段语义正名（条目标题）

    content                 TEXT NOT NULL,

    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,

    -- 【2026-09 修订】以下为编译关键语义列（不得藏入 source_data，§69 自洽要求）
    activation_mode         TEXT NOT NULL DEFAULT 'selective',
                            -- constant(蓝灯) | selective(绿灯) | vectorized
    priority                INTEGER NOT NULL DEFAULT 0,

    position                INTEGER NOT NULL DEFAULT 0,   -- ST 0-7 原值（往返）
    insertion_order         INTEGER NOT NULL DEFAULT 0,

    role                    TEXT NOT NULL DEFAULT 'system',

    keywords_primary        JSONB NOT NULL DEFAULT '[]',
    keywords_secondary      JSONB NOT NULL DEFAULT '[]',

    keyword_logic           TEXT NOT NULL DEFAULT 'andAny',
                            -- andAny|andAll|notAny|notAll（对齐 ST selectiveLogic；初稿 'ANY' 表达不了 NOT *）

    case_sensitive          BOOLEAN NOT NULL DEFAULT FALSE,
    whole_word              BOOLEAN NOT NULL DEFAULT FALSE,

    match_scope             JSONB NOT NULL DEFAULT '[]',  -- 六个 match* 字段合并
    triggers                JSONB NOT NULL DEFAULT '[]',  -- 向量触发词

    scan_depth              INTEGER,

    recursive               BOOLEAN NOT NULL DEFAULT FALSE,
    exclude_recursion       BOOLEAN NOT NULL DEFAULT FALSE,   -- 不被递归激活
    prevent_recursion       BOOLEAN NOT NULL DEFAULT FALSE,   -- 不递归激活他人
    delay_until_recursion   BOOLEAN NOT NULL DEFAULT FALSE,   -- 仅递归激活

    sticky_rounds           INTEGER NOT NULL DEFAULT 0,       -- ST 语义为整数轮数（初稿 BOOLEAN+duration 有误）
    cooldown                INTEGER NOT NULL DEFAULT 0,
    delay                   INTEGER NOT NULL DEFAULT 0,

    probability             REAL NOT NULL DEFAULT 100,

    group_id                TEXT,
    group_override          BOOLEAN NOT NULL DEFAULT FALSE,
    group_weight            REAL,
    use_group_scoring       BOOLEAN NOT NULL DEFAULT TRUE,

    ignore_budget           BOOLEAN NOT NULL DEFAULT FALSE,
    outlet_name             TEXT,                             -- ST 1.18 outlet 注入点

    character_filter        JSONB NOT NULL DEFAULT '{}',

    injection_position      TEXT,
    injection_depth         INTEGER,

    metadata                JSONB NOT NULL DEFAULT '{}',
    source_data             JSONB NOT NULL DEFAULT '{}',      -- 兼容袋（= 资产文件 compat 的 DB 镜像）

    version                 INTEGER NOT NULL DEFAULT 1,

    created_at              TIMESTAMPTZ NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL,
    deleted_at              TIMESTAMPTZ
);
```

---

# 14. Worldbook Entry Version

Worldbook Entry 修改后，旧 Snapshot 必须仍然可以 Replay。

```sql
CREATE TABLE worldbook_entry_versions (
    id                  UUID PRIMARY KEY,
    entry_id            UUID NOT NULL,
    version             INTEGER NOT NULL,

    snapshot            JSONB NOT NULL,
    content_hash        TEXT NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL,

    UNIQUE(entry_id, version)
);
```

---

# 15. Worldbook Runtime State

这是非常重要的一张表。

**Worldbook Asset ≠ Worldbook Runtime State。**

例如：

```text
Worldbook Entry
    ↓
persistent configuration

Worldbook Runtime State
    ↓
sticky / cooldown / cache lifecycle
```

## worldbook_runtime_entries

```sql
CREATE TABLE worldbook_runtime_entries (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,
    worldbook_entry_id  UUID NOT NULL,

    cache_state          TEXT NOT NULL DEFAULT 'unseen',

    -- 首次进入稳定区时分配、此后永不改变（总设计 §11.1）；NULL = 尚未毕业
    physical_order       INTEGER,

    last_activated_at    TIMESTAMPTZ,
    last_activation_seq  INTEGER,

    sticky_until_seq     INTEGER,
    cooldown_until_seq   INTEGER,
    delay_until_seq      INTEGER,

    activation_count     INTEGER NOT NULL DEFAULT 0,

    content_hash         TEXT,

    updated_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(chat_id, worldbook_entry_id)
);
```

允许：

```text
unseen
fresh
stable
stale
retired
```

---

# 16. Worldbook Activation Record

Activation 是一次运行中的结果。

不建议把所有 Activation 结果直接覆盖 Runtime State。

需要保存可审计记录。

## worldbook_activations

```sql
CREATE TABLE worldbook_activations (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,
    run_id              UUID,

    worldbook_entry_id  UUID NOT NULL,

    activated           BOOLEAN NOT NULL,

    reason              TEXT,

    matched_keywords    JSONB NOT NULL DEFAULT '[]',
    source_message_ids  JSONB NOT NULL DEFAULT '[]',

    score               REAL,

    activation_seq      INTEGER NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL
);
```

这样 Inspector 可以回答：

> 为什么这个 Worldbook Entry 这一轮被激活？

例如：

```json
{
  "reason": "keyword",
  "matchedKeywords": ["剑宗"],
  "sourceMessageIds": ["..."],
  "score": 0.92
}
```

---

# 17. Chat

Chat 是 Runtime 的核心容器。

## chats

```sql
CREATE TABLE chats (
    id                      UUID PRIMARY KEY,

    owner_id                UUID NOT NULL,

    title                   TEXT,

    character_id            UUID,
    character_version       INTEGER,

    persona_id              UUID,
    persona_version         INTEGER,

    preset_id               UUID,
    preset_version          INTEGER,

    active_branch_id        UUID,

    model_provider          TEXT,
    model_name              TEXT,

    settings                JSONB NOT NULL DEFAULT '{}',

    runtime_state            JSONB NOT NULL DEFAULT '{}',

    message_sequence        BIGINT NOT NULL DEFAULT 0,

    created_at              TIMESTAMPTZ NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL,
    deleted_at              TIMESTAMPTZ
);
```

群聊预留（P4，总设计 §26）：单聊用 character_id；群聊增加 `chat_members(chat_id, character_id, joined_at, settings)` 成员表，per-(chat, character) 缓存命名空间由 cache_runtime_states 按成员扩展。

---

# 18. Chat Asset Binding

Chat 不应该永远依赖 Character 当前版本。

因此 Chat 保存：

```text
character_id
character_version
persona_id
persona_version
preset_id
preset_version
```

这表示：

> 创建/绑定时使用哪个版本。

如果用户主动切换 Character，则生成新的绑定。

---

# 19. Message

Message 必须支持 Branch。

## messages

```sql
CREATE TABLE messages (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,

    parent_message_id   UUID,

    sequence            BIGINT NOT NULL,

    role                TEXT NOT NULL,

    author_type         TEXT,
    author_id           UUID,

    content             TEXT NOT NULL,

    name                TEXT,

    variant_group_id    UUID,
    variant_index       INTEGER,

    -- 【2026-09 修订】移除 is_active：活跃指针唯一来源 = chats.active_branch_id
    --   → chat_branches.leaf_message_id（避免双指针漂移，见 §21）
    metadata             JSONB NOT NULL DEFAULT '{}',

    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,
    deleted_at          TIMESTAMPTZ
);
```

---

# 20. Message Branch

不直接复制完整聊天。

Branch 通过 Parent Message 表示。

例如：

```text
H1
 |
H2
 |
 ├── H3a
 │    |
 │    H4a
 │
 └── H3b
      |
      H4b
```

Compiler 获取：

```text
active leaf
    ↓
walk parent chain
    ↓
reverse
    ↓
Prompt History
```

---

# 21. Chat Branch

为了方便管理多个对话分支，可以显式建立 Branch。

## chat_branches

```sql
CREATE TABLE chat_branches (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,

    parent_branch_id    UUID,

    root_message_id     UUID,
    leaf_message_id     UUID,

    /**
     * 【2026-09 补】分支血缘位（总设计 §38 决策 25）。
     * fork_message_id  从父分支的哪条消息分叉出去
     * seed_length      继承了多少条父分支消息（前缀长度）
     * is_seeded        是否含从父分支继承的事件前缀
     *
     * 缓存意义：继承前缀 = 可复用的缓存前缀。
     * fork 出去的分支可以直接命中父分支已缓存的前缀，不必从零重发。
     * 分支是 RP 的核心玩法，每次分叉都全量重发的成本不可接受。
     */
    fork_message_id     UUID,
    seed_length         INTEGER NOT NULL DEFAULT 0,
    is_seeded           BOOLEAN NOT NULL DEFAULT FALSE,

    name                TEXT,

    is_active            BOOLEAN NOT NULL DEFAULT FALSE,

    metadata             JSONB NOT NULL DEFAULT '{}',

    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL
);
```

Branch 本身不是 Message 的替代品。

它只是：

```text
Branch Metadata
+
Message Graph
```

活跃指针唯一来源：`chats.active_branch_id → chat_branches.leaf_message_id`（messages 上不设 is_active，见 §19 修订）。

**血缘位的读取规则**：`is_seeded = true` 且 `seed_length > 0` 的分支，其前 `seed_length` 条消息**逐字来自父分支**，Cache Planner 应把这整段视为可复用前缀，沿父分支的 `snapshot_id` 链去找可命中的缓存点。若父分支那一段发生过编辑或条目退役，则本分支的继承前缀同样失效（失效沿血缘传播）。

参照：DeepSeek Harness 的 session fork 语义（`seed + parentSession + seedLength + isSeeded`）。

---

# 22. Message Variant / Swipe

Swipe 本质上是同一个 Parent 下的不同 Assistant Message。

例如：

```text
User H2
 |
 ├── Assistant A
 ├── Assistant B
 └── Assistant C
```

使用：

```text
variant_group_id
variant_index
```

记录。

Active Variant 不应该删除其他 Variant。

---

# 23. Summary Block

Summary 必须支持 Frozen Checkpoint。

## summary_blocks

```sql
CREATE TABLE summary_blocks (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,

    sequence             INTEGER NOT NULL,

    content              TEXT NOT NULL,

    from_message_id     UUID NOT NULL,
    to_message_id       UUID NOT NULL,

    frozen               BOOLEAN NOT NULL DEFAULT FALSE,

    content_hash         TEXT NOT NULL,

    token_count          INTEGER,

    created_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(chat_id, sequence)
);
```

---

# 24. Summary 的设计规则

Summary 不应该被当成：

```text
当前动态字符串
```

而应该被当成：

```text
Checkpoint
```

推荐：

```text
Summary #1
covers H1-H20
frozen

Summary #2
covers H21-H40
frozen

Current History
H41-H50
```

这样：

```text
Summary #1
```

不会因为后续新消息不断变化。

---

# 25. Memory

Memory 与 Summary 不完全相同。

Summary：

```text
压缩历史
```

Memory：

```text
提取长期可复用事实
```

## memories

```sql
CREATE TABLE memories (
    id                  UUID PRIMARY KEY,

    owner_id            UUID NOT NULL,

    chat_id             UUID,

    type                TEXT NOT NULL,

    content             TEXT NOT NULL,

    importance          REAL,

    confidence          REAL,

    source_message_ids  JSONB NOT NULL DEFAULT '[]',

    tags                JSONB NOT NULL DEFAULT '[]',

    metadata             JSONB NOT NULL DEFAULT '{}',

    content_hash        TEXT NOT NULL,

    version             INTEGER NOT NULL DEFAULT 1,

    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,

    deleted_at          TIMESTAMPTZ
);
```

Memory 类型：

```text
fact
preference
relationship
event
world
instruction
other
```

P4 补充（总设计 §25 四层记忆）：①本表需增加 `embedding BLOB`（sqlite-vec vec0 虚拟表或独立向量表）支撑语义检索，另建 FTS5 虚拟表作**关键词兜底**（建表/触发器见 §25.1）；②Dossier 的实体维度以 `entity TEXT` 列 + type='fact' 承载；③尚缺 **timeline_events** 与 **Data Bank**（documents/chunks 两表 + 向量索引），P4 实现时按总设计 §31 补齐。

---

# 25.1 FTS5 关键词索引（memories 兜底检索）

【2026-09，总设计 §25 / §41.1】FTS5 是 **SQLite 专属扩展**（V2 唯一目标库，故允许；但按 §70 的可移植纪律，仅由 Repository 层封装，不扩散进 Core 纯函数包 / Compiler）。因 `memories.id` 是 UUIDv7 TEXT 主键、非整数 rowid，不采用 `content='memories'` 外部内容表模式，改走**独立 FTS5 表 + UNINDEXED 关联列**，仅 `content` 参与索引：

```sql
-- memories 关键词兜底索引（只索 content；memory_id/type/content_hash 可用于查询与校验但不受索引）
CREATE VIRTUAL TABLE memories_fts USING fts5(
    memory_id      UNINDEXED,   -- 关联 memories.id（UUIDv7）
    type           UNINDEXED,   -- fact | preference | relationship | event | world | instruction | other
    content_hash   UNINDEXED,   -- 命中后比对，剔除脏词条 / 版本漂移
    content,                    -- 唯一参与全文索引的列
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '3 4'              -- 可选：开前 3/4 字前缀，支持关键词截断近似匹配
);
```

与 `memories` 的同步触发器（FTS5 虚拟表不会自动跟踪外部表，必须手动维护）：

```sql
CREATE TRIGGER memories_fts_after_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(memory_id, type, content_hash, content)
    VALUES (new.id, new.type, new.content_hash, new.content);
END;

CREATE TRIGGER memories_fts_after_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE memory_id = old.id;
END;

CREATE TRIGGER memories_fts_after_update AFTER UPDATE OF content, type ON memories BEGIN
    DELETE FROM memories_fts WHERE memory_id = OLD.id;
    INSERT INTO memories_fts(memory_id, type, content_hash, content)
    VALUES (NEW.id, NEW.type, NEW.content_hash, NEW.content);
END;
```

检索示例（关键词命中 + `content_hash` 校验剔除陈旧词条；命中片段用 `snippet()` 授权高亮）：

```sql
SELECT memory_id, type, content_hash,
       snippet(memories_fts, 0, '[', ']', '…', 12) AS snip
FROM memories_fts
WHERE memories_fts MATCH :query
  AND EXISTS (SELECT 1 FROM memories m WHERE m.id = memories_fts.memory_id
                                        AND m.content_hash = memories_fts.content_hash)
ORDER BY rank
LIMIT :topN;
```

清理与迁移：`memories` 的软删除（`deleted_at`）不触发物理 DELETE，需按保留策略定期 `DELETE FROM memories_fts WHERE memory_id IN (SELECT id FROM memories WHERE deleted_at IS NOT NULL)`；重建索引 = `DROP + CREATE` 并用 `INSERT INTO ... SELECT` 回填。

> **Data Bank 复用同一模式**（P4）：`chunks` 追加式（append-only），故只需 insert / delete 两个触发器：`chunks_fts(chunk_id UNINDEXED, document_id UNINDEXED, content)`——chunk 重写入以新 chunk_id 追加，不触发 update 重写。

---

# 26. Memory Version

```sql
CREATE TABLE memory_versions (
    id              UUID PRIMARY KEY,

    memory_id       UUID NOT NULL,

    version         INTEGER NOT NULL,

    content         TEXT NOT NULL,

    snapshot        JSONB NOT NULL DEFAULT '{}',

    content_hash    TEXT NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL,

    UNIQUE(memory_id, version)
);
```

---

# 27. Agent

Agent 是 Runtime Entity，而不仅仅是一段 Prompt。

## agents

```sql
CREATE TABLE agents (
    id                  UUID PRIMARY KEY,

    owner_id            UUID NOT NULL,

    name                TEXT NOT NULL,

    description         TEXT,

    agent_type          TEXT NOT NULL,

    instructions        TEXT,

    config              JSONB NOT NULL DEFAULT '{}',

    tool_policy         JSONB NOT NULL DEFAULT '{}',

    memory_policy       JSONB NOT NULL DEFAULT '{}',

    context_policy      JSONB NOT NULL DEFAULT '{}',

    version              INTEGER NOT NULL DEFAULT 1,

    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,

    deleted_at           TIMESTAMPTZ
);
```

Agent 类型：

```text
character
director
writer
checker
editor
tool-agent
custom
```

---

# 28. Agent Version

```sql
CREATE TABLE agent_versions (
    id                  UUID PRIMARY KEY,

    agent_id            UUID NOT NULL,

    version             INTEGER NOT NULL,

    snapshot            JSONB NOT NULL,

    content_hash        TEXT NOT NULL,

    created_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(agent_id, version)
);
```

---

# 29. Agent Runtime State

Agent 的临时状态不能全部塞入 Agent Asset。

## agent_runtime_states

```sql
CREATE TABLE agent_runtime_states (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,
    agent_id            UUID NOT NULL,

    agent_version        INTEGER,           -- 补：Instance 固定使用的 Definition 版本（§7）

    state               JSONB NOT NULL DEFAULT '{}',

    status              TEXT NOT NULL DEFAULT 'idle',

    current_run_id      UUID,

    last_heartbeat_at    TIMESTAMPTZ,       -- 补：Zombie 检测

    created_at           TIMESTAMPTZ NOT NULL,   -- 补

    updated_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(chat_id, agent_id)
);
```

状态：

```text
idle
queued           ← 补
running
waiting
paused
interrupted      ← 补
failed
completed
cancelled
```

> 补（2026-09）：本表即 agent-runtime-spec §7 的 **Agent Instance**——同一 Agent Definition 在多个 Chat 中各自持有一份独立 Runtime State，靠 `agent_version` 实现 §163 热重载（改 Definition 不影响正在运行的 Run）。

---

# 29.1 Roleplay Runtime State（P4）

【2026-09，roleplay-runtime-spec V1.1 §7】RP 的动态角色状态按 **chat × character** 一维一行，与 `agent_runtime_states` 并行（后者管 Agent 生命周期，本表管"角色此刻处于什么情绪/倾向/注意"）。大量字段是 JSON 内部状态，默认不进 Prompt，由 `RoleplayContextPolicy` 选子集。

```sql
CREATE TABLE roleplay_states (
    id                 UUID PRIMARY KEY,

    chat_id            UUID NOT NULL,
    agent_id           UUID NOT NULL,          -- 该角色对应的 Agent（character agent）

    emotional_state    JSONB NOT NULL DEFAULT '{}',   -- EmotionalState（spec §8）
    current_intent     JSONB NOT NULL DEFAULT '{}',   -- CharacterIntent / hidden intent（spec §10）
    initiative_state   JSONB NOT NULL DEFAULT '{}',   -- InitiativeState（spec §13）
    novelty_state      JSONB NOT NULL DEFAULT '{}',   -- NoveltyState / Surprise（spec §19）
    rhythm             JSONB NOT NULL DEFAULT '{}',   -- DialogueRhythm（spec §20）
    expression_history JSONB NOT NULL DEFAULT '{}',   -- ExpressionHistory / Anti-Repetition（spec §18）
    attention_state    JSONB NOT NULL DEFAULT '{}',   -- AttentionState / KnowledgeBoundary（spec §12）

    updated_at         TIMESTAMPTZ NOT NULL,

    UNIQUE(chat_id, agent_id)
);
```

关系不在此表——采用**关系边表** `relationship_states`（§29.4，群聊关系图，每条边一行）。长期档案仍以 Dossier 关系维度为准（技术总设计 §25）；运行时边模型靠 R3 保证不另起记忆系统。

---

# 29.2 Story Thread（未完成剧情线，P4）

【2026-09，roleplay-runtime-spec §14】记录"没有当场解决的事情"，是"活人感"与长期关系的关键。

```sql
CREATE TABLE story_threads (
    id                 UUID PRIMARY KEY,

    chat_id            UUID NOT NULL,
    agent_id           UUID,

    topic              TEXT NOT NULL,

    origin_message_id  UUID,

    importance         REAL,
    emotional_weight   REAL,

    status             TEXT NOT NULL,          -- open | dormant | resolved

    last_mentioned_at  TIMESTAMPTZ,
    revisit_probability REAL,

    created_at         TIMESTAMPTZ NOT NULL,
    resolved_at        TIMESTAMPTZ
);

CREATE INDEX idx_story_threads_chat ON story_threads(chat_id, status);
```

进 Context 时按 `revisit_probability × importance` 排序，只取 relevant（roleplay-runtime-spec §24.1 语义层选内容）。

---

# 29.3 Roleplay Snapshot（P4，Replay/Branch/Undo/Swipe）

【2026-09，roleplay-runtime-spec §26/§35】每次 RP Run 的运行时快照 + decision trace，与 `runtime_checkpoints` / `prompt_snapshots` 双轨（Runtime Decision + Prompt 所见分别可复现）。

```sql
CREATE TABLE roleplay_snapshots (
    id                 UUID PRIMARY KEY,

    run_id             UUID NOT NULL,
    chat_id            UUID NOT NULL,

    character_state    JSONB NOT NULL,
    relationship_state JSONB NOT NULL,
    story_threads      JSONB NOT NULL,
    expression_history JSONB NOT NULL,
    initiative_state   JSONB NOT NULL,

    decision_trace     JSONB NOT NULL,         -- RoleplayDecisionTrace（spec §31）

    state_hash         TEXT NOT NULL,          -- 规范化 JSON → SHA-256（spec §26：字段/数组序、浮点格式确定），Replay/Branch/Rollback 校验

    random_seed        TEXT,

    prompt_snapshot_id UUID,

    created_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_roleplay_snapshots_run ON roleplay_snapshots(run_id);
```

> 触发形式质量报告（Quality Report）不单建表，存 `artifacts`（`type='roleplay_quality'`，`run_id` 关联）；Dialogue Directive 亦存 `artifacts`（`type='roleplay_directive'`），均绑定 run/attempt/step_run。Deep 档用 structured output 生成（spec §28）。两种 Artifact 的形状语义见 [roleplay-quality-spec.md](./roleplay-quality-spec.md) 与 [dialogue-director-spec.md](./dialogue-director-spec.md)。

---

# 29.4 Relationship State（关系边表，P4）

【2026-09，roleplay-runtime-spec V1.1 §9/§27】关系是**边**而非角色属性——群聊中 A↔B、A↔User、B↔C 各一条边，形成关系图。每个节点 `CharacterRuntimeState`，每条边本表。变化渐进，不"突然从陌生人变恋人"。

```sql
CREATE TABLE relationship_states (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,
    source_character_id UUID NOT NULL,
    target_actor_id     UUID NOT NULL,          -- 另一角色或 User

    state               JSONB NOT NULL,          -- 8 维 + labels + recentChanges（spec §9）
    version             BIGINT NOT NULL DEFAULT 1,

    updated_at          TIMESTAMPTZ NOT NULL,

    UNIQUE(chat_id, source_character_id, target_actor_id)
);

CREATE INDEX idx_relationship_states_char ON relationship_states(chat_id, source_character_id);
```

关系：长期档案仍以 Dossier 关系维度为准，本表是其短期连续变化的**运行时边模型镜像**（R3：不另起记忆系统）。

---

# 29.5 Character State Event（状态事件溯源，P4）

【2026-09，roleplay-runtime-spec V1.1 §27/§33】`Snapshot + Event Log` 而非只存最终 JSON，支撑 Audit / Replay / Rollback / Debug。每轮 Commit 追加一条，含上/下一版本号与补丁。

```sql
CREATE TABLE character_state_events (
    id                UUID PRIMARY KEY,

    chat_id           UUID NOT NULL,
    character_id      UUID NOT NULL,

    run_id            UUID,
    attempt_id        UUID,
    step_run_id       UUID,

    event_type        TEXT NOT NULL,            -- USER_PRAISE / EMOTION_CHANGE / DIRECTIVE_CREATED / RESPONSE_GENERATED / RELATIONSHIP_CHANGE / ...
    patch             JSONB NOT NULL,           -- RoleplayStatePatch（spec §26）

    previous_version  BIGINT NOT NULL,
    next_version      BIGINT NOT NULL,

    created_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_character_state_events_char ON character_state_events(chat_id, character_id, created_at);
```

> 与 `events` 表（决策 19，`roleplay.*` 事件域 §5.4）分工：`events` 是**全局事件总线**（含 durability 分档、跨域消费）；`character_state_events` 是**角色状态补丁的专用状态溯源日志**（结构化 patch + 版本号，供状态重放/回滚）。二者并存，前者面向订阅者，后者面向状态还原。

---

# 30. Workflow

Workflow 是 Agent Runtime 的编排结构。

## workflows

```sql
CREATE TABLE workflows (
    id                  UUID PRIMARY KEY,

    owner_id            UUID NOT NULL,

    name                TEXT NOT NULL,

    description         TEXT,

    version              INTEGER NOT NULL DEFAULT 1,

    definition           JSONB NOT NULL,

    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,

    deleted_at          TIMESTAMPTZ
);
```

---

# 31. Workflow Definition

Workflow 使用 DAG。

示例：

```text
User Message
      │
      ▼
 Context Resolve
      │
      ├──────────────┐
      ▼              ▼
 Worldbook       Memory
      │              │
      └──────┬───────┘
             ▼
          Writer
             │
             ▼
          Checker
             │
       ┌─────┴─────┐
       │           │
     pass          fail
       │           │
       ▼           ▼
    Output       Editor
                   │
                   └──→ Writer
```

Definition 示例：

```json
{
  "nodes": [
    {
      "id": "writer",
      "type": "agent",
      "agentId": "..."
    },
    {
      "id": "checker",
      "type": "agent",
      "agentId": "..."
    }
  ],
  "edges": [
    {
      "from": "writer",
      "to": "checker"
    }
  ]
}
```

---

# 32. Workflow Run

每一次 Workflow 执行都必须有独立 Run。

## workflow_runs

```sql
CREATE TABLE workflow_runs (
    id                  UUID PRIMARY KEY,

    workflow_id         UUID NOT NULL,

    workflow_version     INTEGER,           -- 补：Workflow Run 创建时钉住版本（§164）

    chat_id             UUID,

    trigger_message_id  UUID,

    status              TEXT NOT NULL,

    input               JSONB NOT NULL DEFAULT '{}',

    output              JSONB,

    error               JSONB,

    started_at          TIMESTAMPTZ NOT NULL,

    completed_at        TIMESTAMPTZ
);
```

状态：

```text
queued
running
paused
waiting
interrupted      ← 补
completed
failed
cancelled
```

---

# 33. Workflow Step Run

## workflow_step_runs

```sql
CREATE TABLE workflow_step_runs (
    id                  UUID PRIMARY KEY,

    workflow_run_id     UUID NOT NULL,

    node_id             TEXT NOT NULL,

    attempt             INTEGER NOT NULL DEFAULT 1,

    status              TEXT NOT NULL,

    input               JSONB NOT NULL DEFAULT '{}',

    output              JSONB,

    error               JSONB,

    started_at          TIMESTAMPTZ,

    completed_at        TIMESTAMPTZ
);
```

支持：

```text
retry
resume
partial result
failure
timeout
cancellation
```

---

# 34. Run

Agent Runtime 的一次实际执行统一抽象成 Run。

## runs

```sql
CREATE TABLE runs (
    id                  UUID PRIMARY KEY,

    chat_id             UUID,

    agent_id            UUID,

    agent_version        INTEGER,          -- 补：Run 级版本钉住（agent-runtime-spec §163）

    workflow_run_id     UUID,

    workflow_step_run_id UUID,

    parent_run_id       UUID,             -- 补：执行树 parentRunId（agent-runtime-spec §14/§15）

    origin_run_id       UUID,             -- 补：用户触发的"重试"新建 Run → 指向原 Run（裁决 C3）

    attempt             INTEGER NOT NULL DEFAULT 1,   -- 补：Attempt 级重试（裁决 C3）

    trigger_message_id  UUID,

    status              TEXT NOT NULL,

    mode                TEXT NOT NULL DEFAULT 'live',  -- live | simulation | replay | debug

    provider             TEXT,

    model                TEXT,

    input_state          JSONB NOT NULL DEFAULT '{}',

    output_state         JSONB,

    error                JSONB,

    budget_usage         JSONB,            -- 补：BudgetUsage（agent-runtime-spec §41）

    dependency_manifest  JSONB,            -- 补：compiler/agent/workflow/tool 版本清单（§166）

    last_heartbeat_at    TIMESTAMPTZ,      -- 补：Zombie Run 检测（§97）

    started_at           TIMESTAMPTZ NOT NULL,

    completed_at        TIMESTAMPTZ
);
```

状态：

```text
queued
running
waiting
paused
interrupted      ← 补：进程崩溃/心跳超时后的待恢复态（§96/§97）
completed
failed
cancelled
```

> P0 起即启用：每次聊天生成 = 一条 run（agent_id / workflow_run_id 为空），generations.run_id 挂接——统一执行审计从第一天成立。

> **补（2026-09，收编 agent-runtime-spec）**：
> - `parent_run_id` 建立 Run Tree（Director → Writer/Checker），支撑 Inspector / Replay / 成本归集；
> - **Retry 采用双层口径（裁决 C3）**：Provider/Tool 瞬时错误 = 同 Run 内 `attempt + 1`（Run 本体不可变，§12）；用户点"重试" = 新建 Run 并写 `origin_run_id`，绝不把旧 Run 改回 running；
> - `budget_usage` 存 `{turns, toolCalls, inputTokens, outputTokens, cachedTokens, cost, executionTimeMs}`，与 generations 的 usage 是聚合与明细的关系；
> - `dependency_manifest` 是 Resume 兼容性与 Replay 确定性的判据（版本不一致 → `RESUME_INCOMPATIBLE`）。
> - `attempt` 列在 P0–P2 期间承载 attemptNo；**P3 起由独立 `attempts` 表承接**（§34.1），本列语义对齐为其聚合 attemptNo。

---

# 34.1 Attempt（P3，独立表）

【2026-09 收编·裁决 C5，agent-runtime-spec §4.1】P0–P2 阶段 `runs.attempt` 作为 attemptNo 列足够；P3 引入独立表承载 Attempt 的**完整执行环境**（provider / model / runtime snapshot / checkpoint / usage / error）。Retry 创建新 attempt_no，旧 Attempt 历史保留不可变。

```sql
CREATE TABLE attempts (
    id                  UUID PRIMARY KEY,

    run_id              UUID NOT NULL,

    attempt_no          INTEGER NOT NULL,

    status              TEXT NOT NULL,

    parent_attempt_id   UUID,           -- 从历史 checkpoint 派生分支时指向原 Attempt（agent-runtime-spec §10.5）

    reason              TEXT,           -- 重试/分支原因

    runtime_snapshot    JSONB NOT NULL DEFAULT '{}',   -- 判据见 agent-runtime-spec §4.6 / §166

    checkpoint_id       UUID,

    provider             TEXT,
    model                TEXT,

    prompt_snapshot_id   UUID,

    usage               JSONB,          -- UsageSummary

    error               JSONB,

    started_at           TIMESTAMPTZ NOT NULL,
    completed_at         TIMESTAMPTZ,
    timeout_at          TIMESTAMPTZ,

    UNIQUE(run_id, attempt_no)
);
```

---

# 34.2 Step Run（agent 级，P3）

【2026-09 收编·裁决 C5，agent-runtime-spec §4.4】agent 级 run 的步骤执行记录（`workflow_step_runs` 已存在，本表补 agent 级）。主键是该 Step Run 的唯一 id（step_run_id），**绝不能是 `step_id`**；`step_revision` 钉住该 Step 定义版本，终态后不可变。

```sql
CREATE TABLE step_runs (
    id                  UUID PRIMARY KEY,

    attempt_id          UUID NOT NULL,

    step_id             TEXT NOT NULL,
    step_revision       INTEGER NOT NULL,   -- 该 Step 定义版本（§163–165 版本钉住，Replay 依赖）

    run_no              INTEGER NOT NULL,   -- 本 Step 第几次执行（Step Retry = 新 run_no）

    status              TEXT NOT NULL,

    input               JSONB,
    output              JSONB,

    retry_of            UUID,               -- Step Retry 时指向被取代的上一个 Step Run

    checkpoint_id       UUID,

    prompt_snapshot_id   UUID,

    usage               JSONB,

    error               JSONB,

    started_at           TIMESTAMPTZ NOT NULL,
    completed_at         TIMESTAMPTZ,

    UNIQUE(attempt_id, step_id, run_no)
);
```

---

# 34.3 Execution Operation（P3）

【2026-09 收编·裁决 C5，agent-runtime-spec §4.5】Operation 是**设施级** IO / Provider / Tool 重试记录，显式把 “HTTP 重试”与 “Agent Step Retry”区分。**默认不记录**，仅 Debug / simulation / replay 与排障场景开启。

```sql
CREATE TABLE execution_operations (
    id                  UUID PRIMARY KEY,

    step_run_id         UUID,

    type                TEXT NOT NULL,   -- provider_request | tool_request | network_request | storage | plugin_call

    attempt_no          INTEGER NOT NULL,

    status              TEXT NOT NULL,

    latency_ms          INTEGER,

    error               JSONB,

    started_at           TIMESTAMPTZ NOT NULL,
    completed_at         TIMESTAMPTZ
);
```

与 `generations`（§51，Provider 一次语义生成）、`tool_calls`（§35，一次工具调用）的关系：**Operation 是它们内部/底层的重试明细**，不重复记录它们本身。

---

# 35. Tool Call

工具调用必须单独记录。

## tool_calls

```sql
CREATE TABLE tool_calls (
    id                  UUID PRIMARY KEY,

    run_id              UUID NOT NULL,

    tool_name           TEXT NOT NULL,

    arguments           JSONB NOT NULL DEFAULT '{}',

    result              JSONB,

    status              TEXT NOT NULL,

    error               JSONB,

    started_at          TIMESTAMPTZ,

    completed_at        TIMESTAMPTZ
);
```

状态：

```text
pending
running
completed
failed
cancelled
```

---

# 36. Artifact

Agent Runtime 中产生的中间结果不要全部塞进 Message。

## artifacts

```sql
CREATE TABLE artifacts (
    id                  UUID PRIMARY KEY,

    chat_id             UUID,

    run_id              UUID,

    type                TEXT NOT NULL,

    name                TEXT,

    content              TEXT,

    data                JSONB,

    content_hash        TEXT,

    frozen              BOOLEAN NOT NULL DEFAULT FALSE,   -- 补：冻结产物（§72）

    metadata            JSONB NOT NULL DEFAULT '{}',

    created_at           TIMESTAMPTZ NOT NULL
);
```

Artifact 可以被 Prompt Compiler 引用：

```ts
ArtifactRef
```

而不是直接复制全部内容。

> 补（2026-09，**裁决 C2**）：`frozen = true` 表示内容不再变化，但**不改变其缓存分区**——冻结产物一律进入 `injection` / `tail` 区（总设计 §24 与 compiler-spec §83 的既有论证：任何在前缀中部插入内容的做法都会破坏其后的字节稳定性）。`frozen` 的用途是让 Compiler 与 Inspector 知道"这份产物可以安全缓存与复用引用"，而不是把它提升进稳定前缀。

---

# 36.1 Runtime Checkpoint

Resume 必须从最近的安全检查点恢复，不能重跑整个 Run（agent-runtime-spec §51–§55）。

## runtime_checkpoints

```sql
CREATE TABLE runtime_checkpoints (
    id                  UUID PRIMARY KEY,

    run_id              UUID NOT NULL,

    turn_index          INTEGER NOT NULL,

    reason              TEXT NOT NULL,     -- before_provider | after_provider | before_tool
                                           -- | after_tool | before_pause | manual | automatic

    state_hash          TEXT NOT NULL,     -- Resume 兼容性比对（§55）

    agent_state          JSONB NOT NULL DEFAULT '{}',

    variables           JSONB NOT NULL DEFAULT '{}',

    tool_state          JSONB NOT NULL DEFAULT '{}',

    context_state       JSONB NOT NULL DEFAULT '{}',

    prompt_snapshot_id  UUID,

    created_at           TIMESTAMPTZ NOT NULL
);
```

要点：

- 与 `cache_checkpoints`（Prompt 缓存断点）是**两个完全不同的对象**，不要合并：前者是 Runtime 恢复点，后者是 Provider 缓存标记。
- Resume 前必须比对 `state_hash` 与 `runs.dependency_manifest`，不兼容则 `RESUME_INCOMPATIBLE`，默认不强行恢复。
- 保留策略：Run 结束后可清理（Checkpoint 只为恢复服务），但被 paused/interrupted 的 Run 其最后一个 Checkpoint 必须保留。

---

# 36.2 Approval

危险操作需要人工批准（agent-runtime-spec §114–§116）。Waiting 状态不能依赖内存 Promise，必须持久化。

## approvals

```sql
CREATE TABLE approvals (
    id                  UUID PRIMARY KEY,

    run_id              UUID NOT NULL,

    tool_call_id        UUID,

    action              TEXT NOT NULL,

    description         TEXT,

    risk                TEXT NOT NULL,     -- low | medium | high

    requested_permissions JSONB NOT NULL DEFAULT '[]',

    status              TEXT NOT NULL,     -- pending | decided（最终结论见 outcome）

    outcome             TEXT,              -- allowed_once | rejected | cancelled | unavailable（§115.1 四值）

    reason              TEXT,              -- 发起方给出的「为什么问」（不携带工具入参，避免第二份会漂移的副本）

    policy_at_request   TEXT,              -- 发起时的有效 per-chat 策略：ask | never（Replay 需要）

    decided_at          TIMESTAMPTZ,

    expires_at          TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL
);
```

【2026-09 修订】`status` 只表示审计配对的进度（`pending` → `decided`），**最终结论由 `outcome` 承载**，四值封闭枚举：

```text
allowed_once   唯一放行值，且只放行被问到的那一个动作
rejected       明确拒绝
cancelled      请求被撤回（Run 取消 / 超时 / 发起方放弃）
unavailable    没有可用回答者
```

**fail-closed**：调用方只在 `allowed_once` 时放行。无回答者（headless / 后台 workflow / 无 UI）、回答者抛异常、回答者返回枚举外的值，一律落 `unavailable`。**审计事件落库失败时直接拒绝**，不允许返回一个没记进日志的决定。

对应事件：`approval.requested` 与 **`approval.decided`**（`approval.granted` / `approval.rejected` 已合并，见 technical-design §5.4）。两者由同一 `approval_id` 关联，**log-only，不进模型转录**。

> **未配对的 `approval.requested`（有问无答）是异常状态**，崩溃恢复时必须能被检测出来——检测思路与 §36.1 `runtime_checkpoints` 的孤儿检测同构（有 start 无 end = 可检测的中断，而不是一条谎称已完成的 end 记录）。

---

# 37. Provider

## providers

```sql
CREATE TABLE providers (
    id                  UUID PRIMARY KEY,

    owner_id             UUID,

    name                 TEXT NOT NULL,

    type                 TEXT NOT NULL,

    config               JSONB NOT NULL DEFAULT '{}',

    capabilities         JSONB NOT NULL DEFAULT '{}',

    enabled              BOOLEAN NOT NULL DEFAULT TRUE,

    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL
);
```

注意：

> API Key 等敏感凭据不应明文存入普通数据库字段。

应该使用：

```text
OS Keychain
Encrypted Secret Store
Environment Secret
```

数据库只保存 Secret Reference。

> **补（2026-09，总设计 §41.1）**：`providers.config` 可承载同 Provider 多 API Key 的引用列表（secret refs），供 `RATE_LIMIT` 时轮换容错（上限与轮换策略由 Agent Runtime budget 约束）；敏感 key 本身不进库。

---

# 38. Model

## models

```sql
CREATE TABLE models (
    id                  UUID PRIMARY KEY,

    provider_id         UUID NOT NULL,

    model_name          TEXT NOT NULL,

    capabilities         JSONB NOT NULL DEFAULT '{}',

    context_window      INTEGER,

    max_output_tokens   INTEGER,

    pricing             JSONB,

    enabled             BOOLEAN NOT NULL DEFAULT TRUE,

    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL
);
```

---

# 39. Prompt Snapshot

Prompt Snapshot 是 V2 最重要的 Debug / Replay 数据结构之一。

## prompt_snapshots

```sql
CREATE TABLE prompt_snapshots (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,

    run_id              UUID,

    message_id          UUID,

    provider_id         UUID,

    model_id             UUID,

    compiler_version    TEXT NOT NULL,

    schema_version      INTEGER NOT NULL,

    ir                  JSONB NOT NULL,

    cache_plan          JSONB NOT NULL,

    serialized_prompt   JSONB NOT NULL,

    hashes              JSONB NOT NULL,

    diagnostics         JSONB NOT NULL DEFAULT '[]',

    runtime_inputs      JSONB NOT NULL DEFAULT '{}',

    created_at           TIMESTAMPTZ NOT NULL
);
```

---

# 40. Prompt Snapshot 不可变原则

Snapshot 创建后：

```text
UPDATE 禁止
DELETE 默认禁止
```

除非用户明确执行数据清理。

Snapshot 的意义：

> 记录“这一轮模型究竟看到了什么”。

它必须包含：

```text
Prompt IR
Cache Plan
Serialized Prompt
Compiler Version
Provider
Model
Runtime Inputs
Hashes
Diagnostics
```

---

# 41. Prompt Hash

Snapshot 中保存：

```json
{
  "header": "...",
  "stableWB": "...",
  "freshWB": "...",
  "summary": "...",
  "history": "...",
  "injection": "...",
  "tail": "...",
  "final": "..."
}
```

这样可以进行：

```text
Prompt Diff
Cache Diff
Replay Validation
Regression Test
```

---

# 42. Prompt Snapshot Dependency

为了知道 Snapshot 为什么产生当前内容，需要记录依赖。

## prompt_snapshot_dependencies

```sql
CREATE TABLE prompt_snapshot_dependencies (
    id                  UUID PRIMARY KEY,

    snapshot_id         UUID NOT NULL,

    dependency_type     TEXT NOT NULL,

    dependency_id       UUID,

    dependency_version  INTEGER,

    content_hash        TEXT,

    created_at          TIMESTAMPTZ NOT NULL
);
```

例如：

```text
Snapshot
 ├── Character v3
 ├── Persona v2
 ├── Preset v8
 ├── Worldbook Entry A v2
 ├── Worldbook Entry B v1
 ├── Summary #4
 ├── Message H91
 └── Message H92
```

---

# 43. Replay Record

Replay 不应该依赖当前 Runtime State。

## replay_sessions

```sql
CREATE TABLE replay_sessions (
    id                  UUID PRIMARY KEY,

    source_snapshot_id  UUID NOT NULL,

    seed                BIGINT,

    frozen_time         TIMESTAMPTZ,

    runtime_variables   JSONB NOT NULL DEFAULT '{}',

    worldbook_state     JSONB NOT NULL DEFAULT '{}',

    memory_state        JSONB NOT NULL DEFAULT '{}',

    branch_state        JSONB NOT NULL DEFAULT '{}',

    provider_state      JSONB NOT NULL DEFAULT '{}',

    status              TEXT NOT NULL DEFAULT 'created',

    created_at          TIMESTAMPTZ NOT NULL
);
```

Replay 必须尽量做到：

```text
same input
+
same compiler
+
same runtime state
+
same seed
+
same time
=
same Prompt
```

---

# 44. Cache Runtime

Prompt Cache 生命周期需要独立于 Worldbook Asset。

## cache_runtime_states

```sql
CREATE TABLE cache_runtime_states (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,

    zone                 TEXT NOT NULL,

    prefix_hash          TEXT,

    token_count          INTEGER,

    state                TEXT NOT NULL,

    last_snapshot_id     UUID,

    invalidated_at       TIMESTAMPTZ,

    invalidation_reason  TEXT,

    updated_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(chat_id, zone)
);
```

状态：

```text
cold
warm
stable
invalidated
```

---

# 45. Cache Checkpoint

## cache_checkpoints

```sql
CREATE TABLE cache_checkpoints (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,

    snapshot_id         UUID NOT NULL,

    after_segment_id    TEXT NOT NULL,

    prefix_hash         TEXT NOT NULL,

    token_count         INTEGER NOT NULL,

    reason              TEXT NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL
);
```

---

# 46. Cache Invalidation

## cache_invalidations

```sql
CREATE TABLE cache_invalidations (
    id                  UUID PRIMARY KEY,

    chat_id             UUID NOT NULL,

    snapshot_id         UUID,

    scope               TEXT NOT NULL,

    segment_ids         JSONB NOT NULL DEFAULT '[]',

    reason              TEXT NOT NULL,

    details             JSONB NOT NULL DEFAULT '{}',

    created_at          TIMESTAMPTZ NOT NULL
);
```

典型原因（与 [prompt-compiler-spec.md](./prompt-compiler-spec.md) §58 枚举对齐）：

```text
WORLD_BOOK_NEW_ENTRY
WORLD_BOOK_RETIREMENT
WORLD_BOOK_CONTENT_CHANGED
WORLD_BOOK_DEACTIVATED
MACRO_VOLATILE
SUMMARY_CHECKPOINT
HISTORY_COMPACTION
MESSAGE_EDITED
MESSAGE_VARIANT_SWITCHED
BRANCH_SWITCHED
PRESET_CHANGED
CHARACTER_CHANGED
PERSONA_CHANGED
MANUAL_INVALIDATION
```

---

# 47. Macro Runtime

Macro 定义本身可以是代码注册的，不一定存数据库。

但用户自定义 Macro 需要持久化。

## macros

```sql
CREATE TABLE macros (
    id                  UUID PRIMARY KEY,

    owner_id            UUID,

    name                TEXT NOT NULL,

    definition           JSONB NOT NULL,

    enabled              BOOLEAN NOT NULL DEFAULT TRUE,

    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(owner_id, name)
);
```

注意：

> 数据库中保存的是声明，不允许直接保存并执行任意 JavaScript。

---

# 48. Plugin

## plugins

```sql
CREATE TABLE plugins (
    id                  UUID PRIMARY KEY,

    owner_id             UUID,

    plugin_id            TEXT NOT NULL,

    name                 TEXT NOT NULL,

    version              TEXT NOT NULL,

    manifest             JSONB NOT NULL,

    permissions           JSONB NOT NULL DEFAULT '[]',

    enabled              BOOLEAN NOT NULL DEFAULT TRUE,

    installed_at         TIMESTAMPTZ NOT NULL,

    updated_at            TIMESTAMPTZ NOT NULL
);
```

Plugin Permission 示例：

```json
[
  "chat.read",
  "chat.write",
  "prompt.contribute",
  "network.request"
]
```

---

# 49. Plugin State

Plugin 私有数据不能污染核心表。

## plugin_states

```sql
CREATE TABLE plugin_states (
    id                  UUID PRIMARY KEY,

    plugin_id           UUID NOT NULL,

    owner_id            UUID,

    key                 TEXT NOT NULL,

    value               JSONB NOT NULL,

    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,

    UNIQUE(plugin_id, owner_id, key)
);
```

---

# 50. Event Log

V2 应有 Event Bus。

如果需要持久化事件，可建立 Event Log。

## events

```sql
CREATE TABLE events (
    id                  UUID PRIMARY KEY,

    event_type          TEXT NOT NULL,

    /**
     * 【2026-09 补】持久化分档（technical-design §5.4）。
     * durable            已落本表
     * deferred-durable   异步批量落本表，允许延迟不允许丢
     * NOT NULL，新增事件类型必须显式声明，否则打回。
     */
    durability          TEXT NOT NULL,     -- durable | deferred-durable

    aggregate_type      TEXT,

    aggregate_id        UUID,

    run_id              UUID,

    payload             JSONB NOT NULL DEFAULT '{}',

    sequence             BIGINT,

    created_at           TIMESTAMPTZ NOT NULL
);
```

> 落本表的只有 `durable` 与 `deferred-durable` 两档；`live` 档（`generation.delta`、`prompt.compiling`）只在内存广播，**不落表**——`generation.delta` 每 token 一条，落表会直接撑爆这张表。分档判据与完整权威清单见 technical-design §5.4。

事件示例（已按 §5.4 权威清单修正，旧的 `chat.message.created` / `workflow.step.*` 等自造名作废）：

```text
message.created
message.edited

worldbook.activated
worldbook.changed

agent.run.started
agent.run.completed

tool.call.started
tool.call.completed

prompt.compiled
prompt.snapshot.created

approval.requested
approval.decided

cache.invalidated
usage.recorded
```

Event Log 不是业务数据库的替代品。

它主要用于：

```text
debug
audit
replay
telemetry
event-driven runtime
```

---

# 51. Generation Record

模型生成结果应该独立记录。

## generations

```sql
CREATE TABLE generations (
    id                  UUID PRIMARY KEY,

    run_id              UUID NOT NULL,

    snapshot_id         UUID NOT NULL,

    provider_id         UUID,

    model_id            UUID,

    request             JSONB NOT NULL,

    response             JSONB,

    finish_reason       TEXT,

    input_tokens        INTEGER,

    output_tokens       INTEGER,

    cached_tokens       INTEGER,

    latency_ms          INTEGER,

    status              TEXT NOT NULL,

    error               JSONB,

    created_at          TIMESTAMPTZ NOT NULL
);
```

这样可以回答：

```text
这一次模型调用：
用了哪个 Prompt？
用了哪个 Model？
输入多少 token？
缓存命中了多少？
输出多少？
为什么失败？
```

---

# 52. Token Accounting

Token 数据不能完全依赖 Prompt Snapshot。

每次 Provider 调用需要保存实际计费信息。

字段：

```text
input_tokens
output_tokens
cached_tokens
```

如果 Provider 不提供：

```text
estimated
```

必须通过 metadata 标记估算方式。

> **实施注记（V2.7，S5/WP0.6）**：估算方式标记落为 `generations.usage_source` 专用列（`'reported' | 'estimated'`）——可查询、可审计，语义即本节"标记估算方式"。

---

# 53. Import / Export

所有核心资产需要支持导入导出。

## import_jobs

```sql
CREATE TABLE import_jobs (
    id                  UUID PRIMARY KEY,

    owner_id            UUID NOT NULL,

    source_format       TEXT NOT NULL,

    source_metadata     JSONB NOT NULL DEFAULT '{}',

    status              TEXT NOT NULL,

    diagnostics         JSONB NOT NULL DEFAULT '[]',

    created_at           TIMESTAMPTZ NOT NULL,
    completed_at        TIMESTAMPTZ
);
```

## export_jobs

```sql
CREATE TABLE export_jobs (
    id                  UUID PRIMARY KEY,

    owner_id            UUID NOT NULL,

    target_format       TEXT NOT NULL,

    selection            JSONB NOT NULL,

    status               TEXT NOT NULL,

    created_at           TIMESTAMPTZ NOT NULL,
    completed_at         TIMESTAMPTZ
);
```

---

# 54. Compatibility Data

导入 SillyTavern 等外部格式时，不认识的字段不能直接丢弃。

核心对象保留：

```text
source_format
source_data
```

例如：

```json
{
  "sourceFormat": "sillytavern",
  "sourceData": {
    "originalFieldA": "...",
    "unknownFieldB": "..."
  }
}
```

这样：

```text
Imported Asset
      ↓
Normalize
      ↓
Core Schema
      +
Original Source Data
```

可以避免兼容层信息丢失。

命名对应：资产文件内的 `compat` 袋（[technical-plan.md](../technical-plan.md) §5.3/5.5/5.10）= 本表的 `source_data`（DB 侧镜像），导入时互为拷贝。

---

# 55. Database Relationship

核心关系：

```text
User
│
├── Characters
│    └── Character Versions
│
├── Personas
│    └── Persona Versions
│
├── Presets
│    └── Preset Versions
│
├── Worldbooks
│    └── Worldbook Entries
│         └── Entry Versions
│
├── Agents
│    └── Agent Versions
│
├── Workflows
│
├── Providers
│    └── Models
│
└── Chats
     │
     ├── Messages
     │    └── Message Graph
     │
     ├── Branches
     │
     ├── Summary Blocks
     │
     ├── Memories
     │
     ├── Worldbook Runtime
     │
     ├── Agent Runtime
     │
     ├── Workflow Runs
     │    └── Workflow Step Runs
     │
     ├── Runs
     │    ├── Tool Calls
     │    ├── Artifacts
     │    ├── Generations
     │    └── Attempts          ← 裁决 C5 四层执行层级（P3，§34.1）
     │         └── Step Runs    ← agent 级步骤执行（§34.2）
     │              └── Execution Operations   ← 设施级重试明细（P3，§34.3）
     │
     ├── Prompt Snapshots
     │    └── Snapshot Dependencies
     │
     └── Cache Runtime
          ├── Checkpoints
          └── Invalidations
```

---

# 56. 核心 Foreign Key

推荐关系：

```text
characters.owner_id
        → users.id

character_versions.character_id
        → characters.id

personas.owner_id
        → users.id

persona_versions.persona_id
        → personas.id

presets.owner_id
        → users.id

preset_versions.preset_id
        → presets.id

worldbooks.owner_id
        → users.id

worldbook_entries.worldbook_id
        → worldbooks.id

worldbook_entry_versions.entry_id
        → worldbook_entries.id

chats.owner_id
        → users.id

chats.character_id
        → characters.id

chats.persona_id
        → personas.id

chats.preset_id
        → presets.id

messages.chat_id
        → chats.id

messages.parent_message_id
        → messages.id

chat_branches.chat_id
        → chats.id

chat_branches.leaf_message_id
        → messages.id
```

---

# 57. 删除策略

不同实体使用不同删除策略。

## Asset

Character / Persona / Preset / Worldbook：

```text
Soft Delete
```

原因：

历史 Snapshot 仍然可能依赖它们。

---

## Message

默认：

```text
Soft Delete / Tombstone
```

不直接物理删除。

---

## Snapshot

默认：

```text
Immutable
```

用户删除历史 Debug 数据时才允许删除。

---

## Runtime State

可以清理：

```text
Worldbook Runtime State
Cache Runtime State
Agent Runtime State
```

因为它们可以从持久化 Asset + Chat State 重新构建。

---

# 58. 数据真相层级

这是数据库设计必须遵守的原则。

优先级：

```text
Asset
  ↓
Version
  ↓
Runtime State
  ↓
Prompt Snapshot
```

其中：

### Asset

用户真正拥有的东西。

例如：

```text
Character
Worldbook
Preset
Persona
Agent
Workflow
```

### Version

某一时刻的不可变版本。

### Runtime State

运行过程中的状态。

例如：

```text
sticky
cooldown
cacheState
activeBranch
agent status
```

### Snapshot

某次运行实际使用的数据快照。

---

# 59. 不应该把 Snapshot 当成 Source of Truth

错误设计：

```text
Prompt Snapshot
     ↓
以后直接拿 Snapshot 当 Prompt
```

正确设计：

```text
Assets
+
Runtime State
+
Compiler Version
     ↓
Prompt Compiler
     ↓
Prompt Snapshot
```

Snapshot 是：

```text
execution evidence
```

而不是：

```text
authoritative asset
```

口径澄清（与总设计 §19.2"所见即所发"不冲突）：**Snapshot 是"当时实际发送了什么"的证据口径**（Inspector / Replay / 回归以此为准）；**Asset + Runtime State + Compiler 才是"下一轮该发送什么"的生成口径**。证据不改写，生成不抄快照。

---

# 60. Incremental Compilation 所需索引

为了支持增量编译，需要重点优化：

```sql
CREATE INDEX idx_messages_chat_sequence
ON messages(chat_id, sequence);

CREATE INDEX idx_messages_chat_parent
ON messages(chat_id, parent_message_id);

CREATE INDEX idx_worldbook_entries_book
ON worldbook_entries(worldbook_id);

CREATE INDEX idx_worldbook_runtime_chat
ON worldbook_runtime_entries(chat_id);

CREATE INDEX idx_worldbook_activation_chat_seq
ON worldbook_activations(chat_id, activation_seq);

CREATE INDEX idx_summary_chat_sequence
ON summary_blocks(chat_id, sequence);

CREATE INDEX idx_snapshots_chat_created
ON prompt_snapshots(chat_id, created_at);

CREATE INDEX idx_runs_chat_created
ON runs(chat_id, started_at);

CREATE INDEX idx_events_aggregate
ON events(aggregate_type, aggregate_id);

CREATE INDEX idx_generations_run
ON generations(run_id);
```

---

# 61. Message Retrieval

获取当前 Branch History：

```text
active leaf
    ↓
parent_message_id
    ↓
parent_message_id
    ↓
...
    ↓
root
```

最终：

```text
reverse()
```

不要使用：

```sql
SELECT *
FROM messages
WHERE chat_id = ?
ORDER BY sequence;
```

作为唯一方案。

因为 Branch 会导致：

```text
H1
H2
H3a
H3b
H4a
H4b
```

不能简单按全局 Sequence 当作当前历史。

---

# 62. Branch Query

推荐 Runtime 层提供：

```ts
getActiveMessageChain(
  chatId: string
): Message[]
```

数据库层只负责提供：

```text
parent relationship
```

Branch 选择属于 Runtime，而不是 SQL 拼 Prompt。

---

# 63. Worldbook Cache Lifecycle

数据库中：

```text
worldbook_entries
```

负责：

```text
what the entry is
```

而：

```text
worldbook_runtime_entries
```

负责：

```text
what happened to the entry in this chat
```

例如：

```text
Entry A

Asset:
content = "..."

Runtime:
cacheState = stable
physicalOrder = 12
activationCount = 5
```

---

# 64. Cache Graduation 关键规则

禁止：

```text
fresh → stable
```

导致：

```text
physical_order
```

重新排序。

例如：

```text
Round 1

A B C


Round 2

A B C D


Round 3

A B C D
```

D 可以：

```text
fresh → stable
```

但：

```text
physicalOrder(D)
```

不变。

数据库中的：

```text
cache_state
physical_order
```

必须是两个独立字段。

---

# 65. Prompt Compiler Database Boundary

Prompt Compiler 可以读取：

```text
Character Version
Persona Version
Preset Version

Worldbook Entry
Worldbook Runtime State

Summary Block

Message Graph

Memory

Agent Context

Workflow Context

Runtime Variables
```

但不能直接修改这些数据。

---

# 66. Compiler Transaction

推荐：

```text
BEGIN
    read runtime state
    read assets
    resolve versions
    compile
    create snapshot
COMMIT
```

但是：

> Prompt Compiler 本身不负责 Runtime State mutation。

例如 Worldbook：

```text
Compiler:
    read activation state

Worldbook Runtime:
    update sticky/cooldown/cache state
```

两者必须分开。

---

# 67. Compile Consistency

一次 Compile 必须看到一致的数据版本。

建议使用：

```text
transaction snapshot isolation
```

或者：

```text
stateVersion
```

例如：

```ts
interface RuntimeReadVersion {
  chatVersion: number
  worldbookVersion: number
  memoryVersion: number
  branchVersion: number
}
```

Snapshot 保存这些版本。

---

# 68. Optimistic Concurrency

Chat 等高频实体推荐使用：

```text
version
```

例如：

```sql
UPDATE chats
SET
    runtime_state = ?,
    version = version + 1
WHERE
    id = ?
    AND version = ?;
```

如果：

```text
affected rows = 0
```

表示发生并发修改。

Runtime 必须：

```text
reload
retry
```

而不是覆盖其他修改。

---

# 69. JSONB 使用原则

JSONB 适合：

```text
metadata
provider config
plugin state
workflow definition
source_data
diagnostics
runtime_state
```

不适合：

```text
messages
worldbook entries
snapshots
generations
```

这些核心数据需要结构化字段。

原则：

> **高频查询字段结构化，扩展字段 JSON 化。**

---

# 70. SQLite（V2 唯一目标库）

【2026-09 修订】V2 为本地单用户应用（总设计 §3 非目标），**SQLite 是唯一目标库**；初稿"Server/Multi-user → PostgreSQL"的双库支持从 V2 交付中移除（云端/多用户本就是非目标）。

保留的代码卫生约束：

- SQL 保持可移植子集，不依赖 SQLite 专属方言特性；
- 抽象层保留为**代码卫生**而非交付目标：

```ts
Repository        // 业务层唯一入口（§71）
    ↓
Database Adapter  // 目前只有 SQLite 实现
```

远期若做 LAN 部署再评估 PostgreSQL，届时以新增 Adapter 方式进入，不改动 Repository 层。

---

# 71. Repository Layer

不要让 Prompt Compiler 直接执行 SQL。

例如：

```ts
interface ChatRepository {
  getChat(id: string): Promise<Chat>
  getActiveBranch(id: string): Promise<Branch>
  getMessageChain(leafId: string): Promise<Message[]>
}
```

Worldbook：

```ts
interface WorldbookRepository {
  getWorldbook(id: string): Promise<Worldbook>
  getEntries(id: string): Promise<WorldbookEntry[]>
  getRuntimeState(chatId: string): Promise<WorldbookRuntimeState[]>
}
```

Snapshot：

```ts
interface PromptSnapshotRepository {
  create(snapshot: PromptSnapshot): Promise<void>
  get(id: string): Promise<PromptSnapshot>
}
```

---

# 72. Transaction Boundary

推荐 Runtime Transaction：

```text
User Action
    ↓
Application Service
    ↓
Transaction
    ├── mutate Message / Runtime State
    ├── create Run
    ├── compile
    ├── create Snapshot
    └── create Event
    ↓
Commit
```

Provider API 请求不应该长时间占用数据库事务。

因此实际生成流程推荐：

```text
Transaction A
    create Run
    compile
    create Snapshot
    commit

Provider Request
    ↓

Transaction B
    save Generation
    save Message
    update Run
    update Runtime State
    emit Event
    commit
```

---

# 73. Generation 与 Message 分离

不要把模型输出直接写入 Message 后就结束。

正确流程：

```text
Generation
    ↓
validation
    ↓
Message
```

因为模型输出可能：

```text
failed
partial
tool call
invalid
cancelled
retry
```

Generation 是：

```text
Provider Execution
```

Message 是：

```text
Chat State
```

二者不是同一个概念。

---

# 74. Partial Generation

Streaming 时：

```text
Generation
status = running
```

不断更新：

```text
partial_output
```

最终：

```text
completed
```

只有经过 Runtime 接受后：

```text
Message
```

才成为正式聊天历史。

---

# 75. Auditability

任何影响 Prompt 的重要状态变化都应该能够追溯。

至少可以追踪：

```text
Character Version
Persona Version
Preset Version

Worldbook Entry Version
Worldbook Activation

Summary Checkpoint

Message Chain
Memory Selection

Agent Run
Workflow Run

Prompt Snapshot

Provider Generation
```

最终形成：

```text
Message
   ↓
Run
   ↓
Prompt Snapshot
   ↓
Dependencies
   ↓
Assets / Runtime State
```

---

# 76. Debug 查询链

用户在 Inspector 点击：

```text
Why did the model see this?
```

系统可以：

```text
Generation
    ↓
Prompt Snapshot
    ↓
Prompt Segment
    ↓
Segment Source
    ↓
Dependency
    ↓
Asset / Runtime State
```

例如：

```text
Prompt Segment
worldbook:book1:entry:183

       ↓

Worldbook Entry #183

       ↓

Activation #9201

       ↓

matched keyword = "黑塔"

       ↓

source message = H102
```

---

# 77. Data Migration

数据库 Schema 必须带：

```text
schema_version
```

## schema_metadata

```sql
CREATE TABLE schema_metadata (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);
```

例如：

```text
schema_version = 17
```

Migration：

```text
v1
 ↓
v2
 ↓
v3
 ↓
...
 ↓
v17
```

不能直接假设：

```text
latest schema
```

---

# 78. Migration 原则

Migration 必须：

1. 可重复检测
2. 原子执行
3. 可记录
4. 失败可恢复
5. 不静默丢数据

推荐：

```sql
CREATE TABLE migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    checksum        TEXT NOT NULL,
    applied_at      TIMESTAMPTZ NOT NULL
);
```

---

# 79. Data Portability

用户的数据必须可以导出。

建议最终提供：

```text
WhisperTavern Archive
```

结构：

```text
archive/
├── manifest.json
│
├── characters/
├── personas/
├── presets/
├── worldbooks/
├── chats/
├── memories/
├── agents/
├── workflows/
│
├── snapshots/
│
└── assets/
```

---

# 80. Export 原则

导出 Chat 时：

```text
Chat
+
Character Version
+
Persona Version
+
Preset Version
+
Worldbook Entries
+
Summary
+
Memory References
```

应尽可能形成一个自包含 Archive。

这样：

```text
Export
    ↓
另一个 WhisperTavern
    ↓
Import
    ↓
Replay
```

成为可能。

---

# 81. 最小 MVP 数据库（P0）

【2026-09 修订】按总设计路线图重映射——P0 第一天就要 Compiler + Snapshot + Provider（总设计 §36），数据库底线随之调整：

```text
schema_metadata / migrations

users

characters + character_versions
personas + persona_versions
presets + preset_versions

chats / messages / chat_branches

runs                          ← 每次聊天生成一条（agent/workflow 字段留空）
prompt_snapshots + prompt_snapshot_dependencies
providers / models / generations
```

P0 暂不实现（概念从第一天预留，建表随阶段推进，见 §82）：

```text
worldbooks / worldbook_entries / worldbook_runtime_entries / worldbook_activations
cache_runtime_states / cache_checkpoints / cache_invalidations
macros / replay_sessions
summary_blocks / memories
agents / agent_runtime_states / workflows / workflow_runs / workflow_step_runs
tool_calls / artifacts
roleplay_states / story_threads / roleplay_snapshots   ← Roleplay Runtime（P4，§29.1–29.3）
events / plugins / plugin_states / import_jobs / export_jobs
```

---

# 82. 推荐实现顺序

【2026-09 修订】初稿六阶段把 Prompt Compiler 排在 Phase 5、Provider 排在 Phase 6，与总设计路线图（P0 即含 Compiler + Snapshot + Adapter）冲突，已重映射到 P0–P5：

## P0 — Core Runtime（初稿 Phase 1 + 6 + 快照）

```text
users / characters(+v) / personas(+v) / presets(+v)
chats / messages / chat_branches
runs / prompt_snapshots(+dependencies) / providers / models / generations
schema_metadata / migrations
```

完成：

```text
基础聊天
Branch / Swipe
版本绑定
快照与依赖
Token 计量
```

---

## P1/P2 — ST 兼容 + 缓存引擎（初稿 Phase 2）

```text
worldbooks / worldbook_entries(+versions) / worldbook_runtime_entries / worldbook_activations
cache_runtime_states / cache_checkpoints / cache_invalidations
macros / replay_sessions
```

完成：

```text
Activation / Sticky / Cooldown / Recursive / Group
Cache Lifecycle
失效审计
确定性 Replay
```

---

## P3 — Agent Runtime（初稿 Phase 4）

```text
agents(+versions) / agent_runtime_states
workflows / workflow_runs / workflow_step_runs
attempts / step_runs / execution_operations       ← 裁决 C5 统一执行层级（§34.1–34.3）
tool_calls / artifacts
```

完成：

```text
Agent
Workflow
Tool
Resume
Retry
四层执行层级（Run / Attempt / StepRun / Operation）
```

---

## P4 — Memory + Workflow + 群聊 + Roleplay（初稿 Phase 3 + 扩展）

```text
summary_blocks / memories(+versions) / timeline_events
documents / chunks（Data Bank + 向量索引）
chat_members
roleplay_states / story_threads / roleplay_snapshots   ← Roleplay Runtime（§29.1–29.3，裁决 R1–R5）
```

完成：

```text
Summary Checkpoint
长期记忆
RAG
群聊命名空间
Roleplay Fast 档（单调用：角色连续性 / Behavior Director 规则 / Story Thread / Expression History）
```

---

## P5 — Plugin + 生态 + Roleplay Deep（初稿散项）

```text
roleplay 深加工          ← Roleplay Deep 档：LLM Behavior Director / Critic / Quality Gate / Benchmark / Inspector
```

```text
events（事件持久化）
plugins / plugin_states
import_jobs / export_jobs
```

完成：

```text
插件沙箱状态
导入导出作业
```

---

# 83. 最重要的架构规则

整个数据库设计必须遵守以下规则：

### Rule 1

```text
Asset ≠ Runtime State
```

---

### Rule 2

```text
Runtime State ≠ Prompt Snapshot
```

---

### Rule 3

```text
Semantic Placement ≠ Cache Placement
```

---

### Rule 4

```text
Cache Lifecycle ≠ Physical Serialization Order
```

---

### Rule 5

```text
Message ≠ Generation
```

---

### Rule 6

```text
Summary ≠ Mutable String
```

Summary 应优先作为：

```text
Frozen Checkpoint
```

---

### Rule 7

```text
Agent ≠ Prompt
```

Agent 是 Runtime Entity。

---

### Rule 8

```text
Workflow ≠ Hardcoded Pipeline
```

Workflow 使用 DAG。

---

### Rule 9

```text
Prompt Snapshot = Immutable Evidence
```

---

### Rule 10

```text
Prompt Compiler = Pure Consumer
```

Compiler 读取：

```text
Database / Runtime State
```

产生：

```text
Prompt IR
CachePlan
Serialized Prompt
Snapshot
Diagnostics
```

但不直接修改业务状态。

---

# 84. 最终 Runtime 数据流

完整系统：

```text
                    User
                     │
                     ▼
                  Chat UI
                     │
                     ▼
              Application Runtime
                     │
          ┌──────────┴──────────┐
          │                     │
          ▼                     ▼
      Message DB          Agent Runtime
          │                     │
          │              Workflow / Tools
          │                     │
          └──────────┬──────────┘
                     ▼
              Context Resolver
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
    Character     Worldbook     Memory
    Version       Runtime       Summary
        │            │            │
        └────────────┼────────────┘
                     ▼
              Prompt Compiler
                     │
             ┌───────┴────────┐
             ▼                ▼
          Prompt IR       CachePlan
             │                │
             └───────┬────────┘
                     ▼
              Prompt Snapshot
                     │
                     ▼
              Provider Adapter
                     │
                     ▼
                  Model
                     │
                     ▼
                Generation
                     │
                     ▼
                  Message
                     │
                     ▼
               Runtime State
```

---

# 85. 最终核心模型

如果把整个数据库压缩成一句话：

```text
WhisperTavern V2 Database
=
Versioned Assets
+
Graph-based Chat State
+
Runtime State
+
Agent Execution State
+
Immutable Prompt Evidence
```

其中最重要的不是表的数量，而是**状态之间的边界**：

```text
              ┌──────────────┐
              │    Asset     │
              └──────┬───────┘
                     │ version
                     ▼
              ┌──────────────┐
              │Runtime State │
              └──────┬───────┘
                     │ compile
                     ▼
              ┌──────────────┐
              │ Prompt IR    │
              └──────┬───────┘
                     │ serialize
                     ▼
              ┌──────────────┐
              │   Snapshot   │
              └──────┬───────┘
                     │ provider
                     ▼
              ┌──────────────┐
              │ Generation   │
              └──────┬───────┘
                     │ accept
                     ▼
              ┌──────────────┐
              │   Message    │
              └──────────────┘
```

这个边界是 V2 后续实现 **Prompt Inspector、Cache Simulator、Replay、Agent Resume、Branch、Worldbook Cache、Compatibility Mode** 的基础。

---

# 86. 实现验收标准

`database-schema.md` 完成后，数据库层至少必须能够回答以下问题：

### Chat

```text
当前 Chat 是哪个 Character？
使用哪个 Character Version？
当前 Persona / Preset 是哪个版本？
当前 Branch 是哪个？
当前有效 Message Chain 是什么？
```

### Worldbook

```text
这个 Entry 当前是否激活？
为什么激活？
什么时候激活？
当前 sticky/cooldown 状态？
当前 cacheState？
physicalOrder？
```

### Agent

```text
哪个 Agent 在运行？
属于哪个 Workflow？
当前 Step？
第几次 Attempt？
是否可以 Resume？
```

### Prompt

```text
这一轮最终 Prompt 是什么？
Prompt IR 是什么？
CachePlan 是什么？
哪些 Segment 发生了变化？
Cache 为什么断？
使用了哪些 Asset Version？
```

### Generation

```text
用了哪个 Provider？
哪个 Model？
对应哪个 Snapshot？
输入 Token？
输出 Token？
缓存 Token？
为什么失败？
```

### Replay

```text
能否使用历史 Snapshot：
    + Compiler Version
    + Runtime Inputs
    + Worldbook State
    + Memory State
    + Branch State
    + Random Seed
    + Frozen Time

重新得到同一个 Prompt？
```

如果这些问题数据库都能可靠回答，则数据库层基本达到了 V2 的架构要求。