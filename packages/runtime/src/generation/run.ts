import { compile } from '@whispertavern/core'
import {
  type ApplicationError,
  type CacheBreakReason,
  type Diagnostic,
  type MessageRole,
  type PromptContribution,
  type PromptRole,
  type ProviderAdapter,
  type Result,
  type Timestamp,
  type ChatId,
  type MessageId,
  type SnapshotId,
  type ProviderChatRequest,
} from '@whispertavern/contracts'
import { activeLeafId, ancestorChain, createMessage, loadChat, loadMessage } from '../tree/messages'
import { buildWorldbookContributions, type WorldbookMode } from './worldbook'
import { buildPresetContributions } from './preset'
import { buildPersonaContributions } from './persona'
import { buildRuntimeVariables } from './variables'
import type { Chat, Message, ProviderTool } from '@whispertavern/contracts'
import { dispatchGeneration, SnapshotRegistry, type DispatchResult } from './dispatch'
import type { EventBus } from '../events/bus'
import type { WhisperTavernDb } from '../db/database'
import { generations, messages, presets, promptSnapshots, runs } from '../db/schema'
import { eq } from 'drizzle-orm'
import { uuidv7 } from '../util/id'

/**
 * 生成编排(长任务原则,api-spec §143):create run → return ids immediately → SSE。
 * 编译输入组装 = compiler-spec §3 的 Context Resolution(chat 状态 → 段)。
 * P0 口径:header 段来自 chat.settings.systemPrompt(runtime 来源,platform 档);
 * 活跃链消息逐条入 history 区;链尾 user 消息入 tail 区(当轮输入,user/request 档)。
 * S13(WP1.4)扩展:variantMessageId 接线——swipe 壳的生成完成写回壳本身(§20/§22),
 * 不新建消息。本模块只做**编排接线**(runtime 基座),不做传输(HTTP 归 apps/server)。
 */

export const SERVER_COMPILER_VERSION = '0.1.0'

export interface RunDeps {
  store: WhisperTavernDb
  bus: EventBus
  snapshots: SnapshotRegistry
  /** usage 落库钩子(SSE 侧 bus.flush 时机由传输层定) */
  onUsageRecorded?: () => void
}

export interface StartRunInput {
  chatId: ChatId
  parentMessageId?: string
  adapter: ProviderAdapter
  providerId: string
  model: string
  sampling?: ProviderChatRequest['sampling']
  /** PV6:取消闸口(服务端 cancel 路由 abort) */
  signal?: AbortSignal
  /** 传输层预生成(先 track 再 startRun,不错过首事件);缺省内部生成 */
  runId?: string
  /**
   * S13(WP1.4)swipe 填充:生成完成写入既有变体壳而非新建消息(api-spec §20/§22——
   * "生成完成写入 variant 而非新消息")。壳由 swipeMessage 预建且已是指活跃叶子,
   * 编译历史走 parentMessageId(壳为空消息,不得入 prompt)。
   */
  variantMessageId?: MessageId
  now: Timestamp
}

export interface StartedRun {
  runId: string
  generationId: string
  messageId: string
  snapshotId: string
  /**
   * Context Resolution 的产物(编译前的贡献集合,已含 layout 提示)。
   *
   * 【S23 补】供 agent 层做 §152–§155 的 provenance / 审计与 §37 Turn 记账——
   * 属 §38 决策 45 第 3 条允许的"补更细的生成原语导出",**不改任何既有语义**。
   * 世界书激活**有副作用**(运行时态 + 审计落库),故调用方必须复用这一份,
   * 不得为取 provenance 而自行再解析一次(会重复激活)。
   * 最终排序 / 分区仍由 compile() 决定(§153:解析不负责 Layout)。
   */
  contributions: readonly PromptContribution[]
  /** 异步完成句柄(§143:调用方不 await;取消/状态查询走 registry) */
  completion: Promise<DispatchResult>
}

export type StartRunResult = Result<StartedRun, ApplicationError>

