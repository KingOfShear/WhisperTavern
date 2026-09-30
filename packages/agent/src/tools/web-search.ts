/**
 * 网络搜索工具(Web Search)—— p4-plan §7 / WP4.3(S32)。
 *
 * 它**不是**一套并行的抽象:工具经 ToolRegistry 五段流水线执行(agent-runtime-spec §36.1),
 * 每次调用照旧落 `tool_calls` 行 + `tool.call.*` durable 事件四件套(S24 面复用)。
 * 本模块只负责"外发一次只读 HTTP 搜索、把结果归一为结构化输出"。
 *
 * 三条硬约束(逐条对应 p4-plan §7 任务清单):
 *
 * 1. **沙箱(§89 Tool Sandboxing)**。§89 要求不可信工具至少限制 network,
 *    这里的限制是**结构性**的而非尽力而为:出站目标只能是注入配置里那**一个**
 *    endpoint(工具不接受模型传入的 URL),并额外受 per-Run 外发次数封顶——
 *    模型无法借这个工具把宿主变成任意网络的跳板。
 *
 * 2. **结果注 tail + origin 溯源(compiler-spec §86 Tool Results)**。工具本身不碰 zone:
 *    它把 `toolCallId` 交给 run-agent 写进 tool 结果消息元数据,由编译期
 *    `buildContributions` 升格为 `source.type='toolResult'` 并注入 tail 区——
 *    不上行到稳定前缀,故不参与 Prompt Cache 的命中面,也不可能因搜索结果变化
 *    毁掉缓存前缀(§15 tail 注入口径)。
 *
 * 3. **去重与 fail-closed**。同一 query 在短窗内不重复外发;并发发出的同 query 共享
 *    同一个在飞请求(否则"同一批两个相同调用"仍会打出两次网络);超出预算、
 *    后端未配置、后端返回不可识别形状 → 一律**确定性失败**,绝不静默用假结果兜底。
 *
 * 未实现项不掩盖:真实搜索后端的 wire 翻译(各家 query/response 方言)按 R-P4-8
 * 随作者接入真实 API 补齐;当前响应契约是最小面 `{ results: [{title,url,snippet}] }`。
 */
import type { ProviderTool } from '@whispertavern/contracts'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types'
import { ToolBusinessError } from './registry'

/** wire 工具名(命名空间点号,与 `memory.*` 同规);审批门与白名单共用此常量 */
export const WEB_SEARCH_TOOL_NAME = 'web.search'

/**
 * 默认注册面里需**经 §115.1 审批管线**的工具名单(server 组合根装审批门时使用)。
 *
 * 与 `createAutoApprover` 的白名单共用同一常量,杜绝"门开了但没人批"或
 * "批了却没设门"这类两侧漂移。低风险只读外网工具走的是**自动批准**而非
 * **跳过审批**:审计行与 approval.requested/decided 照旧成对落库(§115.1 审计要求)。
 */
export const APPROVAL_GATED_TOOLS: readonly string[] = [WEB_SEARCH_TOOL_NAME]

export const WEB_SEARCH_PERMISSIONS: readonly 'network.request'[] = ['network.request']

/**
 * 注入式传输(默认 `globalThis.fetch`)。
 *
 * 刻意不引入 adapters 的 `FetchLike`:依赖方向是 `agent → runtime → core → contracts`,
 * agent **不得**依赖 adapters(架构守卫 B4)。这里落最小结构类型,
 * `globalThis.fetch` 与 adapters 的 `FetchLike` 实现都天然满足它。
 */
export interface WebSearchHttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export interface WebSearchTransportInit {
  method: string
  headers: Record<string, string>
  /** 取消信号:由 ctx.cancellationToken 派生,使 §45 取消能真正中断在飞请求 */
  signal?: AbortSignal
}

export type WebSearchTransport = (url: string, init: WebSearchTransportInit) => Promise<WebSearchHttpResponse>

/** 归一后的单条搜索结果(`url` 是溯源锚点;无 url 的结果会被丢弃而非凑数) */
export interface WebSearchHit {
  title: string
  url: string
  snippet?: string
}

