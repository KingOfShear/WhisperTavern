/**
 * 单 Agent 端到端编排(agent-runtime-spec §16 Agent Execution Lifecycle / §170 单 Agent 最终流程)。
 *
 * S24 扩展:**工具循环**(§36)——Model → Tool Call → Tool Result → Model → … → Final。
 * 每一轮 Provider Request 都走 `prepareIteration`(编译 → 快照 → dispatch,§26/§27 强制),
 * 快照来自**活跃消息树**(assistant 中间消息 + tool 结果消息逐轮入树),Test 9 的
 * "每次真实请求必挂 snapshotId"由此结构性成立。
 *
 * Run 生命周期由本层持有(S23 起的执行层原语):createExecutionRun → running →
 * succeeded/failed/cancelled/skipped。世界书激活等**有副作用的贡献只在首轮计算**,
 * 后续轮复用(同 run 内重复记账 = 审计失真;且循环内这些段不变,复用 = 前缀稳定)。
 *
 * §16 十六个阶段落点:Trigger(调用方)→ Resolve Agent Version(§163)→ Resolve Runtime
 * State(§7)→ Create Run(执行层)→ Resolve Context(§152–§155)→ Compile/Snapshot/
 * Provider(循环内)→ Tool Decision/Execution(§36.1 五段流水线)→ State Update →
 * Commit Result → Complete Run。
 *
 * 确定性(X14):所有时间戳走注入时钟(`clock`),不用 wall-clock。
 */