/** 启动一次生成:contributions → compile → 落 run/snapshot 行 → dispatch(异步立即返回) */
export function startRun(deps: RunDeps, input: StartRunInput): StartRunResult {
  const { store, bus, snapshots } = deps
  const now = input.now

  const chat = loadChat(store, input.chatId)
  if (!chat.ok) return chat
  const chain = loadActiveChain(store, input.parentMessageId ?? activeLeafId(store, input.chatId))
  if (!chain.ok) return chain
  const last = chain.value.at(-1)
  if (last === undefined || last.role !== 'user') {
    return {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '生成必须以 user 消息结尾(§24 续聊语义)', retryable: false },
    }
  }

  const snapshotId = uuidv7() as SnapshotId
  const runId = input.runId ?? uuidv7()
  const generationId = uuidv7()
  // swipe 填充:run 的 message_id = 预建变体壳(runs/snapshots 归因到壳);常规生成内部新建
  const messageId: MessageId = input.variantMessageId ?? (uuidv7() as MessageId)

  // S16 宏展开变量(§44):user/char/persona 取文对象;构造须在 worldbook 分区之前
  // (分区哈希需要宏展开上下文)。
  const variables = buildRuntimeVariables({ store, chat: chat.value })
  const mode = resolveWorldbookMode(store, chat.value.presetId)

  // 世界书激活层(WP1.2):加载 chat 绑定的世界书 → 激活 → freshWB/injection 贡献 +
  // 运行时态落库 + 审计。激活判定用本轮轮序(messageSequence,单调)驱动 sticky/cooldown/delay。
  // S17(WP2.2):激活后接缓存分区(宏安全条目 → stableWB/freshWB,§2.1)。
  // 激活产生的 UNSUPPORTED_SEMANTIC 等诊断归入 worldbook_activations 审计表(§16),
  // 不并入 compile 快照诊断(P1:Inspector 直接读审计表;快照诊断通道归 P2 统一)。
  const worldbook = buildWorldbookContributions({
    store,
    chatId: input.chatId,
    sequence: chat.value.messageSequence,
    messages: chain.value.map((m) => ({ id: m.id, role: m.role, content: m.content })),
    runId,
    now,
    variables,
    mode,
  })

  // WP1.3 资产注入(S12):persona / preset 绑定 → 贡献。二者均为单值 chat 绑定,
  // 只读 DB 解析,无运行时态落库(persona 是静态档案,preset 是静态提示词配置)。
  const persona = buildPersonaContributions({ store, chatId: input.chatId })
  const preset = buildPresetContributions({ store, chatId: input.chatId })

  const contributions: PromptContribution[] = [
    ...buildContributions(chat.value, chain.value),
    ...persona.contributions,
    ...preset.contributions,
    ...worldbook.contributions,
  ]

  const outcome = compile({
    chatId: input.chatId,
    snapshotId,
    provider: input.providerId,
    model: input.model,
    compilerVersion: SERVER_COMPILER_VERSION,
    now,
    maxContextTokens: input.adapter.capabilities(input.model).maxContextTokens,
    maxOutputTokens: input.adapter.capabilities(input.model).maxOutputTokens,
    // S19 §5:adapter 声明的 cacheType → providerStrategy.prefixTooSmall 阈值判定
    providerCacheType: input.adapter.capabilities(input.model).cacheType,
    mode: 'preview',
    contributions,
    variables,
    ...(last !== undefined ? { lastMessage: { id: last.id, role: last.role, content: last.content } } : {}),
    // S18 §58:跨轮失效事件(runtime 从世界书分区诊断注入;MESSAGE_EDITED 等变体类型
    // 就位、S20 遥测消费面)
    cacheInvalidations: toCacheInvalidations(worldbook.diagnostics),
  })
  if (!outcome.ok) {
    const budgetLike = outcome.error.code === 'PROMPT_CONTEXT_TOO_LARGE'
    return {
      ok: false,
      error: {
        code: budgetLike ? 'PROMPT_BUDGET_EXCEEDED' : 'PROMPT_COMPILE_FAILED',
        message: outcome.error.message,
        retryable: false,
        details: { diagnostics: outcome.error.diagnostics },
      },
    }
  }
  const snapshot = outcome.value.snapshot
  snapshots.register(snapshot)

  store.db.insert(runs).values({
    id: runId,
    chatId: input.chatId,
    // §4.3 ExecutionStatus 口径(S23 统一):run 在跑 = running。
    // P0–P2 曾写 'streaming',与新口径不同名;存量行由 LEGACY_EXECUTION_STATUS_ALIAS
    // 在读侧归一,migration v9 已把库内旧值回填(runtime/execution/status.ts)。
    status: 'running',
    provider: input.providerId,
    model: input.model,
    snapshotId: snapshot.id,
    messageId,
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
  }).run()
  store.db.insert(promptSnapshots).values({
    id: snapshot.id,
    chatId: input.chatId,
    runId,
    messageId,
    provider: snapshot.provider,
    model: snapshot.model,
    compilerVersion: snapshot.compilerVersion,
    ir: JSON.stringify(snapshot.ir),
    cachePlan: JSON.stringify(snapshot.cachePlan),
    serialized: JSON.stringify(snapshot.serialized),
    hashes: JSON.stringify(snapshot.hashes),
    diagnostics: JSON.stringify(snapshot.diagnostics),
    createdAt: snapshot.createdAt,
  }).run()

  bus.publish({
    type: 'prompt.snapshot.created',
    runId,
    aggregateType: 'snapshot',
    aggregateId: snapshot.id,
    timestamp: now,
    payload: { snapshotId: snapshot.id, chatId: input.chatId },
  })

  const completion = dispatchGeneration(
    { adapter: input.adapter, bus, snapshots, sink: generationSink(deps, input.providerId) },
    { runId, chatId: input.chatId, snapshot, sampling: input.sampling, signal: input.signal, now },
  )

  // 完成侧(异步):回复入树(role=character,RP 语义)+ run 状态收尾(§4.3 ExecutionStatus)。
  // swipe 填充语义(§20/§22):completed 时把正文写入预建变体壳(messages 内容补全,
  // 壳本来就是占位事实,不违反"编辑=新变体"——那是针对已有正文消息的规则),
  // leaf 已在壳上(createVariant 移过),并广播 chat.updated(action=variant_filled)。
  const trackedCompletion = completion
    .then((result) => {
      const doneAt = new Date().toISOString() as Timestamp
      // 取消/失败不写回复内容(partial 语义由 generations 记录承载)
      if (result.status === 'completed') {
        if (input.variantMessageId !== undefined) {
          store.db
            .update(messages)
            .set({ content: result.text, updatedAt: doneAt })
            .where(eq(messages.id, input.variantMessageId))
            .run()
          bus.publish({
            type: 'chat.updated',
            aggregateType: 'chat',
            aggregateId: input.chatId,
            timestamp: doneAt,
            payload: { action: 'variant_filled', messageId: input.variantMessageId, runId },
          })
        } else {
          const created = createMessage(store, bus, {
            chatId: input.chatId,
            parentId: (chain.value.at(-1)?.id ?? undefined) as MessageId | undefined,
            role: 'character',
            content: result.text,
            authorType: 'character',
            now: doneAt,
          })
          if (!created.ok) throw new Error(`消息树写入失败: ${created.error.message}`)
        }
      }
      store.db
        .update(runs)
        .set({
          // §4.3 ExecutionStatus 口径(S23 统一):正常完成 = succeeded(P0 曾写 'completed')
          status: result.status === 'completed' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed',
          error: result.error === undefined ? undefined : JSON.stringify(result.error),
          updatedAt: doneAt,
          completedAt: doneAt,
          lastHeartbeatAt: doneAt,
        })
        .where(eq(runs.id, runId))
        .run()
      return result
    })
    .catch((error: unknown) => {
      const failedAt = new Date().toISOString() as Timestamp
      store.db
        .update(runs)
        .set({ status: 'failed', error: String(error).slice(0, 500), updatedAt: failedAt, completedAt: failedAt })
        .where(eq(runs.id, runId))
        .run()
      throw error
    })

  return {
    ok: true,
    value: { runId, generationId, messageId, snapshotId: snapshot.id, contributions, completion: trackedCompletion },
  }
}