export interface WebSearchPayload {
  query: string
  results: WebSearchHit[]
  /** true = 命中短窗去重缓存/共享在飞请求,本次**没有**新开外发请求 */
  deduped: boolean
  /** 是否截断到 maxResults */
  truncated: boolean
}

export interface WebSearchToolOptions {
  /**
   * 搜索后端端点。**未配置 = fail-closed**(确定性失败,不做假的空搜索)。
   * 模型无法替换它——这是 §89 网络限制的唯一出口。
   */
  endpoint?: string
  /** 后端凭据(可缺省;缺失则不发 Authorization 头) */
  apiKey?: string
  fetchImpl?: WebSearchTransport
  /** X14 注入时钟(缺省 wall-clock);去重窗口全用它,保证测试确定性 */
  now?: () => number
  /** 去重窗口:同 query 在此毫秒窗内不重复外发(缺省 60s) */
  searchWindowMs?: number
  /** 单次 Run 的外发请求上限(缺省 8);超限 fail-closed = RUN_BUDGET_EXCEEDED */
  maxOutboundRequests?: number
  /** 单次返回条数上限(缺省 5) */
  maxResults?: number
}

const DEFAULT_SEARCH_WINDOW_MS = 60_000
const DEFAULT_MAX_OUTBOUND_REQUESTS = 8
const DEFAULT_MAX_RESULTS = 5

/** 单次查询的输入(模型可控制的部分仅此三项;URL / 凭据 / 预算都不在内) */
interface SearchQuery {
  query: string
  maxResults: number
  site?: string
}

/** 工具规格(name/description/inputSchema 单一真相源;定义与 wire 投影共用) */
interface WebSearchToolSpec {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOL_SPEC: WebSearchToolSpec = {
  id: 'tool_web_search',
  name: WEB_SEARCH_TOOL_NAME,
  description:
    '在互联网上搜索公开网页,返回标题 / 链接 / 摘要。只读操作,不会修改任何本地数据。' +
    '适合查询作品设定、世界观、现实知识或需要外部事实的内容;不用于查找本会话记忆或世界书(那些在上下文里直接引用)。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或问题' },
      maxResults: { type: 'number', description: '返回条数上限(默认 5)' },
      site: { type: 'string', description: '限定站点域名(可选)' },
    },
    required: ['query'],
  },
}

/** §31 wire 投影(模型看到的工具清单;执行仍走注册表按名派发) */
export function webSearchWireTools(): ProviderTool[] {
  return [{ name: TOOL_SPEC.name, description: TOOL_SPEC.description, inputSchema: TOOL_SPEC.inputSchema }]
}

/**
 * 构造网络搜索工具定义。
 *
 * 缓存与预算的生命周期**刻意不同**,理由说清:
 * - **去重缓存与在飞去重跨 Run 共享**(按 query 归一键 + 窗口 TTL)——"短窗内不重复外发"
 *   针对的正是用户连续重问 / 多 Agent 撞同一问题;按 Run 隔离会让它形同虚设;
 * - **外发预算按 runId 隔离**——预算是 Run 级资源(§39),跨 Run 累计会让长进程
 *   在若干 Run 之后莫名其妙地再也搜不动。
 */
