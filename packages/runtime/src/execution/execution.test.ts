/**
 * 执行四层持久化底座单测(agent-runtime-spec §4.1.1 / §4.3 / §11 / §96 / §97 / §115.1)。
 *
 * 断言重点不是"写得进去",而是**不变量真的会被拦**——§4.1.1 说"禁止用 UPDATE 覆盖
 * 历史失败执行",§11 说"非法状态转换默认禁止",这两条如果只写在 spec 里就是散文。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttemptId, ChatId, RunId, StepRunId, Timestamp } from '@whispertavern/contracts'
import { createDatabase, type WhisperTavernDb } from '../db/database'
import { EventBus, type EventSink } from '../events/bus'
import { createChat } from '../tree/messages'
import type { RuntimeEvent } from '../events/catalog'
import {
  appendAttempt,
  appendOperation,
  appendStepRun,
  completeOperation,
  createExecutionRun,
  decideApproval,
  ExecutionReferenceError,
  ExecutionSequenceConflict,
  loadExecutionTree,
  recordArtifact,
  recordCheckpoint,
  recordToolCall,
  requestApproval,
  transitionRun,
  transitionStepRun,
} from './store'
import {
  assertTransition,
  canTransition,
  ExecutionStatusViolation,
  isTerminalStatus,
  LEGACY_EXECUTION_STATUS_ALIAS,
  normalizeExecutionStatus,
} from './status'
import {
  classifyRecovery,
  isZombie,
  markRunInterrupted,
  recoveryTargetStatus,
  scanForZombieRuns,
} from './recovery'

function ts(offsetSeconds = 0): Timestamp {
  return new Date(Date.UTC(2026, 8, 26, 3, 0, offsetSeconds)).toISOString() as Timestamp
}

let store: WhisperTavernDb
/** 无副作用 sink:本文件的关注点是执行层落库,事件只作为 chat 创建的前置副作用 */
const noopSink: EventSink = { insert: (_batch: readonly RuntimeEvent[]) => {} }
let bus: EventBus
let chatId: ChatId

beforeEach(() => {
  store = createDatabase(':memory:')
  bus = new EventBus(noopSink, { now: () => ts() })
  // createExecutionRun 的 chat_id 受 FK 约束(runs.chat_id → chats.id),故必须建真实 chat
  const chat = createChat(store, bus, { title: 'S22 执行层', now: ts() })
  if (!chat.ok) throw new Error(`建 chat 失败: ${chat.error.message}`)
  chatId = chat.value.id
})

afterEach(() => {
  store.close()
})

function makeRun(now = ts()): RunId {
  return createExecutionRun(store, { chatId, now })
}

describe('ExecutionStatus(§4.3 统一基底 + §11 非法转换 + §12 终态不可回退)', () => {
  it('主干与等待往返合法', () => {
    expect(canTransition('created', 'queued')).toBe(true)
    expect(canTransition('queued', 'running')).toBe(true)
    expect(canTransition('running', 'waiting')).toBe(true)
    expect(canTransition('waiting', 'running')).toBe(true)
    expect(canTransition('running', 'paused')).toBe(true)
    expect(canTransition('paused', 'resuming')).toBe(true)
    expect(canTransition('resuming', 'running')).toBe(true)
    expect(canTransition('running', 'succeeded')).toBe(true)
  })

  it('§11 列举的三条非法转换逐条被拒', () => {
    // spec 原文:completed → running / cancelled → running / failed → completed
    expect(canTransition('succeeded', 'running')).toBe(false)
    expect(canTransition('cancelled', 'running')).toBe(false)
    expect(canTransition('failed', 'succeeded')).toBe(false)
    expect(() => assertTransition('succeeded', 'running')).toThrow(ExecutionStatusViolation)
    expect(() => assertTransition('failed', 'running')).toThrow(/新建 Run|新建 Attempt/)
  })

  it('终态集合封闭:五个终态均无出边', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'] as const) {
      expect(isTerminalStatus(status)).toBe(true)
      for (const to of ['running', 'queued', 'waiting', 'succeeded', 'failed'] as const) {
        expect(canTransition(status, to), `${status} → ${to}`).toBe(false)
      }
    }
    // interrupted 是**待恢复态**而非终态(§96)
    expect(isTerminalStatus('interrupted')).toBe(false)
    expect(canTransition('interrupted', 'running')).toBe(true)
  })

  it('P0 遗留取值经别名归一到 §4.3 口径,未知取值返回 null(不静默吞)', () => {
    expect(LEGACY_EXECUTION_STATUS_ALIAS.streaming).toBe('running')
    expect(normalizeExecutionStatus('streaming')).toBe('running')
    expect(normalizeExecutionStatus('completed')).toBe('succeeded')
    expect(normalizeExecutionStatus('running')).toBe('running')
    expect(normalizeExecutionStatus('nope')).toBeNull()
  })
})