/** 活跃链(根 → 叶);空链返回空数组(§24:先有消息才能生成)。已删消息不进历史(§19 软删) */
export function loadActiveChain(store: WhisperTavernDb, leafId: string | undefined): Result<Message[], ApplicationError> {
  if (leafId === undefined) return { ok: true, value: [] }
  const chainIds = ancestorChain(store, leafId as MessageId).reverse()
  const chain: Message[] = []
  for (const id of chainIds) {
    const loaded = loadMessage(store, id as MessageId)
    if (!loaded.ok) return loaded
    if (loaded.value.deletedAt !== undefined) continue
    chain.push(loaded.value)
  }
  return { ok: true, value: chain }
}

/**
 * S24(§36 工具循环):为**已存在的 Run**准备一轮"编译 → 快照 → dispatch"。
 *
 * 与 startRun 的三点差异(为什么不是同一个函数):
 * 1. **不建 runs 行** —— Run 由调用方(S23 的执行层)创建,循环逐轮复用同一 runId;
 * 2. **不要求链尾是 user** —— 第 2+ 轮的链尾是 tool 结果消息(§10);
 * 3. dispatch **同步可 await** —— 循环拥有消息写入与 Run 状态收尾的时序,
 *    startRun 的 fire-and-forget 完成侧(自动写回复 + 状态收尾)不适用。
 *
 * `recurringContributions`:persona/preset/worldbook 贡献只在**首轮**计算并透传回来
 * 复用——①世界书激活有副作用(运行时态 + 审计落库),同 run 内重算会重复记账;
 * ②循环内这些段不变,复用 = 缓存前缀稳定(§36.3 的立论)。
 * base chat 贡献每轮重算(历史在长:assistant/tool 消息逐轮入树)。
 */
