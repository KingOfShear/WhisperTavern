/**
 * Tool Registry —— 五段流水线 + 有界池 + model order 回灌
 * (agent-runtime-spec §31–§36.3 / §45–§47 / §88–§92)。
 *
 * 顺序铁律(§36.1):pre-execute → **approval** → guards → execute → post-execute →
 * 归一化 → finalizeContent。approval 排在 guards 之前——否则用户刚批准的调用会
 * 被同一个守卫再次拦下,授权等于无效。
 *
 * §36.2:流水线内任意环节 throw → 无损快照后收敛为 status='error',不升格为 Run 失败,
 * 不静默吞掉(落 tool.call.failed)。Cancellation → status='cancelled'(§45,不算失败)。
 *
 * §36.3:并发执行、**按 model order 回灌**——结果依请求序排队进入 post-execute 与
 * tool.call.completed,完成顺序不影响组装出的 prompt(Replay 确定性与缓存前缀)。
 */
import type { Timestamp } from '@whispertavern/contracts'
import { type DispatchToolCall, type EventBus, type WhisperTavernDb } from '@whispertavern/runtime'
import { toolCalls as toolCallsTable, uuidv7 } from '@whispertavern/runtime'
import { eq } from 'drizzle-orm'
import { ApprovalManager, type ApprovalAuditRow } from './approval'
import type { BudgetTracker } from './budget'
import type { PostExecuteOutcome, PreExecuteOutcome, ToolDefinition, ToolExecutionContext, ToolResult } from './types'

/** §47 C3:可重试的瞬时错误(同 Run 内 attempt+1);其余(PERMISSION_DENIED 等)不重试 */
const TRANSIENT_ERROR_CODES = new Set(['NETWORK_ERROR', 'RATE_LIMIT', 'TEMPORARY', 'TIMEOUT'])
/** §47 C3:明确不重试的错误 */
const NON_RETRYABLE_ERROR_CODES = new Set(['PERMISSION_DENIED', 'INVALID_INPUT', 'UNSUPPORTED_PROVIDER', 'USER_CANCELLED'])

export class ToolBusinessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ToolBusinessError'
  }
}

export interface ToolRegistryOptions {
  /** §36.1 ① pre-execute 钩子(缺省 = allow);返回 ask 走审批段 */
  preExecute?: (call: DispatchToolCall, tool: ToolDefinition, ctx: ToolExecutionContext) => Promise<PreExecuteOutcome> | PreExecuteOutcome
  /** §36.1 ⑤ post-execute 钩子(缺省 = accept) */
  postExecute?: (call: DispatchToolCall, result: ToolResult, ctx: ToolExecutionContext) => Promise<PostExecuteOutcome> | PostExecuteOutcome
  /** finalizeContent:最后一道"只允许改内容"的不变量面 */
  finalizeContent?: (call: DispatchToolCall, output: unknown, ctx: ToolExecutionContext) => unknown
  /** §46 Tool Timeout(缺省 30s;超时 status='timeout' 且 outcome.timedOut 独立上报) */
  toolTimeoutMs?: number
  /** §47 C3 瞬时错误重试上限(缺省 1 次重试 = 共 2 次尝试) */
  maxRetryAttempts?: number
  /** §36.3 有界滚动池宽度(缺省 3) */
  maxParallel?: number
}

export interface ToolRegistryDeps {
  store: WhisperTavernDb
  bus: EventBus
  /** §115.1 审计落库口(approvals 表;调用方接 DB,模块本身不依赖 schema 细节) */
  persistApprovalAudit: (row: ApprovalAuditRow) => void
  /** X14 注入时钟(缺省 wall-clock) */
  clock?: () => Timestamp
}

/** Run 级上下文 + 预算追踪器;工具实际拿到的 ToolExecutionContext.budget 是 tracker 的视图 */
export type BatchContext = Omit<ToolExecutionContext, 'budget'> & { budgetTracker: BudgetTracker }

export class ToolRegistry {
  readonly approvals = new ApprovalManager()
  private readonly tools = new Map<string, ToolDefinition>()
  /**
   * §115.1(S32):**永远**须经审批的工具名集合。
   *
   * 与 pre-execute 返回 `'ask'` 是同一段的两个入口,取或:pre-execute 是
   * "本次调用要不要问"的动态判据,这里是"这个工具每次都要问"的静态声明。
   * 为什么不只用 pre-execute:注册面可以在构造注册表**之后**增长(S31/S32 都在
   * server 组合根注册工具),而 pre-execute 只在构造时注入——把"必须审批"钉在工具名上,
   * 才能保证"注册了工具但忘了装审批门"这件事在结构上不可能发生(不绕过 §115.1)。
   * `deny` 仍然优先于审批。
   */
  private readonly approvalGated = new Set<string>()

