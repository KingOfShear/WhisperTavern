/**
 * 执行四层写入与不变量(agent-runtime-spec §4.1.1 / §4.1.2 / §4.2 / §12)。
 *
 * 四层(model order):
 *   Run「做什么」→ Attempt「这次怎么做」→ Step Run「哪一步做了一次」→ Operation「底层调用发生了什么」
 *
 * 本模块是**持久化原语**,不含执行编排(编排归 packages/agent,§38 决策 45)。
 * 它守的是 §4.1.1 的持久化不变量:
 * - 引用完整性:`Attempt.runId` 必须指向存在的 Run,`StepRun.attemptId` 必须指向存在的 Attempt;
 * - 终态不可改写:任何状态转换走 `assertTransition`(§4.3 + §11),终态无出边;
 * - Retry 一律新建记录:attempt_no / run_no 由本模块分配,冲突即拒绝,
 *   禁止用 UPDATE 覆盖历史失败执行(§4.1.1)。
 *
 * ID 规则(§4.1.2):全局唯一 UUIDv7(`run_xxx / attempt_xxx / step_run_xxx / operation_xxx`),
 * 业务身份不依赖数据库自增;`attemptNo / runNo / sequence` 只是局部可读序列。
 */
import { eq } from 'drizzle-orm'
import type {
  AgentId,
  ApprovalId,
  ArtifactId,
  AttemptId,
  CheckpointId,
  MessageId,
  OperationId,
  RunId,
  StepRunId,
  ToolCallId,
  ChatId,
  Timestamp,
} from '@whispertavern/contracts'
import type { WhisperTavernDb } from '../db/database'
import {
  approvals,
  artifacts,
  attempts,
  executionOperations,
  runtimeCheckpoints,
  runs,
  stepRuns,
  toolCalls,
} from '../db/schema'
import { assertTransition, isTerminalStatus, type ExecutionStatus } from './status'
import { uuidv7 } from '../util/id'

/** §4.1.1 引用完整性违反:不是可恢复的运行期错误,是调用序错误 */
export class ExecutionReferenceError extends Error {
  constructor(message: string) {
    super(`INVARIANT_VIOLATION: ${message}`)
    this.name = 'ExecutionReferenceError'
  }
}

/** 同一范围内序列冲突(attempt_no / run_no)= 试图覆盖历史执行(§4.1.1 禁止) */
export class ExecutionSequenceConflict extends Error {
  constructor(message: string) {
    super(`INVARIANT_VIOLATION: ${message}`)
    this.name = 'ExecutionSequenceConflict'
  }
}

export interface CreateExecutionRunInput {
  id?: RunId
  chatId: ChatId
  status?: ExecutionStatus
  /** live | simulation | replay | debug(§147–§151) */
  mode?: string
  agentId?: AgentId
  agentVersion?: number
  parentRunId?: RunId
  /** 用户重试 = 新建 Run + origin_run_id(裁决 C3);旧 Run 保持终态不动 */
  originRunId?: RunId
  triggerMessageId?: MessageId
  provider?: string
  model?: string
  /** §166 版本清单(compiler/agent/workflow/tool + model)——Resume 兼容性判据(§55) */
  dependencyManifest?: Record<string, unknown>
  now: Timestamp
}

