/**
 * Agent Runtime Budget(agent-runtime-spec §38–§42)。
 *
 * §39 收编注的落地:RuntimePolicy(Definition 默认)与 RunBudget(本次 Run 生效值)
 * 二选一时**只以 RunBudget 为判据**——构造时已由调用方合并,本模块不再看 Policy。
 */
import type { BudgetUsage, ToolBudget } from './types'

export class BudgetExceeded extends Error {
  constructor(readonly code: 'RUN_BUDGET_EXCEEDED', message: string) {
    super(`${code}: ${message}`)
    this.name = 'BudgetExceeded'
  }
}

export interface RunBudgetEffective {
  maxTurns: number
  maxToolCalls: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxCost?: number
  maxExecutionTimeMs?: number
}

export class BudgetTracker {
  private readonly startedAt: number
  private usage: BudgetUsage = {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    executionTimeMs: 0,
  }
  /** §42:并发预扣池(reserve 未 settle 的量) */
  private reserved = 0

  constructor(private readonly budget: RunBudgetEffective) {
    this.startedAt = Date.now()
  }

  get snapshot(): Readonly<BudgetUsage> {
    return { ...this.usage, executionTimeMs: Date.now() - this.startedAt }
  }

  remainingToolCalls(): number {
    return Math.max(0, this.budget.maxToolCalls - this.usage.toolCalls - this.reserved)
  }

  /** §38:超限 = RUN_BUDGET_EXCEEDED(spec 原文名) */
  requireToolCall(): void {
    if (this.remainingToolCalls() <= 0) {
      throw new BudgetExceeded('RUN_BUDGET_EXCEEDED', `toolCalls 已达上限 ${this.budget.maxToolCalls}`)
    }
    this.usage.toolCalls += 1
  }

  requireTurn(): void {
    if (this.usage.turns >= this.budget.maxTurns) {
      throw new BudgetExceeded('RUN_BUDGET_EXCEEDED', `turns 已达上限 ${this.budget.maxTurns}`)
    }
    this.usage.turns += 1
  }

  /** §42 reserve→execute→settle;预扣失败 = 并发放不下,调用方不得启动 */
  reserveToolCalls(estimated: number): { ok: boolean; reason?: string } {
    if (estimated > this.remainingToolCalls()) {
      return { ok: false, reason: `RUN_BUDGET_EXCEEDED: 预扣 ${estimated} 超过剩余 ${this.remainingToolCalls()}` }
    }
    this.reserved += estimated
    return { ok: true }
  }

  settleToolCalls(reserved: number, actual: number): void {
    this.reserved = Math.max(0, this.reserved - reserved)
    // 预扣时已计 toolCalls 的量与实际的差 = 实际执行中消耗的增量(通常是 0:requireToolCall 已计)
    void actual
  }

  recordTokens(inputTokens: number, outputTokens: number, cachedTokens: number, cost?: number): void {
    this.usage.inputTokens += inputTokens
    this.usage.outputTokens += outputTokens
    this.usage.cachedTokens += cachedTokens
    if (cost !== undefined) this.usage.cost = (this.usage.cost ?? 0) + cost
    if (this.budget.maxInputTokens !== undefined && this.usage.inputTokens > this.budget.maxInputTokens) {
      throw new BudgetExceeded('RUN_BUDGET_EXCEEDED', `inputTokens 超过上限 ${this.budget.maxInputTokens}`)
    }
    if (this.budget.maxTotalTokens !== undefined && this.usage.inputTokens + this.usage.outputTokens > this.budget.maxTotalTokens) {
      throw new BudgetExceeded('RUN_BUDGET_EXCEEDED', `totalTokens 超过上限 ${this.budget.maxTotalTokens}`)
    }
  }

  /** 工具面视图(§32 ToolExecutionContext.budget) */
  toolView(): ToolBudget {
    return {
      remainingToolCalls: () => this.remainingToolCalls(),
      reserve: (estimated: number) => this.reserveToolCalls(estimated),
      settle: (reserved: number, actual: number) => this.settleToolCalls(reserved, actual),
    }
  }
}
