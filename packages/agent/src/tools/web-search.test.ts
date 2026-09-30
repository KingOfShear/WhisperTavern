/**
 * S32(WP4.3)验收:p4-plan §7 单测五项(审批四值 / 超时 / 预算 / tail 注入 / origin 溯源)
 * + §89 网络沙箱 + 结果缓存与去重。
 *
 * 断言口径逐条对上任务清单:
 * 1. 工具注册 → 走 ToolRegistry 五段流水线,落 `tool_calls` 行 + `tool.call.*` 四件套;
 * 2. 结果注 tail → 编译后段 `cachePlacement.zone === 'tail'`(**不进稳定前缀**);
 * 3. origin 溯源 → 段 `source.type === 'toolResult'` 且 toolCallId 可追回;
 * 4. 缓存去重 → 同 query 短窗内**不外发第二次**;超预算 fail-closed;
 * 5. 审批 → 默认 auto-approve 但**仍走 §115.1 管线**(审计行 + 事件成对)。
 */
import { describe, expect, it } from 'vitest'
import type { ChatId, ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { EventBus, SnapshotRegistry, createChat, createDatabase, createMessage, createSqliteEventSink, type WhisperTavernDb } from '@whispertavern/runtime'
import { createAgentDefinition } from '../runtime/definition'
import { runAgent } from '../runtime/run-agent'
import { createAutoApprover, type ApprovalAuditRow } from './approval'
import { ToolRegistry } from './registry'
import type { ToolDefinition } from './types'
import {
  APPROVAL_GATED_TOOLS,
  WEB_SEARCH_TOOL_NAME,
  createWebSearchToolDefinition,
  webSearchWireTools,
  type WebSearchHttpResponse,
  type WebSearchTransport,
} from './web-search'

const NOW = '2026-09-26T12:00:00.000Z'

interface ScriptedCall {
  id: string
  name: string
  args: string
}

/** 脚本化 adapter:前 N 轮发 tool_call(逐轮一组),之后发 Final 文本 */
class ScriptedAdapter implements ProviderAdapter {
  readonly providerId = 'fake'
  private cursor = 0
  constructor(private readonly rounds: readonly ScriptedCall[][], private readonly finalText: string) {}
  capabilities(_model: string): ProviderCapabilities {
    return {
      systemRole: true, tools: true, vision: false, reasoning: false, streaming: true,
      promptCaching: false, cacheType: 'none', maxContextTokens: 131_072, maxOutputTokens: 4096,
      structuredOutput: 'none', parallelToolCalls: true, toolChoice: false,
    }
  }
  async *stream(_req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    const round = this.cursor
    this.cursor += 1
    yield { type: 'message_start' }
    for (const [index, call] of (this.rounds[round] ?? []).entries()) {
      yield { type: 'tool_call_delta', index, id: call.id, name: call.name, argsFragment: call.args }
    }
    if (round < this.rounds.length) {
      yield { type: 'usage', usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, source: 'reported' } }
      yield { type: 'finish', reason: 'tool_use' }
    } else {
      yield { type: 'text_delta', text: this.finalText }
      yield { type: 'usage', usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 24, source: 'reported' } }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}

function makeStore(): WhisperTavernDb {
  const store = createDatabase(':memory:')
  store.sqlite
    .prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake', 'fake', 'fake', '{}', '{}', ?, ?)`)
    .run(NOW, NOW)
  return store
}

function makeChat(store: WhisperTavernDb, bus: EventBus, userContent: string): ChatId {
  const chat = createChat(store, bus, { title: 'web-search-e2e', now: NOW })
  if (!chat.ok) throw new Error(`建 chat 失败: ${JSON.stringify(chat)}`)
  const msg = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: userContent, now: NOW })
  if (!msg.ok) throw new Error(`建消息失败: ${JSON.stringify(msg)}`)
  return chat.value.id as ChatId
}

/** 文本响应:单次 `{"results":[...]}`;记录每次外发的 URL 供去重断言 */
function textResponse(body: string, status = 200): WebSearchHttpResponse {
  return { ok: status >= 200 && status < 300, status, async text() { return body } }
}

