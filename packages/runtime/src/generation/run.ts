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
import type { Chat, Message } from '@whispertavern/contracts'
import { dispatchGeneration, SnapshotRegistry, type DispatchResult } from './dispatch'
import type { EventBus } from '../events/bus'
import type { WhisperTavernDb } from '../db/database'
import { generations, promptSnapshots, runs } from '../db/schema'
import { eq } from 'drizzle-orm'
import { uuidv7 } from '../util/id'

/**
 * 生成编排(长任务原则,api-spec §143):create run → return ids immediately → SSE。
 * 编译输入组装 = compiler-spec §3 的 Context Resolution(chat 状态 → 段)。
 * P0 口径:header 段来自 chat.settings.systemPrompt(runtime 来源,platform 档);
 * 活跃链消息逐条入 history 区;链尾 user 消息入 tail 区(当轮输入,user/request 档)。
 * 本模块只做**编排接线**(runtime 基座),不做传输(HTTP 归 apps/server)。
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
  const messageId = uuidv7() as MessageId

  const outcome = compile({
    chatId: input.chatId,
    snapshotId,
    provider: input.providerId,
    model: input.model,
    compilerVersion: SERVER_COMPILER_VERSION,
    now,
    maxContextTokens: input.adapter.capabilities(input.model).maxContextTokens,
    mode: 'preview',
    contributions: buildContributions(chat.value, chain.value),
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
    authorityFingerprint: snapshot.authorityFingerprint,
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

  // 完成侧(异步):回复入树(role=character,RP 语义)+ run 状态收尾(§25 GenerationState)
  const trackedCompletion = completion
    .then((result) => {
      const doneAt = new Date().toISOString() as Timestamp
      // 取消/失败不写回复内容(partial 语义由 generations 记录承载)
      if (result.status === 'completed') {
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

/** 活跃链(根 → 叶);空链返回空数组(§24:先有消息才能生成) */
export function loadActiveChain(store: WhisperTavernDb, leafId: string | undefined): Result<Message[], ApplicationError> {
  if (leafId === undefined) return { ok: true, value: [] }
  const chainIds = ancestorChain(store, leafId as MessageId).reverse()
  const chain: Message[] = []
  for (const id of chainIds) {
    const loaded = loadMessage(store, id as MessageId)
    if (!loaded.ok) return loaded
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