export function createWebSearchToolDefinition(options: WebSearchToolOptions = {}): ToolDefinition {
  const now = options.now ?? (() => Date.now())
  const windowMs = options.searchWindowMs ?? DEFAULT_SEARCH_WINDOW_MS
  const maxOutbound = options.maxOutboundRequests ?? DEFAULT_MAX_OUTBOUND_REQUESTS
  const defaultMaxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const transport: WebSearchTransport = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  const endpoint = options.endpoint ?? ''

  /** query 归一键 → 缓存项(含落盘时刻,用于窗口判定) */
  const cache = new Map<string, { at: number; payload: WebSearchPayload }>()
  /**
   * query 归一键 → 在飞请求(并发同 query 共享,不打两次网络)。
   *
   * 带 `at` 的理由:若后端挂起,`execute` 会一直 await 在 task 上,`finally` 永不执行,
   * 该键就永远挂在表里——**后续同 query 会一起永久挂死**(§46 超时只包在 execute 外层,
   * 中断不了被共享的那个 Promise)。故在飞项也受窗口约束:超窗即视为陈旧,新开请求而非加入。
   */
  const inflight = new Map<string, { at: number; task: Promise<WebSearchPayload> }>()
  /** runId → 已外发次数(§39 Run 级预算) */
  const outboundByRun = new Map<string, number>()

  return {
    id: TOOL_SPEC.id,
    name: TOOL_SPEC.name,
    description: TOOL_SPEC.description,
    inputSchema: TOOL_SPEC.inputSchema,
    permissions: WEB_SEARCH_PERMISSIONS,
    // §50:纯只读 → 可安全自动重试(§47 C3 瞬时错误重试生效)。
    // 若声明 non_idempotent,网络抖动永远不会被重试,白白烧掉一次工具调用额度
    sideEffectLevel: 'none',
    async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
      const q = parseQuery(input, defaultMaxResults)
      const key = cacheKey(q)
      const at = now()

      const cached = cache.get(key)
      if (cached !== undefined && at - cached.at < windowMs) {
        return success({ ...cached.payload, deduped: true })
      }
      const pending = inflight.get(key)
      if (pending !== undefined && at - pending.at < windowMs) {
        // 同批并发同 query:共享在飞请求(deduped=true 表示本次调用未新开网络请求)
        return success({ ...(await pending.task), deduped: true })
      }

      if (endpoint === '') {
        // fail-closed:没后端就明确失败,不做"返回空结果"的假成功
        throw new ToolBusinessError('TOOL_FAILED', '网络搜索后端未配置(fail-closed:不外发、不伪造结果)')
      }
      const used = outboundByRun.get(ctx.runId) ?? 0
      if (used >= maxOutbound) {
        // §38/§39:超预算 = RUN_BUDGET_EXCEEDED;此处是"外发次数"这一维度的预算
        throw new ToolBusinessError('RUN_BUDGET_EXCEEDED', `本次 Run 外发搜索已达上限 ${maxOutbound}`)
      }
      outboundByRun.set(ctx.runId, used + 1)

      const task = fetchAndNormalize({ transport, endpoint, apiKey: options.apiKey, q, ctx, now: at })
      inflight.set(key, { at, task })
      try {
        const payload = await task
        cache.set(key, { at, payload })
        return success(payload)
      } finally {
        // 仅在本项仍是自己时才删——超窗替换后可能是别人新开的请求
        if (inflight.get(key)?.task === task) inflight.delete(key)
      }
    },
  }
}

/** 工具结果本体:toolCallId 由流水线在 finalize 时按 wire 调用 id 回填(§36.1 末段冻结) */
function success(payload: WebSearchPayload): ToolResult {
  return { toolCallId: '', status: 'success', output: payload }
}

