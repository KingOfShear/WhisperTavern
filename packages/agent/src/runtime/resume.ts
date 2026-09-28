/**
 * Run Resume(agent-runtime-spec §51–§55,S27/WP3.5)。
 *
 * §52 核心原则:**不是重新执行整个 Agent**——状态都在(消息树 + 检查点 +
 * tool_calls 账),Resume = 兼容性校验(§55)→ 未决工具对账(§50,还账 #11)→
 * 状态推进 → 复用 runAgent 循环从树尾继续编译。Turn 1/2/3 里已完成的轮次
 * 天然不重执行(它们的产物已入树),暂停点之后的轮次继续。
 *
 * §55 安全性:Resume 前比对 runs.dependencyManifest(compiler 版本 / agent 版本 /
 * model);不兼容 → RESUME_INCOMPATIBLE,**默认不强行恢复**;用户可显式
 * force(≈ spec 的 force_resume;migrate/restart 归调用方编排)。
 */
import type {
  AgentRunResult,
} from './run-agent'
import type { ProviderAdapter, ProviderTool, RunId, Timestamp } from '@whispertavern/contracts'
import {
  SERVER_COMPILER_VERSION,
  transitionRun,
  runs as runsTable,
  type EventBus,
  type SnapshotRegistry,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import type { ContextPolicy, OutputPolicy } from '../index'
import type { Artifact } from '../artifacts/store'
import type { SideEffectLevel } from '../tools/types'
import { eq } from 'drizzle-orm'
import type { CancellationToken } from '../tools/types'
import { getOrCreateAgentInstance, transitionAgentInstance } from './instance'
import { reconcileToolCalls } from './recovery'
import { runAgent } from './run-agent'

/** 恢复上下文:调用方在**新进程**里重新提供的执行要素(adapter 等不持久化) */
export interface ResumeRunInput {
  runId: RunId
  chatId: import('@whispertavern/contracts').ChatId
  agentId: import('@whispertavern/contracts').AgentId
  adapter: ProviderAdapter
  providerId: string
  model: string
  sampling?: import('@whispertavern/contracts').ProviderChatRequest['sampling']
  signal?: AbortSignal
  tools?: readonly ProviderTool[]
  contextPolicy?: ContextPolicy
  outputPolicy?: OutputPolicy
  artifacts?: readonly Artifact[]
  permissions?: ReadonlySet<string>
  cancellation?: CancellationToken
  budget?: { maxTurns?: number; maxToolCalls?: number; maxExecutionTimeMs?: number }
  /** §50:非幂等未决工具的对账许可(缺省阻塞) */
  allowNonIdempotent?: boolean
  /** §50 幂等分类注册面(重启后工具注册表可能未就绪;未知 = non_idempotent 保守) */
  toolSideEffects?: Record<string, SideEffectLevel>
  /** §55:不兼容时强行恢复(≈ force_resume;restart/migrate 归调用方) */
  force?: boolean
  mode?: 'live' | 'simulation' | 'replay' | 'debug'
  now: Timestamp
}

export type ResumeRunResult = AgentRunResult

/** §51 一级能力:resume(runId) 从最近安全检查点继续 */
export async function resumeRun(
  deps: {
    store: WhisperTavernDb
    bus: EventBus
    snapshots: SnapshotRegistry
    registry?: import('../tools/registry').ToolRegistry
    onUsageRecorded?: () => void
  },
  input: ResumeRunInput,
): Promise<ResumeRunResult> {
  const { store, bus } = deps
  const run = store.db.select().from(runsTable).where(eq(runsTable.id, input.runId)).get()
  if (run === undefined) {
    return { ok: false, error: { code: 'RESUME_RUN_NOT_FOUND', message: `Run 不存在: ${input.runId}`, retryable: false } }
  }
  if (run.status !== 'paused' && run.status !== 'interrupted' && run.status !== 'waiting') {
    return {
      ok: false,
      error: {
        code: 'RESUME_INVALID_STATE',
        message: `Run ${input.runId} 状态为 ${run.status},仅 paused/interrupted/waiting 可恢复(§51)`,
        retryable: false,
      },
    }
  }

  // —— §55 兼容性:manifest vs 当前进程 ——
  const manifest = JSON.parse(run.dependencyManifest ?? '{}') as { compilerVersion?: string; agentVersion?: number; model?: string }
  const incompatible: string[] = []
  if (manifest.compilerVersion !== undefined && manifest.compilerVersion !== SERVER_COMPILER_VERSION) {
    incompatible.push(`compiler ${manifest.compilerVersion} → ${SERVER_COMPILER_VERSION}`)
  }
  if (manifest.model !== undefined && manifest.model !== input.model) {
    incompatible.push(`model ${manifest.model} → ${input.model}`)
  }
  if (incompatible.length > 0 && input.force !== true) {
    return {
      ok: false,
      error: {
        code: 'RESUME_INCOMPATIBLE',
        message: `依赖清单不兼容(§55): ${incompatible.join('; ')}——可选 restart / migrate / force_resume`,
        retryable: false,
      },
    }
  }

  // —— §50 未决工具对账(还账 #11):非幂等未获许 → 阻塞 ——
  const recon = reconcileToolCalls(store, {
    runId: input.runId,
    now: input.now,
    ...(input.toolSideEffects !== undefined ? { toolSideEffects: input.toolSideEffects } : {}),
    ...(input.allowNonIdempotent !== undefined ? { allowNonIdempotent: input.allowNonIdempotent } : {}),
  })
  if (!recon.ok) {
    return {
      ok: false,
      error: {
        code: 'TOOL_RECONCILIATION_REQUIRED',
        message: `非幂等工具调用未决,需显式确认外部状态(§50): ${recon.blocked.map((b) => `${b.id}(${b.toolName})`).join(', ')}`,
        retryable: false,
      },
    }
  }

  // —— 状态推进:paused/interrupted → resuming → running(§11 弧)——
  transitionRun(store, input.runId, 'resuming', { now: input.now })
  transitionRun(store, input.runId, 'running', { now: input.now })
  // Instance 行可能不存在(崩溃 Run 未建实例)→ 先取或建;paused 出口已复位 idle →
  // 走 queued→running 合法弧(§10)
  getOrCreateAgentInstance(store, {
    chatId: input.chatId,
    agentId: input.agentId,
    agentVersion: manifest.agentVersion ?? 0,
    now: input.now,
  })
  transitionAgentInstance(store, {
    chatId: input.chatId,
    agentId: input.agentId,
    to: 'queued',
    now: input.now,
  })
  transitionAgentInstance(store, {
    chatId: input.chatId,
    agentId: input.agentId,
    to: 'running',
    now: input.now,
    currentRunId: input.runId,
  })
  bus.publish({
    type: 'agent.run.resumed',
    runId: input.runId,
    aggregateType: 'agent-run',
    aggregateId: input.runId,
    timestamp: input.now,
    payload: { runId: input.runId, ...(recon.retried.length > 0 ? { orphanedRetried: recon.retried } : {}), ...(recon.reconciled.length > 0 ? { reconciled: recon.reconciled } : {}) },
  })

  // —— 复用循环:Turn 序号 = 原 Run 的聚合 attempt 号(新 Attempt 新 Turn)——
  return runAgent(deps, {
    chatId: input.chatId,
    agentId: input.agentId,
    adapter: input.adapter,
    providerId: input.providerId,
    model: input.model,
    ...(input.sampling !== undefined ? { sampling: input.sampling } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.contextPolicy !== undefined ? { contextPolicy: input.contextPolicy } : {}),
    ...(input.outputPolicy !== undefined ? { outputPolicy: input.outputPolicy } : {}),
    ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
    ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    ...(input.cancellation !== undefined ? { cancellation: input.cancellation } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    existingRunId: { runId: input.runId, turnIndex: run.attempt },
    now: input.now,
  })
}
