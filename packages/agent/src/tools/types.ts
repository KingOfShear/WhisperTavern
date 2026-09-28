/**
 * Tool Runtime 对象形状(agent-runtime-spec §31–§36 / §38–§42 / §115)。
 *
 * 纪律:只转录 spec 已定义的形状。`PermissionSet` 的容器形状 spec 未定义
 * (§32 只引用),按字符串集合透传;`JSONSchema` 原样 unknown(spec §31 透传)。
 */
import type { CancellationToken, RunBudget } from '../runtime/types'
export type { CancellationToken }

/** §33 权限目录(封闭枚举,spec 原文十项;新权限须先入 spec) */
export const TOOL_PERMISSIONS = [
  'network.request',
  'filesystem.read',
  'filesystem.write',
  'chat.read',
  'chat.write',
  'worldbook.read',
  'worldbook.write',
  'memory.read',
  'memory.write',
  'provider.call',
] as const
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number]

/** §32 Tool Execution Context(逐字段对齐 spec;PermissionSet 形状 spec 未定义 → 字符串集合) */
export interface ToolExecutionContext {
  runId: string
  agentId: string
  chatId: string
  permissions: ReadonlySet<string>
  cancellationToken: CancellationToken
  budget: ToolBudget
  /**
   * §106 Cache Interaction:工具改了世界书 → 经此上报(Runtime 侧发 cache.invalidated +
   * 触发下轮重激活重编译)。可选:S23/S24 存量工具不感知世界书。BatchContext 同形继承。
   */
  reportWorldbookMutation?: (entryId: string) => void
}

/** §39 收编注:RunBudget 是本次 Run 的唯一执行判据;ToolBudget = Run 预算的工具面视图 */
export interface ToolBudget {
  remainingToolCalls: () => number
  /** §42 reserve→execute→settle:并发启动前预扣,防并行超支 */
  reserve: (estimated: number) => { ok: boolean; reason?: string }
  settle: (reserved: number, actual: number) => void
}

/** §31 Tool Definition(inputSchema 原样 JSON Schema 透传;executionMode 见 §36.3) */
export interface ToolDefinition {
  id: string
  name: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  permissions: readonly ToolPermission[]
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>
  /** §36.3:每次启动前**重新分类**(工具可因上下文变化在同 Turn 内从 parallel 变 exclusive) */
  executionMode?: (input: unknown, context: ToolExecutionContext) => ToolExecutionMode
  /**
   * §50 幂等分类:none 只读 / idempotent 可安全重试 / non_idempotent 外部副作用不可自动重试。
   * **缺省 = non_idempotent(保守)**——未声明的副作用按"不能自动重试"处理,自动重试
   * 只对显式声明 none/idempotent 的工具生效(S27 Recovery/Resume 对账同样按此分流)。
   */
  sideEffectLevel?: SideEffectLevel
}

/** §50 幂等分类(spec 形状逐字收编) */
export type SideEffectLevel = 'none' | 'idempotent' | 'non_idempotent'

/** §36.3 执行模式:sync 串行独占 / parallel 可并发 / exclusive 全局 barrier */
export type ToolExecutionMode = 'sync' | 'parallel' | 'exclusive'

/** §35 Tool Result(五值封闭 + D1 正交信号独立上报) */
export type ToolResultStatus = 'success' | 'error' | 'denied' | 'cancelled' | 'timeout'

/** §35 outcome 正交信号(工程纪律 D1:三个事实互不嵌套、各自上报) */
export interface ToolOutcomeSignals {
  timedOut: boolean
  signal?: string
  exitCode?: number | null
}

export interface ToolError {
  code: string
  message: string
  /** §36.2:流水线基础设施错误标记(语义同 error,额外便于观测) */
  infrastructure?: boolean
}

export interface ToolResult {
  toolCallId: string
  status: ToolResultStatus
  output?: unknown
  error?: ToolError
  durationMs?: number
  outcome?: ToolOutcomeSignals
}

/** 五段流水线的钩子面(§36.1;S24 内置段已实现,这里是对外扩展点) */
export type PreExecuteOutcome =
  | { action: 'allow'; input?: unknown; estimatedCost?: number }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason: string }

export type PostExecuteOutcome =
  | { action: 'accept' }
  | { action: 'block'; reason: string }
  | { action: 'replace'; output: unknown }
  | { action: 'add_context'; context: string }

/** §38 RuntimePolicy(已由 §39 收编注定为 RunBudget 的默认来源) */
export type { RunBudget }

/** §41 Budget Usage(每次执行更新) */
export interface BudgetUsage {
  turns: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cost?: number
  executionTimeMs: number
}

/** §115 Approval Request(spec 形状;payload 不携带工具入参——防两份副本漂移) */
export interface ApprovalRequest {
  id: string
  runId: string
  action: string
  description: string
  risk: 'low' | 'medium' | 'high'
  requestedPermissions: readonly string[]
  expiresAt?: string
  reason?: string
  toolCallId?: string
}

/** §115.1 四值封闭 + 默认拒绝 */
export const APPROVAL_OUTCOMES = ['allowed_once', 'rejected', 'cancelled', 'unavailable'] as const
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number]

/** §115.1 per-chat 策略:ask(默认)派发回答者链;never 不派发,确定性 rejected */
export type ApprovalPolicy = 'ask' | 'never'

/** §115.1 回答者:属于该 Run 所属 chat 的一方(UI / 操作者) */
export type ApprovalResponder = (request: ApprovalRequest) => Promise<ApprovalOutcome | string>
