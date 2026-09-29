/**
 * packages/runtime —— Runtime 基座:事件 / 持久化 / 消息树 / 生成编排
 * (总设计 §7 结构注记:事件总线、权限、调度、快照全部在此;apps/server 只做传输)。
 *
 * S5 落地:Event Bus(durability 分档)· SQLite(§77/78 迁移器)· 消息树操作
 * · dispatchGeneration(§5.5 四不变量闸口)。
 */
export { createSqliteEventSink } from './events/sqlite-sink'
export {
  EventBus,
  type EventSink,
  type PublishInput,
  type Subscription,
} from './events/bus'
export {
  EVENT_CATALOG,
  assertEventName,
  durabilityOf,
  EventCatalogViolation,
  type EventDurability,
  type EventName,
  type RuntimeEvent,
} from './events/catalog'
export {
  createDatabase,
  type WhisperTavernDb,
  type DrizzleDb,
} from './db/database'
export {
  currentVersion,
  migrate,
  migrateWithBackup,
  pendingVersions,
  MigrationError,
} from './db/migrate'
export { MIGRATIONS, LATEST_SCHEMA_VERSION, type Migration } from './db/migrations'
export * from './db/schema'
export {
  createMemoryRepository,
  serializeEmbedding,
  parseEmbedding,
  cosine,
  assertMemoryType,
} from './memory/repository'
export { buildSummaryContributions } from './memory/summary-contributions'
export { searchMemory } from './memory/search'
export {
  type MemoryHit,
  type MemoryRepository,
  type MemoryWriter,
  type MemoryReader,
  type KeywordSearchQuery,
  type SemanticSearchQuery,
  type UpsertMemoryInput,
  type AppendTimelineEventInput,
  type AppendChunksInput,
  type AppendSummaryBlockInput,
  type SummaryBlock,
  type InsertDocumentInput,
  type ListMemoriesQuery,
  type ListTimelineEventsQuery,
  type TimelineEventRecord,
  type DocumentRecord,
  type ChunkRecord,
  type ChunkHit,
  type MemorySearchKind,
  type SearchMemoryQuery,
  type MemorySearchHit,
} from './memory/types'
export {
  activateMessage,
  createBranch,
  createChat,
  createMessage,
  deleteChat,
  deleteMessage,
  editMessage,
  activeLeafId,
  loadBranch,
  loadChat,
  loadMessage,
  swipeMessage,
  type CreateChatInput,
  type CreateMessageInput,
  type CreatedMessage,
} from './tree/messages'
export {
  dispatchGeneration,
  buildGenerationRequest,
  assertSnapshotRegistered,
  assertRequestMatchesSnapshot,
  assertNoMetadataOnWire,
  assertWaitingHasDurableEvent,
  InvariantViolation,
  SnapshotRegistry,
  type DispatchInput,
  type DispatchResult,
  type DispatchToolCall,
  type GenerationRecord,
  type GenerationSink,
} from './generation/dispatch'
export { sha256Hex, uuidv7 } from './util/id'
export {
  createSecretStore,
  type SecretStore,
} from './secrets/secret-store'
export {
  startRun,
  prepareIteration,
  buildContributions,
  loadActiveChain,
  SERVER_COMPILER_VERSION,
  type RunDeps,
  type StartRunInput,
  type StartedRun,
  type StartRunResult,
  type IterationPrep,
  type PrepareIterationResult,
} from './generation/run'
export {
  buildRuntimeVariables,
  type BuildRuntimeVariablesInput,
} from './generation/variables'
export {
  AGENT_STATUSES,
  assertTransition,
  canTransition,
  ExecutionStatusViolation,
  EXECUTION_STATUSES,
  EXECUTION_STATUS_SPEC_NOTE,
  isTerminalStatus,
  LEGACY_EXECUTION_STATUS_ALIAS,
  normalizeExecutionStatus,
  TERMINAL_AGENT_STATUSES,
  TERMINAL_EXECUTION_STATUSES,
  type AgentStatus,
  type ExecutionStatus,
} from './execution/status'
export {
  appendAttempt,
  appendOperation,
  appendStepRun,
  APPROVAL_OUTCOMES,
  completeOperation,
  createExecutionRun,
  decideApproval,
  ExecutionReferenceError,
  ExecutionSequenceConflict,
  heartbeatRun,
  loadExecutionTree,
  loadRun,
  recordArtifact,
  recordCheckpoint,
  recordToolCall,
  requestApproval,
  transitionAttempt,
  transitionRun,
  transitionStepRun,
  type AppendAttemptInput,
  type AppendOperationInput,
  type AppendStepRunInput,
  type ApprovalOutcome,
  type CreateExecutionRunInput,
  type ExecutionTree,
} from './execution/store'
export {
  classifyRecovery,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  isZombie,
  markRunInterrupted,
  recoveryTargetStatus,
  scanForZombieRuns,
  type RecoveryAction,
  type RecoveryVerdict,
  type ZombieRunReport,
} from './execution/recovery'
