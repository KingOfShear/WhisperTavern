import { sha256Hex } from '../util/id'

/**
 * 嵌入式 SQL 迁移(database-schema §77/§78)。
 *
 * 迁移器原则(§78):可重复检测(checksum)/ 原子执行(事务)/ 可记录(migrations 表)
 * / 失败可恢复(回滚 + 阻止启动)/ 不静默丢数据。开发期自动应用;用户侧流程
 * (检测 → 备份 → 迁移 → integrity check → 失败回滚阻止启动)见 migrate.ts。
 */

export interface Migration {
  version: number
  name: string
  sql: string
  checksum: string
}

/** v1:P0 全部建表(单迁移;表结构 = db/schema.ts 的 Drizzle 定义) */
const V1_INITIAL = /* sql */ `
CREATE TABLE chats (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT,
    title               TEXT,
    character_id        TEXT,
    character_version   INTEGER,
    persona_id          TEXT,
    persona_version     INTEGER,
    preset_id           TEXT,
    preset_version      INTEGER,
    active_branch_id    TEXT,
    model_provider      TEXT,
    model_name          TEXT,
    settings            TEXT NOT NULL DEFAULT '{}',
    runtime_state       TEXT NOT NULL DEFAULT '{}',
    message_sequence    INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);

CREATE TABLE messages (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT NOT NULL REFERENCES chats(id),
    parent_message_id   TEXT REFERENCES messages(id),
    sequence            INTEGER NOT NULL,
    role                TEXT NOT NULL,
    author_type         TEXT,
    author_id           TEXT,
    content             TEXT NOT NULL,
    name                TEXT,
    variant_group_id    TEXT,
    variant_index       INTEGER,
    metadata            TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);

CREATE INDEX idx_messages_chat_sequence ON messages(chat_id, sequence);
CREATE INDEX idx_messages_variant_group ON messages(variant_group_id);

CREATE TABLE chat_branches (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT NOT NULL REFERENCES chats(id),
    parent_branch_id    TEXT REFERENCES chat_branches(id),
    root_message_id     TEXT REFERENCES messages(id),
    leaf_message_id     TEXT REFERENCES messages(id),
    fork_message_id     TEXT REFERENCES messages(id),
    seed_length         INTEGER NOT NULL DEFAULT 0,
    is_seeded           INTEGER NOT NULL DEFAULT 0,
    name                TEXT,
    is_active           INTEGER NOT NULL DEFAULT 0,
    metadata            TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE providers (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT,
    name                TEXT NOT NULL,
    type                TEXT NOT NULL,
    config              TEXT NOT NULL DEFAULT '{}',
    capabilities        TEXT NOT NULL DEFAULT '{}',
    enabled             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE generations (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    snapshot_id         TEXT NOT NULL,
    provider_id         TEXT REFERENCES providers(id),
    model_id            TEXT,
    request             TEXT NOT NULL,
    response            TEXT,
    finish_reason       TEXT,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cached_tokens       INTEGER,
    usage_source        TEXT,
    latency_ms          INTEGER,
    status              TEXT NOT NULL,
    error               TEXT,
    created_at          TEXT NOT NULL
);

CREATE INDEX idx_generations_run ON generations(run_id);

CREATE TABLE events (
    id                  TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL,
    durability          TEXT NOT NULL,
    aggregate_type      TEXT,
    aggregate_id        TEXT,
    run_id              TEXT,
    payload             TEXT NOT NULL DEFAULT '{}',
    sequence            INTEGER,
    created_at          TEXT NOT NULL
);

CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_run ON events(run_id);
`

