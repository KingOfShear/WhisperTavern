/**
 * Run Recovery(agent-runtime-spec §96/§97 + 还账 #11,S27/WP3.5)。
 *
 * 三件事:
 * 1. **§97 Zombie Run 清零**——`running`/`waiting` 的 Run 靠 heartbeat 活着;
 *    超过 recoveryTimeout 无心跳 = 进程已死,扫描标记 `interrupted`(§96"不能直接
 *    认为成功"——不猜结果,留给 planRecovery 裁决)。崩溃后不产生永久 Zombie。
 * 2. **§96 恢复三选一**——resume / retry / fail,判据 = 检查点有无 + 未决工具调用的
 *    幂等分类(§50):有检查点且无未决副作用 → resume;未决工具全部幂等 → resume
 *    (重执行安全);未决非幂等 → 需要 reconciliation 才能继续;无检查点 → retry
 *    (从触发消息重放)。
 * 3. **non-idempotent 对账(§50,还账 #11)**——崩溃时 `running` 的 tool_calls 行:
 *    幂等/只读 → 标记 orphaned 允许重执行;非幂等 → **缺省阻塞**(除非调用方显式
 *    allowNonIdempotent 确认"外部状态已核对"),绝不静默重执行"发外部请求"类工具。
 */
import { eq } from 'drizzle-orm'
import type { RunId, Timestamp } from '@whispertavern/contracts'
import {
  runs as runsTable,
  runtimeCheckpoints as runtimeCheckpointsTable,
  toolCalls as toolCallsTable,
  transitionRun,
  loadRun,
  type EventBus,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import type { SideEffectLevel } from '../tools/types'
import { loadAgentInstance, transitionAgentInstance } from './instance'

/** §96/§97 Recovery 扫描:过期 heartbeat 的 running/waiting Run → interrupted */
export interface RecoveryScanResult {
  interruptedRunIds: RunId[]
  scannedAt: Timestamp
}

export function scanInterruptedRuns(
  store: WhisperTavernDb,
  bus: EventBus,
  input: { now: Timestamp; recoveryTimeoutMs: number },
): RecoveryScanResult {
  const cutoff = new Date(Date.parse(input.now) - input.recoveryTimeoutMs).toISOString()
  const rows = store.db.select().from(runsTable).all()
  const stale = rows.filter(
    (r) => (r.status === 'running' || r.status === 'waiting') && (r.lastHeartbeatAt === null || r.lastHeartbeatAt < cutoff),
  )
  const interruptedRunIds: RunId[] = []
  for (const r of stale) {
    // §11 弧:running/waiting → interrupted 均合法;interrupted 是待恢复态,不是终态
    transitionRun(store, r.id as RunId, 'interrupted', { now: input.now, error: 'recovery_timeout' })
    if (r.agentId !== null) {
      // Instance 行可能已不存在(手工建 Run / 实例早清)——复位守卫
      const inst = loadAgentInstance(store, r.chatId as import('@whispertavern/contracts').ChatId, r.agentId as import('@whispertavern/contracts').AgentId)
      if (inst !== undefined) {
        transitionAgentInstance(store, {
          chatId: r.chatId as import('@whispertavern/contracts').ChatId,
          agentId: r.agentId as import('@whispertavern/contracts').AgentId,
          to: 'idle',
          now: input.now,
          currentRunId: null,
        })
      }
    }
    bus.publish({
      type: 'agent.run.interrupted',
      ...(r.id ? { runId: r.id as RunId } : {}),
      aggregateType: 'agent-run',
      aggregateId: r.id,
      timestamp: input.now,
      payload: { runId: r.id, reason: 'recovery_timeout', lastHeartbeatAt: r.lastHeartbeatAt },
    })
    interruptedRunIds.push(r.id as RunId)
  }
  return { interruptedRunIds, scannedAt: input.now }
}

/** §50 幂等分类查询面:进程重启后工具注册表可能未就绪,未知工具按 non_idempotent(保守) */
export interface PendingToolCall {
  id: string
  toolName: string
  sideEffectLevel: SideEffectLevel
}

export type RecoveryAction = 'resume' | 'retry' | 'fail'

export interface RecoveryPlan {
  action: RecoveryAction
  reason: string
  /** 未决工具调用(§50 对账面;action=resume 且 pending 全幂等时也列出供审计) */
  pendingToolCalls: PendingToolCall[]
}

/** §96 恢复三选一裁决:检查点 + 未决工具幂等性 → resume/retry/fail */
export function planRecovery(
  store: WhisperTavernDb,
  runId: RunId,
  input?: { toolSideEffects?: Record<string, SideEffectLevel> },
): RecoveryPlan {
  const run = loadRun(store, runId)
  if (run === undefined) return { action: 'fail', reason: 'RUN_NOT_FOUND', pendingToolCalls: [] }
  const levelOf = (toolName: string): SideEffectLevel => input?.toolSideEffects?.[toolName] ?? 'non_idempotent'
  const pendingRows = store.db.select().from(toolCallsTable).where(eq(toolCallsTable.runId, runId)).all()
  const pending = pendingRows
    .filter((tc) => tc.status === 'running')
    .map((tc) => ({ id: tc.id, toolName: tc.toolName, sideEffectLevel: levelOf(tc.toolName) }))
  const hasCheckpoint = store.db.select().from(runtimeCheckpointsTable).where(eq(runtimeCheckpointsTable.runId, runId)).all().length > 0

  if (pending.some((tc) => tc.sideEffectLevel === 'non_idempotent')) {
    return { action: 'fail', reason: 'NON_IDEMPOTENT_PENDING:非幂等工具调用未决,需 reconciliation 确认外部状态(§50/§96)', pendingToolCalls: pending }
  }
  if (hasCheckpoint) {
    return {
      action: 'resume',
      reason: pending.length > 0 ? '检查点在且未决工具全部幂等 → 重执行安全' : '检查点在,无未决工具调用',
      pendingToolCalls: pending,
    }
  }
  return { action: 'retry', reason: '无检查点 → 从触发消息重放(新建 Attempt)', pendingToolCalls: pending }
}

export interface ReconcileResult {
  ok: boolean
  /** 幂等未决:已标记 orphaned,Resume 时按请求序重执行 */
  retried: string[]
  /** 非幂等未决:调用方显式 allow → 假定已完成并留痕(reconciled) */
  reconciled: string[]
  /** 非幂等未决且未获 allow:阻塞 Resume */
  blocked: PendingToolCall[]
}

/** §50 对账:崩溃残留的 running tool_calls 按幂等分类分流;阻塞面 = 未获允许的非幂等 */
export function reconcileToolCalls(
  store: WhisperTavernDb,
  input: {
    runId: RunId
    now: Timestamp
    toolSideEffects?: Record<string, SideEffectLevel>
    allowNonIdempotent?: boolean
  },
): ReconcileResult {
  const levelOf = (toolName: string): SideEffectLevel => input.toolSideEffects?.[toolName] ?? 'non_idempotent'
  const rows = store.db.select().from(toolCallsTable).where(eq(toolCallsTable.runId, input.runId)).all()
  const result: ReconcileResult = { ok: true, retried: [], reconciled: [], blocked: [] }
  for (const tc of rows) {
    if (tc.status !== 'running') continue
    const level = levelOf(tc.toolName)
    if (level !== 'non_idempotent') {
      store.db
        .update(toolCallsTable)
        .set({ status: 'orphaned', error: 'crash_orphan:幂等工具,允许重执行(§50)', completedAt: input.now })
        .where(eq(toolCallsTable.id, tc.id))
        .run()
      result.retried.push(tc.id)
    } else if (input.allowNonIdempotent === true) {
      store.db
        .update(toolCallsTable)
        .set({ status: 'reconciled', error: null, completedAt: input.now })
        .where(eq(toolCallsTable.id, tc.id))
        .run()
      result.reconciled.push(tc.id)
    } else {
      result.blocked.push({ id: tc.id, toolName: tc.toolName, sideEffectLevel: level })
    }
  }
  result.ok = result.blocked.length === 0
  return result
}