export interface IterationPrep {
  runId: string
  snapshotId: SnapshotId
  contributions: readonly PromptContribution[]
  /** 透传给下一轮复用的 persona/preset/worldbook 贡献(见上) */
  recurringContributions: readonly PromptContribution[]
  /** 同步可 await 的一轮 dispatch(generations 落库 + usage 事件在内部完成) */
  dispatch: () => Promise<DispatchResult>
}

export type PrepareIterationResult = Result<IterationPrep, ApplicationError>

export function prepareIteration(
  deps: RunDeps,
  input: {
    runId: string
    chatId: ChatId
    adapter: ProviderAdapter
    providerId: string
    model: string
    sampling?: ProviderChatRequest['sampling']
    signal?: AbortSignal
    now: Timestamp
    recurringContributions?: readonly PromptContribution[]
    /** S24:暴露给模型的工具清单(进 serialized.tools;§31) */
    tools?: readonly ProviderTool[]
    /**
     * S26:贡献过滤器(Agent Runtime 的 Context Policy 落点,§19 分工——
     * Agent Runtime 决定"哪些内容进 Context";Layout 仍归 Compiler)。
     * 依赖方向保持 runtime ← agent:runtime 只认函数,不认 agent 层类型。
     */
    filterContributions?: (contributions: PromptContribution[]) => PromptContribution[]
    /** S26 §106:工具副作用产生的缓存失效原因(空缺省 = 无失效;进 compile 重算 CachePlan) */
    cacheInvalidations?: import('@whispertavern/contracts').CacheBreakReason[]
  },
): PrepareIterationResult {
  const { store, bus, snapshots } = deps
  const now = input.now

  const chat = loadChat(store, input.chatId)
  if (!chat.ok) return chat
  const chain = loadActiveChain(store, activeLeafId(store, input.chatId))
  if (!chain.ok) return chain

  const snapshotId = uuidv7() as SnapshotId
  const variables = buildRuntimeVariables({ store, chat: chat.value })
  const mode = resolveWorldbookMode(store, chat.value.presetId)

  const recurring =
    input.recurringContributions ??
    (() => {
      const worldbook = buildWorldbookContributions({
        store,
        chatId: input.chatId,
        sequence: chat.value.messageSequence,
        messages: chain.value.map((m) => ({ id: m.id, role: m.role, content: m.content })),
        runId: input.runId,
        now,
        variables,
        mode,
      })
      const persona = buildPersonaContributions({ store, chatId: input.chatId })
      const preset = buildPresetContributions({ store, chatId: input.chatId })
      return [...persona.contributions, ...preset.contributions, ...worldbook.contributions] as const
    })()

  const contributions: PromptContribution[] = [...buildContributions(chat.value, chain.value), ...recurring]

  // S26 §19:Agent Runtime 缺省不驱动 compile 输入——Context Policy 过滤由调用方经
  // filterContributions 注入(此处应用;S30 修复:此前参数已声明但从未被消费,WEB/S26 测试
  // 靠编译后快照断言而非依赖过滤行为)。append 语义=追加在过滤结果之后(记忆 tail 注入)。
  const filteredContributions = input.filterContributions !== undefined ? input.filterContributions(contributions) : contributions

  const outcome = compile({
    chatId: input.chatId,
    snapshotId,
    provider: input.providerId,
    model: input.model,
    compilerVersion: SERVER_COMPILER_VERSION,
    now,
    maxContextTokens: input.adapter.capabilities(input.model).maxContextTokens,
    maxOutputTokens: input.adapter.capabilities(input.model).maxOutputTokens,
    providerCacheType: input.adapter.capabilities(input.model).cacheType,
    mode: 'preview',
    contributions: filteredContributions,
    variables,
    ...(chain.value.at(-1) !== undefined
      ? {
          lastMessage: {
            id: chain.value.at(-1)!.id,
            role: chain.value.at(-1)!.role,
            content: chain.value.at(-1)!.content,
          },
        }
      : {}),
    // 循环内 worldbook 诊断已随首轮落审计;复用轮默认不注入失效事件(前缀稳定),
    // 但工具上报的世界书变更(S26 §106)会作为显式失效原因传进来 → CachePlan 重算
    cacheInvalidations: input.cacheInvalidations ?? [],
  })
  if (!outcome.ok) {
    const budgetLike = outcome.error.code === 'PROMPT_CONTEXT_TOO_LARGE'
    return {
      ok: false,
      error: {
        code: budgetLike ? 'PROMPT_BUDGET_EXCEEDED' : 'PROMPT_COMPILE_FAILED',
        message: outcome.error.message,
        retryable: false,
        details: { diagnostics: outcome.error.diagnostics },
      },
    }
  }
  // S24:工具清单进 serialized(catchall 键透传;buildGenerationRequest 读 `serialized.tools`
  // 挂上 wire)。挂账:tools 不参与 serialized.hash——工具清单哈希随 S27 Replay 口径统一。
  const snapshotWithTools =
    input.tools !== undefined && input.tools.length > 0
      ? ({ ...outcome.value.snapshot, serialized: { ...outcome.value.snapshot.serialized, tools: [...input.tools] } } as typeof outcome.value.snapshot)
      : outcome.value.snapshot
  const snapshot = snapshotWithTools
  snapshots.register(snapshot)
  store.db.insert(promptSnapshots).values({
    id: snapshot.id,
    chatId: input.chatId,
    runId: input.runId,
    provider: snapshot.provider,
    model: snapshot.model,
    compilerVersion: snapshot.compilerVersion,
    ir: JSON.stringify(snapshot.ir),
    cachePlan: JSON.stringify(snapshot.cachePlan),
    serialized: JSON.stringify(snapshot.serialized),
    hashes: JSON.stringify(snapshot.hashes),
    diagnostics: JSON.stringify(snapshot.diagnostics),
    createdAt: snapshot.createdAt,
  }).run()
  bus.publish({
    type: 'prompt.snapshot.created',
    runId: input.runId,
    aggregateType: 'snapshot',
    aggregateId: snapshot.id,
    timestamp: now,
    payload: { snapshotId: snapshot.id, chatId: input.chatId },
  })

  const dispatch = (): Promise<DispatchResult> =>
    dispatchGeneration(
      { adapter: input.adapter, bus, snapshots, sink: generationSink(deps, input.providerId) },
      { runId: input.runId, chatId: input.chatId, snapshot, sampling: input.sampling, signal: input.signal, now },
    )

  return {
    ok: true,
    value: {
      runId: input.runId,
      snapshotId: snapshot.id,
      contributions,
      recurringContributions: recurring,
      dispatch,
    },
  }
}

