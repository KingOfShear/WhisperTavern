import { compile } from '@whispertavern/core'
import {
  type ApplicationError,
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
import { buildWorldbookContributions } from './worldbook'
import { buildPresetContributions } from './preset'
import { buildPersonaContributions } from './persona'
import { buildRuntimeVariables } from './variables'
import type { Chat, Message } from '@whispertavern/contracts'
import { dispatchGeneration, SnapshotRegistry, type DispatchResult } from './dispatch'
import type { EventBus } from '../events/bus'
import type { WhisperTavernDb } from '../db/database'
import { generations, messages, promptSnapshots, runs } from '../db/schema'
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

  // 世界书激活层(WP1.2):加载 chat 绑定的世界书 → 激活 → freshWB/injection 贡献 +
  // 运行时态落库 + 审计。激活判定用本轮轮序(messageSequence,单调)驱动 sticky/cooldown/delay。
  // 激活产生的 UNSUPPORTED_SEMANTIC 等诊断归入 worldbook_activations 审计表(§16),
  // 不并入 compile 快照诊断(P1:Inspector 直接读审计表;快照诊断通道归 P2 统一)。
  const worldbook = buildWorldbookContributions({
    store,
    chatId: input.chatId,
    sequence: chat.value.messageSequence,
    messages: chain.value.map((m) => ({ id: m.id, role: m.role, content: m.content })),
    runId,
    now,
  })

  // WP1.3 资产注入(S12):persona / preset 绑定 → 贡献。二者均为单值 chat 绑定,
  // 只读 DB 解析,无运行时态落库(persona 是静态档案,preset 是静态提示词配置)。
  const persona = buildPersonaContributions({ store, chatId: input.chatId })
  const preset = buildPresetContributions({ store, chatId: input.chatId })

  // S16 宏展开变量(§44):user/char/persona 取文对象;lastMessage 取活跃链末条
  // (生成必须以 user 结尾,链尾即当轮输入,{{lastMessage}} 的取文对象)。
  const variables = buildRuntimeVariables({ store, chat: chat.value })

  const outcome = compile({
    chatId: input.chatId,
    snapshotId,
    provider: input.providerId,
    model: input.model,
    compilerVersion: SERVER_COMPILER_VERSION,
    now,
    maxContextTokens: input.adapter.capabilities(input.model).maxContextTokens,
    mode: 'preview',
    contributions: [
      ...buildContributions(chat.value, chain.value),
      ...persona.contributions,
      ...preset.contributions,
      ...worldbook.contributions,
    ],
    variables,
    ...(last !== undefined ? { lastMessage: { id: last.id, role: last.role, content: last.content } } : {}),
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
    status: 'streaming',
    provider: input.providerId,
    model: input.model,
    snapshotId: snapshot.id,
    messageId,
    createdAt: now,
    updatedAt: now,
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
    {
      adapter: input.adapter,
      bus,
      snapshots,
      sink: (record) => {
        store.db
          .insert(generations)
          .values(
            // providerId 覆写为 providers 行主键(dispatch 带的是 adapter 归一 id;
            // generations.provider_id 的 FK 指向 providers 表,database-schema §51)
            recordToRow({ ...record, providerId: input.providerId }) as typeof generations.$inferInsert,
          )
          .run()
        if (record.usageSource !== undefined) deps.onUsageRecorded?.()
      },
    },
    { runId, chatId: input.chatId, snapshot, sampling: input.sampling, signal: input.signal, now },
  )

  // 完成侧(异步):回复入树(role=character,RP 语义)+ run 状态收尾(§25 GenerationState)。
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
          status: result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed',
          error: result.error === undefined ? undefined : JSON.stringify(result.error),
          updatedAt: doneAt,
        })
        .where(eq(runs.id, runId))
        .run()
      return result
    })
    .catch((error: unknown) => {
      store.db
        .update(runs)
        .set({ status: 'failed', error: String(error).slice(0, 500), updatedAt: new Date().toISOString() as Timestamp })
        .where(eq(runs.id, runId))
        .run()
      throw error
    })

  return { ok: true, value: { runId, generationId, messageId, snapshotId: snapshot.id, completion: trackedCompletion } }
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
  for (const message of chain) {
    const isLast = message === chain.at(-1)
    contributions.push({
      id: `chat:${chat.id}:message:${message.sequence}`,
      source: { type: 'message', messageId: message.id },
      segment: {
        role: mapRole(message.role),
        content: message.content,
        zone: isLast && message.role === 'user' ? 'tail' : 'history',
      },
      priority: 0,
      semanticPlacement: { type: 'history', order: message.sequence },
    })
  }
  return contributions
}

/** MessageRole → PromptRole:character/assistant 都按"角色发言"翻译为 assistant */
function mapRole(role: MessageRole): PromptRole {
  if (role === 'system') return 'system'
  if (role === 'tool') return 'tool'
  if (role === 'character' || role === 'assistant') return 'assistant'
  return 'user' // user / narrator
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
