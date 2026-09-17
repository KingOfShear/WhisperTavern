import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * P0 表清单 —— database-schema P0 阶段清单的 Drizzle 投影(p0-plan S5 任务 2):
 * chats / messages / chat_branches(血缘位)/ providers / generations(承载 §52
 * token accounting + usage_source)/ events / schema_metadata / migrations。
 *
 * 映射约定:SQLite 无 TIMESTAMPTZ → TEXT 存 ISO-8601 UTC(契约 Timestamp);
 * JSONB → TEXT(JSON.stringify);UUID → TEXT。
 */

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  title: text('title'),
  characterId: text('character_id'),
  characterVersion: integer('character_version'),
  personaId: text('persona_id'),
  personaVersion: integer('persona_version'),
  presetId: text('preset_id'),
  presetVersion: integer('preset_version'),
  /** 活跃指针唯一来源:active_branch_id → chat_branches.leaf_message_id(§19 修订/§21) */
  activeBranchId: text('active_branch_id'),
  modelProvider: text('model_provider'),
  modelName: text('model_name'),
  settings: text('settings').notNull().default('{}'),
  runtimeState: text('runtime_state').notNull().default('{}'),
  messageSequence: integer('message_sequence').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  parentId: text('parent_message_id'),
  sequence: integer('sequence').notNull(),
  role: text('role').notNull(),
  authorType: text('author_type'),
  authorId: text('author_id'),
  content: text('content').notNull(),
  name: text('name'),
  /** swipe/edit 变体血缘(database-schema §22):兄弟 = 同 variant_group 的不同 index */
  variantGroupId: text('variant_group_id'),
  variantIndex: integer('variant_index'),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const chatBranches = sqliteTable('chat_branches', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  parentBranchId: text('parent_branch_id'),
  rootMessageId: text('root_message_id'),
  /** 活跃叶子:chats.active_branch_id 指到哪条分支,leaf 即树的活动端点(§21) */
  leafMessageId: text('leaf_message_id'),
  /** 血缘位(§38 决策 25):继承前缀 = 可复用缓存前缀 */
  forkMessageId: text('fork_message_id'),
  seedLength: integer('seed_length').notNull().default(0),
  isSeeded: integer('is_seeded', { mode: 'boolean' }).notNull().default(false),
  name: text('name'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  name: text('name').notNull(),
  type: text('type').notNull(),
  /** §37:密钥永不入库——config 只存 secret refs(指向 OS keychain,§41.1 支持多 key) */
  config: text('config').notNull().default('{}'),
  capabilities: text('capabilities').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** §51 Generation Record + §52 Token Accounting:usage 字段在此,usage_source 区分口径 */
export const generations = sqliteTable('generations', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  providerId: text('provider_id'),
  modelId: text('model_id'),
  request: text('request').notNull(),
  response: text('response'),
  finishReason: text('finish_reason'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedTokens: integer('cached_tokens'),
  /** §52/p0-plan S5:reported | estimated;estimated 不入缓存命中率分母(P2 指标) */
  usageSource: text('usage_source'),
  latencyMs: integer('latency_ms'),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
})

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  /** §5.4 分档:落表只有 durable / deferred-durable;live 仅内存广播 */
  durability: text('durability').notNull(),
  aggregateType: text('aggregate_type'),
  aggregateId: text('aggregate_id'),
  runId: text('run_id'),
  payload: text('payload').notNull().default('{}'),
  sequence: integer('sequence'),
  createdAt: text('created_at').notNull(),
})

export const schemaMetadata = sqliteTable('schema_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const migrations = sqliteTable('migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  checksum: text('checksum').notNull(),
  appliedAt: text('applied_at').notNull(),
})

