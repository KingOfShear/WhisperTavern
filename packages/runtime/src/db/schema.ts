import { blob, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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

/**
 * §34 Run —— P0 建 conversation 子集,P3(v8)补 agent 执行列(该表 P0 注释即已声明
 * "agent 执行列随 P3 扩展",故为既定计划内的实现,不是新决策)。
 *
 * `attempt` 列自 P3 起**降为聚合 attemptNo**:Attempt 实体归 `attempts` 表(§34.1 /
 * R-P3-3),本列只保留"当前跑到第几次"的读面,不承载执行环境。
 * 用户触发的重试 = 新建 Run + `origin_run_id`(裁决 C3);Run 本体永不从终态回 running(§12)。
 */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  /** ExecutionStatus(§4.3);P0 遗留取值 streaming/completed 见 execution/status.ts 别名表 */
  status: text('status').notNull(),
  attempt: integer('attempt').notNull().default(1),
  provider: text('provider'),
  model: text('model'),
  snapshotId: text('snapshot_id'),
  messageId: text('message_id'),
  error: text('error'),
  // ── P3 执行列(migration v8 追加)──
  agentId: text('agent_id'),
  /** Run 级版本钉住(§163 热重载:改 Definition 不影响在跑的 Run) */
  agentVersion: integer('agent_version'),
  workflowRunId: text('workflow_run_id'),
  workflowStepRunId: text('workflow_step_run_id'),
  /** 执行树 parentRunId(Director → Writer/Checker;§14/§15) */
  parentRunId: text('parent_run_id'),
  /** 用户重试新建 Run 时指向原 Run(裁决 C3) */
  originRunId: text('origin_run_id'),
  triggerMessageId: text('trigger_message_id'),
  /** live | simulation | replay | debug(§147–§151) */
  mode: text('mode').notNull().default('live'),
  inputState: text('input_state').notNull().default('{}'),
  outputState: text('output_state'),
  /** BudgetUsage(§41);与 generations 的 usage 是聚合与明细的关系 */
  budgetUsage: text('budget_usage'),
  /** compiler/agent/workflow/tool 版本清单(§166)——Resume 兼容性判据 */
  dependencyManifest: text('dependency_manifest'),
  /** Zombie Run 检测(§97):超 recoveryTimeout 未心跳 → interrupted */
  lastHeartbeatAt: text('last_heartbeat_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

/** §39 Prompt Snapshot(不可变,§40:禁止 UPDATE) */
export const promptSnapshots = sqliteTable('prompt_snapshots', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  /** S33a(migration v11):per-(chat, character) 缓存命名空间的键(§26);未绑定角色为 NULL */
  characterId: text('character_id'),
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
  /** 首次注入轮序(单调不变量;WP2.2 S17 起由 fresh 注入时赋值,重注入更新) */
  firstSeenMsg: integer('first_seen_msg'),
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

// ===== P3(WP3.1a)执行层持久化底座(§27–§29 / §34.1–34.3 / §35 / §36–36.2)=====

/**
 * §27 Agent Definition —— Runtime Entity,不只是"一段 Prompt"。
 * `version` 是 Definition 版本;`agent_versions` 存版本快照(§28),二者关系与
 * character/persona/preset 的 `X + X_versions` 范式一致。
 */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** character | director | writer | checker | editor | tool-agent | custom */
  agentType: text('agent_type').notNull(),
  instructions: text('instructions'),
  config: text('config').notNull().default('{}'),
  toolPolicy: text('tool_policy').notNull().default('{}'),
  memoryPolicy: text('memory_policy').notNull().default('{}'),
  contextPolicy: text('context_policy').notNull().default('{}'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** §28 Agent Version —— Definition 版本快照(§163 热重载的钉住基准) */
export const agentVersions = sqliteTable('agent_versions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  version: integer('version').notNull(),
  snapshot: text('snapshot').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * §29 Agent Runtime State = **Agent Instance**(§7):同一 Agent Definition 在多个
 * Chat 中各持一份独立运行态,靠 `agent_version` 实现 §163 热重载。
 *
 * `status` 是 **AgentStatus 聚合态**(idle/queued/running/waiting/paused/interrupted/
 * failed/completed/cancelled),由当前 Run/Attempt 归约而来,**不与 ExecutionStatus 合并**
 * (§4.3 末条)。它还是**区间状态**,不得读成"某条消息跑完了"(§5.5 纪律 D3)。
 */
export const agentRuntimeStates = sqliteTable('agent_runtime_states', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  agentId: text('agent_id').notNull(),
  agentVersion: integer('agent_version'),
  state: text('state').notNull().default('{}'),
  status: text('status').notNull().default('idle'),
  currentRunId: text('current_run_id'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
// UNIQUE(chat_id, agent_id) —— 由 migration v8 建表约束承载。

/**
 * §34.1 Attempt —— "这次怎么做"。持有完整执行环境(provider / model /
 * runtime snapshot / checkpoint / usage / error);历史不可变,Retry 建新 attempt_no。
 */
export const attempts = sqliteTable('attempts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  attemptNo: integer('attempt_no').notNull(),
  status: text('status').notNull(),
  /** 从历史 checkpoint 派生分支时指向原 Attempt(§10.5) */
  parentAttemptId: text('parent_attempt_id'),
  reason: text('reason'),
  /** Runtime Snapshot:一次 Attempt 钉死的执行环境判据(§4.6 / §166) */
  runtimeSnapshot: text('runtime_snapshot').notNull().default('{}'),
  checkpointId: text('checkpoint_id'),
  provider: text('provider'),
  model: text('model'),
  promptSnapshotId: text('prompt_snapshot_id'),
  usage: text('usage'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  timeoutAt: text('timeout_at'),
})

/**
 * §34.2 Step Run —— "哪一步实际做了一次"。主键是 stepRunId,**绝不能是 stepId**;
 * `step_revision` 钉住该 Step 定义版本,终态后不可变(§4.4 Replay 依赖)。
 */
export const stepRuns = sqliteTable('step_runs', {
  id: text('id').primaryKey(),
  attemptId: text('attempt_id').notNull(),
  stepId: text('step_id').notNull(),
  stepRevision: integer('step_revision').notNull(),
  /** 本 Step 第几次执行(Step Retry = 新 run_no,不新增 Attempt;§4.2) */
  runNo: integer('run_no').notNull(),
  status: text('status').notNull(),
  input: text('input'),
  output: text('output'),
  /** Step Retry 时指向被取代的上一个 Step Run */
  retryOf: text('retry_of'),
  checkpointId: text('checkpoint_id'),
  promptSnapshotId: text('prompt_snapshot_id'),
  usage: text('usage'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
})

/**
 * §34.3 Execution Operation —— **设施级** IO / Provider / Tool 重试明细,
 * 把"HTTP 重试"与"Agent Step Retry"显式分开。**默认不记录**,仅 Debug /
 * simulation / replay 与排障开启(§4.5)。与 generations / tool_calls 是
 * "底层重试明细 vs 上层语义事实"的关系,不重复记录后者本身。
 */
export const executionOperations = sqliteTable('execution_operations', {
  id: text('id').primaryKey(),
  stepRunId: text('step_run_id'),
  /** provider_request | tool_request | network_request | storage | plugin_call */
  type: text('type').notNull(),
  attemptNo: integer('attempt_no').notNull(),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
})

/** §35 Tool Call —— 一次工具调用(pending/running/completed/failed/cancelled) */
export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  toolName: text('tool_name').notNull(),
  arguments: text('arguments').notNull().default('{}'),
  result: text('result'),
  status: text('status').notNull(),
  error: text('error'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
})

/**
 * §36 Artifact —— 中间结果不塞进 Message。`frozen` 表内容不再变化,
 * 但**不改变缓存分区**(裁决 C2):冻结产物一律进 injection / tail,
 * 不提升进稳定前缀(compiler-spec §83)。
 */
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  chatId: text('chat_id'),
  runId: text('run_id'),
  type: text('type').notNull(),
  name: text('name'),
  content: text('content'),
  data: text('data'),
  contentHash: text('content_hash'),
  frozen: integer('frozen', { mode: 'boolean' }).notNull().default(false),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
})

/**
 * §36.1 Runtime Checkpoint —— Resume 的恢复点(§51–§55)。
 * 与 `cache_checkpoints`(Provider 缓存标记)是**两个不同对象**,不合并。
 * Run 结束后可清理;paused / interrupted 的 Run 其最后一个 Checkpoint 必须保留。
 */
export const runtimeCheckpoints = sqliteTable('runtime_checkpoints', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  turnIndex: integer('turn_index').notNull(),
  /** before_provider | after_provider | before_tool | after_tool | before_pause | manual | automatic */
  reason: text('reason').notNull(),
  /** Resume 兼容性比对基准(§55) */
  stateHash: text('state_hash').notNull(),
  agentState: text('agent_state').notNull().default('{}'),
  variables: text('variables').notNull().default('{}'),
  toolState: text('tool_state').notNull().default('{}'),
  contextState: text('context_state').notNull().default('{}'),
  promptSnapshotId: text('prompt_snapshot_id'),
  createdAt: text('created_at').notNull(),
})

/**
 * §36.2 Approval —— Waiting 状态**不能依赖内存 Promise**,必须持久化(§116)。
 * `status` 只表审计配对进度(pending → decided);**最终结论由 `outcome` 承载**,
 * 四值封闭:allowed_once | rejected | cancelled | unavailable(§115.1,R-P3-5 fail-closed)。
 * 只有 allowed_once 放行;无回答者(后台 / 定时 / 群聊跑批)默认 unavailable = 拒。
 */
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  toolCallId: text('tool_call_id'),
  action: text('action').notNull(),
  description: text('description'),
  /** low | medium | high */
  risk: text('risk').notNull(),
  requestedPermissions: text('requested_permissions').notNull().default('[]'),
  status: text('status').notNull(),
  outcome: text('outcome'),
  /** 发起方给出的"为什么问"(不携带工具入参,避免第二份会漂移的副本) */
  reason: text('reason'),
  /** 发起时有效的 per-chat 策略:ask | never(Replay 需要) */
  policyAtRequest: text('policy_at_request'),
  decidedAt: text('decided_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
})

/**
 * P4(WP4.1)Memory 持久化底座 —— database-schema §23/§25/§25.1/§25.2/§25.3/§25.4/§26
 * 的 Drizzle 投影(migration v10 同批落库)。
 *
 * 细节:①FTS5 虚拟表(memories_fts/chunks_fts)非 Drizzle 表,经原生 SQL 访问
 * (Repository 层封装,X16);②embedding 为 float32 序列化 BLOB,编解码见
 * `packages/runtime/src/memory/repository.ts`。
 */

/** §23 Summary Block —— 追加式冻结块(R-P4-4;compiler-spec §32/§33) */
export const summaryBlocks = sqliteTable('summary_blocks', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  sequence: integer('sequence').notNull(),
  content: text('content').notNull(),
  fromMessageId: text('from_message_id').notNull(),
  toMessageId: text('to_message_id').notNull(),
  frozen: integer('frozen', { mode: 'boolean' }).notNull().default(false),
  contentHash: text('content_hash').notNull(),
  tokenCount: integer('token_count'),
  createdAt: text('created_at').notNull(),
})

/** §25 Memories —— Dossier 事实卡 + 其他长期记忆;embedding BLOB = float32 语义向量 */
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  chatId: text('chat_id'),
  /**
   * fact | preference | relationship | event | world | instruction | other(§25 类型清单)
   * entity 为 Dossier 实体维度,type='fact' 时非空
   */
  type: text('type').notNull(),
  entity: text('entity'),
  content: text('content').notNull(),
  importance: real('importance'),
  confidence: real('confidence'),
  sourceMessageIds: text('source_message_ids').notNull().default('[]'),
  tags: text('tags').notNull().default('[]'),
  metadata: text('metadata').notNull().default('{}'),
  contentHash: text('content_hash').notNull(),
  embedding: blob('embedding', { mode: 'buffer' }),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** §26 Memory Version —— 版本化更新快照(memory.updated 事件同行) */
export const memoryVersions = sqliteTable('memory_versions', {
  id: text('id').primaryKey(),
  memoryId: text('memory_id').notNull(),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  snapshot: text('snapshot').notNull().default('{}'),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

/** §25.2 Timeline Events —— Scribe 追加式事件流 */
export const timelineEvents = sqliteTable('timeline_events', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  eventType: text('event_type').notNull(),
  summary: text('summary').notNull(),
  participants: text('participants').notNull().default('[]'),
  location: text('location'),
  consequences: text('consequences'),
  sourceMessageId: text('source_message_id'),
  importance: real('importance'),
  emotionalWeight: real('emotional_weight'),
  createdAt: text('created_at').notNull(),
})

/** §25.3 Documents —— Data Bank 元数据 */
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  chatId: text('chat_id'),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull(),
  sourceType: text('source_type').notNull(),
  sourceUri: text('source_uri'),
  mimeType: text('mime_type'),
  fileSizeBytes: integer('file_size_bytes'),
  metadata: text('metadata').notNull().default('{}'),
  totalChunks: integer('total_chunks').default(0),
  indexedAt: text('indexed_at'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** §25.4 Chunks —— Data Bank 文本块(append-only) */
export const chunks = sqliteTable('chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  chatId: text('chat_id'),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  tokenCount: integer('token_count'),
  contentHash: text('content_hash').notNull(),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
})