describe('执行四层写入与引用完整性(§4.1.1 / §4.1.2)', () => {
  it('Run → Attempt → Step Run → Operation 四层可写入,执行树可读回', () => {
    const runId = makeRun()
    const attemptId = appendAttempt(store, { runId, now: ts(1) })
    const stepRunId = appendStepRun(store, {
      attemptId,
      stepId: 'model.generate',
      stepRevision: 7,
      now: ts(2),
    })
    appendOperation(store, { stepRunId, type: 'provider_request', attemptNo: 1, now: ts(3) })

    const tree = loadExecutionTree(store, runId)
    expect(tree).toBeDefined()
    expect(tree?.run.id).toBe(runId)
    expect(tree?.attempts).toHaveLength(1)
    expect(tree?.stepRuns).toHaveLength(1)
    expect(tree?.operations).toHaveLength(1)
    // §4.4:历史 StepRun 保留当时的 revision
    expect(tree?.stepRuns[0]?.stepRevision).toBe(7)
  })

  it('引用完整性:Attempt 必须挂存在的 Run,StepRun 必须挂存在的 Attempt', () => {
    expect(() => appendAttempt(store, { runId: 'run_missing' as RunId, now: ts() })).toThrow(
      ExecutionReferenceError,
    )
    expect(() =>
      appendStepRun(store, { attemptId: 'attempt_missing' as AttemptId, stepId: 'x', stepRevision: 1, now: ts() }),
    ).toThrow(ExecutionReferenceError)
  })

  it('runs.attempt 是聚合 attemptNo,Retry 追加新 Attempt 而非改写旧记录(裁决 C3)', () => {
    const runId = makeRun()
    const first = appendAttempt(store, { runId, now: ts(1) })
    const second = appendAttempt(store, { runId, reason: 'provider 瞬时错误', now: ts(2) })

    expect(second).not.toBe(first)
    const tree = loadExecutionTree(store, runId)
    expect(tree?.attempts.map((a) => a.attemptNo).sort()).toEqual([1, 2])
    expect(tree?.run.attempt).toBe(2)
  })

  it('attempt_no 冲突拒绝:不许用同号覆盖历史 Attempt(§4.1.1)', () => {
    const runId = makeRun()
    appendAttempt(store, { runId, now: ts(1) })
    expect(() => appendAttempt(store, { runId, attemptNo: 1, now: ts(2) })).toThrow(ExecutionSequenceConflict)
  })

  it('Step Retry 新建 Step Run 且 retry_of 自动指向被取代的那一次', () => {
    const runId = makeRun()
    const attemptId = appendAttempt(store, { runId, now: ts(1) })
    const first = appendStepRun(store, { attemptId, stepId: 'model.generate', stepRevision: 3, now: ts(2) })
    transitionStepRun(store, first, 'running', { now: ts(3) })
    transitionStepRun(store, first, 'failed', { now: ts(4), error: { code: 'RATE_LIMIT' } })

    const second = appendStepRun(store, { attemptId, stepId: 'model.generate', stepRevision: 3, now: ts(5) })
    const tree = loadExecutionTree(store, runId)
    const rerun = tree?.stepRuns.find((s) => s.id === second)
    expect(rerun?.runNo).toBe(2)
    expect(rerun?.retryOf).toBe(first)
    // 同 Attempt 内 Step Retry **不新增 Attempt**(§4.2)
    expect(tree?.attempts).toHaveLength(1)
  })

  it('终态 Step Run 不可原地改写(失败的执行不能事后改成成功)', () => {
    const runId = makeRun()
    const attemptId = appendAttempt(store, { runId, now: ts(1) })
    const stepRunId = appendStepRun(store, { attemptId, stepId: 'model.generate', stepRevision: 1, now: ts(2) })
    transitionStepRun(store, stepRunId, 'running', { now: ts(3) })
    transitionStepRun(store, stepRunId, 'failed', { now: ts(4) })
    expect(() => transitionStepRun(store, stepRunId, 'succeeded', { now: ts(5) })).toThrow(ExecutionStatusViolation)
  })

  it('Run 终态不可回 running;用户重试走新建 Run + origin_run_id(§12 + 裁决 C3)', () => {
    const runId = makeRun()
    transitionRun(store, runId, 'queued', { now: ts(1) })
    transitionRun(store, runId, 'running', { now: ts(2) })
    transitionRun(store, runId, 'failed', { now: ts(3), error: 'boom' })
    expect(() => transitionRun(store, runId, 'running', { now: ts(4) })).toThrow(ExecutionStatusViolation)

    const retryRun = createExecutionRun(store, { chatId, originRunId: runId, now: ts(5) })
    const tree = loadExecutionTree(store, retryRun)
    expect(tree?.run.originRunId).toBe(runId)
    expect(loadExecutionTree(store, runId)?.run.status).toBe('failed')
  })

  it('Operation 默认可省略 step_run_id,但给了就必须存在(§4.5)', () => {
    const loose = appendOperation(store, { type: 'network_request', attemptNo: 1, now: ts(1) })
    expect(loose).toBeTruthy()
    expect(() =>
      appendOperation(store, {
        stepRunId: 'step_run_missing' as StepRunId,
        type: 'network_request',
        attemptNo: 1,
        now: ts(2),
      }),
    ).toThrow(ExecutionReferenceError)
  })

  it('Operation 可内部重试并终结(§4.5:设施级重试归 Operation)', () => {
    const runId = makeRun()
    const attemptId = appendAttempt(store, { runId, now: ts(1) })
    const stepRunId = appendStepRun(store, { attemptId, stepId: 'model.generate', stepRevision: 1, now: ts(2) })
    const op1 = appendOperation(store, { stepRunId, type: 'provider_request', attemptNo: 1, now: ts(3) })
    completeOperation(store, op1, 'timed_out', { now: ts(4), latencyMs: 30_000 })
    const op2 = appendOperation(store, { stepRunId, type: 'provider_request', attemptNo: 2, now: ts(5) })
    completeOperation(store, op2, 'succeeded', { now: ts(6), latencyMs: 120 })
    expect(loadExecutionTree(store, runId)?.operations.map((o) => o.status)).toEqual(['timed_out', 'succeeded'])
  })

  it('Tool Call / Artifact / Checkpoint 写入且挂在存在的 Run 上', () => {
    const runId = makeRun()
    const toolCallId = recordToolCall(store, { runId, toolName: 'search', arguments: { q: 'x' }, now: ts(1) })
    expect(toolCallId).toBeTruthy()
    expect(() => recordToolCall(store, { runId: 'run_missing' as RunId, toolName: 't', now: ts(1) })).toThrow(
      ExecutionReferenceError,
    )

    const artifactId = recordArtifact(store, { runId, type: 'outline', content: '# 大纲', frozen: true, now: ts(2) })
    expect(artifactId).toBeTruthy()

    const checkpointId = recordCheckpoint(store, {
      runId,
      turnIndex: 3,
      reason: 'before_provider',
      stateHash: 'sha256:abc',
      now: ts(3),
    })
    expect(checkpointId).toBeTruthy()
    expect(() =>
      recordCheckpoint(store, { runId: 'run_missing' as RunId, turnIndex: 1, reason: 'manual', stateHash: 'h', now: ts(4) }),
    ).toThrow(ExecutionReferenceError)
  })
})