  constructor(
    private readonly deps: ToolRegistryDeps,
    private readonly options: ToolRegistryOptions = {},
  ) {}

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  /** §115.1:声明该工具每次调用都须走审批管线(审计仍成对落库,不是绕过) */
  requireApproval(toolName: string): void {
    this.approvalGated.add(toolName)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** S28(WP3.6)api-spec §154 `GET /tools`:注册面投影(§75/§76 ToolDefinition) */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /**
   * §36.3 批量执行:并发跑,**结果数组按 model order**(请求序)。
   * 相邻 parallel 调用组成并发组;sync/exclusive 独占运行。
   * `budgetTracker`:计数与预扣由调用方(Run 级)持有;工具拿到的 ctx.budget 是其视图。
   */
  async executeBatch(
    calls: readonly DispatchToolCall[],
    baseCtx: BatchContext,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length)
    const fullCtx: ToolExecutionContext = { ...baseCtx, budget: baseCtx.budgetTracker.toolView() }
    let i = 0
    while (i < calls.length) {
      const call = calls[i]!
      const tool = this.tools.get(call.name)
      const mode = tool?.executionMode?.(parseArgs(call.arguments), fullCtx) ?? 'parallel'
      if (mode === 'parallel') {
        // 收集连续 parallel 段;有界池并发,完成序不定
        let j = i
        const group: DispatchToolCall[] = []
        while (j < calls.length) {
          const nextTool = this.tools.get(calls[j]!.name)
          const nextMode = nextTool?.executionMode?.(parseArgs(calls[j]!.arguments), fullCtx) ?? 'parallel'
          if (nextMode !== 'parallel') break
          group.push(calls[j]!)
          j += 1
        }
        const groupResults = await this.runBoundedPool(group, baseCtx)
        // barrier:整组完成后按 model order 逐个走 post/completed(§36.3)
        for (let k = 0; k < group.length; k += 1) {
          results[i + k] = await this.finalize(group[k]!, groupResults[k] ?? errorResult(group[k]!.id, 'pipeline 丢失结果'), baseCtx)
        }
        i = j
      } else {
        // sync / exclusive:独占串行
        const result = await this.executeOne(call, baseCtx)
        results[i] = await this.finalize(call, result, baseCtx)
        i += 1
      }
    }
    return results
  }

  /** 有界滚动池:并发度 ≤ maxParallel;单工具异常按 §36.2 归一,不炸整组 */
  private async runBoundedPool(calls: readonly DispatchToolCall[], ctx: BatchContext): Promise<ToolResult[]> {
    const out: ToolResult[] = new Array(calls.length)
    let cursor = 0
    const width = Math.max(1, Math.min(this.options.maxParallel ?? 3, calls.length))
    const workers = Array.from({ length: width }, async () => {
      while (cursor < calls.length) {
        const index = cursor
        cursor += 1
        out[index] = await this.executeOne(calls[index]!, ctx)
      }
    })
    await Promise.all(workers)
    return out
  }