// §152 P0 挂账补齐(S8):资产注册表(database-schema §6/§8/§10/§12;混合存储口径——
// .dgcard/.dgworld/.dgpreset 文件为事实源,本表为注册索引,决策 11;版本快照表随建,
// 创建即写 version 1 快照,编辑递增随 P1)
const V3_ASSETS = /* sql */ `
CREATE TABLE characters (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT,
    name                TEXT NOT NULL,
    avatar              TEXT,
    description         TEXT,
    personality         TEXT,
    scenario            TEXT,
    first_message       TEXT,
    example_dialogues   TEXT,
    metadata            TEXT NOT NULL DEFAULT '{}',
    source_format       TEXT,
    source_data         TEXT NOT NULL DEFAULT '{}',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);

CREATE TABLE character_versions (
    id                  TEXT PRIMARY KEY,
    character_id        TEXT NOT NULL REFERENCES characters(id),
    version             INTEGER NOT NULL,
    snapshot            TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    UNIQUE(character_id, version)
);

CREATE TABLE personas (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT,
    name            TEXT NOT NULL,
    description     TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}',
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT
);

CREATE TABLE persona_versions (
    id              TEXT PRIMARY KEY,
    persona_id      TEXT NOT NULL REFERENCES personas(id),
    version         INTEGER NOT NULL,
    snapshot        TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(persona_id, version)
);

CREATE TABLE presets (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT,
    name                TEXT NOT NULL,
    description         TEXT,
    compiler_mode       TEXT NOT NULL DEFAULT 'compatibility',
    config              TEXT NOT NULL DEFAULT '{}',
    source_format       TEXT,
    source_data         TEXT NOT NULL DEFAULT '{}',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);

CREATE TABLE preset_versions (
    id              TEXT PRIMARY KEY,
    preset_id       TEXT NOT NULL REFERENCES presets(id),
    version         INTEGER NOT NULL,
    snapshot        TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(preset_id, version)
);

CREATE TABLE worldbooks (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT,
    name                TEXT NOT NULL,
    description         TEXT,
    scan_depth          INTEGER,
    recursive           INTEGER NOT NULL DEFAULT 0,
    metadata            TEXT NOT NULL DEFAULT '{}',
    source_format       TEXT,
    source_data         TEXT NOT NULL DEFAULT '{}',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);
`

const V2_RUNS_SNAPSHOTS = /* sql */ `
CREATE TABLE runs (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT NOT NULL REFERENCES chats(id),
    status              TEXT NOT NULL,
    attempt             INTEGER NOT NULL DEFAULT 1,
    provider            TEXT,
    model               TEXT,
    snapshot_id         TEXT,
    message_id          TEXT,
    error               TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX idx_runs_chat ON runs(chat_id);

CREATE TABLE prompt_snapshots (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT NOT NULL REFERENCES chats(id),
    run_id              TEXT,
    message_id          TEXT,
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    compiler_version    TEXT NOT NULL,
    ir                  TEXT NOT NULL,
    cache_plan          TEXT NOT NULL,
    serialized          TEXT NOT NULL,
    hashes              TEXT NOT NULL,
    diagnostics         TEXT NOT NULL,
    authority_fingerprint TEXT,
    created_at          TEXT NOT NULL
);
`

/**
 * v4 世界书条目与条目版本(database-schema §13/§14)。
 * 存储口径:`.dgworld` 文件是事实源(决策 11 混合存储),本组表是**编译/激活读模型**
 * ——编译关键语义列按 §69 自洽要求显式成列,不藏进 source_data。
 */