/** generations 落库 sink(startRun 与 prepareIteration 共用;FK 见 §51) */
function generationSink(deps: RunDeps, providerId: string) {
  return (record: Parameters<typeof recordToRow>[0]): void => {
    deps.store.db
      .insert(generations)
      .values(recordToRow({ ...record, providerId }) as typeof generations.$inferInsert)
      .run()
    if (record.usageSource !== undefined) deps.onUsageRecorded?.()
  }
}

/**
 * 末尾"新输入"连续段起点(§86 Tool Results + §15 tail 注入)。
 *
 * 规则 = **只把末尾连续的一撮"尚未被模型消费过的输入"注 tail**:user 输入、
 * 或刚回灌的 tool 结果。链尾是 assistant 时什么都不进 tail(生成完的正常 RP 轮)。
 *
 * 为什么必须"连续末尾"而不是"凡是 tool 结果都注 tail":`pipeline.ts` 的稳定排序
 * **先按 zone 再按语义序**,把中间轮次的 tool 结果也挪进 tail 会让 `[u,a1,t1,a2,t2]`
 * 序列化为 `[u,a1,a2,t1,t2]`,tool 结果与其发起调用错位 → provider 协议直接报错。
 * 末尾连续段天然保持区内字节序,故 `[u,a1,t1]` 的 tail 恰为 `[t1]`,而 `a2` 之后的
 * `t1` 已不再是"新鲜输入",回落到 history——这正是 §86 想表达的口径。
 */
