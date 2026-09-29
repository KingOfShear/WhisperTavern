/**
 * packages/agent —— Agent Runtime / Workflow / Tools / Skills / Memory / Artifacts。
 *
 * 分层(§38 决策 45,方案 A):`agent → runtime → core → contracts`,**编排层是终点**;
 * runtime / core / contracts 不得反向依赖本包(architecture.test.ts B4 焊死)。
 *
 * 职责边界:**本包不碰 IO 原语**——四层执行表(attempts / step_runs / execution_operations)、
 * 事件、快照、生成编排与恢复骨架都在 packages/runtime(S22/WP3.1a 已落 migration v8);
 * 本包在其上做编排。S23(WP3.1b)落地 `src/runtime/`:Agent Definition / Instance /
 * State Machine / Turn 记账 / Context Resolution / 单 Agent 流程。
 */
export {
  AGENT_TYPES,
  AGENT_TURN_END_REASONS,
  CONTEXT_RESOLUTION_STAGES,
  EMPTY_AGENT_STATE,
  type AgentContext,
  type AgentDefinition,
  type AgentInstance,
  type AgentRunContext,
  type AgentState,
  type AgentTurn,
  type AgentTurnEndReason,
  type AgentType,
  type CancellationToken,
  type ContextItem,
  type ContextResolutionStage,
  type ContextSource,
  type RunBudget,
  type RuntimePolicy,
} from './runtime/types'

export {
  AGENT_STATUS_SPEC_NOTES,
  AGENT_STATUSES,
  AgentStatusViolation,
  assertAgentTransition,
  canTransitionAgent,
  isTerminalAgentStatus,
  TERMINAL_AGENT_STATUSES,
  type AgentStatus,
} from './runtime/state-machine'

export {
  AgentDefinitionError,
  createAgentDefinition,
  DEFAULT_RUNTIME_POLICY,
  listAgentDefinitions,
  loadAgentDefinition,
  loadAgentVersionSnapshot,
  type CreateAgentDefinitionInput,
} from './runtime/definition'

export {
  getOrCreateAgentInstance,
  heartbeatAgentInstance,
  loadAgentInstance,
  resetAgentInstanceToIdle,
  transitionAgentInstance,
} from './runtime/instance'

export {
  AgentTurnError,
  AgentTurnTracker,
  openTurn,
  type OpenTurnInput,
} from './runtime/turn'

export {
  resolveAgentContext,
  type AgentContextResolution,
  type ResolveAgentContextInput,
  type UnmappedContextOrigin,
} from './runtime/context'

export {
  AGENT_STEP_IDS,
  runAgent,
  type AgentRunDeps,
  type AgentRunOutcome,
  type AgentRunResult,
  type RunAgentInput,
} from './runtime/run-agent'


/** S25(WP3.3):Workflow Runtime —— DAG/条件/并行/Join/有界环/Resume + Director 结构化输出 */
export {
  WorkflowEngine,
  WorkflowValidationError,
  WorkflowLoopExceeded,
  ConditionSyntaxError,
  type WorkflowNodeExecutors,
  type WorkflowRunContext,
  type WorkflowRunResult,
  type WorkflowEngineDeps,
} from './workflow/engine'
export { evaluateCondition, evaluateExpression, type ConditionSyntaxError as ConditionSyntaxErrorT } from './workflow/condition'
export {
  resolveStructuredOutput,
  extractJson,
  validateDirectorDecision,
  type StructuredOutputPolicy,
  type DirectorDecision,
} from './workflow/director'
export {
  TOOL_PERMISSIONS as WORKFLOW_TOOL_PERMISSIONS,
} from './tools/types'
export type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  WorkflowVariable,
  AgentNode,
  ToolNode,
  ConditionNode,
  TransformNode,
  ApprovalNode,
  ParallelNode,
  ParallelFailurePolicy,
  LoopPolicy,
  ConditionExpression,
  WorkflowArtifact,
  WorkflowNodeLedger,
  RetryPolicy as WorkflowRetryPolicy,
  TimeoutPolicy as WorkflowTimeoutPolicy,
} from './workflow/types'