const V4_WORLDBOOK_ENTRIES = /* sql */ `
CREATE TABLE worldbook_entries (
    id                      TEXT PRIMARY KEY,
    worldbook_id            TEXT NOT NULL REFERENCES worldbooks(id),

    entry_key               TEXT,           -- ST 数值 uid 原样保留(字符串;无 uid 的老条目 = NULL)
                                            -- 往返映射键,technical-plan §5.3
    name                    TEXT,           -- 条目标题(ST comment 语义正名)

    content                 TEXT NOT NULL,
    enabled                 INTEGER NOT NULL DEFAULT 1,

    activation_mode         TEXT NOT NULL DEFAULT 'selective',
    priority                INTEGER NOT NULL DEFAULT 0,
    position                INTEGER NOT NULL DEFAULT 0,
    insertion_order         INTEGER NOT NULL DEFAULT 0,
    role                    TEXT NOT NULL DEFAULT 'system',

    keywords_primary        TEXT NOT NULL DEFAULT '[]',
    keywords_secondary      TEXT NOT NULL DEFAULT '[]',
    keyword_logic           TEXT NOT NULL DEFAULT 'andAny',

    -- 三态:NULL = 跟随书级 scan(§5.3),非 NULL = 条目级覆盖
    case_sensitive          INTEGER,
    whole_word              INTEGER,
    scan_depth              INTEGER,

    match_scope             TEXT NOT NULL DEFAULT '[]',
    triggers                TEXT NOT NULL DEFAULT '[]',

    recursive               INTEGER NOT NULL DEFAULT 0,
    exclude_recursion       INTEGER NOT NULL DEFAULT 0,
    prevent_recursion       INTEGER NOT NULL DEFAULT 0,
    delay_until_recursion   INTEGER NOT NULL DEFAULT 0,

    sticky_rounds           INTEGER NOT NULL DEFAULT 0,
    cooldown                INTEGER NOT NULL DEFAULT 0,
    delay                   INTEGER NOT NULL DEFAULT 0,

    probability             REAL NOT NULL DEFAULT 100,

    group_id                TEXT,
    group_override          INTEGER NOT NULL DEFAULT 0,
    group_weight            REAL,
    use_group_scoring       INTEGER NOT NULL DEFAULT 1,

    ignore_budget           INTEGER NOT NULL DEFAULT 0,
    outlet_name             TEXT,
    character_filter        TEXT NOT NULL DEFAULT '{}',

    injection_position      TEXT,
    injection_depth         INTEGER,

    metadata                TEXT NOT NULL DEFAULT '{}',
    source_data             TEXT NOT NULL DEFAULT '{}',   -- = 资产文件 entry.compat 的 DB 镜像

    version                 INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    deleted_at              TEXT
);

CREATE INDEX idx_worldbook_entries_book ON worldbook_entries(worldbook_id);

CREATE TABLE worldbook_entry_versions (
    id                  TEXT PRIMARY KEY,
    entry_id            TEXT NOT NULL REFERENCES worldbook_entries(id),
    version             INTEGER NOT NULL,
    snapshot            TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    UNIQUE(entry_id, version)
);
`

/**
 * v5 世界书运行时状态 + 激活审计(database-schema §15/§16,WP1.2 Activation Engine 有状态化)。
 * 口径:worldbook_entries 是资产读模型(§13);本组表存 Runtime State(sticky/cooldown/delay/
 * cache lifecycle,§27/§28 明确"sticky 属 Runtime State 而非 Prompt Segment"）。
 * cache_state 取值:unseen|fresh|stable|stale|retired(§29);P2 前恒 unseen(毕业/退休归 WP2.2)。
 */
const V5_WORLDBOOK_RUNTIME = /* sql */ `
CREATE TABLE worldbook_runtime_entries (
    id                      TEXT PRIMARY KEY,

    chat_id                 TEXT NOT NULL,
    worldbook_entry_id      TEXT NOT NULL,

    cache_state             TEXT NOT NULL DEFAULT 'unseen',
    physical_order          INTEGER,

    last_activated_at       TEXT,
    last_activation_seq     INTEGER,

    sticky_until_seq        INTEGER,
    cooldown_until_seq      INTEGER,
    delay_until_seq         INTEGER,

    activation_count        INTEGER NOT NULL DEFAULT 0,

    content_hash            TEXT,

    updated_at              TEXT NOT NULL,

    UNIQUE(chat_id, worldbook_entry_id)
);

CREATE TABLE worldbook_activations (
    id                      TEXT PRIMARY KEY,

    chat_id                 TEXT NOT NULL,
    run_id                  TEXT,

    worldbook_entry_id      TEXT NOT NULL,

    activated               INTEGER NOT NULL,

    reason                  TEXT,
    matched_keywords        TEXT NOT NULL DEFAULT '[]',
    source_message_ids      TEXT NOT NULL DEFAULT '[]',

    score                   REAL,

    activation_seq          INTEGER NOT NULL,

    created_at              TEXT NOT NULL
);

CREATE INDEX idx_wb_runtime_chat ON worldbook_runtime_entries(chat_id);
CREATE INDEX idx_wb_activations_chat ON worldbook_activations(chat_id);
`