/** 建 Run。默认 `created`(§4.3 主干入口),由调用方推进到 queued / running */
export function createExecutionRun(store: WhisperTavernDb, input: CreateExecutionRunInput): RunId {
  if (input.parentRunId !== undefined && loadRun(store, input.parentRunId) === undefined) {
    throw new ExecutionReferenceError(`Run.parent_run_id 指向不存在的 Run: ${input.parentRunId}`)
  }
  if (input.originRunId !== undefined && loadRun(store, input.originRunId) === undefined) {
    throw new ExecutionReferenceError(`Run.origin_run_id 指向不存在的 Run: ${input.originRunId}`)
  }
  const id = input.id ?? (uuidv7() as RunId)
  store.db
    .insert(runs)
    .values({
      id,
      chatId: input.chatId,
      status: input.status ?? 'created',
      mode: input.mode ?? 'live',
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      parentRunId: input.parentRunId,
      originRunId: input.originRunId,
      triggerMessageId: input.triggerMessageId,
      provider: input.provider,
      model: input.model,
      ...(input.dependencyManifest !== undefined ? { dependencyManifest: JSON.stringify(input.dependencyManifest) } : {}),
      lastHeartbeatAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run()
  return id
}

export function loadRun(store: WhisperTavernDb, runId: RunId): { id: string; status: string } | undefined {
  return store.db.select({ id: runs.id, status: runs.status }).from(runs).where(eq(runs.id, runId)).get()
}

/**
 * Run 状态推进。终态不可回退(§11/§12):`interrupted` 的恢复由 recovery 决定
 * resume / retry / fail,而不是把它当作可随意重开的中间态。
 */
export function transitionRun(
  store: WhisperTavernDb,
  runId: RunId,
  to: ExecutionStatus,
  options: { now: Timestamp; error?: string; heartbeat?: boolean },
): void {
  const row = loadRun(store, runId)
  if (row === undefined) throw new ExecutionReferenceError(`Run 不存在: ${runId}`)
  assertTransition(row.status as ExecutionStatus, to)
  store.db
    .update(runs)
    .set({
      status: to,
      updatedAt: options.now,
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(isTerminalStatus(to) ? { completedAt: options.now } : {}),
      ...(options.heartbeat === false ? {} : { lastHeartbeatAt: options.now }),
    })
    .where(eq(runs.id, runId))
    .run()
}

/** 心跳:§97 Zombie Run 检测的唯一依据(超 recoveryTimeout 未心跳 → interrupted) */
export function heartbeatRun(store: WhisperTavernDb, runId: RunId, now: Timestamp): void {
  store.db.update(runs).set({ lastHeartbeatAt: now }).where(eq(runs.id, runId)).run()
}

export interface AppendAttemptInput {
  id?: AttemptId
  runId: RunId
  /** 缺省 = 该 Run 内 max(attempt_no) + 1(Retry 建新 Attempt,§4.2) */
  attemptNo?: number
  status?: ExecutionStatus
  parentAttemptId?: AttemptId
  reason?: string
  runtimeSnapshot?: Record<string, unknown>
  checkpointId?: CheckpointId
  provider?: string
  model?: string
  promptSnapshotId?: string
  now: Timestamp
}

/** 追加 Attempt。同时把 `runs.attempt` 更新为**聚合 attemptNo**(R-P3-3) */
export function appendAttempt(store: WhisperTavernDb, input: AppendAttemptInput): AttemptId {
  if (loadRun(store, input.runId) === undefined) {
    throw new ExecutionReferenceError(`Attempt.run_id 指向不存在的 Run: ${input.runId}`)
  }
  const attemptNo = input.attemptNo ?? nextAttemptNo(store, input.runId)
  const taken = store.db
    .select({ attemptNo: attempts.attemptNo })
    .from(attempts)
    .where(eq(attempts.runId, input.runId))
    .all()
    .some((r) => r.attemptNo === attemptNo)
  if (taken) throw new ExecutionSequenceConflict(`attempt_no ${attemptNo} 已存在(Run ${input.runId})`)
  const id = input.id ?? (uuidv7() as AttemptId)
  store.db
    .insert(attempts)
    .values({
      id,
      runId: input.runId,
      attemptNo,
      status: input.status ?? 'created',
      parentAttemptId: input.parentAttemptId,
      reason: input.reason,
      runtimeSnapshot: JSON.stringify(input.runtimeSnapshot ?? {}),
      checkpointId: input.checkpointId,
      provider: input.provider,
      model: input.model,
      promptSnapshotId: input.promptSnapshotId,
      startedAt: input.now,
    })
    .run()
  store.db
    .update(runs)
    .set({ attempt: attemptNo, updatedAt: input.now })
    .where(eq(runs.id, input.runId))
    .run()
  return id
}

export function transitionAttempt(
  store: WhisperTavernDb,
  attemptId: AttemptId,
  to: ExecutionStatus,
  options: { now: Timestamp; error?: string; usage?: Record<string, unknown> },
): void {
  const row = store.db.select({ status: attempts.status }).from(attempts).where(eq(attempts.id, attemptId)).get()
  if (row === undefined) throw new ExecutionReferenceError(`Attempt 不存在: ${attemptId}`)
  assertTransition(row.status as ExecutionStatus, to)
  store.db
    .update(attempts)
    .set({
      status: to,
      error: options.error,
      ...(options.usage === undefined ? {} : { usage: JSON.stringify(options.usage) }),
      ...(isTerminalStatus(to) ? { completedAt: options.now } : {}),
    })
    .where(eq(attempts.id, attemptId))
    .run()
}

export interface AppendStepRunInput {
  id?: StepRunId
  attemptId: AttemptId
  stepId: string
  /** 该 Step 定义版本;历史 StepRun 必须保留当时 revision(§4.4,Replay 依赖) */
  stepRevision: number
  /** 缺省 = 该 (attempt, step) 内 max(run_no) + 1(Step Retry 建新 Step Run,§4.2) */
  runNo?: number
  status?: ExecutionStatus
  input?: Record<string, unknown>
  promptSnapshotId?: string
  now: Timestamp
}

/** 追加 Step Run。Step Retry 自动把 `retry_of` 指向被取代的上一个 Step Run(§34.2) */
export function appendStepRun(store: WhisperTavernDb, input: AppendStepRunInput): StepRunId {
  const attempt = store.db.select({ id: attempts.id }).from(attempts).where(eq(attempts.id, input.attemptId)).get()
  if (attempt === undefined) {
    throw new ExecutionReferenceError(`StepRun.attempt_id 指向不存在的 Attempt: ${input.attemptId}`)
  }
  const previous = store.db
    .select({ id: stepRuns.id, stepId: stepRuns.stepId, runNo: stepRuns.runNo })
    .from(stepRuns)
    .where(eq(stepRuns.attemptId, input.attemptId))
    .all()
    .filter((r) => r.stepId === input.stepId)
    .sort((a, b) => a.runNo - b.runNo)
  const runNo = input.runNo ?? (previous.length === 0 ? 1 : previous[previous.length - 1]!.runNo + 1)
  const id = input.id ?? (uuidv7() as StepRunId)
  const predecessor = previous.find((r) => r.runNo === runNo - 1)
  store.db
    .insert(stepRuns)
    .values({
      id,
      attemptId: input.attemptId,
      stepId: input.stepId,
      stepRevision: input.stepRevision,
      runNo,
      status: input.status ?? 'created',
      input: input.input === undefined ? undefined : JSON.stringify(input.input),
      retryOf: runNo > 1 ? predecessor?.id : undefined,
      promptSnapshotId: input.promptSnapshotId,
      startedAt: input.now,
    })
    .run()
  return id
}

export function transitionStepRun(
  store: WhisperTavernDb,
  stepRunId: StepRunId,
  to: ExecutionStatus,
  options: { now: Timestamp; output?: Record<string, unknown>; error?: Record<string, unknown>; usage?: Record<string, unknown> },
): void {
  const row = store.db.select({ status: stepRuns.status }).from(stepRuns).where(eq(stepRuns.id, stepRunId)).get()
  if (row === undefined) throw new ExecutionReferenceError(`Step Run 不存在: ${stepRunId}`)
  assertTransition(row.status as ExecutionStatus, to)
  store.db
    .update(stepRuns)
    .set({
      status: to,
      ...(options.output === undefined ? {} : { output: JSON.stringify(options.output) }),
      ...(options.error === undefined ? {} : { error: JSON.stringify(options.error) }),
      ...(options.usage === undefined ? {} : { usage: JSON.stringify(options.usage) }),
      ...(isTerminalStatus(to) ? { completedAt: options.now } : {}),
    })
    .where(eq(stepRuns.id, stepRunId))
    .run()
}

export interface AppendOperationInput {
  id?: OperationId
  stepRunId?: StepRunId
  /** provider_request | tool_request | network_request | storage | plugin_call */
  type: string
  attemptNo: number
  status?: ExecutionStatus
  latencyMs?: number
  now: Timestamp
}

/**
 * 追加 Operation(§4.5)。**默认不记录**——只有 Debug / simulation / replay(§58/§125)
 * 与排障场景才开启,这是调用侧的判断,本模块不代劳。
 */
export function appendOperation(store: WhisperTavernDb, input: AppendOperationInput): OperationId {
  if (input.stepRunId !== undefined) {
    const step = store.db.select({ id: stepRuns.id }).from(stepRuns).where(eq(stepRuns.id, input.stepRunId)).get()
    if (step === undefined) {
      throw new ExecutionReferenceError(`Operation.step_run_id 指向不存在的 Step Run: ${input.stepRunId}`)
    }
  }
  const id = input.id ?? (uuidv7() as OperationId)
  store.db
    .insert(executionOperations)
    .values({
      id,
      stepRunId: input.stepRunId,
      type: input.type,
      attemptNo: input.attemptNo,
      status: input.status ?? 'running',
      latencyMs: input.latencyMs,
      startedAt: input.now,
    })
    .run()
  return id
}

export function completeOperation(
  store: WhisperTavernDb,
  operationId: OperationId,
  to: ExecutionStatus,
  options: { now: Timestamp; latencyMs?: number; error?: Record<string, unknown> },
): void {
  const row = store.db
    .select({ status: executionOperations.status })
    .from(executionOperations)
    .where(eq(executionOperations.id, operationId))
    .get()
  if (row === undefined) throw new ExecutionReferenceError(`Operation 不存在: ${operationId}`)
  assertTransition(row.status as ExecutionStatus, to)
  store.db
    .update(executionOperations)
    .set({
      status: to,
      latencyMs: options.latencyMs,
      ...(options.error === undefined ? {} : { error: JSON.stringify(options.error) }),
      completedAt: options.now,
    })
    .where(eq(executionOperations.id, operationId))
    .run()
}

/** §161 执行树读取面(Inspector / Replay / Cost 的共同基础结构) */
export interface ExecutionTree {
  run: typeof runs.$inferSelect
  attempts: (typeof attempts.$inferSelect)[]
  stepRuns: (typeof stepRuns.$inferSelect)[]
  operations: (typeof executionOperations.$inferSelect)[]
}

export function loadExecutionTree(store: WhisperTavernDb, runId: RunId): ExecutionTree | undefined {
  const run = store.db.select().from(runs).where(eq(runs.id, runId)).get()
  if (run === undefined) return undefined
  const attemptRows = store.db.select().from(attempts).where(eq(attempts.runId, runId)).all()
  const attemptIds = new Set(attemptRows.map((a) => a.id))
  const stepRows = store.db
    .select()
    .from(stepRuns)
    .all()
    .filter((s) => attemptIds.has(s.attemptId))
  const stepIds = new Set(stepRows.map((s) => s.id))
  const operationRows = store.db
    .select()
    .from(executionOperations)
    .all()
    .filter((o) => o.stepRunId !== null && stepIds.has(o.stepRunId))
  return { run, attempts: attemptRows, stepRuns: stepRows, operations: operationRows }
}

/** §35 工具调用记录(`pending → running → completed | failed | cancelled`) */
export function recordToolCall(
  store: WhisperTavernDb,
  input: { runId: RunId; toolName: string; arguments?: Record<string, unknown>; now: Timestamp },
): ToolCallId {
  if (loadRun(store, input.runId) === undefined) {
    throw new ExecutionReferenceError(`ToolCall.run_id 指向不存在的 Run: ${input.runId}`)
  }
  const id = uuidv7() as ToolCallId
  store.db
    .insert(toolCalls)
    .values({
      id,
      runId: input.runId,
      toolName: input.toolName,
      arguments: JSON.stringify(input.arguments ?? {}),
      status: 'pending',
      startedAt: input.now,
    })
    .run()
  return id
}

/** §36 产物记录。`frozen` = 内容不再变化,但**不改变缓存分区**(裁决 C2) */
export function recordArtifact(
  store: WhisperTavernDb,
  input: {
    chatId?: ChatId
    runId?: RunId
    type: string
    name?: string
    content?: string
    data?: Record<string, unknown>
    contentHash?: string
    frozen?: boolean
    now: Timestamp
  },
): ArtifactId {
  const id = uuidv7() as ArtifactId
  store.db
    .insert(artifacts)
    .values({
      id,
      chatId: input.chatId,
      runId: input.runId,
      type: input.type,
      name: input.name,
      content: input.content,
      data: input.data === undefined ? undefined : JSON.stringify(input.data),
      contentHash: input.contentHash,
      frozen: input.frozen ?? false,
      createdAt: input.now,
    })
    .run()
  return id
}

/** §36.1 恢复点。paused / interrupted 的 Run 其**最后一个 checkpoint 必须保留** */
export function recordCheckpoint(
  store: WhisperTavernDb,
  input: {
    runId: RunId
    turnIndex: number
    /** before_provider | after_provider | before_tool | after_tool | before_pause | manual | automatic */
    reason: string
    stateHash: string
    agentState?: Record<string, unknown>
    variables?: Record<string, unknown>
    toolState?: Record<string, unknown>
    contextState?: Record<string, unknown>
    promptSnapshotId?: string
    now: Timestamp
  },
): CheckpointId {
  if (loadRun(store, input.runId) === undefined) {
    throw new ExecutionReferenceError(`Checkpoint.run_id 指向不存在的 Run: ${input.runId}`)
  }
  const id = uuidv7() as CheckpointId
  store.db
    .insert(runtimeCheckpoints)
    .values({
      id,
      runId: input.runId,
      turnIndex: input.turnIndex,
      reason: input.reason,
      stateHash: input.stateHash,
      agentState: JSON.stringify(input.agentState ?? {}),
      variables: JSON.stringify(input.variables ?? {}),
      toolState: JSON.stringify(input.toolState ?? {}),
      contextState: JSON.stringify(input.contextState ?? {}),
      promptSnapshotId: input.promptSnapshotId,
      createdAt: input.now,
    })
    .run()
  return id
}

/** §36.2 审批请求落库(Waiting 不能依赖内存 Promise)。结论由 `decideApproval` 写 `outcome` */
export function requestApproval(
  store: WhisperTavernDb,
  input: {
    runId: RunId
    toolCallId?: ToolCallId
    action: string
    description?: string
    risk: 'low' | 'medium' | 'high'
    requestedPermissions?: string[]
    reason?: string
    /** 发起时有效的 per-chat 策略:ask | never(Replay 需要) */
    policyAtRequest?: 'ask' | 'never'
    expiresAt?: Timestamp
    now: Timestamp
  },
): ApprovalId {
  if (loadRun(store, input.runId) === undefined) {
    throw new ExecutionReferenceError(`Approval.run_id 指向不存在的 Run: ${input.runId}`)
  }
  const id = uuidv7() as ApprovalId
  store.db
    .insert(approvals)
    .values({
      id,
      runId: input.runId,
      toolCallId: input.toolCallId,
      action: input.action,
      description: input.description,
      risk: input.risk,
      requestedPermissions: JSON.stringify(input.requestedPermissions ?? []),
      status: 'pending',
      reason: input.reason,
      policyAtRequest: input.policyAtRequest,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    })
    .run()
  return id
}

/**
 * §115.1 审批结论四值,**fail-closed**:只有 `allowed_once` 放行。
 * 无回答者(后台 workflow / 定时任务 / 群聊跑批)取 `unavailable` = 拒(R-P3-5)。
 */
export const APPROVAL_OUTCOMES = ['allowed_once', 'rejected', 'cancelled', 'unavailable'] as const
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number]

export function decideApproval(
  store: WhisperTavernDb,
  approvalId: ApprovalId,
  outcome: ApprovalOutcome,
  options: { now: Timestamp; reason?: string },
): void {
  const row = store.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)).get()
  if (row === undefined) throw new ExecutionReferenceError(`Approval 不存在: ${approvalId}`)
  if (row.status !== 'pending') {
    throw new ExecutionReferenceError(`Approval 已决(${row.status}),重复决策会破坏审计配对(§119 幂等)`)
  }
  store.db
    .update(approvals)
    .set({ status: 'decided', outcome, reason: options.reason, decidedAt: options.now })
    .where(eq(approvals.id, approvalId))
    .run()
}

function nextAttemptNo(store: WhisperTavernDb, runId: RunId): number {
  const rows = store.db.select({ attemptNo: attempts.attemptNo }).from(attempts).where(eq(attempts.runId, runId)).all()
  return rows.length === 0 ? 1 : Math.max(...rows.map((r) => r.attemptNo)) + 1
}
