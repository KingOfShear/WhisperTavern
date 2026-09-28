/**
 * 执行状态语义(agent-runtime-spec §4.1.1 / §4.3 / §9 / §11 / §12 / §96–§98)。
 *
 * 权威边界:
 * - `ExecutionStatus`(§4.3)是 Run / Attempt / Step Run / Operation **四层共用**的
 *   生命周期基底,四层只在其上取子集——禁止各对象各持一套互不兼容的状态集合。
 * - `AgentStatus`(§9)是 Agent Instance 的**聚合状态**,由当前 Run / Attempt 归约而来,
 *   **不与 ExecutionStatus 合并**(§4.3 末条)。
 * - 状态转换合法性在此集中定义并断言(§11 "非法状态转换默认禁止");DB 侧只存 TEXT,
 *   合法性由本条断言守住,而不是靠数据库 CHECK 约束(便于 Replay / 迁移的场景化处理)。
 *
 * 【工程纪律 D1 同源】状态是**正交**的:超时、取消、失败各自成值,不做嵌套。
 */

/** §4.3 基底。`interrupted` 见节末"spec 调和"注。 */
export const EXECUTION_STATUSES = [
  'created',
  'queued',
  'running',
  'waiting',
  'paused',
  'resuming',
  'interrupted',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'skipped',
] as const

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

/**
 * 终态:进入后**不可原地改写**,只能留痕或新建记录(§4.1.1 / §11 / §12)。
 * `interrupted` 不在此列——它是**待恢复态**(§96 "重启后不能直接认为成功"),
 * Recovery 扫描后按 Provider / Tool 状态决定 resume / retry / fail。
 */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'skipped',
]

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.includes(status)
}

/**
 * 允许的转换全集(§4.3 + §11 + §96)。四层共用:
 * - `created → queued → running` 是主干;
 * - `running` 可经 `waiting`(等 tool / child / approval / 外部事件,§116)与
 *   `paused / resuming` 往返;
 * - 终态**无出边**——`completed → running` / `cancelled → running` / `failed → succeeded`
 *   一律拒绝(§11 逐条)。重跑 = 新建 Run(§12)或新建 Attempt / Step Run(§4.2);
 * - `interrupted → running | paused | failed` 承载 §96 的 recovery 三选一。
 */
const ALLOWED: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  // `→ skipped`:开了但没活可干(§4.3 的 skipped 就是为这种"空执行"准备的)。
  // S23 的 Agent 空 Turn 路径需要它:Turn 照常记账,但那个 Run 确实什么都没执行。
  created: ['queued', 'running', 'cancelled', 'failed', 'skipped'],
  queued: ['running', 'cancelled', 'failed', 'timed_out', 'skipped'],
  running: ['waiting', 'paused', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'],
  waiting: ['running', 'resuming', 'failed', 'cancelled', 'timed_out', 'interrupted'],
  paused: ['resuming', 'running', 'failed', 'cancelled', 'interrupted'],
  resuming: ['running', 'waiting', 'paused', 'failed', 'cancelled', 'interrupted'],
  interrupted: ['resuming', 'running', 'paused', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  skipped: [],
}

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return ALLOWED[from].includes(to)
}

/** 非法转换 = 实现 bug,不是可恢复的运行期错误(§11:默认禁止) */
export class ExecutionStatusViolation extends Error {
  constructor(from: ExecutionStatus, to: ExecutionStatus, hint: string) {
    super(`INVARIANT_VIOLATION: 非法执行状态转换 ${from} → ${to}(${hint})`)
    this.name = 'ExecutionStatusViolation'
  }
}

export function assertTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (canTransition(from, to)) return
  const hint = isTerminalStatus(from)
    ? '终态不可原地改写;重跑请新建 Run(§12)或新建 Attempt / Step Run(§4.2)'
    : '不在 §4.3 允许集合内'
  throw new ExecutionStatusViolation(from, to, hint)
}

/**
 * P0–P2 遗留取值 → §4.3 口径别名(runtime/generation/run.ts 现写 `streaming` / `completed`)。
 *
 * 用途:让"统一状态词汇"这件事**机器可见**——读取既有 runs 行时先归一,新增写入一律用
 * §4.3 取值。存量行的回填(把 streaming/completed 改名为 running/succeeded)属跨模块
 * 语义变更,归 S23「Agent 执行生命周期」,不在本会话静默改写(P3-plan §4 注记)。
 */
export const LEGACY_EXECUTION_STATUS_ALIAS = {
  streaming: 'running',
  completed: 'succeeded',
} as const satisfies Record<string, ExecutionStatus>

export function normalizeExecutionStatus(raw: string): ExecutionStatus | null {
  if ((EXECUTION_STATUSES as readonly string[]).includes(raw)) return raw as ExecutionStatus
  const alias = (LEGACY_EXECUTION_STATUS_ALIAS as Record<string, ExecutionStatus | undefined>)[raw]
  return alias ?? null
}

/**
 * §9 / §29 AgentStatus —— Agent Instance 的**聚合**状态,由当前 Run / Attempt 归约,
 * 不与 ExecutionStatus 合并(§4.3)。`idle` 表示"无在跑工作",但它是**区间状态**:
 * 多条排队消息 / 注入上下文 / 后台作业可能共享同一 `running` 区间,把 `idle` 读成
 * "我刚发的那条跑完了"是禁止的(technical-design §5.5 纪律 D3)。
 */
export const AGENT_STATUSES = [
  'idle',
  'queued',
  'running',
  'waiting',
  'paused',
  'interrupted',
  'failed',
  'completed',
  'cancelled',
] as const

export type AgentStatus = (typeof AGENT_STATUSES)[number]

/** Agent 侧终态(§29):`idle` 不是终态,而是"可再次接单"的聚合态 */
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = ['failed', 'completed', 'cancelled']

/**
 * spec 调和注(本文件唯一一处偏离 §4.3 字面的地方,须与 spec 同步):
 * §4.3 的 `ExecutionStatus` 未列 `interrupted`,但 §96(running → recovery scan →
 * unknown / interrupted)、§97(心跳超时 → interrupted)、§98(InternalRunStatus)与
 * database-schema §34(runs.status 取值表)四处都要求它存在,且 §34 明示它是
 * "进程崩溃 / 心跳超时后的**待恢复态**"。故本实现取 §4.3 基底 **+ interrupted**,
 * 已在 agent-runtime-spec §4.3 补记(纯补漏,不改任何既有取值语义)。
 */
export const EXECUTION_STATUS_SPEC_NOTE = 'interrupted 由 §96/§97/§98 + database-schema §34 收编' as const