/**
 * v6 chat↔worldbook 绑定(WP1.2 激活层接线前提;database-schema §18 chat_worldbooks)。
 * 主键 (chat_id, worldbook_id);scan_depth_override / recursive_override = NULL 时
 * 跟随 worldbooks 表默认。条目级运行时状态不在此(归 worldbook_runtime_entries §15)。
 */
const V6_CHAT_WORLDBOOKS = /* sql */ `
CREATE TABLE chat_worldbooks (
    chat_id                 TEXT NOT NULL,
    worldbook_id            TEXT NOT NULL,

    order_index             INTEGER NOT NULL DEFAULT 0,
    scan_depth_override     INTEGER,
    recursive_override      INTEGER,

    created_at              TEXT NOT NULL,

    PRIMARY KEY (chat_id, worldbook_id)
);

CREATE INDEX idx_chat_worldbooks_chat ON chat_worldbooks(chat_id);
`

/**
 * v7(S17/WP2.2):worldbook_runtime_entries 增 first_seen_msg——首次注入轮序
 * (worldbook-cache-design §4 WBCacheEntry;单调不变量,lastActivationSeq 是最近
 * 激活值会被刷新,不可近似)。
 */
const V7_CACHE_FIRST_SEEN = /* sql */ `
ALTER TABLE worldbook_runtime_entries ADD COLUMN first_seen_msg INTEGER;
`

/**
 * v8(P3/WP3.1a)执行层持久化底座(agent-runtime-spec §4.1–4.6 / §96 / §97 / §161;
 * database-schema §27–§29 / §34.1–34.3 / §35 / §36–§36.2)。
 *
 * 覆盖 §161「必须持久化」清单的 P3 子集:Run(扩展)/ Step Run / Agent Runtime State /
 * Tool Call / Checkpoint / Approval(Workflow Runtime State 归 S25 的 v9)。
 *
 * 口径:
 * - runs 的执行列在此追加——该表 P0 注释即已声明"agent 执行列随 P3 扩展",
 *   属既定计划内的实现,非新架构决策。`attempt` 列降为**聚合 attemptNo**,
 *   Attempt 实体归独立表(R-P3-3 / 裁决 C3)。
 * - 四层执行层级切**独立表**(attempts / step_runs / execution_operations):
 *   Run 定义"做什么"、Attempt"这次怎么做"、Step Run"哪一步做了一次"、
 *   Operation"底层调用发生了什么"。Retry 一律新建记录,历史不可变(§4.1.1)。
 * - `agent_runtime_states.status` 是 **AgentStatus 聚合态**,不与 ExecutionStatus 合并(§4.3)。
 */