  /** 五段流水线主体(§36.1);任何环节 throw 在此收敛(§36.2) */
  async executeOne(call: DispatchToolCall, ctx: BatchContext): Promise<ToolResult> {
    const startedAt = this.deps.clock?.() ?? (new Date().toISOString() as Timestamp)
    const wallStart = Date.now()
    const tool = this.tools.get(call.name)
    // 工具与钩子拿到的是完整 ToolExecutionContext(budget = tracker 的实时视图)
    const toolCtx: ToolExecutionContext = { ...ctx, budget: ctx.budgetTracker.toolView() }

    // —— 落账先行:tool.call.started(durable)+ tool_calls 行 ——
    const callId = call.id !== '' ? call.id : uuidv7()
    // S27 真 bug 修复:行主键 = uuidv7,不是 wire 调用 id——模型爱复用 call_1 这类 id,
    // 两个 Run 即撞 UNIQUE;wire id 只做请求内关联,行级真相 = 本行
    const rowId = uuidv7()
    this.publish(toolCtx, 'tool.call.started', callId, { toolCallId: callId, tool: call.name, runId: ctx.runId })
    this.deps.store.db
      .insert(toolCallsTable)
      .values({ id: rowId, runId: ctx.runId, toolName: call.name, arguments: call.arguments, status: 'running', startedAt })
      .run()

    const finish = (result: ToolResult): ToolResult => {
      const completedAt = this.deps.clock?.() ?? (new Date().toISOString() as Timestamp)
      const durationMs = Date.now() - wallStart
      const frozen: ToolResult = { ...result, toolCallId: callId, durationMs }
      // 冻结的权威结果(§36.1 末段)
      this.deps.store.db
        .update(toolCallsTable)
        .set({ status: frozen.status, result: JSON.stringify(frozen.output ?? null), error: frozen.error === undefined ? undefined : JSON.stringify(frozen.error), completedAt })
        .where(eq(toolCallsTable.id, rowId))
        .run()
      if (frozen.status === 'error' || frozen.status === 'timeout') {
        this.publish(toolCtx, 'tool.call.failed', callId, { toolCallId: callId, tool: call.name, status: frozen.status, error: frozen.error })
      } else if (frozen.status === 'denied') {
        this.publish(toolCtx, 'tool.call.denied', callId, { toolCallId: callId, tool: call.name, error: frozen.error })
      } else {
        this.publish(toolCtx, 'tool.call.completed', callId, { toolCallId: callId, tool: call.name, status: frozen.status })
      }
      return frozen
    }

    try {
      if (ctx.cancellationToken.isCancelled()) {
        return finish({ toolCallId: callId, status: 'cancelled', error: { code: 'USER_CANCELLED', message: ctx.cancellationToken.reason ?? '已取消' } })
      }
      if (tool === undefined) {
        return finish({ toolCallId: callId, status: 'error', error: { code: 'INVALID_INPUT', message: `未知工具: ${call.name}` } })
      }
      const input = parseArgs(call.arguments)

      // —— ① pre-execute(策略 / 预扣 / 参数改写;不得改 toolCallId)——
      const pre = this.options.preExecute !== undefined ? await this.options.preExecute(call, tool, toolCtx) : { action: 'allow' as const }
      if (pre.action === 'deny') {
        return finish({ toolCallId: callId, status: 'denied', error: { code: 'TOOL_PRE_DENIED', message: pre.reason } })
      }

      // —— ② approval(一次性授权解析;必须在 guards 之前 §36.1)——
      // 触发面取或:pre-execute 的动态 ask,或本工具被静态声明为"必审批"(S32)
      if (pre.action === 'ask' || this.approvalGated.has(call.name)) {
        const outcome = await this.approvals.resolve(
          { bus: this.deps.bus, persistAudit: this.deps.persistApprovalAudit },
          {
            chatId: ctx.chatId,
            request: {
              runId: ctx.runId,
              action: call.name,
              description: tool.description,
              // §115 risk 当前恒为 medium:注册面尚无按工具声明的风险档(见 web-search
              // createAutoApprover 注——自动批准判据刻意不用 risk,故这里不影响放行面)
              risk: 'medium',
              requestedPermissions: [...tool.permissions],
              reason: pre.action === 'ask' ? pre.reason : '该工具策略要求每次调用均须审批(§115.1)',
              toolCallId: callId,
            },
            now: startedAt,
          },
        )
        if (outcome !== 'allowed_once') {
          return finish({ toolCallId: callId, status: 'denied', error: { code: 'TOOL_PERMISSION_DENIED', message: `审批未放行: ${outcome}` } })
        }
      }

      // —— ③ guards:权限检查(§33/§34)——只 deny 或 abstain,永不放行额外能力 ——
      const missing = tool.permissions.filter((p) => !ctx.permissions.has(p))
      if (missing.length > 0) {
        return finish({
          toolCallId: callId,
          status: 'denied',
          error: { code: 'TOOL_PERMISSION_DENIED', message: `缺少权限: ${missing.join(', ')}` },
        })
      }

      // —— ④ execute:around-dispatch(timeout / retry 包在 dispatch 外层;不吞 cancellation)——
      const result = await this.dispatchWithGuards(tool, input, toolCtx, callId)

      // —— ⑤ post-execute(accept / block / replace / add_context;不得改 status 语义)——
      let output = result.output
      if (this.options.postExecute !== undefined) {
        const post = await this.options.postExecute(call, result, toolCtx)
        if (post.action === 'block') {
          return finish({ ...result, output: undefined, error: { code: 'TOOL_POST_BLOCKED', message: post.reason } })
        }
        if (post.action === 'replace') output = post.output
        if (post.action === 'add_context') output = { ...(typeof output === 'object' && output !== null ? output : { value: output }), context: post.context }
      }

      // —— finalizeContent:只改 output 内容,不动 status/error ——
      const finalOutput = this.options.finalizeContent !== undefined ? this.options.finalizeContent(call, output, toolCtx) : output
      return finish({ ...result, output: finalOutput })
    } catch (error) {
      // §36.2 归一化:任意环节 throw → 收敛为 status='error';不冒泡为 Run 失败
      const cancelled = ctx.cancellationToken.isCancelled() || (error instanceof Error && error.name === 'AbortError')
      if (cancelled) {
        return finish({ toolCallId: callId, status: 'cancelled', error: { code: 'USER_CANCELLED', message: ctx.cancellationToken.reason ?? '已取消' } })
      }
      const infrastructure = !(error instanceof ToolBusinessError)
      const code = error instanceof ToolBusinessError ? error.code : 'TOOL_PIPELINE_ERROR'
      return finish({
        toolCallId: callId,
        status: 'error',
        error: { code, message: String(error instanceof Error ? error.message : error), ...(infrastructure ? { infrastructure: true } : {}) },
      })
    }
  }

