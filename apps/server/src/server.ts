import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm'
import { uuidv7 } from '@whispertavern/runtime'
import { AnthropicAdapter, FakeProviderAdapter, GeminiAdapter, OpenAICompatAdapter } from '@whispertavern/adapters'
import { compile, diffSnapshots } from '@whispertavern/core'
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
  createBranch,
  createChat,
  createMessage,
  deleteChat,
  deleteMessage,
  editMessage,
  loadActiveChain,
  loadChat,
  loadMessage,
  sha256Hex,
  startRun,
  swipeMessage,
  SERVER_COMPILER_VERSION,
  type RuntimeEvent,
} from '@whispertavern/runtime'
import {
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
type JsonStatus = 200 | 201 | 400 | 404 | 409 | 422 | 500

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
      ? (config.fakeTurns as { text?: string; chunkSize?: number; delayMs?: number }[]).map((t) => ({
          text: t.text ?? '[fake]',
          chunkSize: t.chunkSize,
          delayMs: t.delayMs,
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
        const write = (event: RuntimeEvent): void => {
          if (closed) return
          controller.enqueue(encoder.encode(sseFrame(event)))
          if (TERMINAL_EVENTS.has(event.type)) {
            closed = true
            controller.close() // D4:终态即静默
          }
        }
        if (tracked) {
          const { replay, unsubscribe } = registry.subscribe(runId, write, lastEventId)
          c.req.raw.signal.addEventListener('abort', unsubscribe, { once: true })
          for (const event of replay) write(event)
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
    for (const [uri, bytes] of result.assetFiles) {
      const target = join(cardDir, uri)
      mkdirSync(join(target, '..'), { recursive: true })
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

  return { app, registry }
}

function nowIso(): string {
  return new Date().toISOString()
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