const V8_P3_EXECUTION = /* sql */ `
-- §27 Agent Definition(Runtime Entity,不只是"一段 Prompt")
CREATE TABLE agents (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    agent_type          TEXT NOT NULL,
    instructions        TEXT,
    config              TEXT NOT NULL DEFAULT '{}',
    tool_policy         TEXT NOT NULL DEFAULT '{}',
    memory_policy       TEXT NOT NULL DEFAULT '{}',
    context_policy      TEXT NOT NULL DEFAULT '{}',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);

-- §28 Agent Version(Definition 版本快照;§163 热重载钉住基准)
CREATE TABLE agent_versions (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    version             INTEGER NOT NULL,
    snapshot            TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    UNIQUE(agent_id, version)
);

-- §29 Agent Runtime State(= Agent Instance,§7);status = AgentStatus 聚合态
CREATE TABLE agent_runtime_states (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    agent_version       INTEGER,
    state               TEXT NOT NULL DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'idle',
    current_run_id      TEXT,
    last_heartbeat_at   TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE(chat_id, agent_id)
);

CREATE INDEX idx_agent_runtime_states_chat ON agent_runtime_states(chat_id);

-- §34.1 Attempt(完整执行环境);历史不可变,Retry 建新 attempt_no
CREATE TABLE attempts (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL REFERENCES runs(id),
    attempt_no          INTEGER NOT NULL,
    status              TEXT NOT NULL,
    parent_attempt_id   TEXT,
    reason              TEXT,
    runtime_snapshot    TEXT NOT NULL DEFAULT '{}',
    checkpoint_id       TEXT,
    provider            TEXT,
    model               TEXT,
    prompt_snapshot_id  TEXT,
    usage               TEXT,
    error               TEXT,
    started_at          TEXT NOT NULL,
    completed_at        TEXT,
    timeout_at          TEXT,
    UNIQUE(run_id, attempt_no)
);

CREATE INDEX idx_attempts_run ON attempts(run_id);

-- §34.2 Step Run(agent 级;Key 只能是 step_run_id,绝不能是 step_id)
CREATE TABLE step_runs (
    id                  TEXT PRIMARY KEY,
    attempt_id          TEXT NOT NULL REFERENCES attempts(id),
    step_id             TEXT NOT NULL,
    step_revision       INTEGER NOT NULL,
    run_no              INTEGER NOT NULL,
    status              TEXT NOT NULL,
    input               TEXT,
    output              TEXT,
    retry_of            TEXT,
    checkpoint_id       TEXT,
    prompt_snapshot_id  TEXT,
    usage               TEXT,
    error               TEXT,
    started_at          TEXT NOT NULL,
    completed_at        TEXT,
    UNIQUE(attempt_id, step_id, run_no)
);

CREATE INDEX idx_step_runs_attempt ON step_runs(attempt_id);

-- §34.3 Execution Operation(设施级重试明细;默认不记录)
CREATE TABLE execution_operations (
    id                  TEXT PRIMARY KEY,
    step_run_id         TEXT,
    type                TEXT NOT NULL,
    attempt_no          INTEGER NOT NULL,
    status              TEXT NOT NULL,
    latency_ms          INTEGER,
    error               TEXT,
    started_at          TEXT NOT NULL,
    completed_at        TEXT
);

CREATE INDEX idx_execution_operations_step ON execution_operations(step_run_id);

-- §35 Tool Call
CREATE TABLE tool_calls (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    tool_name           TEXT NOT NULL,
    arguments           TEXT NOT NULL DEFAULT '{}',
    result              TEXT,
    status              TEXT NOT NULL,
    error               TEXT,
    started_at          TEXT,
    completed_at        TEXT
);

CREATE INDEX idx_tool_calls_run ON tool_calls(run_id);

-- §36 Artifact(frozen = 内容不再变化,但不改变缓存分区,裁决 C2)
CREATE TABLE artifacts (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT,
    run_id              TEXT,
    type                TEXT NOT NULL,
    name                TEXT,
    content             TEXT,
    data                TEXT,
    content_hash        TEXT,
    frozen              INTEGER NOT NULL DEFAULT 0,
    metadata            TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL
);

CREATE INDEX idx_artifacts_run ON artifacts(run_id);

-- §36.1 Runtime Checkpoint(Resume 恢复点;≠ cache_checkpoints)
CREATE TABLE runtime_checkpoints (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    turn_index          INTEGER NOT NULL,
    reason              TEXT NOT NULL,
    state_hash          TEXT NOT NULL,
    agent_state         TEXT NOT NULL DEFAULT '{}',
    variables           TEXT NOT NULL DEFAULT '{}',
    tool_state          TEXT NOT NULL DEFAULT '{}',
    context_state       TEXT NOT NULL DEFAULT '{}',
    prompt_snapshot_id  TEXT,
    created_at          TEXT NOT NULL
);

CREATE INDEX idx_runtime_checkpoints_run ON runtime_checkpoints(run_id);

-- §36.2 Approval(Waiting 必须持久化;status 表配对进度,结论在 outcome 四值)
CREATE TABLE approvals (
    id                      TEXT PRIMARY KEY,
    run_id                  TEXT NOT NULL,
    tool_call_id            TEXT,
    action                  TEXT NOT NULL,
    description             TEXT,
    risk                    TEXT NOT NULL,
    requested_permissions   TEXT NOT NULL DEFAULT '[]',
    status                  TEXT NOT NULL,
    outcome                 TEXT,
    reason                  TEXT,
    policy_at_request       TEXT,
    decided_at              TEXT,
    expires_at              TEXT,
    created_at              TEXT NOT NULL
);

CREATE INDEX idx_approvals_run ON approvals(run_id);

-- §34 runs 执行列扩展(P0 注释已声明"agent 执行列随 P3 扩展")
-- attempt 列已存在,自本版降为聚合 attemptNo(实体归 attempts 表)
ALTER TABLE runs ADD COLUMN agent_id TEXT;
ALTER TABLE runs ADD COLUMN agent_version INTEGER;
ALTER TABLE runs ADD COLUMN workflow_run_id TEXT;
ALTER TABLE runs ADD COLUMN workflow_step_run_id TEXT;
ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE runs ADD COLUMN origin_run_id TEXT;
ALTER TABLE runs ADD COLUMN trigger_message_id TEXT;
ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'live';
ALTER TABLE runs ADD COLUMN input_state TEXT NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN output_state TEXT;
ALTER TABLE runs ADD COLUMN budget_usage TEXT;
ALTER TABLE runs ADD COLUMN dependency_manifest TEXT;
ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE runs ADD COLUMN completed_at TEXT;

CREATE INDEX idx_runs_status ON runs(status);
`

