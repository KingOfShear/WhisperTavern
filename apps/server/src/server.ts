import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { and, desc, eq, gt, ne } from 'drizzle-orm'
import { uuidv7 } from '@whispertavern/runtime'
import { AnthropicAdapter, FakeProviderAdapter, GeminiAdapter, OpenAICompatAdapter } from '@whispertavern/adapters'
import { compile } from '@whispertavern/core'
import { importCard, isCardParseError } from '@whispertavern/st-compat'
import {
  activeLeafId,
  activateMessage,
  buildContributions,
  createChat,
  createMessage,
  loadActiveChain,
  loadChat,
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
  presetVersions,
  presets as presetsTable,
  promptSnapshots,
  providers as providersTable,
  runs as runsTable,
  worldbooks as worldbooksTable,
} from '@whispertavern/runtime'
import type { Chat, ChatId, MessageId, ProviderAdapter, ProviderChatRequest, SnapshotId } from '@whispertavern/contracts'
import { httpStatusFor } from './api/errors'
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

  // ===== chats(§11–§13 P0 范围)=====

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
    const rows = deps.store.db.select().from(chatsTable).orderBy(desc(chatsTable.createdAt)).limit(100).all()
    return ok(c, requestId, rows.map((row) => ({
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

  // ===== 消息树(§16–§22 P0 范围)=====

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

  app.get('/api/v2/chats/:id/messages', (c) => {
    const requestId = requestIdOf(c)
    const chat = loadChat(deps.store, c.req.param('id') as ChatId)
    if (!chat.ok) return runtimeError(c, requestId, chat.error)
    const chain = loadActiveChain(deps.store, activeLeafId(deps.store, chat.value.id))
    if (!chain.ok) return runtimeError(c, requestId, chain.error)
    return ok(c, requestId, chain.value)
  })

  // §20 swipe:同 variant_group 新建空兄弟壳(P0 建壳;生成填充随 P1 联调)
  app.post('/api/v2/messages/:id/swipe', (c) => {
    const requestId = requestIdOf(c)
    const swiped = swipeMessage(deps.store, deps.bus, { messageId: c.req.param('id') as MessageId, now: nowIso() })
    if (!swiped.ok) return runtimeError(c, requestId, swiped.error)
    return ok(c, requestId, { message: swiped.value }, 201)
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
      authorityFingerprint: snapshot.authorityFingerprint,
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
      authorityFingerprint: row.authorityFingerprint,
      createdAt: row.createdAt,
    })
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
    // 内嵌书抽取:独立 .dgworld 文件 + worldbooks 注册(双向引用)
    let worldbookId: string | undefined
    if (result.extractedWorldbook !== undefined) {
      worldbookId = uuidv7()
      const wbDir = join(deps.assetsDir, 'worldbooks')
      mkdirSync(wbDir, { recursive: true })
      const wbFile = `worldbooks/${result.extractedWorldbook.ref}.dgworld.json`
      writeFileSync(join(deps.assetsDir, wbFile), JSON.stringify({ schemaVersion: 0, sourceFormat: 'st-embedded', raw: result.extractedWorldbook.raw }, null, 2))
      deps.store.db.insert(worldbooksTable).values({
        id: worldbookId,
        name: result.extractedWorldbook.suggestedName,
        sourceFormat: 'st-embedded',
        sourceData: JSON.stringify({ characterRef: null, file: wbFile }),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }).run()
    }
    // 注册索引 + version 1 快照(混合存储:文件事实源,行是索引,决策 11)
    const id = uuidv7()
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

  // —— 全局错误兜底(api-spec §7 信封;D2:对外只暴露一种归一化形式)——
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? `req_${uuidv7()}`
    deps.logger?.('error', `request failed: ${requestId}`, String(error))
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