describe('审批四值 fail-closed(§115.1 / R-P3-5)', () => {
  it('status 只表配对进度,结论在 outcome;只有 allowed_once 放行', () => {
    const runId = makeRun()
    const approvalId = requestApproval(store, {
      runId,
      action: 'write_file',
      risk: 'high',
      requestedPermissions: ['fs:write'],
      policyAtRequest: 'ask',
      now: ts(1),
    })
    decideApproval(store, approvalId, 'rejected', { now: ts(2), reason: '用户拒绝' })
    const row = store.sqlite
      .prepare<[string]>('SELECT status, outcome FROM approvals WHERE id = ?')
      .get(approvalId) as { status: string; outcome: string }
    expect(row.status).toBe('decided')
    expect(row.outcome).toBe('rejected')
  })

  it('重复决策被拒(§119 幂等:审计配对不能被写两次)', () => {
    const runId = makeRun()
    const approvalId = requestApproval(store, { runId, action: 'a', risk: 'low', now: ts(1) })
    decideApproval(store, approvalId, 'allowed_once', { now: ts(2) })
    expect(() => decideApproval(store, approvalId, 'rejected', { now: ts(3) })).toThrow(ExecutionReferenceError)
  })

  it('无回答者（后台/定时/群聊跑批）取 unavailable = 拒,不放行', () => {
    const runId = makeRun()
    const approvalId = requestApproval(store, { runId, action: 'spawn_child', risk: 'medium', now: ts(1) })
    decideApproval(store, approvalId, 'unavailable', { now: ts(2), reason: '无回答者,默认拒绝(R-P3-5)' })
    const row = store.sqlite
      .prepare<[string]>('SELECT outcome FROM approvals WHERE id = ?')
      .get(approvalId) as { outcome: string }
    expect(row.outcome).toBe('unavailable')
  })
})