/**
 * v9(S23/WP3.1b)`runs.status` 词汇归一:把 P0–P2 的 `streaming` / `completed`
 * 回填为 §4.3 `ExecutionStatus` 口径的 `running` / `succeeded`。
 *
 * 背景:同一列曾有两套词——P0 生成路径写 `streaming`/`completed`,而 agent-runtime-spec
 * §4.3 的 ExecutionStatus 用 `running`/`succeeded`。S22 已在读侧给出别名
 * (`LEGACY_EXECUTION_STATUS_ALIAS`),本版把库内旧值一次性归位,使"库与代码一致"
 * 不再依赖读侧兜底(p3-plan §13 指定的 S23 首个动作)。
 *
 * 只动 `runs`;**`generations.status` 的 `completed` 属 §25 GenerationState,另一套词汇**。
 */
const V9_RUN_STATUS_VOCABULARY = /* sql */ `
UPDATE runs SET status = 'running'   WHERE status = 'streaming';
UPDATE runs SET status = 'succeeded' WHERE status = 'completed';
`

/**
 * v10(S29/WP4.1)Memory 持久化底座:p4-plan §4 任务 2 的八项,
 * 逐表镜像 database-schema §23/§25/§25.1/§25.2/§25.3/§25.4/§26。
 *
 * 设计口径:①**只建普通表 + FTS5 虚拟表**,不建 sqlite-vec `vec0` 虚拟表
 * (memory-runtime-spec §3.2 / database-schema §25.5)——vec0 是 loadable 扩展,
 * 版本化迁移必须环境无关(无扩展 env 迁移会炸),语义检索走 embedding BLOB 余弦扫描,
 * vec0 仅为可用时的加速面(S30);②FTS5(§25.1/§25.4)随表同批,memories 用
 * insert/delete/update 三触发器,chunks 因 append-only 只用 insert/delete;
 * ③软删除(deleted_at)不触发 FTS 物理清理,靠定期 cleanup 语句(memory-runtime-spec §3.1)。
 */