function makeTransport(reply: (url: string, call: number) => WebSearchHttpResponse): { transport: WebSearchTransport; urls: string[] } {
  const urls: string[] = []
  const transport: WebSearchTransport = async (url) => {
    await Promise.resolve()
    urls.push(url)
    return reply(url, urls.length)
  }
  return { transport, urls }
}

const OK_BODY = JSON.stringify({
  results: [
    { title: '北京天气', url: 'https://example.com/bj', snippet: '22 度' },
    { title: '无链接条目', snippet: '应被丢弃' },
  ],
})

/** 默认放行白名单:web.search 只读 + auto-approver */
function makeRegistry(
  store: WhisperTavernDb,
  bus: EventBus,
  tools: readonly ToolDefinition[],
  opts?: { auditRows?: ApprovalAuditRow[] } & ConstructorParameters<typeof ToolRegistry>[1],
): ToolRegistry {
  const registry = new ToolRegistry({ store, bus, persistApprovalAudit: (row) => opts?.auditRows?.push(row) }, opts)
  for (const t of tools) registry.register(t)
  return registry
}

describe('S32 §89 网络沙箱:未配置后端 → fail-closed(不伪造结果)', () => {
  it('endpoint 缺省 → 工具确定性失败 TOOL_FAILED,不返回空结果', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '搜索角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '查一下')
      // 故意不传 endpoint(也不传 fetchImpl):任何网络访问都是不可能的
      const registry = makeRegistry(store, bus, [createWebSearchToolDefinition()])
      const adapter = new ScriptedAdapter([[{ id: 'call_ws', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"北京天气"}' }]], '查不到。')

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Run 不因工具失败而炸(§36.2 归一化);但结果必须是 error 且可诊断
      expect(result.value.status).toBe('succeeded')
      const row = store.sqlite.prepare(`SELECT status, error FROM tool_calls WHERE tool_name = ?`).get(WEB_SEARCH_TOOL_NAME) as { status: string; error: string }
      expect(row.status).toBe('error')
      expect(JSON.parse(row.error).code).toBe('TOOL_FAILED')
      expect(JSON.parse(row.error).message).toContain('fail-closed')
      // 失败也照落事件四件套之 failed(不是静默)
      const failed = store.sqlite.prepare(`SELECT payload FROM events WHERE event_type = 'tool.call.failed'`).get() as { payload: string }
      expect(JSON.parse(failed.payload).tool).toBe(WEB_SEARCH_TOOL_NAME)
    } finally {
      store.close()
    }
  })
})

describe('S32 §7-3 结果缓存与去重:同 query 短窗内不重复外发', () => {
  it('两次同 query(同 Run,不同工具调用)→ 第二次不外发,deduped=true 且带缓存结果', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '去重角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '查两次同样的')
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport, now: () => 1_000 }),
      ])
      const adapter = new ScriptedAdapter(
        [
          [{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"北京天气"}' }],
          [{ id: 'c2', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"北京天气"}' }],
        ],
        '查到了。',
      )

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // 两次调用都成功(第二次命中去重),但**只有一次**网络外发
      const rows = store.sqlite
        .prepare(`SELECT status, result FROM tool_calls WHERE tool_name = ? ORDER BY started_at`)
        .all(WEB_SEARCH_TOOL_NAME) as { status: string; result: string }[]
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.status)).toEqual(['success', 'success'])
      expect(urls).toHaveLength(1)
      const second = JSON.parse(rows[1]!.result) as { deduped: boolean; results: { url: string }[] }
      expect(second.deduped).toBe(true)
      expect(second.results).toHaveLength(1) // 无 url 的条目被丢弃
      // 结果顺序与内容来自同一次外发
      expect(second.results[0]!.url).toBe('https://example.com/bj')
    } finally {
      store.close()
    }
  })

  it('同批并发同 query → 共享在飞请求,只外发一次', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '并搜角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '并发查同一件事')
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport, now: () => 1_000 }),
      ])
      const adapter = new ScriptedAdapter(
        [[
          { id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"同一问题"}' },
          { id: 'c2', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"同一问题"}' },
        ]],
        '并发完成。',
      )

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(urls).toHaveLength(1) // 在飞去重:并发同 query 不重复打网络
      const rows = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = ?`).all(WEB_SEARCH_TOOL_NAME) as { status: string }[]
      expect(rows.map((r) => r.status)).toEqual(['success', 'success'])
    } finally {
      store.close()
    }
  })

  it('窗口外的同 query 会重新外发(去重不是永久缓存)', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '超窗角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '隔很久再查')
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      // 注入时钟逐次推进:第 1 次 0(写入缓存),第 2 次 1000(超出 10ms 窗口 → 重新外发)
      let ticks = 0
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({
          endpoint: 'https://search.test/v1',
          fetchImpl: transport,
          searchWindowMs: 10,
          now: () => (ticks += 1) === 1 ? 0 : 1_000,
        }),
      ])
      const adapter = new ScriptedAdapter(
        [
          [{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"旧闻"}' }],
          [{ id: 'c2', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"旧闻"}' }],
        ],
        '两次都查了。',
      )

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(urls).toHaveLength(2) // 超窗 = 重新外发
    } finally {
      store.close()
    }
  })
})

describe('S32 §7-3 沙箱预算:外发次数超限 → fail-closed', () => {
  it('maxOutboundRequests=1 而模型要两次不同 query → 第二次 RUN_BUDGET_EXCEEDED', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '限额角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '查两件事')
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport, maxOutboundRequests: 1 }),
      ])
      const adapter = new ScriptedAdapter(
        [
          [{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"第一件事"}' }],
          [{ id: 'c2', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"第二件事"}' }],
        ],
        '第二件查不了。',
      )

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(urls).toHaveLength(1) // 超预算 = 不外发
      const rows = store.sqlite
        .prepare(`SELECT status, error FROM tool_calls WHERE tool_name = ? ORDER BY started_at`)
        .all(WEB_SEARCH_TOOL_NAME) as { status: string; error: string | null }[]
      expect(rows[0]!.status).toBe('success')
      expect(rows[1]!.status).toBe('error')
      expect(JSON.parse(rows[1]!.error!).code).toBe('RUN_BUDGET_EXCEEDED')
    } finally {
      store.close()
    }
  })

  it('预算按 Run 隔离:前一个 Run 的外发不消耗后一个 Run 的额度', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '跨Run角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '分两次跑')
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport, maxOutboundRequests: 1 }),
      ])
      const deps = { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW }
      const runOnce = (id: string, q: string) =>
        runAgent(deps, {
          chatId, agentId: def.id,
          adapter: new ScriptedAdapter([[{ id, name: WEB_SEARCH_TOOL_NAME, args: JSON.stringify({ query: q }) }]], '好了。'),
          providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW,
        })

      const first = await runOnce('r1', '第一轮')
      const second = await runOnce('r2', '第二轮')
      expect(first.ok && second.ok).toBe(true)
      // 两个 Run 各一次外发均成功(maxOutbound=1 是 per-Run 额度)
      expect(urls).toHaveLength(2)
      const statuses = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = ?`).all(WEB_SEARCH_TOOL_NAME) as { status: string }[]
      expect(statuses.map((s) => s.status)).toEqual(['success', 'success'])
    } finally {
      store.close()
    }
  })
})

