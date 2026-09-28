/**
 * Agent Turn 开合与空 Turn 记账(agent-runtime-spec §37 / §37.1)。
 *
 * §37.1 三条规则的落地:
 * 1. **开合判据**——Turn 在"第一份输入被认领(claim)之前"开启;"不再欠任何东西时"关闭
 *    (没有待执行工具调用 / 待回灌工具结果 / 待认领的 next-step 输入)。
 * 2. **空 Turn 必须记账**——被拒绝的、或首份输入被改写为空的 Turn,照常开一条记录并正常关闭,
 *    只是 `stepCount = 0`、不消耗任何 Step。理由:否则"用户发了消息但 Agent 拒绝执行"
 *    这类事件在审计上完全消失(长 RP 里 worldbook 屏蔽 / 权限拦截 / 注入过滤正是要追的东西)。
 * 3. **Turn ≠ Attempt**——一次 Attempt 失败**不关闭** Turn;`maxTurns` 限制的是 Turn,不是 Step。
 *
 * 持久化面:spec 没有 `agent_turns` 表,而 §5.4 权威表把 `agent.turn.started` /
 * `agent.turn.completed` 定为 **durable**。故 Turn 记录落在 durable 事件里
 * (stepCount / endReason 进 payload),不臆造表——审计面与 §5.4 一致,Replay 也读得到。
 */
import type { EventBus, RuntimeEvent } from '@whispertavern/runtime'
import type { Timestamp } from '@whispertavern/contracts'
import { AGENT_TURN_END_REASONS, type AgentTurn, type AgentTurnEndReason } from './types'

export class AgentTurnError extends Error {
  constructor(message: string) {
    super(`AGENT_TURN_ERROR: ${message}`)
    this.name = 'AgentTurnError'
  }
}

export interface OpenTurnInput {
  runId: string
  /** 0-based;一次 Run 内单调递增 */
  index: number
  chatId?: string
  agentId?: string
  now: Timestamp
}

/**
 * Turn 生命周期句柄。
 *
 * "欠"的三项即 §37.1 关闭判据的充要条件;它们在这里是**可断言的集合**而不是注释,
 * 因为 S24 的工具循环一旦漏回灌,这里会立刻变红(而不是悄悄提前关闭 Turn)。
 */
export class AgentTurnTracker {
  private steps = 0
  private readonly pendingToolCalls = new Set<string>()
  private readonly pendingToolResults = new Set<string>()
  private pendingNextStepInputs = 0
  private closed = false
  private readonly startedEvent: RuntimeEvent

  constructor(
    private readonly bus: EventBus,
    private readonly input: OpenTurnInput,
  ) {
    this.startedEvent = bus.publish({
      type: 'agent.turn.started',
      runId: input.runId,
      aggregateType: 'agent-turn',
      aggregateId: `${input.runId}:turn-${input.index}`,
      timestamp: input.now,
      payload: {
        turnIndex: input.index,
        runId: input.runId,
        ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      },
    })
  }

  get turnIndex(): number {
    return this.input.index
  }

  get stepCount(): number {
    return this.steps
  }

  /** 仍欠着东西 → 不能以 `completed` 关闭(§37.1 一) */
  get owes(): boolean {
    return (
      this.pendingToolCalls.size > 0 || this.pendingToolResults.size > 0 || this.pendingNextStepInputs > 0
    )
  }

  /** §37.1 一:认领一份输入 = 消耗一个 Step */
  claimInput(): void {
    this.assertOpen()
    this.steps += 1
  }

  notePendingToolCall(toolCallId: string): void {
    this.assertOpen()
    this.pendingToolCalls.add(toolCallId)
  }

  resolveToolCall(toolCallId: string): void {
    this.pendingToolCalls.delete(toolCallId)
    this.pendingToolResults.add(toolCallId)
  }

  resolveToolResult(toolCallId: string): void {
    this.pendingToolResults.delete(toolCallId)
  }

  notePendingNextStepInput(count = 1): void {
    this.assertOpen()
    this.pendingNextStepInputs += count
  }

  resolveNextStepInput(count = 1): void {
    this.pendingNextStepInputs = Math.max(0, this.pendingNextStepInputs - count)
  }

  /**
   * 关闭 Turn(§37.1 一 + 二)。
   *
   * - `completed` 要求"不再欠任何东西"——欠着就是实现漏了回灌,直接抛;
   * - 其余原因(取消 / 预算 / 溢出 / 拒绝 / 空输入)表示**主动放弃在飞工作**,允许强制关闭;
   * - `stepCount` 由 `claimInput()` 累计;**空 Turn 天然为 0,且照样发事件**(§37.1 二)。
   */
  close(input: {
    endReason: AgentTurnEndReason
    now: Timestamp
    promptSnapshotId?: string
    generationId?: string
    result?: string
    toolCalls?: readonly string[]
  }): AgentTurn {
    this.assertOpen()
    if (!AGENT_TURN_END_REASONS.includes(input.endReason)) {
      throw new AgentTurnError(`未声明的 Turn 关闭原因: ${String(input.endReason)}`)
    }
    if (input.endReason === 'completed' && this.owes) {
      throw new AgentTurnError(
        `Turn ${this.input.index} 仍欠工作(工具调用 ${this.pendingToolCalls.size} / 工具结果 ${this.pendingToolResults.size} / next-step 输入 ${this.pendingNextStepInputs}),不得以 completed 关闭(§37.1)`,
      )
    }
    this.closed = true
    const turn: AgentTurn = {
      index: this.input.index,
      promptSnapshotId: input.promptSnapshotId ?? '',
      generationId: input.generationId ?? '',
      toolCalls: [...(input.toolCalls ?? [])],
      ...(input.result === undefined ? {} : { result: input.result }),
      stepCount: this.steps,
      endReason: input.endReason,
    }
    this.bus.publish({
      type: 'agent.turn.completed',
      runId: this.input.runId,
      aggregateType: 'agent-turn',
      aggregateId: this.startedEvent.aggregateId ?? `${this.input.runId}:turn-${this.input.index}`,
      timestamp: input.now,
      payload: {
        turnIndex: turn.index,
        stepCount: turn.stepCount,
        endReason: turn.endReason,
        toolCallCount: turn.toolCalls.length,
        promptSnapshotId: turn.promptSnapshotId,
        generationId: turn.generationId,
        // 正文长度而非正文:events 表面向审计,塞全文会把它撑爆(§5.4 分档的同一理由)
        resultLength: turn.result?.length ?? 0,
      },
    })
    return turn
  }

  /** §37.1 二:空 Turn 的显式入口——记账语义与普通 Turn 完全一致,只是 stepCount = 0 */
  closeEmpty(endReason: 'rejected' | 'empty_input', now: Timestamp): AgentTurn {
    if (this.steps !== 0) {
      throw new AgentTurnError(`closeEmpty 只用于空 Turn,当前 stepCount=${this.steps}`)
    }
    return this.close({ endReason, now })
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentTurnError(`Turn ${this.input.index} 已关闭,不得再操作(§37.1)`)
  }
}

/** 开启一个 Turn(§37.1:在第一份输入被认领之前) */
export function openTurn(bus: EventBus, input: OpenTurnInput): AgentTurnTracker {
  return new AgentTurnTracker(bus, input)
}
