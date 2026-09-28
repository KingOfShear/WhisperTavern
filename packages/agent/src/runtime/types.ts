/**
 * Agent 运行时对象形状(agent-runtime-spec §5–§9 / §13 / §37 / §38 / §1515)。
 *
 * 纪律(AGENTS §3 纪律 2 "spec 是真相源"):
 * - 本文件**只转录 spec 已定义的形状**,不发明字段。spec 引用但未定义的类型
 *   (GoalState / WorkingMemory / ToolPolicy / ModelPolicy / PermissionSet)
 *   一律按**不透明 JSON** 透传并标注归谁落地——早定义 = 早漂移。
 * - `AgentStatus` / `ExecutionStatus` 的单一真相源在 `@whispertavern/runtime`
 *   (`execution/status.ts`),此处**只引用不复刻**(shared-contracts §1:
 *   禁各模块自造同义核心类型)。
 */
import type {
  AgentId,
  ChatId,
  MessageId,
  RunId,
  Timestamp,
} from '@whispertavern/contracts'
import type { AgentStatus } from '@whispertavern/runtime'
import type { RuntimeVariables } from '@whispertavern/core'

/** §6 Agent Type —— 只是预定义角色;Runtime 不为每种类型写独立执行器(§6) */
export const AGENT_TYPES = [
  'character',
  'director',
  'writer',
  'checker',
  'editor',
  'tool-agent',
  'custom',
] as const
export type AgentType = (typeof AGENT_TYPES)[number]

/** §1483 RuntimePolicy —— 工具循环与 Turn 上限(maxTurns 限制 Turn 数,§37.1) */
export interface RuntimePolicy {
  maxTurns: number
  maxToolCalls: number
  maxExecutionTimeMs: number
}

/**
 * §8 Agent State —— Agent 在 Chat 中积累的运行状态。
 * **Agent State 不是 Prompt**(§8):Compiler 只读取其中允许暴露给 Context 的部分。
 * `goals` / `workingMemory` 的元素形状 spec 未定义(仅 §8 引用),故按不透明项透传。
 */
export interface AgentState {
  variables: Record<string, unknown>
  goals?: readonly Record<string, unknown>[]
  workingMemory?: readonly Record<string, unknown>[]
  counters?: Record<string, number>
  metadata?: Record<string, unknown>
}

export const EMPTY_AGENT_STATE: AgentState = { variables: {} }

/**
 * §5 Agent Definition —— **持久化资产**(§4 对象层级);`version` 与 `agent_versions`
 * 快照配对,支撑 §163 热重载(改 Definition 不影响在跑的 Run)。
 *
 * 五个 Policy 的落地分工(spec 未定义者不透传形状):
 * - `contextPolicy` / `memoryPolicy`:§18–§22 归 **S26**(R-P3-9:Memory 只落接口形状 + 空实现);
 * - `toolPolicy` / `modelPolicy`:spec 未定义,归 **S24**(Tool Runtime / 开放点 3);
 * - `runtimePolicy`:§38 已定义,本层直接转录。
 */
export interface AgentDefinition {
  id: AgentId
  version: number
  name: string
  description?: string
  type: AgentType
  instructions: string
  contextPolicy: Record<string, unknown>
  memoryPolicy: Record<string, unknown>
  toolPolicy: Record<string, unknown>
  modelPolicy: Record<string, unknown>
  runtimePolicy: RuntimePolicy
  metadata?: Record<string, unknown>
}