describe('S32 §7-4 审批:默认 auto-approve,但仍走 §115.1 管线(不绕过)', () => {
  it('web.search 被自动放行,且审计行 + approval 事件成对落库', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '审批角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '联网查')
      const auditRows: ApprovalAuditRow[] = []
      const { transport } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport }),
      ], { auditRows })
      // 与 server 组合根同构:静态审批门 + 默认回答者
      registry.requireApproval(WEB_SEARCH_TOOL_NAME)
      registry.approvals.setDefaultResponder(createAutoApprover(APPROVAL_GATED_TOOLS))

      const adapter = new ScriptedAdapter([[{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"北京天气"}' }]], '查到了。')
      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = ?`).get(WEB_SEARCH_TOOL_NAME) as { status: string }
      expect(row.status).toBe('success') // 自动批准 → 放行执行
      // **不绕过**:审计 requested→decided 成对,且结论 = allowed_once
      expect(auditRows).toHaveLength(2)
      expect(auditRows[0]!.status).toBe('pending')
      expect(auditRows[1]!.status).toBe('decided')
      expect(auditRows[1]!.outcome).toBe('allowed_once')
      expect(auditRows[1]!.action).toBe(WEB_SEARCH_TOOL_NAME)
      // §115.1 审计要求:事件成对(durable)
      const requested = store.sqlite.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'approval.requested'`).get() as { n: number }
      const decided = store.sqlite.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'approval.decided'`).get() as { n: number }
      expect(requested.n).toBe(1)
      expect(decided.n).toBe(1)
    } finally {
      store.close()
    }
  })

  it('§115.1 四值:缺默认回答者 → unavailable → denied(工具体不执行)', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '无答角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '联网查')
      const auditRows: ApprovalAuditRow[] = []
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport }),
      ], { auditRows })
      registry.requireApproval(WEB_SEARCH_TOOL_NAME) // 装了门,但**没有**回答者

      const adapter = new ScriptedAdapter([[{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"x"}' }]], '没批成。')
      await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      const row = store.sqlite.prepare(`SELECT status, error FROM tool_calls WHERE tool_name = ?`).get(WEB_SEARCH_TOOL_NAME) as { status: string; error: string }
      expect(row.status).toBe('denied')
      expect(JSON.parse(row.error).code).toBe('TOOL_PERMISSION_DENIED')
      expect(urls).toHaveLength(0) // 拒绝 → 绝不出网
      expect(auditRows[1]!.outcome).toBe('unavailable')
    } finally {
      store.close()
    }
  })

  it("policy='never' 在自动批准之前生效 → rejected(自动批准无法越过无人值守策略)", async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '策略角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '联网查')
      const auditRows: ApprovalAuditRow[] = []
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport }),
      ], { auditRows })
      registry.requireApproval(WEB_SEARCH_TOOL_NAME)
      registry.approvals.setDefaultResponder(createAutoApprover(APPROVAL_GATED_TOOLS))
      registry.approvals.setPolicy(chatId, 'never')

      const adapter = new ScriptedAdapter([[{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"x"}' }]], '没批。')
      await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(auditRows[1]!.outcome).toBe('rejected')
      expect(urls).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('auto-approver 只放行白名单内的只读工具;白名单外一律弃权 → unavailable', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '越权角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '写文件')
      const auditRows: ApprovalAuditRow[] = []
      let executed = 0
      // 恶意的"只读白名单"注入:把带写权限的工具塞进白名单也必须被弃权
      const writer: ToolDefinition = {
        id: 'tool_writer',
        name: 'fs.write',
        description: '写文件',
        inputSchema: {},
        permissions: ['filesystem.write'],
        async execute() {
          executed += 1
          return { toolCallId: '', status: 'success' as const, output: { written: true } }
        },
      }
      const registry = makeRegistry(store, bus, [writer], { auditRows })
      registry.requireApproval('fs.write')
      // 白名单**故意**包含 fs.write——权限守门必须挡住它
      registry.approvals.setDefaultResponder(createAutoApprover(['fs.write']))

      const adapter = new ScriptedAdapter([[{ id: 'c1', name: 'fs.write', args: '{}' }]], '被拒。')
      await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(executed).toBe(0) // 白名单不能提权:写权限 → 弃权 → unavailable → 拒绝
      const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = 'fs.write'`).get() as { status: string }
      expect(row.status).toBe('denied')
      expect(auditRows[1]!.outcome).toBe('unavailable')
    } finally {
      store.close()
    }
  })

  it('auto-approver 对白名单**外**的工具弃权:per-chat 回答者仍可放行(链序不封死人工路径)', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '链序角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '随便')
      const auditRows: ApprovalAuditRow[] = []
      let executed = 0
      const other: ToolDefinition = {
        id: 'tool_other',
        name: 'other.tool',
        description: '别的工具',
        inputSchema: {},
        permissions: ['chat.read'],
        async execute() {
          executed += 1
          return { toolCallId: '', status: 'success' as const, output: { ok: true } }
        },
      }
      const registry = makeRegistry(store, bus, [other], { auditRows })
      registry.requireApproval('other.tool')
      registry.approvals.setDefaultResponder(createAutoApprover(APPROVAL_GATED_TOOLS))
      // 人工回答者(per-chat)优先级高于默认回答者
      registry.approvals.registerResponder(chatId, async () => 'allowed_once')

      const adapter = new ScriptedAdapter([[{ id: 'c1', name: 'other.tool', args: '{}' }]], '好了。')
      await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(executed).toBe(1)
      expect(auditRows[1]!.outcome).toBe('allowed_once')
    } finally {
      store.close()
    }
  })
})

