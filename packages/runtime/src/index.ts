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
export { MIGRATIONS, type Migration } from './db/migrations'
export * from './db/schema'
export {
  activateMessage,
  createBranch,
  createChat,
  createMessage,
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
  buildContributions,
  loadActiveChain,
  SERVER_COMPILER_VERSION,
  type RunDeps,
  type StartRunInput,
  type StartedRun,
  type StartRunResult,
} from './generation/run'