/** §34 Run(P0 子集:conversation 面;agent 执行列随 P3 扩展) */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  status: text('status').notNull(),
  provider: text('provider'),
  model: text('model'),
  snapshotId: text('snapshot_id'),
  messageId: text('message_id'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** §39 Prompt Snapshot(不可变,§40:禁止 UPDATE) */
export const promptSnapshots = sqliteTable('prompt_snapshots', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  runId: text('run_id'),
  messageId: text('message_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  compilerVersion: text('compiler_version').notNull(),
  ir: text('ir').notNull(),
  cachePlan: text('cache_plan').notNull(),
  serialized: text('serialized').notNull(),
  hashes: text('hashes').notNull(),
  diagnostics: text('diagnostics').notNull(),
  authorityFingerprint: text('authority_fingerprint'),
  createdAt: text('created_at').notNull(),
})

// ===== 资产注册表(§152 P0;混合存储:文件为事实源,本表为注册索引,决策 11)=====

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  name: text('name').notNull(),
  avatar: text('avatar'),
  description: text('description'),
  personality: text('personality'),
  scenario: text('scenario'),
  firstMessage: text('first_message'),
  exampleDialogues: text('example_dialogues'),
  metadata: text('metadata').notNull().default('{}'),
  sourceFormat: text('source_format'),
  sourceData: text('source_data').notNull().default('{}'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const characterVersions = sqliteTable('character_versions', {
  id: text('id').primaryKey(),
  characterId: text('character_id').notNull(),
  version: integer('version').notNull(),
  snapshot: text('snapshot').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

export const personas = sqliteTable('personas', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  name: text('name').notNull(),
  description: text('description'),
  metadata: text('metadata').notNull().default('{}'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const personaVersions = sqliteTable('persona_versions', {
  id: text('id').primaryKey(),
  personaId: text('persona_id').notNull(),
  version: integer('version').notNull(),
  snapshot: text('snapshot').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

export const presets = sqliteTable('presets', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  name: text('name').notNull(),
  description: text('description'),
  compilerMode: text('compiler_mode').notNull().default('compatibility'),
  config: text('config').notNull().default('{}'),
  sourceFormat: text('source_format'),
  sourceData: text('source_data').notNull().default('{}'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

/**
 * 世界书条目(database-schema §13;migration v4)。
 * 口径:`.dgworld` 文件是事实源,本表是编译/激活读模型——语义列显式成列,
 * 不藏进 source_data(§69 自洽要求);sourceData = 文件 entry.compat 的 DB 镜像。
 */
export const worldbookEntries = sqliteTable('worldbook_entries', {
  id: text('id').primaryKey(),
  worldbookId: text('worldbook_id').notNull(),
  /** ST 数值 uid 原样保留(字符串)= 往返映射键(technical-plan §5.3);无 uid 的老条目 = null */
  entryKey: text('entry_key'),
  name: text('name'),
  content: text('content').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  activationMode: text('activation_mode').notNull().default('selective'),
  priority: integer('priority').notNull().default(0),
  position: integer('position').notNull().default(0),
  insertionOrder: integer('insertion_order').notNull().default(0),
  role: text('role').notNull().default('system'),
  keywordsPrimary: text('keywords_primary').notNull().default('[]'),
  keywordsSecondary: text('keywords_secondary').notNull().default('[]'),
  keywordLogic: text('keyword_logic').notNull().default('andAny'),
  /** 三态:null = 跟随书级 scan(§5.3),非 null = 条目级覆盖 */
  caseSensitive: integer('case_sensitive', { mode: 'boolean' }),
  wholeWord: integer('whole_word', { mode: 'boolean' }),
  scanDepth: integer('scan_depth'),
  matchScope: text('match_scope').notNull().default('[]'),
  triggers: text('triggers').notNull().default('[]'),
  recursive: integer('recursive', { mode: 'boolean' }).notNull().default(false),
  excludeRecursion: integer('exclude_recursion', { mode: 'boolean' }).notNull().default(false),
  preventRecursion: integer('prevent_recursion', { mode: 'boolean' }).notNull().default(false),
  delayUntilRecursion: integer('delay_until_recursion', { mode: 'boolean' }).notNull().default(false),
  stickyRounds: integer('sticky_rounds').notNull().default(0),
  cooldown: integer('cooldown').notNull().default(0),
  delay: integer('delay').notNull().default(0),
  probability: real('probability').notNull().default(100),
  groupId: text('group_id'),
  groupOverride: integer('group_override', { mode: 'boolean' }).notNull().default(false),
  groupWeight: real('group_weight'),
  useGroupScoring: integer('use_group_scoring', { mode: 'boolean' }).notNull().default(true),
  ignoreBudget: integer('ignore_budget', { mode: 'boolean' }).notNull().default(false),
  outletName: text('outlet_name'),
  characterFilter: text('character_filter').notNull().default('{}'),
  injectionPosition: text('injection_position'),
  injectionDepth: integer('injection_depth'),
  metadata: text('metadata').notNull().default('{}'),
  sourceData: text('source_data').notNull().default('{}'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const worldbookEntryVersions = sqliteTable('worldbook_entry_versions', {
  id: text('id').primaryKey(),
  entryId: text('entry_id').notNull(),
  version: integer('version').notNull(),
  snapshot: text('snapshot').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * 世界书条目运行时状态(database-schema §15,```worldbook_runtime_entries```)——
 * sticky/cooldown/delay/cache lifecycle 属 Runtime State 而非 Prompt Segment(§27/§28)。
 * Worldbook Asset ≠ Runtime State:本表按 (chat, entry) 存轮序上的定时状态与缓存档位。
 * P2 前 cache_state/physical_order 仅占位(unseen),毕业/退休逻辑归 WP2.2。
 */
export const worldbookRuntimeEntries = sqliteTable('worldbook_runtime_entries', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  worldbookEntryId: text('worldbook_entry_id').notNull(),
  cacheState: text('cache_state').notNull().default('unseen'),
  physicalOrder: integer('physical_order'),
  lastActivatedAt: text('last_activated_at'),
  lastActivationSeq: integer('last_activation_seq'),
  stickyUntilSeq: integer('sticky_until_seq'),
  cooldownUntilSeq: integer('cooldown_until_seq'),
  delayUntilSeq: integer('delay_until_seq'),
  activationCount: integer('activation_count').notNull().default(0),
  contentHash: text('content_hash'),
  updatedAt: text('updated_at').notNull(),
})
// UNIQUE(chat_id, worldbook_entry_id) —— 一条目一 chat 一行,driver 扁平 DI 约束不同步 Drizzle,
// 由 migration v5 的 UNIQUE 建表约束承载(core 不读运行库)。

/**
 * 世界书激活审计(database-schema §16,```worldbook_activations```)——每轮激活结果是可审计
 * 记录,不覆盖 Runtime State;Inspector 靠它回答"这条目为什么这轮被激活"。
 */
export const worldbookActivations = sqliteTable('worldbook_activations', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  runId: text('run_id'),
  worldbookEntryId: text('worldbook_entry_id').notNull(),
  activated: integer('activated', { mode: 'boolean' }).notNull(),
  reason: text('reason'),
  matchedKeywords: text('matched_keywords').notNull().default('[]'),
  sourceMessageIds: text('source_message_ids').notNull().default('[]'),
  score: real('score'),
  activationSeq: integer('activation_seq').notNull(),
  createdAt: text('created_at').notNull(),
})

export const presetVersions = sqliteTable('preset_versions', {
  id: text('id').primaryKey(),
  presetId: text('preset_id').notNull(),
  version: integer('version').notNull(),
  snapshot: text('snapshot').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

export const worldbooks = sqliteTable('worldbooks', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  name: text('name').notNull(),
  description: text('description'),
  scanDepth: integer('scan_depth'),
  recursive: integer('recursive', { mode: 'boolean' }).notNull().default(false),
  metadata: text('metadata').notNull().default('{}'),
  sourceFormat: text('source_format'),
  sourceData: text('source_data').notNull().default('{}'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

/**
 * chat↔worldbook 绑定(database-schema §18 `chat_worldbooks`;WP1.2 激活层接线前提)。
 * 主键 (chat_id, worldbook_id);scan_depth_override / recursive_override = NULL 时
 * 跟随 worldbooks 表默认。条目级运行时状态不在此(归 worldbook_runtime_entries §15)。
 */
export const chatWorldbooks = sqliteTable(
  'chat_worldbooks',
  {
    chatId: text('chat_id').notNull(),
    worldbookId: text('worldbook_id').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    scanDepthOverride: integer('scan_depth_override'),
    recursiveOverride: integer('recursive_override', { mode: 'boolean' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.worldbookId] }),
  }),
)