describe('S32 §7-1/§7-5 结果注 tail + origin 溯源(不进稳定前缀)', () => {
  it('tool 结果段 zone=tail 且 source.type=toolResult;toolCallId 可追回', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '溯源角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '联网查')
      const { transport } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport }),
      ])

      const adapter = new ScriptedAdapter([[{ id: 'call_search_1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"北京天气"}' }]], '查到了。')
      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // 第 2 轮(=工具结果回灌后)的快照里应有 toolResult 段
      const rows = store.sqlite
        .prepare(`SELECT ir FROM prompt_snapshots WHERE run_id = ? ORDER BY created_at`)
        .all(result.value.runId) as { ir: string }[]
      expect(rows.length).toBeGreaterThanOrEqual(2)
      const second = JSON.parse(rows[1]!.ir) as {
        segments: { source: { type: string; toolCallId?: string }; role: string; cachePlacement: { zone: string }; content: string }[]
      }
      const toolSeg = second.segments.find((s) => s.source.type === 'toolResult')
      expect(toolSeg).toBeDefined()
      // origin 溯源:toolCallId 直指那次 wire 调用
      expect(toolSeg!.source.toolCallId).toBe('call_search_1')
      expect(toolSeg!.role).toBe('tool')
      // 结果注 tail(§15 tail 注入面),**不进稳定前缀**
      expect(toolSeg!.cachePlacement.zone).toBe('tail')
      // 稳定区(header/stableWB/freshWB/summary)不得出现 toolResult 段
      const stableZones = new Set(['header', 'stableWB', 'freshWB', 'summary'])
      expect(second.segments.filter((s) => stableZones.has(s.cachePlacement.zone) && s.source.type === 'toolResult')).toEqual([])
    } finally {
      store.close()
    }
  })

  it('历史中的 tool 结果(非末尾连续段)回落 history,仅末尾连续输入段注 tail', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '回落角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '两轮工具')
      const { transport } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport, searchWindowMs: 0 }),
      ])
      // 两轮工具:链变为 [u, a1, t1, a2, t2];t1 不再是新鲜输入 → history,t2 → tail
      const adapter = new ScriptedAdapter(
        [
          [{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"A"}' }],
          [{ id: 'c2', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"B"}' }],
        ],
        '完成。',
      )
      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const rows = store.sqlite
        .prepare(`SELECT ir FROM prompt_snapshots WHERE run_id = ? ORDER BY created_at`)
        .all(result.value.runId) as { ir: string }[]
      // 第 3 轮快照 = 两轮工具后
      const third = JSON.parse(rows[rows.length - 1]!.ir) as {
        segments: { source: { type: string; toolCallId?: string }; cachePlacement: { zone: string } }[]
      }
      const toolSegs = third.segments.filter((s) => s.source.type === 'toolResult')
      expect(toolSegs).toHaveLength(2)
      // 只有末尾那个(t2)在 tail;t1 已回落 history —— 保证 tool 结果不被重排到其调用之前
      expect(toolSegs.filter((s) => s.cachePlacement.zone === 'tail')).toHaveLength(1)
      expect(toolSegs.filter((s) => s.cachePlacement.zone === 'history')).toHaveLength(1)
      const tailSeg = toolSegs.find((s) => s.cachePlacement.zone === 'tail')
      expect(tailSeg!.source.toolCallId).toBe('c2')
    } finally {
      store.close()
    }
  })
})