function trailingInputStart(chain: readonly Message[]): number {
  let start = chain.length
  while (start > 0) {
    const role = chain[start - 1]!.role
    if (role !== 'user' && role !== 'tool') break
    start -= 1
  }
  return start
}

/** Context Resolution(chat 状态 → 段,compiler-spec §3):P0 口径,见模块头 */
export function buildContributions(chat: Chat, chain: readonly Message[]): PromptContribution[] {
  const settings = chat.settings as { systemPrompt?: string }
  const contributions: PromptContribution[] = [
    {
      id: `runtime:${chat.id}:system`,
      source: { type: 'runtime', key: 'system' },
      segment: { role: 'system', content: settings.systemPrompt ?? '', zone: 'header' },
      priority: 0,
      semanticPlacement: { type: 'header', order: 0 },
    },
  ]
  const tailStart = trailingInputStart(chain)
  for (let i = 0; i < chain.length; i += 1) {
    const message = chain[i]!
    contributions.push({
      id: `chat:${chat.id}:message:${message.sequence}`,
      source: sourceOfMessage(message),
      segment: {
        role: mapRole(message.role),
        content: message.content,
        zone: i >= tailStart ? 'tail' : 'history',
      },
      priority: 0,
      semanticPlacement: { type: 'history', order: message.sequence },
    })
  }
  return contributions
}

/**
 * 消息来源溯源(compiler-spec §86 Tool Results / §10 来源登记表)。
 *
 * tool 结果消息的 `toolCallId` 是**唯一能追回"这条结果由哪次调用产生"的键**
 * (wire 侧关联 id 不进 IR,见 S24 不变量 2),故在消息元数据里持久化并在此升格为
 * `toolResult` 来源。缺元数据时退回 `message` 来源——老数据与普通消息行为不变。
 */
function sourceOfMessage(message: Message): PromptContribution['source'] {
  const toolCallId = message.metadata?.['toolCallId']
  if (message.role === 'tool' && typeof toolCallId === 'string' && toolCallId !== '') {
    return { type: 'toolResult', toolCallId }
  }
  return { type: 'message', messageId: message.id }
}

/** MessageRole → PromptRole:character/assistant 都按"角色发言"翻译为 assistant */
function mapRole(role: MessageRole): PromptRole {
  if (role === 'system') return 'system'
  if (role === 'tool') return 'tool'
  if (role === 'character' || role === 'assistant') return 'assistant'
  return 'user' // user / narrator
}

/** §11 双模式:chat 绑定的 preset.compilerMode='compatibility' → compatibility;其余 → performance */
function resolveWorldbookMode(store: WhisperTavernDb, presetId: string | undefined): WorldbookMode {
  if (presetId === undefined) return 'performance'
  const row = store.db.select().from(presets).where(eq(presets.id, presetId)).get()
  return row?.compilerMode === 'compatibility' ? 'compatibility' : 'performance'
}

/** S18 §58:世界书分区诊断 → CacheBreakReason(§31 退休 / §30 失活移除) */
function toCacheInvalidations(diagnostics: readonly Diagnostic[]): CacheBreakReason[] {
  const invalidations: CacheBreakReason[] = []
  for (const d of diagnostics) {
    const entryId = typeof d.details?.entryId === 'string' ? d.details.entryId : undefined
    if (entryId === undefined) continue
    if (d.code === 'WORLD_BOOK_RETIRED') invalidations.push({ type: 'WORLD_BOOK_RETIREMENT', entryId })
    if (d.code === 'WORLD_BOOK_DEACTIVATED') invalidations.push({ type: 'WORLD_BOOK_DEACTIVATED', entryId })
  }
  return invalidations
}

function recordToRow(record: {
  id: string
  runId: string
  snapshotId: string
  providerId?: string
  request: Record<string, unknown>
  response?: Record<string, unknown>
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  usageSource?: string
  latencyMs: number
  status: string
  error?: Record<string, unknown>
  createdAt: Timestamp
}): Record<string, unknown> {
  return {
    id: record.id,
    runId: record.runId,
    snapshotId: record.snapshotId,
    providerId: record.providerId,
    request: JSON.stringify(record.request),
    response: record.response === undefined ? undefined : JSON.stringify(record.response),
    finishReason: record.finishReason,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens,
    usageSource: record.usageSource,
    latencyMs: record.latencyMs,
    status: record.status,
    error: record.error === undefined ? undefined : JSON.stringify(record.error),
    createdAt: record.createdAt,
  }
}
