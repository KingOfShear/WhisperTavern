import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath, sep as pathSep, dirname } from 'node:path'
import { Hono } from 'hono'
import { and, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm'
import { uuidv7 } from '@whispertavern/runtime'
import { AnthropicAdapter, FakeProviderAdapter, GeminiAdapter, OpenAICompatAdapter } from '@whispertavern/adapters'
import { compile, diffSnapshots, isCacheScenarioName, projectSegment, replayCacheScenarios, simulateCachePlan } from '@whispertavern/core'
import {
  importCard,
  importWorldbook,
  importWorldbookFromJson,
  importPreset,
  isCardParseError,
  isWorldbookParseError,
  isPresetParseError,
  SLOT_TO_ST_POSITION,
  type DgWorldbook,
  type DgPreset,
} from '@whispertavern/st-compat'
import {
  activeLeafId,
  activateMessage,
  buildContributions,
  buildRuntimeVariables,
  createBranch,
  createChat,
  createMessage,
  createMemoryRepository,
  deleteChat,
  deleteMessage,
  editMessage,
  loadActiveChain,
  loadChat,
  loadMessage,
  searchMemory,
  sha256Hex,
  startRun,
  swipeMessage,
  SERVER_COMPILER_VERSION,
  type RuntimeEvent,
} from '@whispertavern/runtime'
import {
  attempts as attemptsTable,
} from '@whispertavern/runtime'
import {
  AGENT_TYPES,
  assertCanSpawn,
  createAgentDefinition,
  createMemoryWriterToolDefinitions,
  listAgentDefinitions,
  loadAgentDefinition,
  resumeRun,
  runAgent as runAgentOrchestrator,
  runScribe,
  ToolRegistry,
  type AgentRunDeps,
  type ToolDefinition,
} from '@whispertavern/agent'
import {
  agentRuntimeStates,
  artifacts as artifactsTable,
  chats as chatsTable,
  characterVersions,
  characters as charactersTable,
  events as eventsTable,
  generations as generationsTable,
  messages as messagesTable,
  personas as personasTable,
  personaVersions,
  presetVersions,
  presets as presetsTable,
  promptSnapshots,
  providers as providersTable,
  runs as runsTable,
  stepRuns as stepRunsTable,
  toolCalls as toolCallsTable,
  worldbookEntries,
  worldbookEntryVersions,
  worldbooks as worldbooksTable,
  chatWorldbooks,
} from '@whispertavern/runtime'
import type { Chat, ChatId, MessageId, ProviderAdapter, ProviderChatRequest, SnapshotId } from '@whispertavern/contracts'
import { httpStatusFor } from './api/errors'
import { buildDebugBundle, resolvePolicy } from './api/debug-export'
import { RunStreamRegistry } from './api/run-streams'
import { SSE_HEADERS, sseFrame } from './api/types'
import type { ServerDeps } from './api/types'

/**
 * WhisperTavern HTTP/SSE 网关(api-spec P0 范围,§152 MVP Scope)。
 * **纯传输层**(总设计 §7):路由 = HTTP ↔ runtime 调用翻译,零业务逻辑;
 * 编排语义在 packages/runtime(startRun),归一契约在 adapters/contracts。
 */

type AppEnv = { Variables: { requestId: string } }
type JsonStatus = 200 | 201 | 202 | 400 | 404 | 409 | 422 | 500

interface Ctx {
  header(name: string, value: string): void
  json(body: unknown, status?: JsonStatus): Response
}

const PROVIDER_TYPES = new Set(['openai-compat', 'anthropic', 'gemini', 'fake'])
const TERMINAL_EVENTS = new Set(['generation.completed', 'generation.failed'])

export interface CreatedApp {
  app: Hono<AppEnv>
  registry: RunStreamRegistry
}

export function createApp(deps: ServerDeps): CreatedApp {
  const app = new Hono<AppEnv>()
  const registry = new RunStreamRegistry(deps.bus)
  /** S28 §154:空注册表兜底(GET /tools 读面);持有者可注入已注册工具 */
  const tools = deps.tools ?? new ToolRegistry({ store: deps.store, bus: deps.bus, persistApprovalAudit: () => undefined })
  /** S31(WP4.2b):注册 Scribe 记忆写入工具(Scribe/Roleplay 共通;GET /tools 亦可见) */
  for (const tool of createMemoryWriterToolDefinitions({ store: deps.store, bus: deps.bus })) tools.register(tool)
  const agentRunDeps = (): AgentRunDeps => ({
    store: deps.store,
    bus: deps.bus,
    snapshots: deps.snapshots,
    registry: tools,
    onUsageRecorded: () => deps.bus.flush(),
  })

  // —— Request ID(api-spec §5):客户端建议携带,服务器兜底生成,响应回显 ——
  app.use('/api/v2/*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? `req_${uuidv7()}`
    c.set('requestId', requestId)
    await next()
    c.header('X-Request-ID', requestId)
  })

  const requestIdOf = (c: { get(name: 'requestId'): string }): string => c.get('requestId')

  const ok = <T>(c: Ctx, requestId: string, data: T, status: JsonStatus = 200): Response => {
    c.header('X-Request-ID', requestId)
    return c.json({ data, requestId }, status)
  }

  const fail = (
    c: Ctx,
    requestId: string,
    code: string,
    message: string,
    options: { status?: JsonStatus; details?: unknown; retryable?: boolean } = {},
  ): Response => {
    c.header('X-Request-ID', requestId)
    return c.json(
      { error: { code, message, details: options.details, retryable: options.retryable ?? false, requestId } },
      options.status ?? (httpStatusFor(code) as JsonStatus),
    )
  }

  const jsonBody = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    try {
      const body = await c.req.json()
      return (body ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  const runtimeError = (
    c: Ctx,
    requestId: string,
    error: { code: string; message: string; details?: unknown; retryable?: boolean },
  ): Response => fail(c, requestId, error.code, error.message, { details: error.details, retryable: error.retryable ?? false })

  // —— Provider 解析与 adapter 构造(密钥经 secretStore,永不过 HTTP,PV5)——

  function buildAdapter(type: string, config: Record<string, unknown>, apiKey: string | undefined): ProviderAdapter {
    const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : ''
    const fakeTurns = Array.isArray(config.fakeTurns)
      ? (config.fakeTurns as { text?: string; chunkSize?: number; delayMs?: number; cachedInputTokens?: number }[]).map((t) => ({
          text: t.text ?? '[fake]',
          chunkSize: t.chunkSize,
          delayMs: t.delayMs,
          cachedInputTokens: t.cachedInputTokens,
        }))
      : undefined
    switch (type) {
      case 'fake':
        return new FakeProviderAdapter(fakeTurns ?? [{ text: '[fake] 示例回复' }])
      case 'openai-compat':
        return new OpenAICompatAdapter({ baseUrl, apiKey })
      case 'anthropic':
        return new AnthropicAdapter({ baseUrl: baseUrl || 'https://api.anthropic.com', apiKey: apiKey ?? '' })
      case 'gemini':
        return new GeminiAdapter({ baseUrl: baseUrl || 'https://generativelanguage.googleapis.com', apiKey: apiKey ?? '' })
      default:
        throw Object.assign(new Error(`未知 provider type: ${type}`), { code: 'VALIDATION_ERROR' })
    }
  }

  function resolveProvider(
    chat: Chat,
    body: Record<string, unknown>,
  ): { providerId: string; model: string; adapter: ProviderAdapter } | { error: { code: string; message: string } } {
    const providerId = (typeof body.providerId === 'string' ? body.providerId : undefined) ?? chat.modelProvider
    const model = (typeof body.model === 'string' ? body.model : undefined) ?? chat.modelName
    if (providerId === undefined || model === undefined) {
      return { error: { code: 'VALIDATION_ERROR', message: 'chat 未绑定 provider/model,且请求未覆盖' } }
    }
    const row = deps.store.db.select().from(providersTable).where(eq(providersTable.id, providerId)).get()
    if (row === undefined) {
      return { error: { code: 'PROVIDER_NOT_FOUND', message: `provider 不存在: ${providerId}` } }
    }
    const config = JSON.parse(row.config) as Record<string, unknown>
    const secretRef = typeof config.secretRef === 'string' ? config.secretRef : undefined
    const apiKey = secretRef === undefined ? undefined : deps.secretStore.get(secretRef)
    try {
      return { providerId, model, adapter: buildAdapter(row.type, config, apiKey) }
    } catch (error) {
      return { error: { code: 'VALIDATION_ERROR', message: String((error as Error).message) } }
    }
  }

  // ===== chats(§11–§15;S13 补 PATCH name / DELETE soft+purge)=====

  app.post('/api/v2/chats', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const created = createChat(deps.store, deps.bus, {
      title: typeof body.title === 'string' ? body.title : undefined,
      now: nowIso(),
    })
    if (!created.ok) return runtimeError(c, requestId, created.error)
    if (typeof body.systemPrompt === 'string') {
      deps.store.db.update(chatsTable)
        .set({ settings: JSON.stringify({ systemPrompt: body.systemPrompt }), updatedAt: nowIso() })
        .where(eq(chatsTable.id, created.value.id))
        .run()
    }
    return ok(c, requestId, {
      id: created.value.id,
      title: created.value.title ?? null,
      activeBranchId: created.value.activeBranchId ?? null,
    }, 201)
  })

  app.get('/api/v2/chats', (c) => {
    const requestId = requestIdOf(c)
    // §15:软删 chat 不再出现在列表(事实行保留,恢复随 P5 备份/导入导出)
    const rows = deps.store.db.select().from(chatsTable).orderBy(desc(chatsTable.createdAt)).limit(100).all()
    return ok(c, requestId, rows.filter((row) => row.deletedAt == null).map((row) => ({
      id: row.id,
      title: row.title,
      modelProvider: row.modelProvider,
      modelName: row.modelName,
      createdAt: row.createdAt,
    })))
  })

  app.get('/api/v2/chats/:id', (c) => {
    const requestId = requestIdOf(c)
    const chat = loadChat(deps.store, c.req.param('id') as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    return ok(c, requestId, chat.value)
  })

  // §15 DELETE:默认软删(deleted_at 置位);?purge=true 连同消息/分支/生成记录彻底删除
  app.delete('/api/v2/chats/:id', (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id') as ChatId
    const purged = deleteChat(deps.store, deps.bus, { chatId, purge: c.req.query('purge') === 'true', now: nowIso() })
    if (!purged.ok) return runtimeError(c, requestId, purged.error)
    return ok(c, requestId, { chatId, purged: purged.value })
  })

  // S12(WP1.3)起:chat 单值绑定(chats 列直接承载;非多对多)。persona_id / preset_id
  // 必须在各自资产表存在,否则 404;传 null 解除绑定。S13 补 §14 name(→ title 列)。
  // characterIds(§14)为 P4 群聊面(chats.character_id 单聊单值,§17);worldbookIds 走 §18 绑定路由。
  app.patch('/api/v2/chats/:id', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id') as ChatId
    const chat = loadChat(deps.store, chatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const body = await jsonBody(c)
    const now = nowIso()
    const patch: Record<string, unknown> = {}

    if (typeof body.name === 'string' && body.name !== '') {
      patch.title = body.name
    }

    if (typeof body.personaId === 'string' && body.personaId !== '') {
      const p = deps.store.db.select().from(personasTable).where(eq(personasTable.id, body.personaId)).get()
      if (p === undefined) return fail(c, requestId, 'PERSONA_NOT_FOUND', `persona 不存在: ${body.personaId}`)
      patch.personaId = body.personaId
      patch.personaVersion = typeof body.personaVersion === 'number' ? body.personaVersion : p.version
    } else if (body.personaId === null) {
      patch.personaId = null
      patch.personaVersion = null
    }

    if (typeof body.presetId === 'string' && body.presetId !== '') {
      const pr = deps.store.db.select().from(presetsTable).where(eq(presetsTable.id, body.presetId)).get()
      if (pr === undefined) return fail(c, requestId, 'PRESET_NOT_FOUND', `preset 不存在: ${body.presetId}`)
      patch.presetId = body.presetId
      patch.presetVersion = typeof body.presetVersion === 'number' ? body.presetVersion : pr.version
    } else if (body.presetId === null) {
      patch.presetId = null
      patch.presetVersion = null
    }

    if (Object.keys(patch).length === 0) {
      return fail(c, requestId, 'VALIDATION_ERROR', '至少需要一个绑定字段(personaId 或 presetId)')
    }
    patch.updatedAt = now
    deps.store.db.update(chatsTable).set(patch).where(eq(chatsTable.id, chatId)).run()

    const reloaded = loadChat(deps.store, chatId)
    if (!reloaded.ok) return runtimeError(c, requestId, reloaded.error)
    const updated = reloaded.value
    return ok(
      c,
      requestId,
      {
        id: chatId,
        name: updated.title ?? null,
        personaId: updated.personaId ?? null,
        personaVersion: updated.personaVersion ?? null,
        presetId: updated.presetId ?? null,
        presetVersion: updated.presetVersion ?? null,
      },
      200,
    )
  })

  // ===== 消息树(§16–§22;S13/WP1.4 完整交互)=====

  app.post('/api/v2/chats/:id/messages', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const role = body.role
    if (role !== 'user' && role !== 'system' && role !== 'narrator') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'P0 用户面消息 role 只允许 user/system/narrator(assistant 面由生成写入)')
    }
    const created = createMessage(deps.store, deps.bus, {
      chatId: c.req.param('id') as ChatId,
      parentId: typeof body.parentId === 'string' ? (body.parentId as MessageId) : undefined,
      role,
      content: typeof body.content === 'string' ? body.content : '',
      now: nowIso(),
    })
    if (!created.ok) return runtimeError(c, requestId, created.error)
    return ok(c, requestId, { message: created.value.message, activeLeaf: created.value.activeLeaf }, 201)
  })

  // §16 消息列表:活跃链 + 游标分页(limit/before/after;branch=active 为唯一取值)。
  // 每条消息附带 variants(§17 修订"兄弟链"投影:id + variantIndex)——swipe ◀▶ 数据面。
  app.get('/api/v2/chats/:id/messages', (c) => {
    const requestId = requestIdOf(c)
    const chat = loadChat(deps.store, c.req.param('id') as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const branch = c.req.query('branch') ?? 'active'
    if (branch !== 'active') {
      return fail(c, requestId, 'VALIDATION_ERROR', `branch 只支持 active(分支管理经 active-leaf): ${branch}`)
    }
    const chain = loadActiveChain(deps.store, activeLeafId(deps.store, chat.value.id))
    if (!chain.ok) return runtimeError(c, requestId, chain.error)
    const paged = pageMessages(chain.value, c.req.query('before'), c.req.query('after'), c.req.query('limit'))
    if (!paged.ok) return fail(c, requestId, 'VALIDATION_ERROR', paged.error)
    return ok(c, requestId, paged.value.map((m) => ({ ...m, variants: variantSiblings(deps.store, m) })))
  })

  // §17 单条消息读取(含已删——历史事实可见,deletedAt 由调用方判)
  app.get('/api/v2/messages/:id', (c) => {
    const requestId = requestIdOf(c)
    const loaded = loadMessage(deps.store, c.req.param('id') as MessageId)
    if (!loaded.ok) return runtimeError(c, requestId, loaded.error)
    return ok(c, requestId, loaded.value)
  })

  // §19 编辑:新建变体,原消息内容永不动;leaf 移到新版本
  app.post('/api/v2/messages/:id/edit', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    if (typeof body.content !== 'string' || body.content === '') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'content 必填')
    }
    const edited = editMessage(deps.store, deps.bus, {
      messageId: c.req.param('id') as MessageId,
      content: body.content,
      now: nowIso(),
    })
    if (!edited.ok) return runtimeError(c, requestId, edited.error)
    return ok(c, requestId, edited.value, 201)
  })

  // §20 swipe(S13 完整语义):建壳 + 触发生成填充变体(P0 挂账解除);
  // 生成完成写入壳本身(startRun variantMessageId),返回 { runId, messageId } 走 SSE。
  app.post('/api/v2/messages/:id/swipe', async (c) => {
    const requestId = requestIdOf(c)
    const swiped = swipeMessage(deps.store, deps.bus, { messageId: c.req.param('id') as MessageId, now: nowIso() })
    if (!swiped.ok) return runtimeError(c, requestId, swiped.error)
    const shell = swiped.value
    const chat = loadChat(deps.store, shell.chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const resolved = resolveProvider(chat.value, await jsonBody(c))
    if ('error' in resolved) return fail(c, requestId, resolved.error.code, resolved.error.message)
    const controller = new AbortController()
    const runId = uuidv7()
    registry.track(runId, controller)
    const started = startRun(
      { store: deps.store, bus: deps.bus, snapshots: deps.snapshots, onUsageRecorded: () => deps.bus.flush() },
      {
        chatId: chat.value.id,
        parentMessageId: (shell.parentMessageId ?? undefined) as string | undefined,
        variantMessageId: shell.id,
        adapter: resolved.adapter,
        providerId: resolved.providerId,
        model: resolved.model,
        signal: controller.signal,
        now: nowIso(),
        runId,
      },
    )
    if (!started.ok) {
      registry.abort(runId) // 启动失败回收 track
      return runtimeError(c, requestId, started.error)
    }
    return ok(c, requestId, { runId: started.value.runId, messageId: shell.id }, 201)
  })

  // §16–§23 删除:软删 + message.deleted;活跃指针回退最近未删祖先
  app.delete('/api/v2/messages/:id', (c) => {
    const requestId = requestIdOf(c)
    const deleted = deleteMessage(deps.store, deps.bus, { messageId: c.req.param('id') as MessageId, now: nowIso() })
    if (!deleted.ok) return runtimeError(c, requestId, deleted.error)
    return ok(c, requestId, { messageId: c.req.param('id'), deletedAt: deleted.value.deletedAt, activeLeaf: deleted.value.fallbackLeafId ?? null })
  })

  // §21 分支:不复制聊天,只记录血缘位并切活跃指针(fork-and-continue)
  app.post('/api/v2/chats/:id/branch', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    if (typeof body.fromMessageId !== 'string') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'fromMessageId 必填')
    }
    const branched = createBranch(deps.store, deps.bus, {
      chatId: c.req.param('id') as ChatId,
      fromMessageId: body.fromMessageId as MessageId,
      name: typeof body.name === 'string' ? body.name : undefined,
      now: nowIso(),
    })
    if (!branched.ok) return runtimeError(c, requestId, branched.error)
    return ok(c, requestId, { branchId: branched.value.id, activeLeafId: branched.value.leafMessageId ?? null }, 201)
  })

  // §22 激活:leaf 指针唯一移动(变体切换/分支回退共用)
  app.post('/api/v2/chats/:id/active-leaf', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    if (typeof body.messageId !== 'string') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'messageId 必填')
    }
    const activated = activateMessage(deps.store, deps.bus, {
      chatId: c.req.param('id') as ChatId,
      messageId: body.messageId as MessageId,
      now: nowIso(),
    })
    if (!activated.ok) return runtimeError(c, requestId, activated.error)
    return ok(c, requestId, { branchId: activated.value.branchId, activeLeafId: activated.value.activeLeafId })
  })

  // ===== 生成(§24/§30/§143:立即返回 ids,SSE 承载流)=====

  app.post('/api/v2/chats/:id/generate', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const chat = loadChat(deps.store, c.req.param('id') as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const resolved = resolveProvider(chat.value, body)
    if ('error' in resolved) return fail(c, requestId, resolved.error.code, resolved.error.message)

    // 长任务原则(§143):先 track(不错过首事件),startRun 立即返回 ids
    const controller = new AbortController()
    const runId = uuidv7()
    registry.track(runId, controller)
    const sampling =
      body.sampling !== undefined && typeof body.sampling === 'object'
        ? (body.sampling as ProviderChatRequest['sampling'])
        : undefined
    const started = startRun(
      { store: deps.store, bus: deps.bus, snapshots: deps.snapshots, onUsageRecorded: () => deps.bus.flush() },
      {
        chatId: chat.value.id,
        parentMessageId: typeof body.parentMessageId === 'string' ? body.parentMessageId : undefined,
        adapter: resolved.adapter,
        providerId: resolved.providerId,
        model: resolved.model,
        sampling,
        signal: controller.signal,
        now: nowIso(),
        runId,
      },
    )
    if (!started.ok) {
      registry.abort(runId) // 启动失败回收 track
      return runtimeError(c, requestId, started.error)
    }
    return ok(c, requestId, {
      runId: started.value.runId,
      generationId: started.value.generationId,
      messageId: started.value.messageId,
      snapshotId: started.value.snapshotId,
    })
  })

  app.post('/api/v2/runs/:id/cancel', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    if (registry.abort(runId)) {
      return ok(c, requestId, { cancelled: true })
    }
    const row = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (row === undefined) {
      return fail(c, requestId, 'GENERATION_NOT_FOUND', `run 不存在: ${runId}`)
    }
    return ok(c, requestId, { cancelled: false, status: row.status }) // 已终态:幂等
  })

  // ===== SSE 事件流(§26/§27/§142:信封 + run 内 sequence 单调 + Last-Event-ID 续传)=====

  app.get('/api/v2/runs/:id/events', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const lastEventId = Number.parseInt(c.req.header('last-event-id') ?? '0', 10) || 0
    const encoder = new TextEncoder()

    const replayFromDb = (): RuntimeEvent[] =>
      deps.store.db.select()
        .from(eventsTable)
        .where(and(eq(eventsTable.runId, runId), gt(eventsTable.sequence, lastEventId), ne(eventsTable.durability, 'live')))
        .orderBy(eventsTable.sequence)
        .all()
        .map((row) => ({
          id: row.id,
          type: row.eventType as RuntimeEvent['type'],
          durability: row.durability as RuntimeEvent['durability'],
          runId: row.runId ?? undefined,
          sequence: row.sequence ?? 0,
          timestamp: row.createdAt,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        }))

    const tracked = registry.isTracked(runId)
    if (!tracked) {
      const runRow = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
      if (runRow === undefined) {
        return fail(c, requestId, 'GENERATION_NOT_FOUND', `run 不存在: ${runId}`)
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false
        let unsubscribe: (() => void) | undefined
        const write = (event: RuntimeEvent): void => {
          if (closed) return
          controller.enqueue(encoder.encode(sseFrame(event)))
          if (TERMINAL_EVENTS.has(event.type)) {
            closed = true
            controller.close() // D4:终态即静默
            unsubscribe?.() // 终态已送达,订阅即刻失去价值(注册表懒淘汰入口)
          }
        }
        if (tracked) {
          const sub = registry.subscribe(runId, write, lastEventId)
          unsubscribe = sub.unsubscribe
          c.req.raw.signal.addEventListener('abort', sub.unsubscribe, { once: true })
          for (const event of sub.replay) write(event)
        } else {
          // 已结束的 run:重放 durable 行(live 不落库,§141)后关闭
          for (const event of replayFromDb()) write(event)
          if (!closed) controller.close()
        }
      },
    })
    c.header('X-Request-ID', requestId)
    return new Response(stream, { headers: SSE_HEADERS })
  })

  // ===== 编译与快照(§32–§34/§36 P0 范围;Inspector 数据面)=====

  app.post('/api/v2/chats/:id/prompt/compile', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const chat = loadChat(deps.store, c.req.param('id') as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const resolved = resolveProvider(chat.value, body)
    if ('error' in resolved) return fail(c, requestId, resolved.error.code, resolved.error.message)
    const chain = loadActiveChain(deps.store, activeLeafId(deps.store, chat.value.id))
    if (!chain.ok) return runtimeError(c, requestId, chain.error)

    const outcome = compile({
      chatId: chat.value.id,
      snapshotId: uuidv7() as SnapshotId,
      provider: resolved.providerId,
      model: resolved.model,
      compilerVersion: SERVER_COMPILER_VERSION,
      now: nowIso(),
      maxContextTokens: resolved.adapter.capabilities(resolved.model).maxContextTokens,
      mode: 'preview',
      contributions: buildContributions(chat.value, chain.value),
      variables: buildRuntimeVariables({ store: deps.store, chat: chat.value }),
    })
    if (!outcome.ok) {
      return fail(
        c,
        requestId,
        outcome.error.code === 'PROMPT_CONTEXT_TOO_LARGE' ? 'PROMPT_BUDGET_EXCEEDED' : 'PROMPT_COMPILE_FAILED',
        outcome.error.message,
        { details: { diagnostics: outcome.error.diagnostics } },
      )
    }
    const snapshot = outcome.value.snapshot
    return ok(c, requestId, {
      snapshotId: snapshot.id,
      hashes: snapshot.hashes,
      serialized: snapshot.serialized,
      diagnostics: snapshot.diagnostics,
    })
  })

  app.get('/api/v2/prompt-snapshots/:id', (c) => {
    const requestId = requestIdOf(c)
    const row = deps.store.db.select().from(promptSnapshots).where(eq(promptSnapshots.id, c.req.param('id'))).get()
    if (row === undefined) {
      return fail(c, requestId, 'NOT_FOUND', `snapshot 不存在: ${c.req.param('id')}`)
    }
    return ok(c, requestId, {
      id: row.id,
      chatId: row.chatId,
      runId: row.runId,
      provider: row.provider,
      model: row.model,
      compilerVersion: row.compilerVersion,
      ir: JSON.parse(row.ir),
      cachePlan: JSON.parse(row.cachePlan),
      serialized: JSON.parse(row.serialized),
      hashes: JSON.parse(row.hashes),
      diagnostics: JSON.parse(row.diagnostics),
      createdAt: row.createdAt,
    })
  })

  // ===== Inspector / Diff / Debug Export(S14/WP1.5;§107/§38 + 还账 #15)=====

  /** prompt_snapshots 行 → PromptSnapshot 形状(ir 是权威段源,serialized 是发送原文) */
  function loadSnapshotRow(snapshotId: string) {
    const row = deps.store.db.select().from(promptSnapshots).where(eq(promptSnapshots.id, snapshotId)).get()
    if (row === undefined) return undefined
    return {
      row,
      snapshot: {
        id: row.id,
        chatId: row.chatId,
        runId: row.runId ?? undefined,
        messageId: row.messageId ?? undefined,
        provider: row.provider,
        model: row.model,
        compilerVersion: row.compilerVersion,
        ir: JSON.parse(row.ir),
        cachePlan: JSON.parse(row.cachePlan),
        serialized: JSON.parse(row.serialized),
        hashes: JSON.parse(row.hashes),
        diagnostics: JSON.parse(row.diagnostics),
        createdAt: row.createdAt,
      } as import('@whispertavern/contracts').PromptSnapshot,
    }
  }

  // §107 Prompt Inspector API:run → snapshot + cachePlan + provider + usage + diagnostics + events
  app.get('/api/v2/runs/:id/inspector', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) {
      return fail(c, requestId, 'GENERATION_NOT_FOUND', `run 不存在: ${runId}`)
    }
    const loaded = loadSnapshotRow(run.snapshotId ?? '')
    if (loaded === undefined) {
      return fail(c, requestId, 'NOT_FOUND', `snapshot 不存在: ${String(run.snapshotId)}`)
    }
    const usageRow = deps.store.db
      .select()
      .from(generationsTable)
      .where(eq(generationsTable.runId, runId))
      .all()
      .at(-1)
    const events = deps.store.db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.runId, runId), ne(eventsTable.durability, 'live')))
      .orderBy(eventsTable.sequence)
      .all()
      .map((row) => ({
        id: row.id,
        type: row.eventType as RuntimeEvent['type'],
        durability: row.durability as RuntimeEvent['durability'],
        runId: row.runId ?? undefined,
        sequence: row.sequence ?? 0,
        timestamp: row.createdAt,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }))
    return ok(c, requestId, {
      snapshot: loaded.snapshot,
      cache: loaded.snapshot.cachePlan,
      provider: { id: run.provider, model: run.model },
      usage:
        usageRow === undefined || usageRow.inputTokens === null || usageRow.outputTokens === null
          ? undefined
          : {
              inputTokens: usageRow.inputTokens,
              cachedInputTokens: usageRow.cachedTokens ?? 0,
              outputTokens: usageRow.outputTokens,
              source: usageRow.usageSource ?? 'estimated',
            },
      warnings: loaded.snapshot.diagnostics.filter((d) => d.level !== 'info'),
      diagnostics: loaded.snapshot.diagnostics,
      events,
    })
  })

  // §38 Prompt Diff:相邻两轮快照对比(段级 kind + firstDivergence + tokenDelta + cacheBreak 启发式)
  app.get('/api/v2/prompt-snapshots/:a/diff/:b', (c) => {
    const requestId = requestIdOf(c)
    const snapA = loadSnapshotRow(c.req.param('a'))
    if (snapA === undefined) return fail(c, requestId, 'NOT_FOUND', `snapshot 不存在: ${c.req.param('a')}`)
    const snapB = loadSnapshotRow(c.req.param('b'))
    if (snapB === undefined) return fail(c, requestId, 'NOT_FOUND', `snapshot 不存在: ${c.req.param('b')}`)
    const diff = diffSnapshots(snapA.snapshot, snapB.snapshot)
    return ok(c, requestId, {
      snapshotAId: snapA.snapshot.id,
      snapshotBId: snapB.snapshot.id,
      ...diff,
    })
  })

  // §36 修订:会话快照列表(Inspector 相邻两轮 diff 的枚举面;createdAt 降序;§19.3 滚动保留上限内)
  app.get('/api/v2/chats/:id/prompt-snapshots', (c) => {
    const requestId = requestIdOf(c)
    const chat = loadChat(deps.store, c.req.param('id') as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const parsed = Number.parseInt(c.req.query('limit') ?? '20', 10)
    const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= 50 ? parsed : 20
    const rows = deps.store.db
      .select()
      .from(promptSnapshots)
      .where(eq(promptSnapshots.chatId, chat.value.id))
      .orderBy(desc(promptSnapshots.createdAt))
      .limit(limit)
      .all()
    return ok(c, requestId, rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      runId: row.runId,
      provider: row.provider,
      model: row.model,
      tokenCount: (JSON.parse(row.serialized) as { tokenCount?: number }).tokenCount ?? 0,
      createdAt: row.createdAt,
    })))
  })

  // —— §41 Cache Telemetry / §43 Cache Simulation 共用聚合(纯读库;§43「不调用真实 Provider」)——
  // limit:只聚合最近 N 轮(§43 的 rounds 窗口;窗口首轮无前置基线,理论承接从窗口第 2 轮起算)
  function buildCacheTelemetry(
    chatId: ChatId,
    limit?: number,
  ): {
    rounds: Record<string, unknown>[]
    aggregate: Record<string, number | undefined>
    cacheBreaks: Record<string, unknown>[]
    simulator: Record<string, unknown>
    runCount: number
  } {
    const allRunRows = deps.store.db
      .select()
      .from(runsTable)
      .where(eq(runsTable.chatId, chatId))
      .orderBy(runsTable.createdAt)
      .all()
    const runRows = limit === undefined ? allRunRows : allRunRows.slice(-limit)
    const usageByRun = new Map<string, { inputTokens: number; cachedTokens: number; outputTokens: number; source: string }>()
    for (const row of deps.store.db.select().from(generationsTable).all()) {
      if (row.runId === null) continue
      usageByRun.set(row.runId, {
        inputTokens: row.inputTokens ?? 0,
        cachedTokens: row.cachedTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        source: row.usageSource ?? 'estimated',
      })
    }

    type Round = Record<string, unknown>
    const rounds: Round[] = []
    let round = 0
    // 段级 contentHash 投影(core projectSegment 口径;Simulator 跨轮前缀比对输入)
    const stableHashesByRun = new Map<string, Record<string, string>>()
    for (const run of runRows) {
      if (run.snapshotId === null) continue
      const loaded = loadSnapshotRow(run.snapshotId)
      if (loaded === undefined) continue
      const snapshot = loaded.snapshot
      const hashById: Record<string, string> = {}
      for (const seg of (snapshot.ir as { segments: unknown[] }).segments) {
        const p = projectSegment(seg as never)
        hashById[p.id] = p.contentHash
      }
      stableHashesByRun.set(run.id, hashById)
    }
    for (const run of runRows) {
      round += 1
      const usage = usageByRun.get(run.id)
      const snapshot = run.snapshotId === null ? undefined : loadSnapshotRow(run.snapshotId)?.snapshot
      const cachePlan = snapshot?.cachePlan
      const breakReasons = (cachePlan?.breakReasons ?? []) as { type: string }[]
      // §7 任务 1「每轮实际发送内容」:serialized.parts = 本轮真正上 wire 的消息序列(§65)
      const serialized = (snapshot?.serialized ?? { parts: [], tokenCount: 0, hash: '' }) as {
        parts: { role?: string; content?: string }[]
        tokenCount?: number
        hash?: string
      }
      rounds.push({
        round,
        runId: run.id,
        createdAt: run.createdAt,
        status: run.status,
        /** provider prompt_tokens(§2.2 token 计;§41 CacheRoundMetric) */
        promptTokens: usage?.inputTokens ?? 0,
        /** provider cached_tokens(§2.2) */
        cachedTokens: usage?.cachedTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        usageSource: usage?.source ?? 'estimated',
        stablePrefixTokens: cachePlan?.stablePrefixTokens ?? 0,
        freshTokens: cachePlan?.freshTokens ?? 0,
        volatileTokens: cachePlan?.volatileTokens ?? 0,
        prefixTooSmall: cachePlan?.providerStrategy?.prefixTooSmall,
        breakReasons: breakReasons.map((r) => r.type),
        invalidationRisk: cachePlan?.invalidationRisk ?? 'low',
        /** 本轮实际发送内容(role/content 序;§7 任务 1) */
        sentParts: serialized.parts.map((p) => ({ role: p.role ?? null, content: p.content ?? '' })),
        sentTokenCount: serialized.tokenCount ?? 0,
        sentHash: serialized.hash ?? '',
        segmentCount: (snapshot?.ir as { segments?: unknown[] } | undefined)?.segments?.length ?? 0,
        cachePlan,
      })
    }

    // §33.2 四层口径:reported 才计命中率;estimated 单列(不入分母,亦不冒充实际命中)
    const reported = rounds.filter((r) => r.usageSource === 'reported')
    const sumOf = (rows: Record<string, unknown>[], key: string): number =>
      rows.reduce((sum, r) => sum + (r[key] as number), 0)
    const reportedPrompt = sumOf(reported, 'promptTokens')
    const reportedCached = sumOf(reported, 'cachedTokens')
    const promptTokens = sumOf(rounds, 'promptTokens')
    const cachedTokens = sumOf(rounds, 'cachedTokens')
    // S20 验收③:Simulator 消费真实编译产物 → 理论缓存率/成本削减/Killer(输出对齐金样)
    // §33.2 两套口径并列:理论层用 plan token 计,实际层用 provider 回传(绝不混算)
    const simulatorRounds = rounds
      .filter((r) => r.cachePlan !== undefined)
      .map((r) => ({
        round: r.round as number,
        plan: r.cachePlan as import('@whispertavern/contracts').CachePlan,
        stablePrefixHashes: stableHashesByRun.get(r.runId as string) ?? {},
        actualCachedTokens: r.usageSource === 'reported' ? (r.cachedTokens as number) : undefined,
        providerInputTokens: r.usageSource === 'reported' ? (r.promptTokens as number) : undefined,
      }))
    const simulator = simulateCachePlan(simulatorRounds)
    // CacheBreak 事件(§33.3):breakReasons 非空轮 + 其轮次/原因清单
    const cacheBreaks = rounds
      .filter((r) => (r.breakReasons as string[]).length > 0)
      .map((r) => ({
        round: r.round as number,
        runId: r.runId as string,
        reasons: r.breakReasons as string[],
        stablePrefixTokens: r.stablePrefixTokens as number,
      }))

    return {
      rounds,
      // §41 aggregate(状态量分层:plan 计 = 理论可缓存面;provider 计 = 实际回传面)
      aggregate: {
        stableTokens: sumOf(rounds, 'stablePrefixTokens'),
        eligibleTokens: simulator.baselineInputTokens,
        cachedTokens,
        freshTokens: promptTokens - cachedTokens,
        theoreticalHitRate: simulator.theoreticalHitRatio,
        actualHitRate: reportedPrompt === 0 ? undefined : reportedCached / reportedPrompt,
        reportedHitRate: reportedPrompt === 0 ? undefined : reportedCached / reportedPrompt,
        overallHitRate: promptTokens === 0 ? undefined : cachedTokens / promptTokens,
      },
      cacheBreaks,
      simulator: {
        theoreticalHitRatio: simulator.theoreticalHitRatio,
        actualHitRatio: simulator.actualHitRatio,
        baselineInputTokens: simulator.baselineInputTokens,
        uncachedInputTokens: simulator.uncachedInputTokens,
        inputCostReduction: simulator.inputCostReduction,
        topCacheKillers: simulator.topCacheKillers,
        rounds: simulator.rounds,
      },
      runCount: runRows.length,
    }
  }

  // §41 Cache Telemetry(S20/WP2.5 落地):命中率曲线 + cached/prompt 口径 + 前缀过小 + Simulator
  app.get('/api/v2/chats/:id/cache/telemetry', (c) => {
    const requestId = requestIdOf(c)
    const chat = loadChat(deps.store, c.req.param('id') as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const telemetry = buildCacheTelemetry(chat.value.id)
    // §41 Query:from/to(ISO 时间窗;按轮次 createdAt 过滤)
    const from = c.req.query('from')
    const to = c.req.query('to')
    if (from === undefined && to === undefined) return ok(c, requestId, telemetry)
    const inWindow = (r: Record<string, unknown>): boolean => {
      const createdAt = r.createdAt as string
      return (from === undefined || createdAt >= from) && (to === undefined || createdAt <= to)
    }
    return ok(c, requestId, { ...telemetry, rounds: telemetry.rounds.filter(inWindow) })
  })

  // §42 Cache Break Diagnosis(S20/WP2.5 落地):二分层——定位"谁毁了缓存" + 影响 token + 建议
  app.get('/api/v2/runs/:id/cache-break', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) return fail(c, requestId, 'NOT_FOUND', `run 不存在: ${runId}`)
    if (run.snapshotId === null) return fail(c, requestId, 'GENERATION_NOT_FOUND', `run 无快照: ${runId}`)
    const current = loadSnapshotRow(run.snapshotId)
    if (current === undefined) return fail(c, requestId, 'NOT_FOUND', `snapshot 不存在: ${run.snapshotId}`)
    // 上一轮 = 同 chat 中 createdAt 早于本轮的最近一条快照(二分比较的 A 侧)
    const prior = deps.store.db
      .select()
      .from(promptSnapshots)
      .where(and(eq(promptSnapshots.chatId, run.chatId), lt(promptSnapshots.createdAt, current.row.createdAt)))
      .orderBy(desc(promptSnapshots.createdAt))
      .limit(1)
      .all()
    if (prior.length === 0) {
      return ok(c, requestId, {
        broken: false,
        affectedTokens: 0,
        suggestions: ['本轮为该会话首轮快照,无前置缓存可破坏(§33:首轮不计 CacheBreak)'],
      })
    }
    const previous = loadSnapshotRow(prior[0]!.id)
    if (previous === undefined) return fail(c, requestId, 'NOT_FOUND', `snapshot 不存在: ${prior[0]!.id}`)
    const diff = diffSnapshots(previous.snapshot, current.snapshot)
    if (diff.firstDivergence === undefined) {
      return ok(c, requestId, {
        broken: false,
        affectedTokens: 0,
        suggestions: ['两轮段哈希链逐段一致,稳定前缀未断裂'],
      })
    }
    const segments = current.snapshot.ir.segments
    const index = segments.findIndex((s) => s.id === diff.firstDivergence!.segmentId)
    // 影响面 = 首分歧段起的**整个后缀**(字节前缀断裂后,后续段全部重发)
    const affectedTokens = index < 0 ? 0 : segments.slice(index).reduce((sum, s) => sum + s.tokenCount, 0)
    const segment = segments.find((s) => s.id === diff.firstDivergence!.segmentId) ?? previous.snapshot.ir.segments.find((s) => s.id === diff.firstDivergence!.segmentId)
    const source = segment?.source
    const sourceId =
      source === undefined
        ? undefined
        : 'messageId' in source
          ? source.messageId
          : 'entryId' in source
            ? source.entryId
            : 'presetId' in source
              ? source.presetId
              : 'assetId' in source
                ? source.assetId
                : undefined
    // §58 无 BUDGET_TRIM 原因码,裁剪归因借 MANUAL_INVALIDATION 的自由 reason 字段如实标注(不静默改标成内容变更)
    const trimmed = segment !== undefined && !segment.enabled
    const reason = trimmed ? 'MANUAL_INVALIDATION' : (diff.cacheBreak?.type ?? 'MANUAL_INVALIDATION')
    return ok(c, requestId, {
      broken: true,
      firstDivergence: {
        previousSnapshot: previous.snapshot.id,
        currentSnapshot: current.snapshot.id,
        segmentId: diff.firstDivergence.segmentId,
        /** S20 补齐:S14 只给段级,这里给段内**首个分歧字节**(UTF-8 偏移) */
        byteOffset: diff.firstDivergence.byteOffset,
        sourceId,
        reason,
        /** 裁剪归因(§49 Budget Manager 把该段标记 enabled=false:它已不在发送字节流中) */
        ...(trimmed ? { trimReason: 'BUDGET_TRIM' as const } : {}),
      },
      affectedTokens,
      suggestions: cacheBreakSuggestions(reason, trimmed),
    })
  })

  // §43/§44 Cache Simulation(S20/WP2.5 落地):零 API 成本——只消费已编译快照,不调 Provider
  app.post('/api/v2/cache/simulate', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const chatId = typeof body.chatId === 'string' ? body.chatId : ''
    if (chatId === '') return fail(c, requestId, 'VALIDATION_ERROR', 'chatId 必填(§43 CacheSimulationRequest)')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const requestedRounds = body.rounds
    const requestedScenarios = Array.isArray(body.scenarios) ? body.scenarios.filter((s) => typeof s === 'string') : []
    const supportedScenarios = requestedScenarios.filter(isCacheScenarioName)
    const unknownScenarios = requestedScenarios.filter((s) => !isCacheScenarioName(s))

    // S21(WP2.6)§43 scenarios:声明场景族 → 确定性回放(合成轮次脚本喂真实 compile,零 Provider 调用)。
    // 与下面的 S20 路径是**两种数据来源**:S20 只回放该 chat 已编译快照,不虚构轮次。
    if (supportedScenarios.length > 0) {
      const cap = Math.min(typeof requestedRounds === 'number' && requestedRounds > 0 ? Math.floor(requestedRounds) : 50, 1000)
      const replay = replayCacheScenarios({ rounds: cap, scenarios: supportedScenarios })
      return ok(c, requestId, {
        rounds: replay.rounds.map((r) => ({
          round: r.round,
          stableTokens: r.stableTokens,
          freshTokens: r.freshTokens,
          volatileTokens: r.volatileTokens,
          prefixHash: r.prefixHash,
          theoreticalCachedTokens: r.cachedTokens,
          cacheBreak: r.declaredBreaks[0] ?? r.unexpectedBreaks[0],
          appliedScenarios: r.applied,
          trimmedSegments: r.trimmedSegments,
        })),
        aggregate: {
          expectedCacheRatio: replay.hitRatio,
          totalInvalidatedTokens: replay.rounds.reduce((sum, r) => sum + (r.planInputTokens - r.cachedTokens), 0),
        },
        // §2.2 端到端 KPI + 未声明失效计数(两道 CI 门禁的同一口径,便于人在面板上复算)
        kpi: {
          hitRatio: replay.hitRatio,
          costReduction: replay.costReduction,
          unexpectedBreakTotal: replay.unexpectedBreakTotal,
        },
        simulator: replay.simulator,
        unsupportedScenarios: unknownScenarios,
      })
    }

    const limit =
      typeof requestedRounds === 'number' && Number.isFinite(requestedRounds) && requestedRounds > 0
        ? Math.min(Math.floor(requestedRounds), 200)
        : 50
    const telemetry = buildCacheTelemetry(chat.value.id, limit)
    const simulatorRounds = telemetry.simulator.rounds as {
      round: number
      theoreticalStableTokens: number
      theoreticalCachedTokens: number
      cacheBreak: boolean
    }[]
    return ok(c, requestId, {
      // §44 CacheSimulationResult
      rounds: telemetry.rounds.map((r) => {
        const sim = simulatorRounds.find((s) => s.round === r.round)
        return {
          round: r.round as number,
          stableTokens: r.stablePrefixTokens as number,
          freshTokens: r.freshTokens as number,
          volatileTokens: r.volatileTokens as number,
          prefixHash: r.sentHash as string,
          theoreticalCachedTokens: sim?.theoreticalCachedTokens ?? 0,
          cacheBreak: (r.breakReasons as string[])[0],
        }
      }),
      aggregate: {
        expectedCacheRatio: telemetry.simulator.theoreticalHitRatio as number,
        // 失效总量 = 发生 CacheBreak 的轮次中未能承接的稳定前缀 token 之和
        totalInvalidatedTokens: simulatorRounds
          .filter((s) => s.cacheBreak)
          .reduce((sum, s) => sum + (s.theoreticalStableTokens - s.theoreticalCachedTokens), 0),
      },
      simulator: telemetry.simulator,
      // S20 路径只回放该 chat 已有真实快照;未识别的场景名原样回显(不静默忽略)。
      // 已识别的场景族走上面的 S21 确定性回放分支,不会落到这里。
      unsupportedScenarios: unknownScenarios,
    })
  })

  // 还账 #15:Sanitized Debug Export(默认 sanitized;密钥经 PV5 redact;bundle 可回放)
  app.post('/api/v2/debug/export', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const resourceType = body.resourceType
    if (resourceType !== 'snapshot') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'resourceType 仅支持 snapshot(§60 debug 导出 P0 口径)')
    }
    const resourceId = typeof body.resourceId === 'string' ? body.resourceId : ''
    const loaded = loadSnapshotRow(resourceId)
    if (loaded === undefined) {
      return fail(c, requestId, 'NOT_FOUND', `snapshot 不存在: ${resourceId}`)
    }
    const requested = typeof body.policy === 'object' && body.policy !== null ? (body.policy as Record<string, unknown>) : {}
    const policy = resolvePolicy({
      mode: requested.mode === 'full' ? 'full' : requested.mode === 'sanitized' ? 'sanitized' : undefined,
      stripUserContent: typeof requested.stripUserContent === 'boolean' ? requested.stripUserContent : undefined,
      anonymizeIds: typeof requested.anonymizeIds === 'boolean' ? requested.anonymizeIds : undefined,
    })
    // PV5 密钥表:全部 provider 的已存密钥进 redact(值本身不入 bundle,只做替换)
    const secrets = deps.store.db
      .select()
      .from(providersTable)
      .all()
      .flatMap((row) => {
        const config = JSON.parse(row.config) as { secretRef?: string }
        if (config.secretRef === undefined) return []
        const value = deps.secretStore.get(config.secretRef)
        return value === undefined ? [] : [value]
      })
    const bundle = buildDebugBundle({
      snapshot: loaded.snapshot,
      policy,
      secrets,
      exportedAt: nowIso(),
    })
    return ok(c, requestId, bundle)
  })

  // ===== provider 配置与密钥(§152;密钥只写不读回,PV5/R-P0-6)=====

  app.post('/api/v2/providers', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const name = typeof body.name === 'string' ? body.name : ''
    const type = typeof body.type === 'string' ? body.type : ''
    if (name === '' || !PROVIDER_TYPES.has(type)) {
      return fail(c, requestId, 'VALIDATION_ERROR', `name 必填;type 必须是 ${[...PROVIDER_TYPES].join('/')}`)
    }
    const id = uuidv7()
    const secretRef = `provider.${id}`
    const hasKey = typeof body.apiKey === 'string' && body.apiKey !== ''
    if (hasKey) deps.secretStore.set(secretRef, body.apiKey as string) // R-P0-6:明文只进 SecretStore
    const config = {
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      secretRef: hasKey ? secretRef : undefined,
      models: Array.isArray(body.models) ? (body.models as string[]) : [],
      fakeTurns: Array.isArray(body.fakeTurns) ? (body.fakeTurns as { text: string }[]) : undefined,
    }
    deps.store.db.insert(providersTable)
      .values({
        id,
        name,
        type,
        config: JSON.stringify(config),
        capabilities: '{}',
        enabled: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run()
    return ok(c, requestId, {
      id,
      name,
      type,
      config: { baseUrl: config.baseUrl ?? null, models: config.models },
    }, 201)
  })

  app.get('/api/v2/providers', (c) => {
    const requestId = requestIdOf(c)
    const rows = deps.store.db.select().from(providersTable).orderBy(desc(providersTable.createdAt)).all()
    return ok(c, requestId, rows.map((row) => projectProvider(row)))
  })

  app.get('/api/v2/providers/:id/models', (c) => {
    const requestId = requestIdOf(c)
    const row = deps.store.db.select().from(providersTable).where(eq(providersTable.id, c.req.param('id'))).get()
    if (row === undefined) return fail(c, requestId, 'PROVIDER_NOT_FOUND', `provider 不存在: ${c.req.param('id')}`)
    const config = JSON.parse(row.config) as { models?: string[] }
    return ok(c, requestId, config.models ?? [])
  })

  app.post('/api/v2/providers/:id/secret', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    if (typeof body.secret !== 'string' || body.secret === '') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'secret 必填')
    }
    deps.secretStore.set(`provider.${c.req.param('id')}`, body.secret)
    return ok(c, requestId, { stored: true }) // 永不回显明文(PV5)
  })

  // ===== 资产注册(§152 P0;POST 即注册并写 version 1 快照;编辑/导入随 P1)=====

  app.get('/api/v2/characters', (c) => {
    const requestId = requestIdOf(c)
    const rows = deps.store.db.select().from(charactersTable).orderBy(desc(charactersTable.createdAt)).limit(100).all()
    return ok(c, requestId, rows.map((row) => ({ id: row.id, name: row.name, description: row.description, version: row.version })))
  })

  // S9(WP1.1a):卡导入(§152 P0;st-compat 归一 → 文件落盘 + 注册 + v1 快照)
  app.post('/api/v2/characters/import', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    if (typeof body.base64 !== 'string' || body.base64 === '') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'base64(卡文件字节)必填')
    }
    let result
    try {
      result = importCard(new Uint8Array(Buffer.from(body.base64, 'base64')))
    } catch (error) {
      if (isCardParseError(error)) {
        return fail(c, requestId, 'VALIDATION_ERROR', error.message)
      }
      throw error
    }
    const slug = result.card.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'card'
    const id = uuidv7() // 先取 id:内嵌书要回填 characterRef(双向引用)
    const cardDir = join(deps.assetsDir, 'cards', slug)
    mkdirSync(cardDir, { recursive: true })
    // .dgcard 文件(事实源,决策 11)+ 附带资产
    const cardFileName = 'card.dgcard.json'
    writeFileSync(join(cardDir, cardFileName), JSON.stringify(result.card, null, 2))
    const cardRoot = resolvePath(cardDir)
    for (const [uri, bytes] of result.assetFiles) {
      // Zip-Slip 防护:uri 来自外部卡文件(zip 条目/清单),解析后必须仍落在卡目录内
      const target = resolvePath(cardDir, uri)
      if (!target.startsWith(cardRoot + pathSep)) {
        return fail(c, requestId, 'VALIDATION_ERROR', `资产 uri 越界,拒绝写入卡目录之外: ${uri}`)
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    // 内嵌书抽取:S10 起走完整归一(老/现代字段集 → 原生 .dgworld),不再 passthrough
    let worldbookId: string | undefined
    if (result.extractedWorldbook !== undefined) {
      const embedded = importWorldbookFromJson(result.extractedWorldbook.raw, {
        name: result.extractedWorldbook.suggestedName,
        sourceFormat: 'st-embedded',
      })
      worldbookId = persistWorldbook(deps, embedded.worldbook, 'st-embedded', { characterRef: id })
    }
    // 注册索引 + version 1 快照(混合存储:文件事实源,行是索引,决策 11)
    const now = nowIso()
    const cardFile = `cards/${slug}/${cardFileName}`
    deps.store.db.insert(charactersTable).values({
      id,
      name: result.card.meta.name,
      description: result.card.persona.description,
      personality: result.card.persona.personality,
      scenario: result.card.persona.scenario,
      firstMessage: result.card.greetings.first,
      metadata: JSON.stringify({ worldbookRef: result.card.worldbookRef, cardFile }),
      sourceFormat: result.report.asset.sourceFormat,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run()
    const snapshot = JSON.stringify({ card: result.card, worldbookId })
    deps.store.db.insert(characterVersions).values({
      id: uuidv7(),
      characterId: id,
      version: 1,
      snapshot,
      contentHash: sha256Hex(snapshot),
      createdAt: now,
    }).run()
    return ok(c, requestId, { character: { id, name: result.card.meta.name, version: 1 }, worldbookId: worldbookId ?? null, report: result.report }, 201)
  })

  app.post('/api/v2/characters', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const name = typeof body.name === 'string' ? body.name : ''
    if (name === '') return fail(c, requestId, 'VALIDATION_ERROR', 'name 必填')
    const id = uuidv7()
    const now = nowIso()
    const record = {
      id,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      personality: typeof body.personality === 'string' ? body.personality : undefined,
      scenario: typeof body.scenario === 'string' ? body.scenario : undefined,
      firstMessage: typeof body.firstMessage === 'string' ? body.firstMessage : undefined,
      exampleDialogues: typeof body.exampleDialogues === 'string' ? body.exampleDialogues : undefined,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    deps.store.db.insert(charactersTable).values(record).run()
    const snapshot = JSON.stringify(record)
    deps.store.db.insert(characterVersions).values({
      id: uuidv7(),
      characterId: id,
      version: 1,
      snapshot,
      contentHash: sha256Hex(snapshot),
      createdAt: now,
    }).run()
    return ok(c, requestId, { id, name, version: 1 }, 201)
  })

  app.get('/api/v2/worldbooks', (c) => {
    const requestId = requestIdOf(c)
    const rows = deps.store.db.select().from(worldbooksTable).orderBy(desc(worldbooksTable.createdAt)).limit(100).all()
    return ok(c, requestId, rows.map((row) => ({ id: row.id, name: row.name, scanDepth: row.scanDepth, recursive: row.recursive, version: row.version })))
  })

  // S10(WP1.1b):世界书导入(老 8 字段 uid 键对象 / 现代 42 字段 → .dgworld + 注册 + 条目落库)
  app.post('/api/v2/worldbooks/import', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    if (typeof body.base64 !== 'string' || body.base64 === '') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'base64(世界书文件字节)必填')
    }
    let result
    try {
      result = importWorldbook(new Uint8Array(Buffer.from(body.base64, 'base64')), {
        name: typeof body.name === 'string' && body.name !== '' ? body.name : undefined,
      })
    } catch (error) {
      if (isWorldbookParseError(error)) return fail(c, requestId, 'VALIDATION_ERROR', error.message)
      throw error
    }
    const worldbookId = persistWorldbook(deps, result.worldbook, result.report.asset.sourceFormat)
    return ok(
      c,
      requestId,
      {
        worldbook: { id: worldbookId, name: result.worldbook.meta.name, entryCount: result.worldbook.entries.length, version: 1 },
        report: result.report,
      },
      201,
    )
  })

  app.post('/api/v2/worldbooks', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const name = typeof body.name === 'string' ? body.name : ''
    if (name === '') return fail(c, requestId, 'VALIDATION_ERROR', 'name 必填')
    const id = uuidv7()
    const now = nowIso()
    deps.store.db.insert(worldbooksTable).values({
      id,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      scanDepth: typeof body.scanDepth === 'number' ? body.scanDepth : undefined,
      recursive: body.recursive === true,
      createdAt: now,
      updatedAt: now,
    }).run()
    return ok(c, requestId, { id, name, version: 1 }, 201)
  })

  // S11(WP1.2):chat↔worldbook 绑定(§18 chat_worldbooks;激活层接线前提)
  app.get('/api/v2/chats/:id/worldbooks', (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id') as ChatId
    const rows = deps.store.db
      .select()
      .from(chatWorldbooks)
      .where(eq(chatWorldbooks.chatId, chatId))
      .orderBy(chatWorldbooks.orderIndex)
      .all()
    return ok(c, requestId, rows.map((r) => ({
      worldbookId: r.worldbookId,
      order: r.orderIndex,
      scanDepthOverride: r.scanDepthOverride,
      recursiveOverride: r.recursiveOverride,
    })))
  })

  app.post('/api/v2/chats/:id/worldbooks', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id') as ChatId
    const chat = loadChat(deps.store, chatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const body = await jsonBody(c)
    const worldbookId = typeof body.worldbookId === 'string' ? body.worldbookId : ''
    if (worldbookId === '') return fail(c, requestId, 'VALIDATION_ERROR', 'worldbookId 必填')
    const wb = deps.store.db.select().from(worldbooksTable).where(eq(worldbooksTable.id, worldbookId)).get()
    if (wb === undefined) return fail(c, requestId, 'WORLDBOOK_NOT_FOUND', `worldbook 不存在: ${worldbookId}`)
    const existing = deps.store.db
      .select()
      .from(chatWorldbooks)
      .where(and(eq(chatWorldbooks.chatId, chatId), eq(chatWorldbooks.worldbookId, worldbookId)))
      .get()
    if (existing !== undefined) return ok(c, requestId, { chatId, worldbookId, order: existing.orderIndex }, 200)
    const order = typeof body.order === 'number' ? body.order : 0
    const now = nowIso()
    deps.store.db
      .insert(chatWorldbooks)
      .values({
        chatId,
        worldbookId,
        orderIndex: order,
        scanDepthOverride: typeof body.scanDepthOverride === 'number' ? body.scanDepthOverride : null,
        recursiveOverride: body.recursiveOverride === true ? true : body.recursiveOverride === false ? false : null,
        createdAt: now,
      })
      .run()
    return ok(c, requestId, { chatId, worldbookId, order }, 201)
  })

  app.delete('/api/v2/chats/:id/worldbooks/:worldbookId', (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id') as ChatId
    const worldbookId = c.req.param('worldbookId')
    deps.store.db
      .delete(chatWorldbooks)
      .where(and(eq(chatWorldbooks.chatId, chatId), eq(chatWorldbooks.worldbookId, worldbookId)))
      .run()
    return ok(c, requestId, { chatId, worldbookId, unbound: true })
  })

  app.get('/api/v2/presets', (c) => {
    const requestId = requestIdOf(c)
    const rows = deps.store.db.select().from(presetsTable).orderBy(desc(presetsTable.createdAt)).limit(100).all()
    return ok(c, requestId, rows.map((row) => ({ id: row.id, name: row.name, compilerMode: row.compilerMode, version: row.version })))
  })

  app.post('/api/v2/presets', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const name = typeof body.name === 'string' ? body.name : ''
    if (name === '') return fail(c, requestId, 'VALIDATION_ERROR', 'name 必填')
    const id = uuidv7()
    const now = nowIso()
    const record = {
      id,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      compilerMode: typeof body.compilerMode === 'string' ? body.compilerMode : 'compatibility',
      config: typeof body.config === 'object' && body.config !== null ? JSON.stringify(body.config) : '{}',
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    deps.store.db.insert(presetsTable).values(record).run()
    const snapshot = JSON.stringify(record)
    deps.store.db.insert(presetVersions).values({
      id: uuidv7(),
      presetId: id,
      version: 1,
      snapshot,
      contentHash: sha256Hex(snapshot),
      createdAt: now,
    }).run()
    return ok(c, requestId, { id, name, version: 1 }, 201)
  })

  // S12(WP1.3):ST 预设导入(§80–§81 prompts[] + prompt_order[] → .dgpreset)。
  // 归一走 st-compat,落盘 .dgpreset 文件(事实源)+ presets 行(config=原生 JSON)+ v1 快照。
  app.post('/api/v2/presets/import', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    if (typeof body.base64 !== 'string' || body.base64 === '') {
      return fail(c, requestId, 'VALIDATION_ERROR', 'base64(预设文件字节)必填')
    }
    let result
    try {
      result = importPreset(new Uint8Array(Buffer.from(body.base64, 'base64')), {
        name: typeof body.name === 'string' && body.name !== '' ? body.name : undefined,
      })
    } catch (error) {
      if (isPresetParseError(error)) return fail(c, requestId, 'VALIDATION_ERROR', error.message)
      throw error
    }
    const presetId = persistPreset(deps, result.preset, result.report.asset.sourceFormat)
    return ok(
      c,
      requestId,
      {
        preset: { id: presetId, name: result.preset.meta.name, segmentCount: result.preset.segments.length, version: 1 },
        report: result.report,
      },
      201,
    )
  })

  app.get('/api/v2/personas', (c) => {
    const requestId = requestIdOf(c)
    const rows = deps.store.db.select().from(personasTable).orderBy(desc(personasTable.createdAt)).limit(100).all()
    return ok(c, requestId, rows.map((row) => ({ id: row.id, name: row.name, version: row.version })))
  })

  // S12(WP1.3):Persona 库创建(名称 + 描述 + 元数据)+ v1 快照(资产注册表口径)。
  app.post('/api/v2/personas', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const name = typeof body.name === 'string' ? body.name : ''
    if (name === '') return fail(c, requestId, 'VALIDATION_ERROR', 'name 必填')
    const id = uuidv7()
    const now = nowIso()
    const meta = typeof body.metadata === 'object' && body.metadata !== null ? (body.metadata as Record<string, unknown>) : {}
    const description = typeof body.description === 'string' ? body.description : null
    deps.store.db.insert(personasTable).values({
      id,
      name,
      description,
      metadata: JSON.stringify(meta),
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run()
    const snapshot = JSON.stringify({ id, name, description, metadata: meta })
    deps.store.db.insert(personaVersions).values({
      id: uuidv7(),
      personaId: id,
      version: 1,
      snapshot,
      contentHash: sha256Hex(snapshot),
      createdAt: now,
    }).run()
    return ok(c, requestId, { id, name, version: 1 }, 201)
  })

  // ===== P3 Agent API(§154;S28/WP3.6 落地)=====

  /** §64 建 Run:provider 解析顺序 = body.providerId/model → agent.modelPolicy → chat 绑定 */
  function resolveAgentProvider(
    agentModelPolicy: Record<string, unknown>,
    chat: Chat | undefined,
    body: Record<string, unknown>,
  ): { providerId: string; model: string; adapter: ProviderAdapter } | { error: { code: string; message: string } } {
    const fromPolicy = (typeof agentModelPolicy.provider === 'string' ? agentModelPolicy.provider : undefined)
    const fromPolicyModel = (typeof agentModelPolicy.model === 'string' ? agentModelPolicy.model : undefined)
    const providerId = (typeof body.providerId === 'string' ? body.providerId : undefined)
      ?? fromPolicy
      ?? (chat?.modelProvider as string | undefined)
    const model = (typeof body.model === 'string' ? body.model : undefined)
      ?? fromPolicyModel
      ?? (chat?.modelName as string | undefined)
    if (providerId === undefined || model === undefined) {
      return { error: { code: 'VALIDATION_ERROR', message: 'agent 未声明 modelPolicy.provider/model,且请求未覆盖' } }
    }
    const row = deps.store.db.select().from(providersTable).where(eq(providersTable.id, providerId)).get()
    if (row === undefined) {
      return { error: { code: 'PROVIDER_NOT_FOUND', message: `provider 不存在: ${providerId}` } }
    }
    const config = JSON.parse(row.config) as Record<string, unknown>
    const secretRef = typeof config.secretRef === 'string' ? config.secretRef : undefined
    const apiKey = secretRef === undefined ? undefined : deps.secretStore.get(secretRef)
    try {
      return { providerId, model, adapter: buildAdapter(row.type, config, apiKey) }
    } catch (error) {
      return { error: { code: 'VALIDATION_ERROR', message: String((error as Error).message) } }
    }
  }

  /** §62/§63 GET /agents:Definition 列表(未软删;createdAt 升序) */
  app.get('/api/v2/agents', (c) => {
    const requestId = requestIdOf(c)
    return ok(c, requestId, listAgentDefinitions(deps.store))
  })

  /** §63 POST /agents:建 Definition(name 必填;type 缺省 custom) */
  app.post('/api/v2/agents', async (c) => {
    const requestId = requestIdOf(c)
    const body = await jsonBody(c)
    const name = typeof body.name === 'string' ? body.name : ''
    if (name === '') return fail(c, requestId, 'VALIDATION_ERROR', 'name 必填')
    const requestedType = typeof body.type === 'string' ? body.type : 'custom'
    if (!AGENT_TYPES.includes(requestedType as never)) {
      return fail(c, requestId, 'VALIDATION_ERROR', `未知 agent type: ${requestedType}(${AGENT_TYPES.join('/')})`)
    }
    const definition = createAgentDefinition(deps.store, {
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      type: requestedType as never,
      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      contextPolicy: isRecord(body.contextPolicy) ? body.contextPolicy : undefined,
      memoryPolicy: isRecord(body.memoryPolicy) ? body.memoryPolicy : undefined,
      toolPolicy: isRecord(body.toolPolicy) ? body.toolPolicy : undefined,
      modelPolicy: isRecord(body.modelPolicy) ? body.modelPolicy : undefined,
      runtimePolicy: isRecord(body.runtimePolicy)
        ? {
            maxTurns: num(body.runtimePolicy.maxTurns, 8),
            maxToolCalls: num(body.runtimePolicy.maxToolCalls, 20),
            maxExecutionTimeMs: num(body.runtimePolicy.maxExecutionTimeMs, 10 * 60_000),
          }
        : undefined,
      metadata: isRecord(body.metadata) ? body.metadata : undefined,
      now: nowIso(),
    })
    deps.bus.publish({ type: 'agent.created', aggregateType: 'agent', aggregateId: definition.id, runId: undefined, timestamp: nowIso(), payload: { agentId: definition.id } })
    return ok(c, requestId, definition, 201)
  })

  /**
   * §64 POST /agents/:id/runs:启动 Agent Run(长任务原则 §143:先 track 再异步跑)。
   * 请求体 {input, chatId?, parentRunId?, context?, budget?}。input 作为 user 消息
   * 入树(runAgent 从活跃链读取),provider 解析见 resolveAgentProvider。
   */
  app.post('/api/v2/agents/:id/runs', async (c) => {
    const requestId = requestIdOf(c)
    const agentId = c.req.param('id')
    const definition = loadAgentDefinition(deps.store, agentId as never)
    if (definition === undefined) {
      return fail(c, requestId, 'AGENT_NOT_FOUND', `agent 不存在: ${agentId}`)
    }
    const body = await jsonBody(c)
    const inputText = typeof body.input === 'string' ? body.input : ''
    if (inputText === '') return fail(c, requestId, 'VALIDATION_ERROR', 'input 必填')

    // chatId:缺省 = 新建一个以 agent 命名的 chat(§64 chatId 可选)
    let chatId = typeof body.chatId === 'string' ? body.chatId : undefined
    if (chatId === undefined) {
      const created = createChat(deps.store, deps.bus, { title: `agent:${definition.name}`, now: nowIso() })
      if (!created.ok) return runtimeError(c, requestId, created.error)
      chatId = created.value.id
    } else {
      const chat = loadChat(deps.store, chatId as ChatId)
      if (!chat.ok) return runtimeError(c, requestId, chat.error)
    }
    const chat = loadChat(deps.store, chatId as ChatId)

    const resolved = resolveAgentProvider(definition.modelPolicy, chat.ok ? chat.value : undefined, body)
    if ('error' in resolved) return fail(c, requestId, resolved.error.code, resolved.error.message)

    // input → user 消息入树(runAgent 从活跃链编译)
    const message = createMessage(deps.store, deps.bus, {
      chatId: chatId as ChatId,
      role: 'user',
      content: inputText,
      now: nowIso(),
    })
    if (!message.ok) return runtimeError(c, requestId, message.error)

    // 长任务:先 track(不错过首事件)再异步跑;AbortController 供 cancel/pause 用
    const controller = new AbortController()
    const runId = uuidv7()
    registry.track(runId, controller)

    const parentRunId = typeof body.parentRunId === 'string' ? body.parentRunId : undefined
    const guard = assertCanSpawn(deps.store, {
      ...(parentRunId === undefined ? {} : { parentRunId: parentRunId as never }),
      limits: budgetTreeLimits(body),
      ...(isRecord(body.budget) ? {} : {}),
    })
    if (!guard.allowed) {
      registry.abort(runId)
      return fail(c, requestId, 'AGENT_RECURSION_LIMIT', guard.reason ?? 'Agent Tree 递归护栏拒绝 spawn', { status: 409 })
    }

    void runAgentOrchestrator(agentRunDeps(), {
      chatId: chatId as ChatId,
      agentId: agentId as never,
      adapter: resolved.adapter,
      providerId: resolved.providerId,
      model: resolved.model,
      signal: controller.signal,
      runId: runId as never,
      now: nowIso(),
      budget: {
        ...(isRecord(body.budget) ? {
          ...(body.budget.maxTurns === undefined ? {} : { maxTurns: num(body.budget.maxTurns, 1) }),
          ...(body.budget.maxToolCalls === undefined ? {} : { maxToolCalls: num(body.budget.maxToolCalls, 20) }),
          ...(body.budget.maxExecutionTimeMs === undefined ? {} : { maxExecutionTimeMs: num(body.budget.maxExecutionTimeMs, 0) }),
        } : {}),
      },
      ...(parentRunId === undefined ? {} : { parentRunId: parentRunId as never }),
    })
      .then((outcome) => {
        if (!outcome.ok) {
          deps.logger?.('error', `agent run 失败: ${runId}`, outcome.error.message)
        } else if (outcome.value.status === 'failed') {
          deps.logger?.('info', `agent run 完成但失败: ${runId}`, outcome.value.status)
        }
        registry.abort(runId) // 终止后清掉注册(懒淘汰兜底)
      })
      .catch((error) => {
        deps.logger?.('error', `agent run 异常: ${runId}`, String(error))
        registry.abort(runId)
      })

    return ok(c, requestId, {
      runId,
      chatId: chatId as string,
      agentId,
      status: 'running',
    }, 202)
  })

  /** §66 GET /agent-runs/:id:Run 状态 + Attempt/Step 摘要(§65 AgentRunState 投影) */
  app.get('/api/v2/agent-runs/:id', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) return fail(c, requestId, 'NOT_FOUND', `agent run 不存在: ${runId}`)
    const attempts = deps.store.db.select().from(attemptsTable).where(eq(attemptsTable.runId, runId)).orderBy(attemptsTable.attemptNo).all()
    return ok(c, requestId, {
      runId: run.id,
      chatId: run.chatId,
      agentId: run.agentId,
      agentVersion: run.agentVersion,
      status: run.status,
      mode: run.mode ?? 'live',
      provider: run.provider,
      model: run.model,
      parentRunId: run.parentRunId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      error: run.error,
      attempts: attempts.map((a) => ({
        attemptNo: a.attemptNo,
        status: a.status,
        error: a.error,
        startedAt: a.startedAt,
        completedAt: a.completedAt,
      })),
    })
  })

  // ===== S28 任务 3 观测面(agent-runtime-spec §121/§122/§124;零新存储,只读投影既有执行层)=====

  /**
   * §121 Run Timeline:按时间序把 Run 的执行足迹展开成可读时序
   * (operations 设施级明细 + step_runs 步骤 + attempts 尝试;源均为既有表)。
   */
  app.get('/api/v2/agent-runs/:id/timeline', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent run 不存在: ${runId}`)
    const attempts = deps.store.db.select().from(attemptsTable).where(eq(attemptsTable.runId, runId)).orderBy(attemptsTable.attemptNo).all()
    const stepRuns = attempts.flatMap((a) =>
      deps.store.db.select().from(stepRunsTable).where(eq(stepRunsTable.attemptId, a.id)).orderBy(stepRunsTable.runNo).all(),
    )
    const entries = ([] as { at: string; kind: string; label: string }[])
      .concat(
        attempts.map((a) => ({ at: a.startedAt, kind: 'attempt', label: `Attempt ${a.attemptNo} ${a.status}` })),
        attempts.filter((a) => a.completedAt !== null).map((a) => ({ at: a.completedAt!, kind: 'attempt', label: `Attempt ${a.attemptNo} done` })),
        stepRuns.map((s) => ({ at: s.startedAt, kind: 'step', label: `Step ${s.stepId} #${s.runNo} ${s.status}` })),
      )
    const timeline = entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    return ok(c, requestId, timeline)
  })

  /**
   * §122 Cost Tracking:Run 的 Attempt/Step 逐级 usage(provider 上报 token 计数)汇总。
   * toolCost 属 Workflow 面(execution_operations 的 tool_request),Run 面只给 token 账。
   */
  app.get('/api/v2/agent-runs/:id/cost', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent run 不存在: ${runId}`)
    const attempts = deps.store.db.select().from(attemptsTable).where(eq(attemptsTable.runId, runId)).orderBy(attemptsTable.attemptNo).all()
    const sum = (rows: { usage: string | null }[], key: string): number =>
      rows.reduce((acc, r) => {
        if (r.usage === null) return acc
        const parsed = JSON.parse(r.usage) as Record<string, unknown>
        const v = parsed[key]
        return typeof v === 'number' ? acc + v : acc
      }, 0)
    const attemptsUsage = attempts.filter((a) => a.usage !== null)
    return ok(c, requestId, {
      runId,
      inputTokens: sum(attemptsUsage, 'inputTokens'),
      outputTokens: sum(attemptsUsage, 'outputTokens'),
      cachedTokens: sum(attemptsUsage, 'cachedTokens'),
      providerCost: null,
      toolCost: null,
      totalCost: null,
      attempts: attempts.length,
    })
  })

  /**
   * §124 Agent Inspector:Definition + Runtime State + 当前 Run + Tool Calls + Artifacts
   * (Budget 取 Definition.runtimePolicy;Context 让给 §123 Prompt Inspector 链路)。
   */
  app.get('/api/v2/agents/:id/inspector', (c) => {
    const requestId = requestIdOf(c)
    const agentId = c.req.param('id')
    const definition = loadAgentDefinition(deps.store, agentId as never)
    if (definition === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent 不存在: ${agentId}`)
    const states = deps.store.db.select().from(agentRuntimeStates).where(eq(agentRuntimeStates.agentId, agentId)).all()
    const toolCalls = deps.store.db
      .select()
      .from(toolCallsTable)
      .where(eq(toolCallsTable.runId, agentId))
      .all()
      .slice(0, 50)
    const artifacts = deps.store.db
      .select()
      .from(artifactsTable)
      .where(isNull(artifactsTable.runId))
      .all()
      .slice(0, 50)
    const inspector = {
      agent: { id: definition.id, version: definition.version, name: definition.name, type: definition.type, runtimePolicy: definition.runtimePolicy },
      states: states.map((s) => ({
        chatId: s.chatId,
        agentId: s.agentId,
        agentVersion: s.agentVersion,
        status: s.status,
        currentRunId: s.currentRunId,
        lastHeartbeatAt: s.lastHeartbeatAt,
        state: JSON.parse(s.state),
      })),
      currentRun: states.find((s) => s.currentRunId !== null)?.currentRunId,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        toolName: tc.toolName,
        status: tc.status,
        error: tc.error,
        startedAt: tc.startedAt,
        completedAt: tc.completedAt,
      })),
      artifacts: artifacts.map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        frozen: a.frozen,
        createdAt: a.createdAt,
      })),
    }
    return ok(c, requestId, inspector)
  })

  /** §66 取消:活跃 run 走 registry.abort;已终态幂等返回当前状态 */
  app.post('/api/v2/agent-runs/:id/cancel', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    if (registry.abort(runId)) return ok(c, requestId, { cancelled: true })
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent run 不存在: ${runId}`)
    return ok(c, requestId, { cancelled: false, status: run.status })
  })

  /** §66 暂停:仅对**活跃流式** run 生效(经 abort 相同机制;已终态幂等返回状态) */
  app.post('/api/v2/agent-runs/:id/pause', (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent run 不存在: ${runId}`)
    if (run.status !== 'running') return ok(c, requestId, { paused: false, status: run.status })
    return fail(c, requestId, 'VALIDATION_ERROR', '暂停仅支持已接入 pauseToken 的活跃 run(§51);本轮经 cancel/resume 走')
  })

  /** §66 恢复:S27 §51–§55 resumeRun(兼容性校验 + 对账 + 新 Attempt 续跑) */
  app.post('/api/v2/agent-runs/:id/resume', async (c) => {
    const requestId = requestIdOf(c)
    const runId = c.req.param('id')
    const run = deps.store.db.select().from(runsTable).where(eq(runsTable.id, runId)).get()
    if (run === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent run 不存在: ${runId}`)
    const agentId = run.agentId as unknown as string
    const definition = loadAgentDefinition(deps.store, agentId as never)
    if (definition === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent 不存在: ${agentId}`)
    const chat = loadChat(deps.store, run.chatId as ChatId)
    const resolved = resolveAgentProvider(definition.modelPolicy, chat.ok ? chat.value : undefined, await jsonBody(c))
    if ('error' in resolved) return fail(c, requestId, resolved.error.code, resolved.error.message)
    const result = await resumeRun(agentRunDeps(), {
      runId: runId as never,
      chatId: run.chatId as ChatId,
      agentId: agentId as never,
      adapter: resolved.adapter,
      providerId: resolved.providerId,
      model: resolved.model,
      now: nowIso(),
    })
    if (!result.ok) return runtimeError(c, requestId, result.error)
    return ok(c, requestId, { runId, status: result.value.status })
  })

  /**
   * §71 delegate:以 :id 为父 spawn 子 Run(§93 assertCanSpawn 先行,超护栏 409)。
   * 子 Run 复用父 Run 的 chat;input = task。
   */
  app.post('/api/v2/agent-runs/:id/delegate', async (c) => {
    const requestId = requestIdOf(c)
    const parentRunId = c.req.param('id')
    const parent = deps.store.db.select().from(runsTable).where(eq(runsTable.id, parentRunId)).get()
    if (parent === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent run 不存在: ${parentRunId}`)
    const body = await jsonBody(c)
    const childAgentId = typeof body.agentId === 'string' ? body.agentId : ''
    const task = typeof body.task === 'string' ? body.task : ''
    if (childAgentId === '' || task === '') return fail(c, requestId, 'VALIDATION_ERROR', 'agentId 与 task 必填')

    const guard = assertCanSpawn(deps.store, {
      parentRunId: parentRunId as never,
      limits: budgetTreeLimits(body),
    })
    if (!guard.allowed) {
      return fail(c, requestId, 'AGENT_RECURSION_LIMIT', guard.reason ?? 'Agent Tree 递归护栏拒绝 spawn', { status: 409 })
    }

    const definition = loadAgentDefinition(deps.store, childAgentId as never)
    if (definition === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent 不存在: ${childAgentId}`)
    const chat = loadChat(deps.store, parent.chatId as ChatId)
    const resolved = resolveAgentProvider(definition.modelPolicy, chat.ok ? chat.value : undefined, body)
    if ('error' in resolved) return fail(c, requestId, resolved.error.code, resolved.error.message)

    const message = createMessage(deps.store, deps.bus, {
      chatId: parent.chatId as ChatId,
      role: 'user',
      content: task,
      now: nowIso(),
    })
    if (!message.ok) return runtimeError(c, requestId, message.error)

    const controller = new AbortController()
    const childRunId = uuidv7()
    registry.track(childRunId, controller)
    void runAgentOrchestrator(agentRunDeps(), {
      chatId: parent.chatId as ChatId,
      agentId: childAgentId as never,
      adapter: resolved.adapter,
      providerId: resolved.providerId,
      model: resolved.model,
      signal: controller.signal,
      runId: childRunId as never,
      parentRunId: parentRunId as never,
      now: nowIso(),
      budget: {
        ...(isRecord(body.budget) ? {
          ...(body.budget.maxTurns === undefined ? {} : { maxTurns: num(body.budget.maxTurns, 1) }),
          ...(body.budget.maxToolCalls === undefined ? {} : { maxToolCalls: num(body.budget.maxToolCalls, 20) }),
        } : {}),
      },
    })
      .then(() => registry.abort(childRunId))
      .catch((error) => {
        deps.logger?.('error', `agent run 异常: ${childRunId}`, String(error))
        registry.abort(childRunId)
      })
    return ok(c, requestId, { childRunId }, 202)
  })

  /**
   * §73 handoff:以 :id 为父把手伸给 targetAgent(§93 护栏先行)。
   * Handoff 不复制全 Context(§73:只传 handoff payload + allowed context);
   * 此处把 reason/findings 作为新 user 消息入树(目标 Agent 从活跃链读到)。
   */
  app.post('/api/v2/agent-runs/:id/handoff', async (c) => {
    const requestId = requestIdOf(c)
    const parentRunId = c.req.param('id')
    const parent = deps.store.db.select().from(runsTable).where(eq(runsTable.id, parentRunId)).get()
    if (parent === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent run 不存在: ${parentRunId}`)
    const body = await jsonBody(c)
    const targetAgentId = typeof body.targetAgentId === 'string' ? body.targetAgentId : ''
    const reason = typeof body.reason === 'string' ? body.reason : ''
    if (targetAgentId === '' || reason === '') return fail(c, requestId, 'VALIDATION_ERROR', 'targetAgentId 与 reason 必填')

    const guard = assertCanSpawn(deps.store, {
      parentRunId: parentRunId as never,
      limits: budgetTreeLimits(body),
    })
    if (!guard.allowed) {
      return fail(c, requestId, 'AGENT_RECURSION_LIMIT', guard.reason ?? 'Agent Tree 递归护栏拒绝 spawn', { status: 409 })
    }

    const definition = loadAgentDefinition(deps.store, targetAgentId as never)
    if (definition === undefined) return fail(c, requestId, 'AGENT_NOT_FOUND', `agent 不存在: ${targetAgentId}`)
    const chat = loadChat(deps.store, parent.chatId as ChatId)
    const resolved = resolveAgentProvider(definition.modelPolicy, chat.ok ? chat.value : undefined, body)
    if ('error' in resolved) return fail(c, requestId, resolved.error.code, resolved.error.message)

    const findings = typeof body.findings === 'string' ? body.findings : ''
    const handoffTask = `[handoff ${reason}]${findings !== '' ? `\n${findings}` : ''}`
    const message = createMessage(deps.store, deps.bus, {
      chatId: parent.chatId as ChatId,
      role: 'user',
      content: handoffTask,
      now: nowIso(),
    })
    if (!message.ok) return runtimeError(c, requestId, message.error)

    const controller = new AbortController()
    const targetRunId = uuidv7()
    registry.track(targetRunId, controller)
    void runAgentOrchestrator(agentRunDeps(), {
      chatId: parent.chatId as ChatId,
      agentId: targetAgentId as never,
      adapter: resolved.adapter,
      providerId: resolved.providerId,
      model: resolved.model,
      signal: controller.signal,
      runId: targetRunId as never,
      parentRunId: parentRunId as never,
      now: nowIso(),
    })
      .then(() => registry.abort(targetRunId))
      .catch((error) => {
        deps.logger?.('error', `agent run 异常: ${targetRunId}`, String(error))
        registry.abort(targetRunId)
      })
    return ok(c, requestId, { targetRunId }, 202)
  })

  /** §75/§76 GET /tools:注册面投影(agentId/capability 过滤留 P4;P5 插件工具面) */
  app.get('/api/v2/tools', (c) => {
    const requestId = requestIdOf(c)
    const capability = c.req.query('capability')
    const all = tools.list()
    const projected = all
      .filter((t) => capability === undefined || capability === null || t.permissions.some((p) => p === capability))
      .map((t: ToolDefinition) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        permission: t.permissions[0] ?? '',
        source: 'core' as const,
      }))
    return ok(c, requestId, projected)
  })

  /** §79 GET /skills:S28 技能目录仍为空(仅 .gitkeep);注册面随 P4 引入 */
  app.get('/api/v2/skills', (c) => {
    const requestId = requestIdOf(c)
    return ok(c, requestId, [])
  })

  // —— 全局错误兜底(api-spec §7 信封;D2:对外只暴露一种归一化形式)——
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? `req_${uuidv7()}`
    const message = error instanceof Error ? error.message : String(error)
    deps.logger?.('error', `request failed: ${requestId}`, `${message}\n${error instanceof Error ? (error.stack ?? '') : ''}`)
    c.header('X-Request-ID', requestId)
    return c.json(
      { error: { code: 'PROVIDER_UNAVAILABLE', message: '内部错误(已记录)', retryable: false, requestId } },
      500,
    )
  })

  // ===== S31(WP4.2b)Memory HTTP 面(api-spec §88–§92 / §155;记忆读写唯一入口 = Repository)=====

  /** §88 POST /chats/:id/memory/search:跨四层检索(plugin:kinds 过滤;limit 上限防无界) */
  app.post('/api/v2/chats/:id/memory/search', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const body = await jsonBody(c)
    if (typeof body.query !== 'string' || body.query === '') return fail(c, requestId, 'VALIDATION_ERROR', 'query 必填')
    const rawKinds = Array.isArray(body.kinds) ? body.kinds : undefined
    const kinds = rawKinds?.filter((k): k is NonNullable<(typeof rawKinds)[number]> => typeof k === 'string' && ['summary', 'dossier', 'timeline', 'document'].includes(k))
    const limit = num(body.limit, 20)
    const items = await searchMemory(deps.store.sqlite, {
      chatId,
      query: body.query,
      limit: Math.min(Math.max(limit, 1), 100),
      kinds: kinds && kinds.length > 0 ? (kinds as ('summary' | 'dossier' | 'timeline' | 'document')[]) : undefined,
    })
    return ok(c, requestId, { items, total: items.length })
  })

  /** §90 GET /chats/:id/summaries:冻结块链(sequence 升序 = 剧情压缩时间序) */
  app.get('/api/v2/chats/:id/summaries', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const repo = createMemoryRepository(deps.store.sqlite)
    const chain = await repo.listSummaryChain(chatId)
    return ok(c, requestId, chain.map((b) => ({
      id: b.id,
      seq: b.sequence,
      content: b.content,
      coversMessageRange: { from: b.fromMessageId, to: b.toMessageId },
      frozenAt: b.createdAt,
      ...(b.tokenCount === undefined ? {} : { tokenCount: b.tokenCount }),
    })))
  })

  /** §90 POST /chats/:id/summaries:显式 Checkpoint 冻结块(§24;ContentRange 校验区间属本 chat) */
  app.post('/api/v2/chats/:id/summaries', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const body = await jsonBody(c)
    const content = typeof body.content === 'string' && body.content !== '' ? body.content : ''
    if (content === '') return fail(c, requestId, 'VALIDATION_ERROR', 'content 必填')
    const range = body.coversMessageRange
    const from = isRecord(range) && typeof range.from === 'string' ? range.from : ''
    const to = isRecord(range) && typeof range.to === 'string' ? range.to : ''
    if (from === '' || to === '') return fail(c, requestId, 'VALIDATION_ERROR', 'coversMessageRange.{from,to} 必填')
    const repo = createMemoryRepository(deps.store.sqlite)
    const block = await repo.appendSummaryBlock({
      chatId,
      content,
      fromMessageId: from,
      toMessageId: to,
      tokenCount: typeof body.tokenCount === 'number' ? body.tokenCount : undefined,
    })
    return ok(c, requestId, {
      id: block.id,
      seq: block.sequence,
      content: block.content,
      coversMessageRange: { from: block.fromMessageId, to: block.toMessageId },
      frozenAt: block.createdAt,
      ...(block.tokenCount === undefined ? {} : { tokenCount: block.tokenCount }),
    }, 201)
  })

  /** §91 GET /chats/:id/dossier:Dossier 实体卡列表(图 type='fact',按 updated_at 降序) */
  app.get('/api/v2/chats/:id/dossier', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const repo = createMemoryRepository(deps.store.sqlite)
    const entries = await repo.listMemories({ chatId, type: 'fact', limit: 200 })
    return ok(c, requestId, entries.map((m) => toDossierDto(chatId, m)))
  })

  /** §91 POST /chats/:id/dossier/entities:建/更新实体卡(同 entity = 版本化更新,镜像 memory.upsert_dossier 工具) */
  app.post('/api/v2/chats/:id/dossier/entities', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const body = await jsonBody(c)
    const entity = typeof body.entity === 'string' && body.entity !== '' ? body.entity : ''
    const content = typeof body.content === 'string' && body.content !== '' ? body.content : ''
    if (entity === '' || content === '') return fail(c, requestId, 'VALIDATION_ERROR', 'entity/content 必填')
    const repo = createMemoryRepository(deps.store.sqlite)
    // 同 entity 的既有卡 = 版本化更新(upsertMemory 仅有 memoryId 才走 UPDATE;先查后传)
    const existing = await repo.listMemories({ chatId, type: 'fact', entity, limit: 1 })
    const memoryId = await repo.upsertMemory({
      ...(existing[0] ? { memoryId: existing[0].memoryId } : {}),
      ownerId: 'api',
      chatId,
      type: 'fact',
      entity,
      content,
      importance: typeof body.importance === 'number' ? body.importance : (existing[0]?.importance ?? undefined),
      confidence: typeof body.confidence === 'number' ? body.confidence : (existing[0]?.confidence ?? undefined),
      sourceMessageIds: Array.isArray(body.sourceMessageIds)
        ? body.sourceMessageIds.filter((x): x is string => typeof x === 'string')
        : existing[0]?.sourceMessageIds,
    })
    const memory = await repo.getMemory(memoryId)
    return ok(c, requestId, toDossierDto(chatId, memory!), 201)
  })

  /** §91 PATCH /dossier/entities/:id:更新既有实体卡(实体名不变,内容/重要度可改;版本化) */
  app.patch('/api/v2/dossier/entities/:id', async (c) => {
    const requestId = requestIdOf(c)
    const entityId = c.req.param('id')
    const repo = createMemoryRepository(deps.store.sqlite)
    const existing = await repo.getMemory(entityId)
    if (existing === undefined || existing.type !== 'fact') return fail(c, requestId, 'MEMORY_NOT_FOUND', 'Dossier 实体卡不存在', { status: 404 })
    const chatId = existing.chatId ?? ''
    if (chatId === '') return fail(c, requestId, 'VALIDATION_ERROR', '实体卡无 chatId,无法定位会话')
    const body = await jsonBody(c)
    const content = typeof body.content === 'string' && body.content !== '' ? body.content : existing.content
    const memoryId = await repo.upsertMemory({
      memoryId: entityId,
      ownerId: 'api',
      chatId,
      type: 'fact',
      entity: existing.entity ?? '',
      content,
      importance: typeof body.importance === 'number' ? body.importance : existing.importance,
      confidence: typeof body.confidence === 'number' ? body.confidence : existing.confidence,
      sourceMessageIds: typeof body.sourceMessageIds === 'undefined' ? existing.sourceMessageIds : (Array.isArray(body.sourceMessageIds) ? body.sourceMessageIds.filter((x): x is string => typeof x === 'string') : undefined),
    })
    const memory = await repo.getMemory(memoryId)
    return ok(c, requestId, toDossierDto(chatId, memory!))
  })

  /** §92 GET /chats/:id/timeline:追加式事件流(created_at 降序 = 最新在前) */
  app.get('/api/v2/chats/:id/timeline', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const repo = createMemoryRepository(deps.store.sqlite)
    const events = await repo.listTimelineEvents({ chatId, limit: 200 })
    return ok(c, requestId, events.map((e) => toTimelineDto(e)))
  })

  /** §92 POST /chats/:id/timeline:追加事件(只追加不 UPDATE,§4.1.3) */
  app.post('/api/v2/chats/:id/timeline', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const body = await jsonBody(c)
    const eventType = typeof body.eventType === 'string' && body.eventType !== '' ? body.eventType : ''
    const summary = typeof body.summary === 'string' && body.summary !== '' ? body.summary : ''
    if (eventType === '' || summary === '') return fail(c, requestId, 'VALIDATION_ERROR', 'eventType/summary 必填')
    const repo = createMemoryRepository(deps.store.sqlite)
    const eventId = await repo.appendTimelineEvent({
      chatId,
      eventType,
      summary,
      participants: Array.isArray(body.participants) ? body.participants.filter((x): x is string => typeof x === 'string') : undefined,
      location: typeof body.location === 'string' ? body.location : undefined,
      consequences: typeof body.consequences === 'string' ? body.consequences : undefined,
      sourceMessageId: typeof body.sourceMessageId === 'string' ? body.sourceMessageId : undefined,
      importance: typeof body.importance === 'number' ? body.importance : undefined,
      emotionalWeight: typeof body.emotionalWeight === 'number' ? body.emotionalWeight : undefined,
    })
    const events = await repo.listTimelineEvents({ chatId, limit: 1 })
    const created = events.find((e) => e.id === eventId) ?? {
      id: eventId,
      chatId,
      eventType,
      summary,
      participants: [],
      location: typeof body.location === 'string' ? body.location : undefined,
      consequences: typeof body.consequences === 'string' ? body.consequences : undefined,
      sourceMessageId: typeof body.sourceMessageId === 'string' ? body.sourceMessageId : undefined,
      importance: typeof body.importance === 'number' ? body.importance : undefined,
      emotionalWeight: typeof body.emotionalWeight === 'number' ? body.emotionalWeight : undefined,
      createdAt: nowIso(),
    }
    return ok(c, requestId, toTimelineDto(created), 201)
  })

  /** wp4.2b Scribe 触发(§4.2 用户指令 Trigger;§143 长任务先 track 再异步跑;写入经 tool_calls/artifacts 落账) */
  app.post('/api/v2/chats/:id/memory/scribe', async (c) => {
    const requestId = requestIdOf(c)
    const chatId = c.req.param('id')
    const chat = loadChat(deps.store, chatId as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const body = await jsonBody(c)

    // provider 解析:body.providerId/model 覆盖 → 对话绑定
    const providerId = typeof body.providerId === 'string' ? body.providerId : chat.value.modelProvider
    const model = typeof body.model === 'string' ? body.model : chat.value.modelName
    if (providerId === undefined || model === undefined) {
      return fail(c, requestId, 'VALIDATION_ERROR', 'chat 未绑定 modelProvider/model,且请求未覆盖')
    }
    const providerRow = deps.store.db.select().from(providersTable).where(eq(providersTable.id, providerId)).get()
    if (providerRow === undefined) return fail(c, requestId, 'PROVIDER_NOT_FOUND', `provider 不存在: ${providerId}`)
    let adapter: ProviderAdapter | undefined
    try {
      const config = JSON.parse(providerRow.config) as Record<string, unknown>
      const secretRef = typeof config.secretRef === 'string' ? config.secretRef : undefined
      const apiKey = secretRef === undefined ? undefined : deps.secretStore.get(secretRef)
      adapter = buildAdapter(providerRow.type, config, apiKey)
    } catch (error) {
      return fail(c, requestId, 'VALIDATION_ERROR', String((error as Error).message))
    }
    if (adapter === undefined) return fail(c, requestId, 'VALIDATION_ERROR', 'Scribe 需要可用 provider')

    // 长任务:先 track(不错过首事件)再异步跑
    const controller = new AbortController()
    const runId = uuidv7()
    registry.track(runId, controller)

    void runScribe(agentRunDeps(), {
      chatId: chatId as ChatId,
      ...(typeof body.fromMessageId === 'string' ? { fromMessageId: body.fromMessageId } : {}),
      ...(typeof body.toMessageId === 'string' ? { toMessageId: body.toMessageId } : {}),
      adapter,
      providerId,
      model,
      signal: controller.signal,
      runId: runId as never,
      ...(isRecord(body.budget)
        ? {
            budget: {
              ...(body.budget.maxTurns === undefined ? {} : { maxTurns: num(body.budget.maxTurns, 1) }),
              ...(body.budget.maxToolCalls === undefined ? {} : { maxToolCalls: num(body.budget.maxToolCalls, 20) }),
              ...(body.budget.maxExecutionTimeMs === undefined ? {} : { maxExecutionTimeMs: num(body.budget.maxExecutionTimeMs, 0) }),
            },
          }
        : {}),
      now: nowIso(),
    })
      .then(() => registry.abort(runId))
      .catch((error) => {
        deps.logger?.('error', `scribe run 异常: ${runId}`, String(error))
        registry.abort(runId)
      })

    return ok(c, requestId, { runId, chatId, status: 'running' }, 202)
  })

  function toDossierDto(chatId: string, m: { memoryId: string; entity?: string; content: string; importance?: number; confidence?: number; version: number; createdAt: string; updatedAt: string }): Record<string, unknown> {
    return {
      id: m.memoryId,
      chatId,
      entity: m.entity ?? '',
      content: m.content,
      ...(m.importance === undefined ? {} : { importance: m.importance }),
      ...(m.confidence === undefined ? {} : { confidence: m.confidence }),
      version: m.version,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }
  }

  function toTimelineDto(e: { id: string; chatId: string; eventType: string; summary: string; participants: string[]; location?: string; consequences?: string; sourceMessageId?: string; importance?: number; emotionalWeight?: number; createdAt: string }): Record<string, unknown> {
    return {
      id: e.id,
      chatId: e.chatId,
      eventType: e.eventType,
      summary: e.summary,
      participants: e.participants,
      ...(e.location === undefined ? {} : { location: e.location }),
      ...(e.consequences === undefined ? {} : { consequences: e.consequences }),
      ...(e.sourceMessageId === undefined ? {} : { sourceMessageId: e.sourceMessageId }),
      ...(e.importance === undefined ? {} : { importance: e.importance }),
      ...(e.emotionalWeight === undefined ? {} : { emotionalWeight: e.emotionalWeight }),
      createdAt: e.createdAt,
    }
  }

  return { app, registry }
}

function nowIso(): string {
  return new Date().toISOString()
}

/** §154 请求体保守读取:对象形才收(其余按缺省),杜绝字符串/数组混进 Record */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** §154 数值读取:非有限正数则取缺省 */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

/** §39/§70 树护栏字段(§93 assertCanSpawn 消费);非薄记录直接跳过 */
function budgetTreeLimits(body: Record<string, unknown>): { maxDepth?: number; maxChildren?: number; maxTotalAgents?: number; maxRuntimeMs?: number } {
  if (!isRecord(body.budget)) return {}
  const b = body.budget
  const limits: { maxDepth?: number; maxChildren?: number; maxTotalAgents?: number; maxRuntimeMs?: number } = {}
  if (typeof b.maxDepth === 'number') limits.maxDepth = b.maxDepth
  if (typeof b.maxChildren === 'number') limits.maxChildren = b.maxChildren
  if (typeof b.maxTotalAgents === 'number') limits.maxTotalAgents = b.maxTotalAgents
  if (typeof b.maxRuntimeMs === 'number') limits.maxRuntimeMs = b.maxRuntimeMs
  return limits
}

/**
 * §42 CacheBreakDiagnosis.suggestions —— 按失效归因给可执行下一步(§58 归因 + §15.1 分区语义)。
 * 只给"为什么断+往哪调"的方向,不给自动改写(红线:不用 Prompt 修架构问题)。
 */
function cacheBreakSuggestions(reason: string, trimmed = false): string[] {
  if (trimmed) {
    return ['该段被预算裁剪移出发送窗口(§49 Budget Manager,enabled=false)→ 它已不在字节流中;检查 world_info_budget 配额或上下文窗口是否过紧']
  }
  switch (reason) {
    case 'MESSAGE_EDITED':
      return ['历史消息被编辑 → 其后全部前缀失效;把易改内容留在 tail,或用 swipe 生成新变体而非改写历史']
    case 'WORLD_BOOK_CONTENT_CHANGED':
      return ['世界书条目内容变更 → 该条目所在稳定区整段失效;检查条目是否应留在 freshWB 观察一轮再毕业']
    case 'WORLD_BOOK_NEW_ENTRY':
      return ['稳定区插入新条目 → 新条目打乱物理序;让其先入 freshWB(append-only 序不回溯)']
    case 'WORLD_BOOK_RETIREMENT':
    case 'WORLD_BOOK_DEACTIVATED':
      return ['条目退休/失活改变了稳定区成员集合;确认退休策略是否应与缓存分区解耦']
    case 'MACRO_VOLATILE':
      return ['易变宏({{random}}/{{time}} 等)落在稳定区 → 每轮重渲染必断;按 Macro Cache Rule 移出 stable zone']
    case 'PRESET_CHANGED':
      return ['预设段变更 → 预设属 header 稳定区,变更代价最高;确认是否可用 Persona/世界书覆盖替代']
    case 'PERSONA_CHANGED':
    case 'CHARACTER_CHANGED':
      return ['角色/Persona 资产变更 → 其段位于稳定区前列;变更会使整个稳定前缀重发']
    default:
      return ['未归类失效:用 /prompt-snapshots/{a}/diff/{b} 查看段级 firstDivergence 与 byteOffset 定位具体段']
  }
}

/**
 * §17 修订的"兄弟链"投影:同 variant_group 的全部未删兄弟(id + variantIndex,按 index 升序)。
 * 无变体组的消息返回空数组——user 消息与单回复默认形态不变。
 */
function variantSiblings(
  store: ServerDeps['store'],
  message: { id: string; variantGroupId?: string },
): { id: string; variantIndex: number | null }[] {
  if (message.variantGroupId === undefined) return []
  return store.db
    .select({ id: messagesTable.id, variantIndex: messagesTable.variantIndex })
    .from(messagesTable)
    .where(and(eq(messagesTable.variantGroupId, message.variantGroupId), isNull(messagesTable.deletedAt)))
    .orderBy(messagesTable.variantIndex)
    .all()
}

/**
 * §16 游标分页:活跃链(根→叶)上按 messageId 锚点裁剪。
 * before=X → X 之前的消息(向上翻页);after=X → X 之后的消息(向下续读);
 * limit 缺省 100。锚点不在链上 = VALIDATION_ERROR(400)。
 */
function pageMessages(
  chain: readonly { id: string }[],
  before: string | undefined,
  after: string | undefined,
  limitRaw: string | undefined,
): { ok: true; value: readonly { id: string }[] } | { ok: false; error: string } {
  if (before !== undefined && after !== undefined) {
    return { ok: false, error: 'before 与 after 不可同时使用' }
  }
  let start = 0
  let end = chain.length
  if (before !== undefined) {
    const idx = chain.findIndex((m) => m.id === before)
    if (idx < 0) return { ok: false, error: `before 锚点不在活跃链上: ${before}` }
    end = idx
  }
  if (after !== undefined) {
    const idx = chain.findIndex((m) => m.id === after)
    if (idx < 0) return { ok: false, error: `after 锚点不在活跃链上: ${after}` }
    start = idx + 1
  }
  const limit = limitRaw === undefined ? 100 : Number.parseInt(limitRaw, 10)
  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false, error: `limit 必须为正整数: ${String(limitRaw)}` }
  }
  return { ok: true, value: chain.slice(Math.max(start, end - limit), end) }
}

/**
 * 世界书落盘 + 注册 + 条目落库 + v1 快照(决策 11 混合存储:.dgworld 文件是事实源,
 * worldbooks 行是索引,worldbook_entries 是编译/激活读模型——database-schema §13)。
 * 卡导入的内嵌书与世界书导入共用此路径,保证两条来源的落库口径一致。
 */
function persistWorldbook(
  deps: ServerDeps,
  worldbook: DgWorldbook,
  sourceFormat: string,
  extra: { characterRef?: string } = {},
): string {
  const id = uuidv7()
  const now = nowIso()
  const slug = worldbook.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'worldbook'
  const file = `worldbooks/${slug}-${id.slice(0, 8)}.dgworld.json`
  mkdirSync(join(deps.assetsDir, 'worldbooks'), { recursive: true })
  writeFileSync(join(deps.assetsDir, file), JSON.stringify(worldbook, null, 2))

  deps.store.db.insert(worldbooksTable).values({
    id,
    name: worldbook.meta.name,
    description: worldbook.meta.description,
    scanDepth: worldbook.scan.scanDepth,
    recursive: worldbook.scan.recursive,
    metadata: JSON.stringify({ file, scan: worldbook.scan, entryCount: worldbook.entries.length }),
    sourceFormat,
    sourceData: JSON.stringify({ file, characterRef: extra.characterRef ?? null }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  }).run()

  for (const entry of worldbook.entries) {
    const entryId = uuidv7()
    deps.store.db.insert(worldbookEntries).values({
      id: entryId,
      worldbookId: id,
      entryKey: entry.uid === undefined ? null : String(entry.uid),
      name: entry.title,
      content: entry.content,
      enabled: entry.enabled,
      activationMode: entry.activation.mode,
      position: SLOT_TO_ST_POSITION[entry.placement.slot],
      insertionOrder: entry.placement.order,
      role: entry.placement.role,
      keywordsPrimary: JSON.stringify(entry.activation.keys),
      keywordsSecondary: JSON.stringify(entry.activation.secondaryKeys),
      keywordLogic: entry.activation.logic,
      caseSensitive: entry.activation.caseSensitive,
      wholeWord: entry.activation.matchWholeWords,
      scanDepth: entry.activation.scanDepth,
      matchScope: JSON.stringify(entry.activation.matchScope),
      triggers: JSON.stringify(entry.activation.triggers),
      excludeRecursion: entry.recursion.excluded,
      preventRecursion: entry.recursion.prevent,
      delayUntilRecursion: entry.recursion.delayedUntil,
      stickyRounds: entry.lifecycle.sticky,
      cooldown: entry.lifecycle.cooldown,
      delay: entry.lifecycle.delay,
      probability: entry.activation.chance,
      groupId: entry.group.id,
      groupOverride: entry.group.override,
      groupWeight: entry.group.weight,
      useGroupScoring: entry.group.scoring,
      ignoreBudget: entry.budget.ignore,
      outletName: entry.placement.outletName,
      characterFilter: JSON.stringify(entry.activation.characterFilter),
      // injection_* 由 S11 激活层接线时填充(语义未定,不留猜测值)
      metadata: JSON.stringify({ id: entry.id, zoning: entry.zoning, depth: entry.placement.depth }),
      sourceData: JSON.stringify(entry.compat),
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run()
    const snapshot = JSON.stringify(entry)
    deps.store.db.insert(worldbookEntryVersions).values({
      id: uuidv7(),
      entryId,
      version: 1,
      snapshot,
      contentHash: sha256Hex(snapshot),
      createdAt: now,
    }).run()
  }
  return id
}

/**
 * 预设落盘 + 注册(决策 11 混合存储:.dgpreset 文件是事实源,presets 行是注册索引,
 * config 列存原生 JSON 供 runtime builder 直接解析;v1 版本快照随建)。
 */
function persistPreset(deps: ServerDeps, preset: DgPreset, sourceFormat: string): string {
  const id = uuidv7()
  const now = nowIso()
  const slug = preset.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'preset'
  const file = `presets/${slug}-${id.slice(0, 8)}.dgpreset.json`
  mkdirSync(join(deps.assetsDir, 'presets'), { recursive: true })
  writeFileSync(join(deps.assetsDir, file), JSON.stringify(preset, null, 2))

  deps.store.db.insert(presetsTable).values({
    id,
    name: preset.meta.name,
    description: null,
    compilerMode: 'compatibility',
    config: JSON.stringify(preset),
    sourceFormat,
    sourceData: JSON.stringify({ file }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  }).run()

  const snapshot = JSON.stringify(preset)
  deps.store.db.insert(presetVersions).values({
    id: uuidv7(),
    presetId: id,
    version: 1,
    snapshot,
    contentHash: sha256Hex(snapshot),
    createdAt: now,
  }).run()
  return id
}

type ProviderRow = {
  id: string
  name: string
  type: string
  config: string
  enabled: boolean
  createdAt: string
}

/** provider 投影:config 只出 baseUrl/models,secretRef 只出引用名(密钥零回显,PV5) */
function projectProvider(row: ProviderRow): Record<string, unknown> {
  const config = JSON.parse(row.config) as { baseUrl?: string; secretRef?: string; models?: string[] }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: { baseUrl: config.baseUrl ?? null, secretRef: config.secretRef ?? null, models: config.models ?? [] },
    enabled: row.enabled,
  }
}
