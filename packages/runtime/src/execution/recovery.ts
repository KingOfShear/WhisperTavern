/**
 * 恢复语义骨架(agent-runtime-spec §96 Run Recovery / §97 Zombie Run)。
 *
 * 本会话只落**状态流转与判定**,不含 Resume 完整实现(§51–§58 归 S27)。
 * 两条硬约束来自 spec:
 * - §96:进程崩溃后 Run 停在 `running`,**重启不能直接认为成功**——必须经 recovery scan
 *   落到 `interrupted`,再由 Provider / Tool 状态决定 resume / retry / fail;
 * - §97:禁止永久 `running`——心跳(`last_heartbeat_at`)超 `recoveryTimeout` 即 `interrupted`。
 *
 * 判据是**注入的时间**,不是 wall-clock:同一份数据在任何时刻重放得到同一结论
 * (X14 确定性;S27 的 Replay 依赖此性质)。
 */
import { inArray } from 'drizzle-orm'
import type { RunId, Timestamp } from '@whispertavern/contracts'
import type { WhisperTavernDb } from '../db/database'
import { runs } from '../db/schema'
import { transitionRun } from './store'
import type { ExecutionStatus } from './status'

/** §97 recoveryTimeout 缺省 5 分钟;可被调用方按 Provider 特性覆盖 */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 5 * 60_000

/** 僵尸候选:**仅 `running`**(§97 的目标是"禁止永久 running";waiting 由 durable 事件唤醒,§116) */
const ZOMBIE_CANDIDATE_STATUSES = ['running'] as const

export interface ZombieRunReport {
  runId: RunId
  lastHeartbeatAt: Timestamp | null
  /** 距判定点的静默时长(ms);无心跳记录 = 从 createdAt 起算 */
  silentMs: number
}

/**
 * §97 判定:心跳静默超过 recoveryTimeout = Zombie Run。
 * 无 `last_heartbeat_at` 的记录(None)按 `createdAt` 起算,不给"忘了写心跳"留后门。
 */
export function isZombie(input: {
  lastHeartbeatAt: Timestamp | null
  createdAt: Timestamp
  now: Timestamp
  recoveryTimeoutMs?: number
}): boolean {
  const timeout = input.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
  const baseline = input.lastHeartbeatAt ?? input.createdAt
  return Date.parse(input.now) - Date.parse(baseline) > timeout
}

/** §96/§97 扫描:只读,不改状态——判定与处置分离,便于 Inspector / 测试单独断言 */
export function scanForZombieRuns(
  store: WhisperTavernDb,
  options: { now: Timestamp; recoveryTimeoutMs?: number },
): ZombieRunReport[] {
  const rows = store.db
    .select({
      id: runs.id,
      lastHeartbeatAt: runs.lastHeartbeatAt,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(inArray(runs.status, [...ZOMBIE_CANDIDATE_STATUSES]))
    .all()
  const out: ZombieRunReport[] = []
  for (const row of rows) {
    const zombie = isZombie({
      lastHeartbeatAt: row.lastHeartbeatAt,
      createdAt: row.createdAt,
      now: options.now,
      recoveryTimeoutMs: options.recoveryTimeoutMs,
    })
    if (!zombie) continue
    const baseline = row.lastHeartbeatAt ?? row.createdAt
    out.push({
      runId: row.id as RunId,
      lastHeartbeatAt: (row.lastHeartbeatAt ?? null) as Timestamp | null,
      silentMs: Date.parse(options.now) - Date.parse(baseline),
    })
  }
  return out
}

/**
 * §96 处置:`running → interrupted`(待恢复),**不是**失败。
 * 恢复动作(resume / retry / fail)由 `classifyRecovery` 在拿到 Provider / Tool
 * 状态后决定,本函数只负责把永不结束的 `running` 关掉。
 */
export function markRunInterrupted(store: WhisperTavernDb, runId: RunId, now: Timestamp): void {
  transitionRun(store, runId, 'interrupted', { now })
}

export type RecoveryAction = 'resume' | 'retry' | 'fail'

export interface RecoveryVerdict {
  action: RecoveryAction
  reason: string
}

/**
 * §96 recovery 三选一。判据(与 §55 Resume 安全性对齐,完整版归 S27):
 * - 无可用 checkpoint → `retry`(没有安全恢复点,从该 Attempt 重来);
 * - checkpoint 与当前 dependency manifest 不兼容 → `fail`(§55 `RESUME_INCOMPATIBLE`,
 *   默认不强行恢复);
 * - 其余 → `resume`。
 */
export function classifyRecovery(input: {
  hasCheckpoint: boolean
  /** §55:state_hash / dependency_manifest 是否兼容 */
  checkpointCompatible: boolean
}): RecoveryVerdict {
  if (!input.hasCheckpoint) {
    return { action: 'retry', reason: '无可用 checkpoint,退回该 Attempt 重跑(§96)' }
  }
  if (!input.checkpointCompatible) {
    return { action: 'fail', reason: 'RESUME_INCOMPATIBLE:checkpoint 与 dependency manifest 不一致(§55)' }
  }
  return { action: 'resume', reason: 'checkpoint 兼容,可从最近安全点续跑(§51–§55)' }
}

/**
 * interrupted 的恢复去向。注意 **retry 不终结 Run**:§4.2 明确 Provider / Tool 瞬时
 * 错误 = 同 Run 内新 Attempt(§47 左半),故 Run 回到 `running` 并追加一条 Attempt,
 * 而不是把 Run 判死——判死会丢掉这个 Run 的完整执行历史(§12)。
 */
export function recoveryTargetStatus(action: RecoveryAction): ExecutionStatus {
  switch (action) {
    case 'resume':
      return 'resuming'
    case 'retry':
      return 'running'
    case 'fail':
      return 'failed'
  }
}