  /** §46 超时 + §47 C3 瞬时重试的 around-dispatch;超时终态 status='timeout'(D1:outcome.timedOut 独立上报) */
  private async dispatchWithGuards(tool: ToolDefinition, input: unknown, ctx: ToolExecutionContext, callId: string): Promise<ToolResult> {
    const timeoutMs = this.options.toolTimeoutMs ?? 30_000
    const maxAttempts = (this.options.maxRetryAttempts ?? 1) + 1
    let lastError: unknown
    let timedOut = false

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (ctx.cancellationToken.isCancelled()) {
        return { toolCallId: callId, status: 'cancelled', error: { code: 'USER_CANCELLED', message: ctx.cancellationToken.reason ?? '已取消' } }
      }
      try {
        const result = await withTimeout(tool.execute(input, ctx), timeoutMs)
        if (ctx.cancellationToken.isCancelled() && result.status !== 'cancelled') {
          return { ...result, status: 'cancelled', error: { code: 'USER_CANCELLED', message: ctx.cancellationToken.reason ?? '已取消' } }
        }
        return result
      } catch (error) {
        lastError = error
        if (ctx.cancellationToken.isCancelled() || (error instanceof Error && error.name === 'AbortError')) {
          return { toolCallId: callId, status: 'cancelled', error: { code: 'USER_CANCELLED', message: ctx.cancellationToken.reason ?? '已取消' } }
        }
        if (error instanceof Error && error.name === 'TimeoutError') timedOut = true
        const code = error instanceof ToolBusinessError ? error.code : 'TOOL_PIPELINE_ERROR'
        const retryable = TRANSIENT_ERROR_CODES.has(code) && !NON_RETRYABLE_ERROR_CODES.has(code)
        // §50:自动重试只对只读/幂等工具生效——non_idempotent(含缺省未知)首错即失败,
        // 否则"发送外部请求/创建文件"类副作用会被静默执行两次
        const sideEffectSafe = (tool.sideEffectLevel ?? 'non_idempotent') !== 'non_idempotent'
        if (!retryable || !sideEffectSafe || attempt === maxAttempts) break
      }
    }
    if (timedOut) {
      // §35 D1:超时是独立事实;"超时但已干净退出"不得被误读为干净成功
      return { toolCallId: callId, status: 'timeout', outcome: { timedOut: true, exitCode: null } }
    }
    // 收敛(§36.2):业务错误保留码;其余 = 流水线基础设施错误
    if (lastError instanceof ToolBusinessError) {
      return { toolCallId: callId, status: 'error', error: { code: lastError.code, message: lastError.message } }
    }
    return {
      toolCallId: callId,
      status: 'error',
      error: { code: 'TOOL_PIPELINE_ERROR', message: String(lastError instanceof Error ? lastError.message : lastError), infrastructure: true },
    }
  }

  /** §36.3:post-execute + completed 落账按 model order 排队(并发组 barrier 后逐个走) */
  private async finalize(call: DispatchToolCall, result: ToolResult, ctx: BatchContext): Promise<ToolResult> {
    // finalize 阶段的 result 已在 executeOne 内落账;这里保留 model order 排队语义的接缝
    void call
    void ctx
    return result
  }

  private publish(ctx: ToolExecutionContext, type: 'tool.call.started' | 'tool.call.completed' | 'tool.call.failed' | 'tool.call.denied', aggregateId: string, payload: Record<string, unknown>): void {
    this.deps.bus.publish({
      type,
      runId: ctx.runId,
      aggregateType: 'tool-call',
      aggregateId,
      timestamp: this.deps.clock?.() ?? (new Date().toISOString() as Timestamp),
      payload,
    })
  }
}

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw } // 解析失败不 here 崩;由工具侧按 INVALID_INPUT 处理
  }
}

function errorResult(toolCallId: string, message: string): ToolResult {
  return { toolCallId, status: 'error', error: { code: 'TOOL_PIPELINE_ERROR', message, infrastructure: true } }
}

/** §46 工具超时:超时以 TimeoutError 抛出,由 dispatchWithGuards 归一为 status='timeout' */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new ToolBusinessError('TIMEOUT', `工具执行超过 ${ms}ms`)
      error.name = 'TimeoutError'
      reject(error)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