/** §7 Agent Instance —— 同一 Definition 在多个 Chat 各持一份独立 Runtime State */
export interface AgentInstance {
  id: string
  agentId: AgentId
  agentVersion: number
  chatId: ChatId
  state: AgentState
  status: AgentStatus
  currentRunId?: RunId
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** §1624 CancellationToken —— 所有 Runtime 操作必须支持(§44 取消传播) */
export interface CancellationToken {
  isCancelled(): boolean
  reason?: string
  onCancel(callback: () => void): void
}

/** §1515 RunBudget —— Agent Runtime 自己的预算(maxTurns 等) */
export interface RunBudget {
  maxTurns: number
  maxToolCalls: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxCost?: number
  maxExecutionTimeMs?: number
}

/** §13 Run Context —— 每次 Agent Run 自己的 Runtime Context */
export interface AgentRunContext {
  runId: RunId
  chatId: ChatId
  agentId: AgentId
  agentVersion: number
  triggerMessageId?: MessageId
  variables: RuntimeVariables
  branchId?: string
  budget: RunBudget
  cancellation: CancellationToken
  /** §33/§34 PermissionSet 的具体形状归 S24;此处不透明透传 */
  permissions: Record<string, unknown>
  parentRunId?: RunId
}

/**
 * §37.1 Turn 关闭原因(六值)+ `failed`。
 *
 * 补 `failed` 的理由(与 §4.3 补 `interrupted` 同类):§37.1 三 说"一次 Attempt 失败
 * **不关闭** Turn"——那是指**会重试**的瞬时失败;而当 Run 最终判死时,那个 Turn 若永不关闭,
 * `agent.turn.started` 就会**永远没有配对的 completed**,审计上成了悬空记录。
 * 原枚举六值里没有任何一个能表达"尝试终态失败",故补一值,已在 spec §37.1 记调和注。
 */
export const AGENT_TURN_END_REASONS = [
  'completed',
  'rejected',
  'empty_input',
  'cancelled',
  // S27 调和注:暂停面——Run 以 paused 挂起时 Turn 未关闭,Resume 从新 Attempt 续;
  // 此值只出现在暂停出口的打开态快照里(§51/§53)
  'paused',
  'budget_exceeded',
  'context_overflow',
  'failed',
] as const
export type AgentTurnEndReason = (typeof AGENT_TURN_END_REASONS)[number]

/**
 * §37 Agent Turn + §37.1 补充字段。
 *
 * **持久化面**:spec 没有 `agent_turns` 表,而 §5.4 权威表把
 * `agent.turn.started` / `agent.turn.completed` 定为 **durable**。故 Turn 记录落在
 * durable 事件里(`stepCount` / `endReason` 进 payload)——不臆造表(纪律 2)。
 */
export interface AgentTurn {
  index: number
  promptSnapshotId: string
  generationId: string
  toolCalls: string[]
  result?: string
  /** §37.1 本次 Turn 实际消耗的 Step 数,空 Turn 为 0 */
  stepCount: number
  /** §37.1 Turn 关闭原因 */
  endReason: AgentTurnEndReason
}

/** §154 Context Item —— 带 provenance 的上下文条目 */
export interface ContextItem {
  id: string
  type: string
  content: string
  source: ContextSource
  confidence?: number
  priority?: number
}

/** §155 Context Source —— **封闭五型**,不得自造变体(如 system / preset / persona) */
export type ContextSource =
  | { type: 'message'; messageId: string }
  | { type: 'memory'; memoryId: string }
  | { type: 'worldbook'; entryId: string }
  | { type: 'artifact'; artifactId: string }
  | { type: 'agent'; agentId: string }

/** §152 Context Resolution 的产物:解析结果 + provenance,**不含 Layout**(§153) */
export interface AgentContext {
  items: ContextItem[]
  /** 解析阶段走过的 stage(可审计;§152 的管线顺序) */
  stages: readonly ContextResolutionStage[]
}

/** §152 管线阶段名(逐字对齐该节流程图) */
export const CONTEXT_RESOLUTION_STAGES = [
  'agent-definition',
  'agent-runtime-state',
  'chat-state',
  'character-version',
  'persona-version',
  'preset-version',
  'worldbook-activation',
  'memory-retrieval',
  'summary',
  'history',
  'artifacts',
  'tool-results',
] as const
export type ContextResolutionStage = (typeof CONTEXT_RESOLUTION_STAGES)[number]
