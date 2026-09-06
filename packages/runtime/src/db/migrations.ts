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
]