const V10_P4_MEMORY_TABLES = /* sql */ `
-- §23 Summary Block(追加式冻结块;R-P4-4)
CREATE TABLE summary_blocks (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT NOT NULL REFERENCES chats(id),
    sequence            INTEGER NOT NULL,
    content             TEXT NOT NULL,
    from_message_id     TEXT NOT NULL REFERENCES messages(id),
    to_message_id       TEXT NOT NULL REFERENCES messages(id),
    frozen              INTEGER NOT NULL DEFAULT 0,
    content_hash        TEXT NOT NULL,
    token_count         INTEGER,
    created_at          TEXT NOT NULL,
    UNIQUE(chat_id, sequence)
);

CREATE INDEX idx_summary_blocks_chat_seq ON summary_blocks(chat_id, sequence);

-- §25 Memories(Dossier 事实卡 + Summary 之外的全部长期记忆;embedding BLOB = float32)
CREATE TABLE memories (
    id                  TEXT PRIMARY KEY,

    owner_id            TEXT NOT NULL,
    chat_id             TEXT,

    type                TEXT NOT NULL,
    entity              TEXT,                    -- P4:Dossier 实体维度(type='fact' 时非空)

    content             TEXT NOT NULL,

    importance          REAL,
    confidence          REAL,

    source_message_ids  TEXT NOT NULL DEFAULT '[]',
    tags                TEXT NOT NULL DEFAULT '[]',

    metadata            TEXT NOT NULL DEFAULT '{}',
    content_hash        TEXT NOT NULL,

    embedding           BLOB,                    -- sqlite-vec 语义向量(float32 序列化,§25.5)

    version             INTEGER NOT NULL DEFAULT 1,

    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,

    deleted_at          TEXT
);

CREATE INDEX idx_memories_chat_type ON memories(chat_id, type) WHERE deleted_at IS NULL;
CREATE INDEX idx_memories_entity ON memories(entity) WHERE deleted_at IS NULL AND entity IS NOT NULL;

-- §25.1 FTS5 关键词兜底索引(memories_fts;只索 content)
CREATE VIRTUAL TABLE memories_fts USING fts5(
    memory_id      UNINDEXED,
    type           UNINDEXED,
    content_hash   UNINDEXED,
    content,
    tokenize='unicode61 remove_diacritics 2',
    prefix='3 4'
);

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

-- §26 Memory Version(版本化更新;memory.updated 事件同行)
CREATE TABLE memory_versions (
    id              TEXT PRIMARY KEY,
    memory_id       TEXT NOT NULL REFERENCES memories(id),
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,
    snapshot        TEXT NOT NULL DEFAULT '{}',
    content_hash    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(memory_id, version)
);

CREATE INDEX idx_memory_versions_memory ON memory_versions(memory_id, version);

-- §25.2 Timeline Events(Scribe 追加式事件流)
CREATE TABLE timeline_events (
    id                TEXT PRIMARY KEY,
    chat_id           TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    summary           TEXT NOT NULL,
    participants      TEXT NOT NULL DEFAULT '[]',
    location          TEXT,
    consequences      TEXT,
    source_message_id TEXT,
    importance        REAL,
    emotional_weight  REAL,
    created_at        TEXT NOT NULL
);

CREATE INDEX idx_timeline_events_chat ON timeline_events(chat_id, created_at);
CREATE INDEX idx_timeline_events_type ON timeline_events(chat_id, event_type);

-- §25.3 Documents — Data Bank 元数据
CREATE TABLE documents (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT,
    owner_id        TEXT NOT NULL,

    title           TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    source_uri      TEXT,

    mime_type       TEXT,
    file_size_bytes INTEGER,

    metadata        TEXT NOT NULL DEFAULT '{}',

    total_chunks    INTEGER DEFAULT 0,
    indexed_at      TEXT,

    created_at      TEXT NOT NULL,
    deleted_at      TEXT
);

CREATE INDEX idx_documents_chat ON documents(chat_id) WHERE deleted_at IS NULL;

-- §25.4 Chunks(append-only)+ FTS5(仅 insert/delete 触发器)
CREATE TABLE chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES documents(id),
    chat_id         TEXT,

    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,

    token_count     INTEGER,
    content_hash    TEXT NOT NULL,

    metadata        TEXT NOT NULL DEFAULT '{}',

    created_at      TEXT NOT NULL,
    deleted_at      TEXT
);

CREATE INDEX idx_chunks_document ON chunks(document_id) WHERE deleted_at IS NULL;

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    chunk_id        UNINDEXED,
    document_id     UNINDEXED,
    content_hash    UNINDEXED,
    content,
    tokenize='unicode61 remove_diacritics 2',
    prefix='3 4'
);

CREATE TRIGGER chunks_fts_after_insert AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(chunk_id, document_id, content_hash, content)
    VALUES (new.id, new.document_id, new.content_hash, new.content);
END;

CREATE TRIGGER chunks_fts_after_delete AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;
`