/** S24(WP3.2):Tool Runtime —— 五段流水线 / 审批 / 预算 / §36.3 model order 回灌 */
export {
  ApprovalManager,
  ApprovalAuditError,
  type ApprovalAuditRow,
} from './tools/approval'
export { BudgetExceeded, BudgetTracker, type RunBudgetEffective } from './tools/budget'
export {
  ToolBusinessError,
  ToolRegistry,
  type BatchContext,
  type ToolRegistryDeps,
  type ToolRegistryOptions,
} from './tools/registry'
export {
  APPROVAL_OUTCOMES,
  TOOL_PERMISSIONS,
  type ApprovalOutcome,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalResponder,
  type BudgetUsage,
  type PostExecuteOutcome,
  type PreExecuteOutcome,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionMode,
  type ToolOutcomeSignals,
  type ToolPermission,
  type ToolResult,
  type ToolResultStatus,
} from './tools/types'



/** S26(WP3.4):Context Policy 族 + Artifact + Output Commit + State Mutation */
export {
  DEFAULT_CONTEXT_POLICY,
  resolveContextByPolicy,
  resolveMemoryItems,
  type ContextPolicy,
  type HistoryPolicy,
  type MemoryContextPolicy,
  type WorldbookPolicy,
  type ArtifactPolicy,
  type SummaryPolicy,
  type ToolResultPolicy,
  type AgentVisibilityPolicy,
  type PolicyDrop,
  type PolicyFilterResult,
} from './context/policy'
/** S30(WP4.2a):Memory Policy 真实实现(R-P3-9 兑现)——检索编排经 Context Policy 注 tail */
export { resolveMemoryPolicy, type MemoryPolicyInput, type MemoryPolicyResult } from './memory/policy'
/** S31(WP4.2b):Scribe Agent + 记忆写入工具(memory-runtime-spec §4) */
export {
  runScribe,
  scribeChatTitle,
  SCRIBE_METADATA_ROLE,
  type RunScribeInput,
  type RunScribeResult,
} from './memory/scribe'
export {
  createMemoryWriterToolDefinitions,
  memoryWriterWireTools,
  MEMORY_WRITE_PERMISSIONS,
  MEMORY_TOOL_SPECS,
  type MemoryWriterToolDeps,
} from './memory/tools'
export {
  createArtifact,
  freezeArtifact,
  updateArtifactContent,
  loadArtifact,
  listChatArtifacts,
  artifactContributions,
  ArtifactError,
  type Artifact,
  type CreateArtifactInput,
} from './artifacts/store'
export {
  commitOutput,
  DEFAULT_OUTPUT_POLICY,
  OutputCommitError,
  type AgentOutput,
  type OutputPolicy,
  type OutputCommitter,
  type CommitOutputResult,
} from './output/commit'
export {
  applyStatePatches,
  readAgentState,
  StateMutationError,
  type StatePatch,
  type AgentStateView,
  type ApplyStatePatchesResult,
} from './state/mutation'



/** S27(WP3.5):Resume / Recovery / Replay —— §51–§55 / §96–§97 / §143–§146 */
export { resumeRun, type ResumeRunInput, type ResumeRunResult } from './runtime/resume'
export {
  scanInterruptedRuns,
  planRecovery,
  reconcileToolCalls,
  type RecoveryScanResult,
  type RecoveryAction,
  type RecoveryPlan,
  type PendingToolCall,
  type ReconcileResult,
} from './runtime/recovery'
export { ReplayAdapter, replayToolResults } from './runtime/replay'
export type { SideEffectLevel } from './tools/types'

/** S28(WP3.6)还账 #17:Runtime Scheduler —— §93 assertCanSpawn(Agent Tree 递归护栏) */
export {
  assertCanSpawn,
  TreeGuardViolation,
  type SpawnCheckInput,
  type SpawnCheckResult,
  type TreeGuardLimits,
} from './runtime/scheduler'