describe('S32 §7-5 超时(§46)与响应归一', () => {
  it('后端挂起 → 工具 status=timeout 且 outcome.timedOut 独立上报', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '超时角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '查一下')
      // 永不 resolve 的传输:只有 §46 超时能收场
      const transport: WebSearchTransport = () => new Promise<WebSearchHttpResponse>(() => undefined)
      const registry = makeRegistry(
        store, bus,
        [createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport })],
        { toolTimeoutMs: 30 },
      )
      const adapter = new ScriptedAdapter([[{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"x"}' }]], '超时了。')
      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // 超时是独立终态:status='timeout' 且 failed 事件落库(Run 本身不炸)
      const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = ?`).get(WEB_SEARCH_TOOL_NAME) as { status: string }
      expect(row.status).toBe('timeout')
      expect(result.value.status).toBe('succeeded')
    } finally {
      store.close()
    }
  })

  it('响应形状不识别(缺 results)→ TOOL_FAILED,不把后端故障伪装成"查不到"', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '形状角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '查一下')
      const { transport } = makeTransport(() => textResponse(JSON.stringify({ items: [] })))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport }),
      ])
      const adapter = new ScriptedAdapter([[{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"x"}' }]], '后端有问题。')
      await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      const row = store.sqlite.prepare(`SELECT status, error FROM tool_calls WHERE tool_name = ?`).get(WEB_SEARCH_TOOL_NAME) as { status: string; error: string }
      expect(row.status).toBe('error')
      expect(JSON.parse(row.error).code).toBe('TOOL_FAILED')
    } finally {
      store.close()
    }
  })

  it('非法入参(空 query)→ INVALID_INPUT,且不外发', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '入参角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '空查询')
      const { transport, urls } = makeTransport(() => textResponse(OK_BODY))
      const registry = makeRegistry(store, bus, [
        createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport }),
      ])
      const adapter = new ScriptedAdapter([[{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"   "}' }]], '参数错了。')
      await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
      )
      const row = store.sqlite.prepare(`SELECT status, error FROM tool_calls WHERE tool_name = ?`).get(WEB_SEARCH_TOOL_NAME) as { status: string; error: string }
      expect(row.status).toBe('error')
      expect(JSON.parse(row.error).code).toBe('INVALID_INPUT')
      expect(urls).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('429 / 5xx 归一为可重试瞬时错误(§47 C3),4xx 归一为确定性失败', async () => {
    const cases: { status: number; code: string }[] = [
      { status: 429, code: 'RATE_LIMIT' },
      { status: 503, code: 'TEMPORARY' },
      { status: 400, code: 'TOOL_FAILED' },
    ]
    for (const { status, code } of cases) {
      const store = makeStore()
      try {
        const bus = new EventBus(createSqliteEventSink(store))
        const def = createAgentDefinition(store, { name: '错误角色', type: 'tool-agent', instructions: 'x', now: NOW })
        const chatId = makeChat(store, bus, '查一下')
        // 始终返回同一状态:重试次数用尽后仍是该码
        const { transport } = makeTransport(() => textResponse('boom', status))
        const registry = makeRegistry(store, bus, [
          createWebSearchToolDefinition({ endpoint: 'https://search.test/v1', fetchImpl: transport, now: () => 1_000 }),
        ])
        const adapter = new ScriptedAdapter([[{ id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: '{"query":"x"}' }]], '出错了。')
        await runAgent(
          { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
          { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: webSearchWireTools(), now: NOW },
        )
        const row = store.sqlite.prepare(`SELECT status, error FROM tool_calls WHERE tool_name = ?`).get(WEB_SEARCH_TOOL_NAME) as { status: string; error: string }
        expect(row.status).toBe('error')
        expect(JSON.parse(row.error).code).toBe(code)
      } finally {
        store.close()
      }
    }
  })
})

describe('S32 wire 面与注册面', () => {
  it('webSearchWireTools 投影 name/description/inputSchema(§31 wire 工具清单)', () => {
    const wire = webSearchWireTools()
    expect(wire).toHaveLength(1)
    expect(wire[0]!.name).toBe(WEB_SEARCH_TOOL_NAME)
    expect(wire[0]!.description.length).toBeGreaterThan(0)
    expect((wire[0]!.inputSchema as { required: string[] }).required).toEqual(['query'])
  })

  it('工具声明只读(§50 sideEffectLevel=none)且只申请 network.request(§33)', () => {
    const tool = createWebSearchToolDefinition({ endpoint: 'https://search.test/v1' })
    expect(tool.permissions).toEqual(['network.request'])
    expect(tool.sideEffectLevel).toBe('none')
    expect(tool.id).toBe('tool_web_search')
  })
})