import type {
  AgentId,
  ApplicationError,
  ChatId,
  MessageId,
  PromptContribution,
  ProviderAdapter,
  ProviderTool,
  Result,
  RunId,
  SnapshotId,
  Timestamp,
} from '@whispertavern/contracts'
import {
  activeLeafId,
  appendAttempt,
  appendOperation,
  appendStepRun,
  createExecutionRun,
  createMessage,
  heartbeatRun,
  recordCheckpoint,
  loadActiveChain,
  prepareIteration,
  SERVER_COMPILER_VERSION,
  transitionAttempt,
  transitionRun,
  transitionStepRun,
  type DispatchResult,
  type EventBus,
  type SnapshotRegistry,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import { eq } from 'drizzle-orm'
import { runs as runsTable, createMemoryRepository } from '@whispertavern/runtime'
import { BudgetTracker, BudgetExceeded } from '../tools/budget'
import { ToolRegistry, type BatchContext } from '../tools/registry'
import { TOOL_PERMISSIONS, type CancellationToken, type ToolResult } from '../tools/types'
import { DEFAULT_CONTEXT_POLICY, resolveContextByPolicy, type ContextPolicy, type PolicyDrop } from '../context/policy'
import { resolveMemoryPolicy } from '../memory/policy'
import { artifactContributions, type Artifact } from '../artifacts/store'
import { commitOutput, DEFAULT_OUTPUT_POLICY, type OutputPolicy } from '../output/commit'
import { replayToolResults } from './replay'

import { loadAgentDefinition } from './definition'
import { getOrCreateAgentInstance, resetAgentInstanceToIdle, transitionAgentInstance } from './instance'
import { resolveAgentContext, type AgentContextResolution } from './context'
import { openTurn } from './turn'
import type { AgentDefinition, AgentTurn } from './types'

/** §4.1 执行树的 Step 名(逐字对齐该节示例树) */
export const AGENT_STEP_IDS = {
  resolveContext: 'resolve_context',
  compilePrompt: 'compile_prompt',
  modelCall: 'model_call',
} as const

/** S24 无版本化 Step 定义,故 revision 恒 1;真正的版本钉住语义归 S27 Replay(§4.4) */
const STEP_REVISION = 1

/** 缺省权限面 = §33 全量目录(测试便利;生产由调用方按 §34 裁定传入) */
const TOOL_PERMISSIONS_ALL: ReadonlySet<string> = new Set<string>(TOOL_PERMISSIONS)
const NEVER_CANCELLED: CancellationToken = { isCancelled: () => false, onCancel: () => undefined }

export interface AgentRunDeps {
  store: WhisperTavernDb
  bus: EventBus
  snapshots: SnapshotRegistry
  /** S24:工具注册表(缺省 = 无工具可用,模型不会收到 tools 清单) */
  registry?: ToolRegistry
  /** X14:注入时钟(缺省 wall-clock;测试传固定值以保确定性) */
  clock?: () => Timestamp
  onUsageRecorded?: () => void
}

export interface RunAgentInput {
  chatId: ChatId
  agentId: AgentId
  adapter: ProviderAdapter
  providerId: string
  model: string
  sampling?: import('@whispertavern/contracts').ProviderChatRequest['sampling']
  signal?: AbortSignal
  parentMessageId?: MessageId
  /**
   * pre-step 拒绝原因(§37.1 的 `rejected` 空 Turn 面)。
   * S24 由调用方给出;权限闸门 / 注入过滤将作为真实触发源接在这里。
   */
  preStepRejection?: string
  /** §4.5 Operation 默认**不记录**,仅 Debug / simulation / replay 与排障开启 */
  recordOperations?: boolean
  /** S24:暴露给模型的工具清单(§31;capabilities.tools=false 的 adapter 由 adapter 侧拒绝) */
  tools?: readonly ProviderTool[]
  /** §39:本次 Run 生效预算(缺省 maxTurns=1 / maxToolCalls=20;RuntimePolicy 是 Definition 上的默认来源) */
  budget?: { maxTurns?: number; maxToolCalls?: number; maxExecutionTimeMs?: number }
  /** §33/§34:Run 的权限集合(缺省 = 全量目录;真实权限面由调用方按 §34 裁定) */
  permissions?: ReadonlySet<string>
  /** S26 §18–§22:Context Policy(缺省 = 全放行;历史/世界书/Artifact 过滤落编译前) */
  contextPolicy?: ContextPolicy
  /**
   * S30 §20:记忆检索入参(policy.memory.enabled 时生效)。
   * query=关键词兜底 / embedding=语义向量;策略 recent/importance 可不传。
   * 命中经 resolveMemoryPolicy **一律注 tail**(memory-runtime-spec §5)——绝不进稳定前缀(C2/R4)。
   */
  memoryRetrieval?: { query?: string; embedding?: Float32Array }
  /** S26 §22:参与本次 Run 的 Artifact(经 ArtifactPolicy 投影为贡献;frozen → injection) */
  artifacts?: readonly Artifact[]
  /** S26 §75:Output Policy(缺省 = mode message + role character,保 S23 行为) */
  outputPolicy?: OutputPolicy
  /** §44:取消令牌(缺省 = 永不取消;信号可经 input.signal 同步进 Provider 请求) */
  cancellation?: import('./types').CancellationToken
  /** S27 §147–§151:运行模式(缺省 live;debug 强制 recordOperations=完整观测面) */
  mode?: 'live' | 'simulation' | 'replay' | 'debug'
  /** S27 §51:暂停令牌——每轮模型调用**前**检测;请求暂停 → before_pause 检查点 + Run=paused */
  pauseToken?: { isPauseRequested(): boolean }
  /**
   * S27 Resume:复用既有 Run 继续循环(resumeRun 专用;调用方已完成 §55 兼容性校验、
   * 状态推进 paused/interrupted→resuming→running 与 Instance 复位)。此时不重复
   * pre-step / 建 Run / started 事件,Turn 序号沿用入参。
   */
  existingRunId?: { runId: RunId; turnIndex?: number }
  /**
   * S27 §145/§146:Replay 源 Run——mode='replay' 时工具**不真实执行**,结果从该 Run 的
   * tool_calls 录制读取(按工具名+同名序对齐);外部副作用无触发路径(§146 安全性)。
   */
  replaySourceRunId?: RunId
  /**
   * S28(WP3.6)§71 delegate / §73 handoff:父 Run 的 parent_run_id(§15 Run Tree)。
   * 传 parentRunId 的路应先过 §93 `assertCanSpawn`(Scheduler 树护栏)再落 Run;
   * 本字段只在 createExecutionRun 时写入,不改变执行语义。
   */
  parentRunId?: RunId
  /**
   * S28(WP3.6)§154 API:server 预生成的 RunId(§143 长任务原则先 track 再异步跑,
   * 首事件不丢;缺省 = 执行层内部生成)。
   */
  runId?: RunId
  now: Timestamp
}

export interface AgentRunOutcome {
  runId: RunId
  snapshotId: SnapshotId | null
  messageId: MessageId | null
  turn: AgentTurn
  context: AgentContextResolution
  /** Run 的终态(§4.3);`skipped` = 空 Turn 路径(开了 Run 但无活可干) */
  status: 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'paused'
  /** S26 §18:Context Policy 裁决审计(哪条贡献被哪条策略扔了;只记首轮) */
  policyDrops?: readonly PolicyDrop[]
}

export type AgentRunResult = Result<AgentRunOutcome, ApplicationError>

/** §170:User Message → Character Agent → Prompt → Model → Message(含 §36 工具循环) */
export async function runAgent(deps: AgentRunDeps, input: RunAgentInput): Promise<AgentRunResult> {
  const { store, bus } = deps
  const clock = deps.clock ?? defaultClock

  // —— Resolve Agent Version(§16):Run 钉住读到的版本(§163 热重载)——
  const definition = loadAgentDefinition(store, input.agentId)
  if (definition === undefined) {
    return {
      ok: false,
      error: { code: 'AGENT_NOT_FOUND', message: `Agent Definition 不存在: ${input.agentId}`, retryable: false },
    }
  }

  const resuming = input.existingRunId !== undefined
  // —— Resolve Runtime State(§16):本 Chat 里该 Agent 的活状态(§7)——
  getOrCreateAgentInstance(store, {
    chatId: input.chatId,
    agentId: input.agentId,
    agentVersion: definition.version,
    now: input.now,
  })
  // S27:Resume 不复位——instance 已由 resumeRun 推进 queued→running(§51)
  if (!resuming) {
    resetAgentInstanceToIdle(store, { chatId: input.chatId, agentId: input.agentId, now: input.now })
  }
  // —— §37.1 pre-step 闸门:空输入 / 被拒,必须在**不发 Provider 请求**的前提下留下 Turn 痕迹 ——
  // (Resume 不走 pre-step:触发输入早已在树里,兼容性校验由 resumeRun 完成)
  const preStepRejection = resuming ? undefined : evaluatePreStep(store, input)
  if (preStepRejection !== undefined) {
    return finishEmptyTurn(deps, { input, reason: preStepRejection })
  }

  // —— Run 建立(执行层原语,S22)+ Instance/Run 状态推进;Resume 复用既有 Run ——
  const runMode = input.mode ?? 'live'
  const runId = resuming ? input.existingRunId!.runId : createExecutionRun(store, {
    // S28 §154 API:server 预生成 runId 先 track(长任务原则 §143 的首事件不丢),
    // 这里优先使用它;缺省仍由执行层生成
    ...(input.runId === undefined ? {} : { id: input.runId }),
    chatId: input.chatId,
    mode: runMode,
    agentId: input.agentId,
    agentVersion: definition.version,
    provider: input.providerId,
    model: input.model,
    // S28 §93:delegate/handoff 建子 Run 时写 parent_run_id(§15 Run Tree;护栏先行)
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    // §166 版本清单:Resume 兼容性判据(§55)——compiler 版本来自 runtime 原语常量
    dependencyManifest: { compilerVersion: SERVER_COMPILER_VERSION, agentVersion: definition.version, model: input.model },
    now: input.now,
  })
  if (!resuming) {
    transitionRun(store, runId, 'running', { now: input.now })
    transitionAgentInstance(store, { chatId: input.chatId, agentId: input.agentId, to: 'queued', now: input.now })
  }
  if (!resuming) {
    transitionAgentInstance(store, {
      chatId: input.chatId,
      agentId: input.agentId,
      to: 'running',
      now: input.now,
      currentRunId: runId,
    })
  }

  // —— §37.1:Turn 在第一份输入被认领**之前**开启(此时 runId 已确定,事件可正确归因)——
  // Resume 的 Turn 序号 = 调用方给的续跑序号(新 Attempt 新 Turn)
  const turn = openTurn(bus, { runId, index: input.existingRunId?.turnIndex ?? 0, chatId: input.chatId, agentId: input.agentId, now: input.now })
  if (!resuming) {
    bus.publish({
      type: 'agent.run.started',
      runId,
      aggregateType: 'agent-run',
      aggregateId: runId,
      timestamp: input.now,
      payload: {
        runId,
        chatId: input.chatId,
        agentId: input.agentId,
        agentVersion: definition.version,
        model: input.model,
      },
    })
  }

  // —— §39/§41 预算:RunBudget 是唯一判据(§39 收编注)——
  const budget = new BudgetTracker({
    maxTurns: input.budget?.maxTurns ?? 1,
    maxToolCalls: input.budget?.maxToolCalls ?? 20,
    maxExecutionTimeMs: input.budget?.maxExecutionTimeMs,
  })
  budget.requireTurn()

  // —— 执行四层归因(§4.1):Attempt;Step 逐轮记账 ——
  const attemptId = appendAttempt(store, {
    runId,
    provider: input.providerId,
    model: input.model,
    runtimeSnapshot: { agentId: input.agentId, agentVersion: definition.version },
    now: input.now,
  })
  transitionAttempt(store, attemptId, 'running', { now: input.now })

  const batchCtxFor = (): BatchContext => ({
    runId,
    agentId: input.agentId,
    chatId: input.chatId,
    permissions: input.permissions ?? TOOL_PERMISSIONS_ALL,
    cancellationToken: input.cancellation ?? NEVER_CANCELLED,
    budgetTracker: budget,
    // §106 Cache Interaction:工具改世界书 → 失效事件 + 下轮重激活重编译(闭包变量
    // 在循环内才被触碰,声明顺序无碍)
    reportWorldbookMutation: (entryId) => {
      cacheBreaks.push({ type: 'WORLD_BOOK_CONTENT_CHANGED', entryId })
      bus.publish({
        type: 'cache.invalidated',
        runId,
        aggregateType: 'worldbook',
        aggregateId: entryId,
        timestamp: clock(),
        payload: { runId, reason: 'WORLD_BOOK_CONTENT_CHANGED', entryId },
      })
      recurringInvalid = true
    },
  })

  let recurring: readonly PromptContribution[] | undefined
  let context: AgentContextResolution = { items: [], stages: [], unmapped: [] }
  let result: DispatchResult | undefined
  let lastSnapshotId: SnapshotId | undefined
  let iteration = 0
  const executedToolCallIds: string[] = []
  // —— S26:Context Policy 过滤审计 + Artifact 贡献 + §106 缓存失效收集 ——
  const policy = input.contextPolicy ?? DEFAULT_CONTEXT_POLICY
  const policyDrops: PolicyDrop[] = []
  // S30 §20:记忆 tail 贡献(每轮检索后由 filterContributions append;zone=tail 可逐轮变)
  let memoryTailContribs: PromptContribution[] = []
  const artifactContribs =
    input.artifacts !== undefined && input.artifacts.length > 0 ? artifactContributions(input.artifacts, policy.artifacts).contributions : []
  const cacheBreaks: import('@whispertavern/contracts').CacheBreakReason[] = []
  let recurringInvalid = false
  const finishError = (message: string): ApplicationError => ({
    code: 'GENERATION_FAILED',
    message,
    retryable: true,
  })

  try {
    // —— §36 工具循环:每轮 = 编译 → 快照 → dispatch →(tool_use?执行回灌:Final)——
    for (;;) {
      iteration += 1
      // S27 §97:heartbeat(每轮一次;Recovery 扫描以 lastHeartbeatAt 判 Zombie)
      heartbeatRun(store, runId, clock())
      // S27 §51:pause 语义——模型调用前响应暂停,留 before_pause 检查点;Run 停在 paused
      if (input.pauseToken?.isPauseRequested() === true) {
        const pausedAt = clock()
        recordCheckpoint(store, {
          runId,
          turnIndex: iteration,
          reason: 'before_pause',
          stateHash: 'pause:it' + iteration + ':snap:' + (lastSnapshotId ?? 'none'),
          ...(lastSnapshotId !== undefined ? { promptSnapshotId: lastSnapshotId } : {}),
          now: pausedAt,
        })
        transitionRun(store, runId, 'paused', { now: pausedAt })
        transitionAgentInstance(store, { chatId: input.chatId, agentId: input.agentId, to: 'idle', now: pausedAt, currentRunId: null })
        bus.publish({
          type: 'agent.run.paused',
          runId,
          aggregateType: 'agent-run',
          aggregateId: runId,
          timestamp: pausedAt,
          payload: { runId, turnIndex: iteration },
        })
        return {
          ok: true,
          value: {
            runId,
            snapshotId: lastSnapshotId ?? null,
            messageId: null,
            // 暂停 = Turn 未关闭(§37.1:欠账/打开态随 Checkpoint 持久化,Resume 另起 Turn 续)
            turn: {
              index: 0,
              promptSnapshotId: lastSnapshotId ?? '',
              generationId: result?.generationId ?? '',
              toolCalls: [...executedToolCallIds],
              stepCount: iteration,
              endReason: 'paused',
            },
            context,
            status: 'paused',
          },
        }
      }
      // §104:Tool Result → Context Update → Prompt Recompile——世界书被工具改过就
      // 丢弃复用贡献重跑激活(副作用只此一次);§106 的失效原因同时进 compile 重算 CachePlan
      if (recurringInvalid) {
        recurring = undefined
        recurringInvalid = false
      }
      // S30 §20:记忆检索(每轮一次;命中注 tail 可逐轮变,volatile 不破坏稳定前缀)。
      // 首轮与后续轮都重查——记忆随会话增长检索结果应随之更新(memory-runtime-spec §2 四层语义)
      if (policy.memory.enabled && input.memoryRetrieval !== undefined) {
        const memResult = await resolveMemoryPolicy({
          policy: policy.memory,
          repository: createMemoryRepository(store.sqlite),
          chatId: input.chatId,
          query: input.memoryRetrieval.query,
          embedding: input.memoryRetrieval.embedding,
        })
        memoryTailContribs = memResult.items
      } else {
        memoryTailContribs = []
      }
      const prep = prepareIteration(
        { store, bus, snapshots: deps.snapshots, onUsageRecorded: deps.onUsageRecorded },
        {
          runId,
          chatId: input.chatId,
          adapter: input.adapter,
          providerId: input.providerId,
          model: input.model,
          ...(input.sampling === undefined ? {} : { sampling: input.sampling }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          now: input.now,
          ...(recurring === undefined ? {} : { recurringContributions: recurring }),
          ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
          ...(cacheBreaks.length > 0 ? { cacheInvalidations: cacheBreaks.splice(0) } : {}),
          // §19 分工:Agent Runtime 裁决"哪些内容进 Context";Layout 仍归 Compiler。
          // S30:记忆命中(zone=tail)在策略过滤后追加——tail 永久不碰稳定前缀(C2/R4)
          filterContributions: (contribs) => {
            const filtered = resolveContextByPolicy(policy, contribs)
            if (iteration === 1) policyDrops.push(...filtered.dropped)
            return [...filtered.contributions, ...memoryTailContribs]
          },
        },
      )
      if (!prep.ok) {
        // 编译失败(如上下文超限):Run 判 failed,Turn 以 rejected 关闭(主动放弃在飞工作)
        transitionRun(store, runId, 'failed', { now: clock(), error: prep.error.message })
        transitionAgentInstance(store, { chatId: input.chatId, agentId: input.agentId, to: 'idle', now: clock(), currentRunId: null })
        turn.close({ endReason: 'rejected', now: clock(), toolCalls: executedToolCallIds })
        return {
          ok: false,
          error: { code: prep.error.code, message: prep.error.message, retryable: false },
        }
      }
      // Artifact 贡献随首轮合入复用集(运行内不变 → 前缀稳定);frozen → injection(§72 C2)
      recurring = artifactContribs.length > 0 ? [...prep.value.recurringContributions, ...artifactContribs] : prep.value.recurringContributions
      // S27 §53/§54:before_provider 检查点(Resume 兼容性判据的锚点 = 快照 + 轮次)
      recordCheckpoint(store, {
        runId,
        turnIndex: iteration,
        reason: 'before_provider',
        stateHash: 'bp:it' + iteration + ':' + prep.value.snapshotId,
        promptSnapshotId: prep.value.snapshotId,
        now: clock(),
      })
      if (iteration === 1) {
        // §152–§155:provenance 只取首轮(贡献集合在循环内除 history 外不变)
        context = resolveAgentContext({ contributions: prep.value.contributions })
        recordStep(store, attemptId, AGENT_STEP_IDS.resolveContext, clock(), {
          itemCount: context.items.length,
          unmappedCount: context.unmapped.length,
        })
      }
      // compilePrompt Step(每轮一次:快照逐轮新建)
      recordStep(store, attemptId, AGENT_STEP_IDS.compilePrompt, clock(), { snapshotId: prep.value.snapshotId })

      turn.claimInput() // §37.1 一:认领一份输入 = 消耗一个 Step(每轮模型调用)
      // model_call Step(每轮一次)
      const modelStep = appendStepRun(store, {
        attemptId,
        stepId: AGENT_STEP_IDS.modelCall,
        stepRevision: STEP_REVISION,
        now: clock(),
        promptSnapshotId: prep.value.snapshotId,
      })
      transitionStepRun(store, modelStep, 'running', { now: clock() })
      if (input.recordOperations === true || runMode === 'debug') {
        appendOperation(store, { stepRunId: modelStep, type: 'provider_request', attemptNo: 1, now: clock() })
      }

      result = await prep.value.dispatch()
      const doneAt = clock()
      const stepStatus = result.status === 'completed' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed'
      transitionStepRun(store, modelStep, stepStatus, { now: doneAt, output: { textLength: result.text.length } })
      if (result.usage !== undefined) {
        budget.recordTokens(result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedInputTokens, result.usage.estimatedCost)
      }
      lastSnapshotId = prep.value.snapshotId

      const toolCalls = result.status === 'completed' && result.finishReason === 'tool_use' ? (result.toolCalls ?? []) : []
      if (toolCalls.length === 0) break

      // —— §38 上限:每个请求的调用先记账(超限 = RUN_BUDGET_EXCEEDED)——
      for (const _call of toolCalls) budget.requireToolCall()

      // —— 模型的工具调用意图入树(下一轮编译可见;§10/§36)——
      const assistantMsg = createMessage(store, bus, {
        chatId: input.chatId,
        role: 'character',
        content: result.text,
        authorType: 'character',
        now: doneAt,
      })
      if (!assistantMsg.ok) throw new Error(`消息树写入失败: ${assistantMsg.error.message}`)

      // —— 工具执行(五段流水线;§36.3 model order 回灌)——
      const toolResults =
        runMode === 'replay' && input.replaySourceRunId !== undefined
          ? // §145 Tool Replay:录制结果替代真实执行(§146:无副作用触发路径)
            replayToolResults(store, input.replaySourceRunId, toolCalls)
          : await (deps.registry?.executeBatch(toolCalls, batchCtxFor()) ?? Promise.resolve(toolCalls.map((c) => ({ toolCallId: c.id, status: 'error' as const, error: { code: 'INVALID_INPUT', message: '未配置工具注册表' } }))))

      // S27 §53/§54:after_tool 检查点(崩溃后 Recovery 按 toolState 判对账面)
      recordCheckpoint(store, {
        runId,
        turnIndex: iteration,
        reason: 'after_tool',
        stateHash: 'at:it' + iteration + ':' + executedToolCallIds.length,
        toolState: { executedToolCallIds: [...executedToolCallIds] },
        now: clock(),
      })
      // —— 回灌:tool 结果消息逐条入树(按 model order);Turn 欠账清零 ——
      for (let i = 0; i < toolCalls.length; i += 1) {
        const call = toolCalls[i]!
        const outcome: ToolResult = toolResults[i] ?? { toolCallId: call.id, status: 'error', error: { code: 'TOOL_PIPELINE_ERROR', message: '结果缺失', infrastructure: true } }
        turn.notePendingToolCall(call.id)
        turn.resolveToolCall(call.id)
        turn.resolveToolResult(call.id)
        executedToolCallIds.push(call.id)
        const isError = outcome.status === 'error' || outcome.status === 'denied' || outcome.status === 'timeout'
        const payload = isError ? { error: outcome.error } : { output: outcome.output }
        const created = createMessage(store, bus, {
          chatId: input.chatId,
          role: 'tool',
          content: JSON.stringify(payload),
          authorType: 'tool',
          authorId: call.name,
          // S32(§86 Tool Results):toolCallId 是结果↔调用唯一的持久关联键,
          // 编译期据此还原 source.type='toolResult'(compiler-spec §10 来源登记表)
          metadata: { toolCallId: call.id, toolName: call.name, status: outcome.status },
          now: doneAt,
        })
        if (!created.ok) throw new Error(`tool 结果写入失败: ${created.error.message}`)
      }
      // 循环继续:下一轮 prepareIteration(树尾 = tool 结果)
    }

    // —— Final:回复入树(role=character,RP 语义)+ Run 状态收尾(§4.3)——
    const doneAt = clock()
    const finalStatus = result!.status === 'completed' ? 'succeeded' : result!.status === 'cancelled' ? 'cancelled' : 'failed'
    let messageId: MessageId | null = null
    if (result!.status === 'completed') {
      // §74:Output → Output Policy → Commit → Message/Artifact(不再自动落消息树;
      // 缺省 policy = mode message + role character,保 S23 行为)
      const committed = commitOutput(store, bus, {
        chatId: input.chatId,
        runId,
        output: { text: result!.text, toolResults: executedToolCallIds.length > 0 ? [...executedToolCallIds] : undefined },
        policy: input.outputPolicy ?? DEFAULT_OUTPUT_POLICY,
        now: doneAt,
      })
      messageId = committed.messageId
    }
    // runs 行补最终归因(快照/消息);状态由 transitionRun 收口
    store.db
      .update(runsTable)
      .set({ snapshotId: lastSnapshotId, ...(messageId !== null ? { messageId } : {}), updatedAt: doneAt })
      .where(eq(runsTable.id, runId))
      .run()
    transitionRun(store, runId, finalStatus, {
      now: doneAt,
      ...(result!.error === undefined ? {} : { error: JSON.stringify(result!.error) }),
    })

    // —— Attempt 收口 ——
    transitionAttempt(store, attemptId, finalStatus, { now: doneAt })

    // —— Instance 聚合复位(§4.3 末条;S27:resuming 路径 instance=running,合法弧)——
    transitionAgentInstance(store, { chatId: input.chatId, agentId: input.agentId, to: 'idle', now: doneAt, currentRunId: null })
    // 工具循环内的欠账已在回灌处逐条清零(漏回灌会在这里抛,§37.1 判据是可断言集合)。
    const closedTurn = turn.close({
      endReason: result!.status === 'completed' ? 'completed' : result!.status === 'cancelled' ? 'cancelled' : 'failed',
      now: doneAt,
      promptSnapshotId: lastSnapshotId,
      generationId: result!.generationId,
      result: result!.text,
      toolCalls: executedToolCallIds,
    })

    return {
      ok: true,
      value: {
        runId,
        snapshotId: lastSnapshotId ?? null,
        messageId,
        turn: closedTurn,
        context,
        status: finalStatus,
        policyDrops,
      },
    }
  } catch (error) {
    // —— Run 判死的统一收尾(Step/Attempt 已在循环内记账;此处收 Run/Instance/Turn)——
    const failedAt = clock()
    transitionRun(store, runId, 'failed', { now: failedAt, error: String(error).slice(0, 500) })
    transitionAttempt(store, attemptId, 'failed', { now: failedAt, error: String(error).slice(0, 500) })
    transitionAgentInstance(store, { chatId: input.chatId, agentId: input.agentId, to: 'idle', now: failedAt, currentRunId: null })
    bus.publish({
      type: 'agent.run.failed',
      runId,
      aggregateType: 'agent-run',
      aggregateId: runId,
      timestamp: failedAt,
      payload: { runId, error: String(error).slice(0, 300) },
    })
    turn.close({
      endReason: error instanceof BudgetExceeded ? 'budget_exceeded' : 'failed',
      now: failedAt,
      toolCalls: executedToolCallIds,
    })
    if (error instanceof BudgetExceeded) {
      return { ok: false, error: { code: 'RUN_BUDGET_EXCEEDED', message: error.message, retryable: false } }
    }
    return { ok: false, error: finishError(String(error)) }
  }
}

/**
 * §37.1 pre-step 判据:**不发 Provider 请求**就能判定该 Turn 无料可跑。
 * 两条触发源与 §37.1 的 `rejected` / `empty_input` 一一对应;
 * 权限闸门 / 注入过滤会作为额外 `preStepRejection` 接进来。
 */
function evaluatePreStep(store: WhisperTavernDb, input: RunAgentInput): 'rejected' | 'empty_input' | undefined {
  if (input.preStepRejection !== undefined) return 'rejected'
  const chain = loadActiveChain(store, input.parentMessageId ?? activeLeafId(store, input.chatId))
  if (!chain.ok) return undefined
  const last = chain.value.at(-1)
  if (last !== undefined && last.role === 'user' && last.content.trim() === '') return 'empty_input'
  return undefined
}

/**
 * 空 Turn 路径(§37.1 二):照常开一条 Turn 记录并正常关闭,`stepCount = 0`。
 *
 * §16 的 "Create Run" 在这条路径上没有 generation 可挂,故由执行层直接建 Run 并判 `skipped`
 * ——§4.3 的 `skipped` 正是"开了但没活可干";正常路径的 Run 由本层逐轮编译驱动。
 */
function finishEmptyTurn(
  deps: AgentRunDeps,
  ctx: { input: RunAgentInput; reason: 'rejected' | 'empty_input'; hint?: string },
): AgentRunResult {
  const { store, bus } = deps
  const { input } = ctx
  resetAgentInstanceToIdle(store, { chatId: input.chatId, agentId: input.agentId, now: input.now })
  const runMode = input.mode ?? 'live'
  const emptyTurnVersion = loadAgentDefinition(store, input.agentId)?.version
  const runId = createExecutionRun(store, {
    chatId: input.chatId,
    mode: runMode,
    agentId: input.agentId,
    ...(emptyTurnVersion !== undefined ? { agentVersion: emptyTurnVersion } : {}),
    provider: input.providerId,
    model: input.model,
    // §166 版本清单:Resume 兼容性判据(§55)——compiler 版本来自 runtime 原语常量
    dependencyManifest: { compilerVersion: SERVER_COMPILER_VERSION, ...(emptyTurnVersion !== undefined ? { agentVersion: emptyTurnVersion } : {}), model: input.model },
    now: input.now,
  })
  transitionRun(store, runId, 'skipped', { now: input.now })
  bus.publish({
    type: 'agent.run.completed',
    runId,
    aggregateType: 'agent-run',
    aggregateId: runId,
    timestamp: input.now,
    payload: {
      runId,
      status: 'skipped',
      emptyTurnReason: ctx.reason,
      ...(ctx.hint === undefined ? {} : { hint: ctx.hint }),
    },
  })
  const turn = openTurn(bus, { runId, index: 0, chatId: input.chatId, agentId: input.agentId, now: input.now })
  const closed = turn.closeEmpty(ctx.reason, input.now)
  return {
    ok: true,
    value: {
      runId,
      snapshotId: null,
      messageId: null,
      turn: closed,
      context: { items: [], stages: [], unmapped: [] },
      status: 'skipped',
    },
  }
}

/** 一条已完成的 Step Run(resolve_context / compile_prompt 都是瞬时纯步骤) */
function recordStep(
  store: WhisperTavernDb,
  attemptId: ReturnType<typeof appendAttempt>,
  stepId: string,
  now: Timestamp,
  output: Record<string, unknown>,
): void {
  const id = appendStepRun(store, { attemptId, stepId, stepRevision: STEP_REVISION, now })
  transitionStepRun(store, id, 'running', { now })
  transitionStepRun(store, id, 'succeeded', { now, output })
}

function defaultClock(): Timestamp {
  return new Date().toISOString() as Timestamp
}

export type { AgentDefinition, AgentTurn }