/** 外发 + 归一:**唯一**接触网络的地方 */
async function fetchAndNormalize(input: {
  transport: WebSearchTransport
  endpoint: string
  apiKey?: string
  q: SearchQuery
  ctx: ToolExecutionContext
  now: number
}): Promise<WebSearchPayload> {
  const { transport, endpoint, apiKey, q, ctx } = input
  const controller = new AbortController()
  if (ctx.cancellationToken.isCancelled()) controller.abort()
  // §45 取消传播:工具内不做轮询检查,直接把取消信号接进 HTTP 层
  ctx.cancellationToken.onCancel(() => controller.abort())

  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey !== undefined && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`

  let response: WebSearchHttpResponse
  try {
    response = await transport(buildUrl(endpoint, q), { method: 'GET', headers, signal: controller.signal })
  } catch (error) {
    // 取消不算失败:§45 cancellation 是独立终态,不能在这里被误报成网络错误
    if (controller.signal.aborted) throw new ToolBusinessError('USER_CANCELLED', '搜索请求已取消')
    // 瞬时网络错误 → §47 C3 可重试(§50:sideEffectLevel='none' 才允许自动重试)
    throw new ToolBusinessError('NETWORK_ERROR', `搜索请求失败: ${messageOf(error)}`)
  }
  if (controller.signal.aborted) throw new ToolBusinessError('USER_CANCELLED', '搜索请求已取消')

  const body = await safeText(response)
  if (!response.ok) throw httpError(response.status, body)

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ToolBusinessError('TOOL_FAILED', '搜索后端返回非 JSON 响应(形状不可识别,拒绝猜测)')
  }
  const { hits, truncated } = normalizeResults(parsed, q.maxResults)
  return { query: q.query, results: hits, deduped: false, truncated }
}

/** HTTP 状态 → 工具错误码;只有限流/5xx 是瞬时(可重试),其余是确定性失败 */
function httpError(status: number, detail: string): ToolBusinessError {
  if (status === 429) return new ToolBusinessError('RATE_LIMIT', `搜索后端限流(429): ${detail}`)
  if (status >= 500) return new ToolBusinessError('TEMPORARY', `搜索后端暂时不可用(${status}): ${detail}`)
  return new ToolBusinessError('TOOL_FAILED', `搜索后端拒绝请求(${status}): ${detail}`)
}

/**
 * 响应归一(最小契约 `{ results: [...] }`)。
 *
 * 形状不识别 = 确定性失败,不猜字段、**不返回空数组**——空结果与"后端坏了"必须可区分,
 * 否则模型会把后端故障当成"网上查不到",进而编造答案。
 */
function normalizeResults(parsed: unknown, limit: number): { hits: WebSearchHit[]; truncated: boolean } {
  const list = (parsed as { results?: unknown }).results
  if (!Array.isArray(list)) {
    throw new ToolBusinessError('TOOL_FAILED', '搜索后端响应缺少 results 数组(形状不可识别)')
  }
  const hits: WebSearchHit[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const url = typeof rec['url'] === 'string' ? rec['url'] : ''
    if (url === '') continue // 无链接的结果不可溯源,丢弃而非凑数
    const title = typeof rec['title'] === 'string' && rec['title'] !== '' ? rec['title'] : url
    const snippet = typeof rec['snippet'] === 'string' ? rec['snippet'] : undefined
    hits.push({ title, url, ...(snippet === undefined ? {} : { snippet }) })
  }
  return { hits: hits.slice(0, limit), truncated: hits.length > limit }
}

function buildUrl(endpoint: string, q: SearchQuery): string {
  const params = new URLSearchParams({ q: q.query, limit: String(q.maxResults) })
  if (q.site !== undefined && q.site !== '') params.set('site', q.site)
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`
}

/** 归一键必须含全部限定条件,否则"同词不同站点/不同条数"会被错误去重 */
function cacheKey(q: SearchQuery): string {
  return `${q.query}\u0000${q.site ?? ''}\u0000${q.maxResults}`
}

async function safeText(response: WebSearchHttpResponse): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ''
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const MAX_RESULTS_CEILING = 20

/** 入参解析:缺失/非法 query = INVALID_INPUT(与 memory 写入工具的 requireChatId 同规) */
function parseQuery(input: unknown, defaultMaxResults: number): SearchQuery {
  const rec = (input ?? {}) as Record<string, unknown>
  const query = typeof rec['query'] === 'string' ? rec['query'].trim() : ''
  if (query === '') {
    throw new ToolBusinessError('INVALID_INPUT', `${WEB_SEARCH_TOOL_NAME} 需要非空 query`)
  }
  const raw = rec['maxResults']
  // 条数上限同时封顶到 MAX_RESULTS_CEILING:模型要 1000 条不该变成一次巨型上下文注入
  const requested = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : defaultMaxResults
  const maxResults = Math.min(requested, MAX_RESULTS_CEILING)
  const site = typeof rec['site'] === 'string' && rec['site'] !== '' ? rec['site'] : undefined
  return { query, maxResults, ...(site === undefined ? {} : { site }) }
}
