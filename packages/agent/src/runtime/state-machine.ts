/**
 * Agent 状态机(agent-runtime-spec §9 Agent Status / §10 Agent State Machine / §11 非法转换)。
 *
 * 与 `ExecutionStatus`(**Run/Attempt/StepRun/Operation** 的执行层级)分工不同(§4.3 末条):
 * - `ExecutionStatus` 描述"这一次执行到哪了";
 * - `AgentStatus` 是 **Agent Instance 的聚合状态**,由当前 Run / Attempt 归约而来。
 * 两者不合并——所以本文件在 runtime 的转换表之外**另立一张表**,而不是复用那张。
 *
 * 【§11 三条硬禁止】`completed → running` / `cancelled → running` / `failed → completed`。
 * 注意 `failed → running` 是**允许**的:它对应 §10 图里的 `retry` 弧。这与 Run 的
 * "终态不可回退"(§12)不矛盾——Run 是执行记录(不可变),Agent Instance 是活着的聚合态
 * (可再次接单)。
 */
import { AGENT_STATUSES, type AgentStatus } from '@whispertavern/runtime'

/** §9 取值全集(含 §29 收编的 `interrupted`,见文件末调和注) */
export { AGENT_STATUSES, type AgentStatus }

/** §11 终态**瞬态**:无出边指向 running,但可回 `idle` 复位(见文件末调和注) */
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = ['completed', 'cancelled']

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status)
}

/**
 * 允许的转换:
 *
 * ```text
 * idle → queued → running → { waiting | paused | completed | failed | cancelled | interrupted }
 * waiting → { running | cancelled }                (§10)
 * paused  → { running | cancelled }                (§10)
 * failed  → running                                (§10 的 retry 弧)
 * interrupted → { running | cancelled | failed }   (§29 收编,§96/§97 同源)
 * {running,waiting,interrupted,completed,cancelled,failed} → idle   ← 聚合复位(调和注)
 * ```
 *
 * **为什么必须有"→ idle"**:§29 的 `UNIQUE(chat_id, agent_id)` 只允许每个 (chat, agent)
 * 一行 Instance,而 §11 又禁止 `completed → running`。两者相撞的唯一自洽解是
 * "Run 收尾后聚合态复位为 idle,下一次触发走 idle → queued → running(新 Run)"。
 * 这样 §11 的禁止**逐条仍然成立**(永远不存在 completed → running 这条边)。
 */
const ALLOWED: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ['queued'],
  queued: ['running', 'cancelled', 'failed', 'idle'],
  running: ['waiting', 'paused', 'completed', 'failed', 'cancelled', 'interrupted', 'idle'],
  waiting: ['running', 'cancelled', 'failed', 'interrupted', 'idle'],
  paused: ['running', 'cancelled', 'failed', 'interrupted', 'idle'],
  interrupted: ['running', 'cancelled', 'failed', 'idle'],
  failed: ['running', 'idle'],
  completed: ['idle'],
  cancelled: ['idle'],
}

export function canTransitionAgent(from: AgentStatus, to: AgentStatus): boolean {
  return ALLOWED[from].includes(to)
}

/** 非法转换 = 实现 bug(§11:默认禁止),不是可恢复的运行期错误 */
export class AgentStatusViolation extends Error {
  constructor(from: AgentStatus, to: AgentStatus, hint: string) {
    super(`INVARIANT_VIOLATION: 非法 Agent 状态转换 ${from} → ${to}(${hint})`)
    this.name = 'AgentStatusViolation'
  }
}

export function assertAgentTransition(from: AgentStatus, to: AgentStatus): void {
  if (canTransitionAgent(from, to)) return
  const hint = isTerminalAgentStatus(from)
    ? '终态无出边(§11);需要重新执行请新建 Run(§11/§12)'
    : '不在 §10 允许弧内'
  throw new AgentStatusViolation(from, to, hint)
}

/**
 * spec 调和注(两条,均与 runtime `execution/status.ts` 的注同源,须与 spec 同步):
 *
 * ① **`interrupted`**:§9 的 `AgentStatus` 枚举未列它,但 database-schema §29 的
 *    `agent_runtime_states.status` 取值表列了,且 §97 要求"心跳超时 → interrupted"。
 *    故取 §9 八值 **+ interrupted**(纯补漏)。
 *
 * ② **`→ idle`(聚合复位)**:§10 的图把 AgentStatus 画成 `idle → … → completed` 的
 *    一次性流程,§11 又禁止 `completed → running`;而 §29 的 `UNIQUE(chat_id, agent_id)`
 *    规定每个 (chat, agent) **只有一行** Instance(§7:同一 Definition 在多 Chat 各持一份
 *    "独立 Runtime State",是长期对象)。三条约束同时成立只有一个解:
 *    **`completed` / `failed` / `cancelled` 是"刚结束那次 Run 的结果"的瞬态,不驻留;
 *    Run 收尾即复位为 `idle`**,下一次触发走 `idle → queued → running`(新 Run)。
 *    于是 §11 的三条禁止仍然逐字成立——`completed → running` 这条边**永远不存在**。
 *
 *    §4.3 末条为此提供了依据:AgentStatus 是"由当前 Run / Attempt 归约"的**聚合态**;
 *    没有在跑的 Run 时,聚合结果就是 `idle`。
 */
export const AGENT_STATUS_SPEC_NOTES = [
  'interrupted 由 database-schema §29 + §97 收编(§9 原枚举漏列)',
  'completed/failed/cancelled 为瞬态,Run 收尾复位 idle(§7 长期 Instance + §29 UNIQUE + §11 共同推出)',
] as const