describe('恢复语义骨架(§96 Run Recovery / §97 Zombie Run)', () => {
  it('§97 心跳静默超时判定用注入时间,无心跳则从 createdAt 起算', () => {
    const timeout = 5 * 60_000
    expect(isZombie({ lastHeartbeatAt: ts(0), createdAt: ts(0), now: ts(200), recoveryTimeoutMs: timeout })).toBe(false)
    expect(isZombie({ lastHeartbeatAt: ts(0), createdAt: ts(0), now: ts(400), recoveryTimeoutMs: timeout })).toBe(true)
    // 没有 last_heartbeat_at 不给"忘了写心跳"留后门
    expect(isZombie({ lastHeartbeatAt: null, createdAt: ts(0), now: ts(400), recoveryTimeoutMs: timeout })).toBe(true)
  })

  it('§96/§97 scan 只捕 running,把僵尸 Run 落到 interrupted(不是 failed)', () => {
    const zombie = makeRun(ts(0))
    transitionRun(store, zombie, 'running', { now: ts(1), heartbeat: true })
    const fresh = makeRun(ts(0))
    transitionRun(store, fresh, 'running', { now: ts(600), heartbeat: true })
    const done = makeRun(ts(0))
    transitionRun(store, done, 'queued', { now: ts(1) })
    transitionRun(store, done, 'running', { now: ts(2) })
    transitionRun(store, done, 'succeeded', { now: ts(3) })

    const zombies = scanForZombieRuns(store, { now: ts(600) })
    expect(zombies.map((z) => z.runId)).toEqual([zombie])

    markRunInterrupted(store, zombie, ts(601))
    expect(loadExecutionTree(store, zombie)?.run.status).toBe('interrupted')
    // 终态 Run 不受扫描影响
    expect(loadExecutionTree(store, done)?.run.status).toBe('succeeded')
  })

  it('§96 recovery 三选一:无 checkpoint→retry;不兼容→fail(§55);兼容→resume', () => {
    expect(classifyRecovery({ hasCheckpoint: false, checkpointCompatible: false }).action).toBe('retry')
    expect(classifyRecovery({ hasCheckpoint: true, checkpointCompatible: false }).action).toBe('fail')
    expect(classifyRecovery({ hasCheckpoint: true, checkpointCompatible: true }).action).toBe('resume')
    // retry 不判死 Run(§4.2:同 Run 内新 Attempt)
    expect(recoveryTargetStatus('retry')).toBe('running')
    expect(recoveryTargetStatus('resume')).toBe('resuming')
    expect(recoveryTargetStatus('fail')).toBe('failed')
  })
})