/**
 * v11(S33a/WP4.4):prompt_snapshots 增 character_id——per-(chat, character) 缓存命名空间的**键**。
 *
 * 为什么现在才加、为什么加在这张表(§26 群聊 / worldbook-cache-design §6)：
 * Provider Prompt Cache 的作用域是 **(chat, character)**——世界书缓存按 chat 共享
 * (内容寻址),但每个角色的 header 前缀天然不同(角色卡进 header,见
 * `generation/character.ts`),故各角色各自成链。此前快照行只记 chat_id,于是
 * "上一轮"只能按 chat 取,群聊里会拿 A 的第 N 轮去比 B 的第 N−1 轮——
 * 永久性的、无意义的 CacheBreak 报告。这就是本列存在要修的**具体缺陷**。
 *
 * 落点选择 = 快照行本身,而非新表(S17 三次修订已裁决"不建独立 chatCache 哈希表",
 * WBCacheEntry 落 worldbook_runtime_entries 按 (chat, entry) 一行)。
 * `database-schema` §44 的 cache_runtime_states 保持**未迁移**——本列即是命名空间键,
 * 快照表是唯一真相源,缓存链由它派生,不另立平行状态。
 *
 * 可空:单聊未绑定角色时为 NULL(= 沿用 chat 级语义,与 v11 之前行为一致——
 * 未绑定 chat 的快照查询逐字节/逐行不变)。为了让 `(chat_id, character_id)` 过滤
 * 走索引,建复合索引覆盖查询形态;`created_at` 作第三列使"同命名空间内最近一轮"
 * 的 orderBy desc + limit 1 成为纯索引扫描。
 */
const V11_SNAPSHOT_CHARACTER_NAMESPACE = /* sql */ `
ALTER TABLE prompt_snapshots ADD COLUMN character_id TEXT;

CREATE INDEX idx_prompt_snapshots_character
    ON prompt_snapshots(chat_id, character_id, created_at);
`

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'p0-initial',
    sql: V1_INITIAL,
    checksum: sha256Hex(V1_INITIAL),
  },
  {
    version: 2,
    name: 'p0-runs-snapshots',
    sql: V2_RUNS_SNAPSHOTS,
    checksum: sha256Hex(V2_RUNS_SNAPSHOTS),
  },
  {
    version: 3,
    name: 'p0-asset-registry',
    sql: V3_ASSETS,
    checksum: sha256Hex(V3_ASSETS),
  },
  {
    version: 4,
    name: 'p1-worldbook-entries',
    sql: V4_WORLDBOOK_ENTRIES,
    checksum: sha256Hex(V4_WORLDBOOK_ENTRIES),
  },
  {
    version: 5,
    name: 'p1-worldbook-runtime-state',
    sql: V5_WORLDBOOK_RUNTIME,
    checksum: sha256Hex(V5_WORLDBOOK_RUNTIME),
  },
  {
    version: 6,
    name: 'p1-chat-worldbook-binding',
    sql: V6_CHAT_WORLDBOOKS,
    checksum: sha256Hex(V6_CHAT_WORLDBOOKS),
  },
  {
    version: 7,
    name: 'p2-cache-first-seen-msg',
    sql: V7_CACHE_FIRST_SEEN,
    checksum: sha256Hex(V7_CACHE_FIRST_SEEN),
  },
  {
    version: 8,
    name: 'p3-execution-core',
    sql: V8_P3_EXECUTION,
    checksum: sha256Hex(V8_P3_EXECUTION),
  },
  {
    version: 9,
    name: 'p3-run-status-vocabulary',
    sql: V9_RUN_STATUS_VOCABULARY,
    checksum: sha256Hex(V9_RUN_STATUS_VOCABULARY),
  },
  {
    version: 10,
    name: 'p4-memory-tables',
    sql: V10_P4_MEMORY_TABLES,
    checksum: sha256Hex(V10_P4_MEMORY_TABLES),
  },
  {
    version: 11,
    name: 'p4-snapshot-character-namespace',
    sql: V11_SNAPSHOT_CHARACTER_NAMESPACE,
    checksum: sha256Hex(V11_SNAPSHOT_CHARACTER_NAMESPACE),
  },
]

/**
 * 当前(最新)迁移版本 = `MIGRATIONS` 末项的 version。
 *
 * 存在的理由:断言"已应用到最新"时**不许硬编码版本号**——加 v8 时同一类硬编码曾在
 * `migrate.test.ts` 与 `apps/server/src/e2e.test.ts` 各制造一次假失败(2026-09-26)。
 * 版本是可派生的,写死就是纪律 6 说的 magic number。架构守卫 **D4** 会拦。
 */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version
