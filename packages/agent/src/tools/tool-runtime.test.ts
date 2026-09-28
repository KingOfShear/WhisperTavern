/**
 * S24(WP3.2)验收:agent-runtime-spec §174 Test 2(Tool Loop)/ Test 3(Cancellation)/
 * Test 4(Retry)/ Test 8(Permission)+ §115.1 审批四值 fail-closed + §36.3 并行回灌
 * 按 model order。
 */
import { describe, expect, it } from 'vitest'
import type { ChatId, ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { EventBus, SnapshotRegistry, createDatabase, createMessage, createChat, createSqliteEventSink, type WhisperTavernDb } from '@whispertavern/runtime'
import { BudgetExceeded } from './budget'
import { ToolRegistry, ToolBusinessError } from './registry'
import type { ApprovalAuditRow } from './approval'
import type { ApprovalRequest, ToolDefinition } from './types'
import { createAgentDefinition } from '../runtime/definition'
import { runAgent } from '../runtime/run-agent'

const NOW = '2026-09-26T12:00:00.000Z'

interface ScriptedCall {
  id: string
  name: string
  args: string
}

/** 脚本化 adapter:前 N 轮发 tool_call(逐轮一组),之后发 Final 文本 */
class ToolLoopAdapter implements ProviderAdapter {
  readonly providerId = 'fake'
  private cursor = 0
  constructor(
    private readonly rounds: readonly ScriptedCall[][],
    private readonly finalText: string,
    private readonly cancelOnRound?: number,
  ) {}
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
    if (this.cancelOnRound === round) {
      yield { type: 'error', error: { code: 'CANCELLED', retryable: false, keyRotatable: false, detail: '用户中止' } }
      return
    }
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
  const chat = createChat(store, bus, { title: 'tool-e2e', now: NOW })
  if (!chat.ok) throw new Error(`建 chat 失败: ${JSON.stringify(chat)}`)
  const msg = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: userContent, now: NOW })
  if (!msg.ok) throw new Error(`建消息失败: ${JSON.stringify(msg)}`)
  return chat.value.id as ChatId
}

const WEATHER_TOOL: ToolDefinition = {
  id: 'tool_weather',
  name: 'get_weather',
  description: '查询天气',
  inputSchema: { type: 'object' },
  permissions: [],
  sideEffectLevel: 'idempotent',
  async execute(input) {
    return { toolCallId: '', status: 'success', output: { city: (input as { city?: string }).city, temp: 22 } }
  },
}

function makeRegistry(
  store: WhisperTavernDb,
  bus: EventBus,
  tools: readonly ToolDefinition[],
  opts?: { auditRows?: ApprovalAuditRow[] } & ConstructorParameters<typeof ToolRegistry>[1],
): ToolRegistry {
  const registry = new ToolRegistry(
    { store, bus, persistApprovalAudit: (row) => opts?.auditRows?.push(row) },
    opts,
  )
  for (const t of tools) registry.register(t)
  return registry
}

describe('§174 Test 2 — Tool Loop(工具循环后 Final)', () => {
  it('模型请求工具 → 执行 → 回灌 → 模型 Final;两轮快照、tool_calls 落库、Turn 欠账清零', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '工具角色', type: 'tool-agent', instructions: '用工具。', now: NOW })
      const chatId = makeChat(store, bus, '今天天气如何?')
      const registry = makeRegistry(store, bus, [WEATHER_TOOL])

      const adapter = new ToolLoopAdapter([[{ id: 'call_1', name: 'get_weather', args: '{"city":"北京"}' }]], '北京今天 22 度。')
      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', tools: [{ name: 'get_weather', description: '查询天气', inputSchema: {} }], now: NOW },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('succeeded')
      expect(result.value.turn.endReason).toBe('completed')
      expect(result.value.turn.toolCalls).toEqual(['call_1'])
      expect(result.value.turn.stepCount).toBe(2) // 两轮模型调用
      // Final 正文入树(最后一条 = character 的 Final 文本;其前是 tool 结果消息)
      const tail = store.sqlite
        .prepare<[string]>(`SELECT role, author_id, content FROM messages WHERE chat_id = ? ORDER BY sequence DESC LIMIT 2`)
        .all(chatId) as { role: string; author_id: string | null; content: string }[]
      expect(tail[0]?.role).toBe('character')
      expect(tail[0]?.content).toBe('北京今天 22 度。')
      expect(tail[1]?.role).toBe('tool')
      expect(JSON.parse(tail[1]?.content ?? '{}')).toEqual({ output: { city: '北京', temp: 22 } })
      // tool_calls 权威结果落库(§36.1 冻结)
      const row = store.sqlite.prepare(`SELECT status, result FROM tool_calls WHERE tool_name = 'get_weather'`).get() as { status: string; result: string }
      expect(row.status).toBe('success')
      expect(JSON.parse(row.result ?? '{}')).toEqual({ city: '北京', temp: 22 })
      // 每轮一个快照(Test 9 的循环版)
      const snapCount = (store.sqlite.prepare<[string]>(`SELECT COUNT(*) AS n FROM prompt_snapshots WHERE run_id = ?`).get(result.value.runId) as { n: number }).n
      expect(snapCount).toBe(2)
      // Turn 事件配对且 payload 带 toolCallCount
      const completed = store.sqlite
        .prepare(`SELECT payload FROM events WHERE event_type = 'agent.turn.completed' ORDER BY created_at DESC LIMIT 1`)
        .get() as { payload: string }
      expect(JSON.parse(completed.payload).toolCallCount).toBe(1)
    } finally {
      store.close()
    }
  })
})

describe('§174 Test 8 — Permission(拒绝不执行,Run 继续)', () => {
  it('缺权限 → denied(TOOL_PERMISSION_DENIED),工具体未执行,模型收到拒绝后继续 Final', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '受限角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '连个网')
      let executed = 0
      const netTool: ToolDefinition = {
        ...WEATHER_TOOL,
        name: 'network_request',
        description: '网络请求',
        permissions: ['network.request'],
        async execute(input, ctx) {
          executed += 1
          void ctx
          return { toolCallId: '', status: 'success', output: { ok: true, input } }
        },
      }
      const registry = makeRegistry(store, bus, [netTool])
      const adapter = new ToolLoopAdapter([[{ id: 'call_net', name: 'network_request', args: '{}' }]], '被拒了,我如实转告。')

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW, permissions: new Set() },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('succeeded') // Run 按策略继续,不因拒绝而炸
      expect(executed).toBe(0) // 工具体未执行
      const row = store.sqlite.prepare(`SELECT status, error FROM tool_calls WHERE tool_name = 'network_request'`).get() as { status: string; error: string }
      expect(row.status).toBe('denied')
      expect(JSON.parse(row.error ?? '{}').code).toBe('TOOL_PERMISSION_DENIED')
      // tool.call.denied 事件落库
      const denied = store.sqlite.prepare(`SELECT id FROM events WHERE event_type = 'tool.call.denied'`).get()
      expect(denied).toBeDefined()
    } finally {
      store.close()
    }
  })
})

describe('§174 Test 3 — Cancellation(取消 ≠ 失败)', () => {
  it('Provider 中途 CANCELLED → Run = cancelled,Turn 以 cancelled 关闭', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '取消角色', type: 'character', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '开始生成')
      const registry = makeRegistry(store, bus, [WEATHER_TOOL])
      const adapter = new ToolLoopAdapter([], '', 0) // 首轮即 CANCELLED

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('cancelled')
      expect(result.value.turn.endReason).toBe('cancelled')
      const runRow = store.sqlite.prepare(`SELECT status FROM runs WHERE id = ?`).get(result.value.runId) as { status: string }
      expect(runRow.status).toBe('cancelled')
    } finally {
      store.close()
    }
  })
})

describe('§174 Test 4 — Retry(瞬时错误重试,同 Run 内完成)', () => {
  it('第一次 NETWORK_ERROR → 重试成功;结果 success 且 duration 记账', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '重试角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '调一次')
      let attempts = 0
      const flaky: ToolDefinition = {
        ...WEATHER_TOOL,
        name: 'flaky_tool',
        permissions: [],
  sideEffectLevel: 'idempotent',
        async execute() {
          attempts += 1
          if (attempts === 1) throw new ToolBusinessError('NETWORK_ERROR', '网络抖动')
          return { toolCallId: '', status: 'success', output: { attempt: attempts } }
        },
      }
      const registry = makeRegistry(store, bus, [flaky])
      const adapter = new ToolLoopAdapter([[{ id: 'call_flaky', name: 'flaky_tool', args: '{}' }]], '重试后拿到了。')

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(attempts).toBe(2) // C3:瞬时错误同 Run 内重试一次
      const row = store.sqlite.prepare(`SELECT status, result FROM tool_calls WHERE tool_name = 'flaky_tool'`).get() as { status: string; result: string }
      expect(row.status).toBe('success')
      expect(JSON.parse(row.result ?? '{}').attempt).toBe(2)
    } finally {
      store.close()
    }
  })
})

describe('§115.1 审批四值 + fail-closed', () => {
  function makeAskTool(): ToolDefinition {
    return { ...WEATHER_TOOL, name: 'danger_tool', description: '危险操作', permissions: [] }
  }
  function askRegistry(store: WhisperTavernDb, bus: EventBus, chatId: string, responder?: (r: ApprovalRequest) => Promise<string>) {
    const auditRows: ApprovalAuditRow[] = []
    const registry = makeRegistry(store, bus, [makeAskTool()], {
      auditRows,
      preExecute: () => ({ action: 'ask', reason: '危险操作需要确认' }),
    })
    if (responder !== undefined) registry.approvals.registerResponder(chatId, responder)
    return { registry, auditRows }
  }

  it('无回答者(headless)→ unavailable → denied;request/decided 成对落库', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: 'h', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, 'x')
      const { registry, auditRows } = askRegistry(store, bus, chatId)
      const adapter = new ToolLoopAdapter([[{ id: 'call_d', name: 'danger_tool', args: '{}' }]], '没批,作罢。')
      const result = await runAgent({ store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW }, { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = 'danger_tool'`).get() as { status: string }
      expect(row.status).toBe('denied')
      // 成对审计:pending → decided(unavailable)
      expect(auditRows).toHaveLength(2)
      expect(auditRows[0]?.status).toBe('pending')
      expect(auditRows[1]?.status).toBe('decided')
      expect(auditRows[1]?.outcome).toBe('unavailable')
      // 事件成对(durable)
      const requested = (store.sqlite.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'approval.requested'`).get() as { n: number }).n
      const decided = (store.sqlite.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'approval.decided'`).get() as { n: number }).n
      expect(requested).toBe(1)
      expect(decided).toBe(1)
    } finally {
      store.close()
    }
  })

  it("policy 'never' → 派发之前确定性 rejected(后注册的回答者不被调用)", async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: 'n', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, 'x')
      let responderCalled = 0
      const { registry, auditRows } = askRegistry(store, bus, chatId, async () => {
        responderCalled += 1
        return 'allowed_once'
      })
      registry.approvals.setPolicy(chatId, 'never')
      const adapter = new ToolLoopAdapter([[{ id: 'call_n', name: 'danger_tool', args: '{}' }]], '没批。')
      await runAgent({ store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW }, { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW })
      expect(responderCalled).toBe(0)
      expect(auditRows[1]?.outcome).toBe('rejected')
    } finally {
      store.close()
    }
  })

  it('回答者抛异常 / 返回枚举外 → 一律 unavailable(不允许部分放行)', async () => {
    for (const broken of [async (): Promise<string> => { throw new Error('UI 崩了') }, async (): Promise<string> => 'yes sure']) {
      const store = makeStore()
      try {
        const bus = new EventBus(createSqliteEventSink(store))
        const def = createAgentDefinition(store, { name: 'b', type: 'tool-agent', instructions: 'x', now: NOW })
        const chatId = makeChat(store, bus, 'x')
        const { registry, auditRows } = askRegistry(store, bus, chatId, broken)
        const adapter = new ToolLoopAdapter([[{ id: 'call_b', name: 'danger_tool', args: '{}' }]], '仍被拒。')
        await runAgent({ store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW }, { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW })
        const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = 'danger_tool'`).get() as { status: string }
        expect(row.status).toBe('denied')
        expect(auditRows[1]?.outcome).toBe('unavailable')
      } finally {
        store.close()
      }
    }
  })

  it('allowed_once → 放行执行一次', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: 'a', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, 'x')
      const { registry } = askRegistry(store, bus, chatId, async () => 'allowed_once')
      const adapter = new ToolLoopAdapter([[{ id: 'call_ok', name: 'danger_tool', args: '{}' }]], '批了,执行完。')
      const result = await runAgent({ store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW }, { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = 'danger_tool'`).get() as { status: string }
      expect(row.status).toBe('success')
    } finally {
      store.close()
    }
  })
})

describe('§36.3 并行回灌按 model order', () => {
  it('乱序完成(慢的先请求)仍按请求序落 tool 结果消息与 executeBatch 结果', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '并行角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '并行调两个')
      const slow: ToolDefinition = {
        ...WEATHER_TOOL, name: 'slow_tool',
        async execute() {
          await new Promise((r) => setTimeout(r, 60))
          return { toolCallId: '', status: 'success', output: { which: 'slow' } }
        },
      }
      const fast: ToolDefinition = {
        ...WEATHER_TOOL, name: 'fast_tool',
        async execute() {
          await new Promise((r) => setTimeout(r, 5))
          return { toolCallId: '', status: 'success', output: { which: 'fast' } }
        },
      }
      const registry = makeRegistry(store, bus, [slow, fast])
      // model order:slow 在前、fast 在后;fast 先完成
      const adapter = new ToolLoopAdapter(
        [[{ id: 'call_slow', name: 'slow_tool', args: '{}' }, { id: 'call_fast', name: 'fast_tool', args: '{}' }]],
        '两个都好了。',
      )
      const result = await runAgent({ store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW }, { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // tool 结果消息顺序 = model order(slow 的结果在前,尽管 fast 先完成)
      const order = store.sqlite
        .prepare(`SELECT author_id FROM messages WHERE chat_id = ? AND role = 'tool' ORDER BY sequence`)
        .all(chatId) as { author_id: string }[]
      expect(order.map((r) => r.author_id)).toEqual(['slow_tool', 'fast_tool'])
    } finally {
      store.close()
    }
  })
})

describe('§38 上限:RUN_BUDGET_EXCEEDED', () => {
  it('maxToolCalls=1 而模型连要两个 → Run 失败,Turn 以 budget_exceeded 关闭', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '超限角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, 'x')
      const registry = makeRegistry(store, bus, [WEATHER_TOOL])
      const adapter = new ToolLoopAdapter(
        [[{ id: 'c1', name: 'get_weather', args: '{}' }, { id: 'c2', name: 'get_weather', args: '{}' }]],
        '不该到达',
      )
      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW, budget: { maxToolCalls: 1 } },
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('RUN_BUDGET_EXCEEDED')
      // Turn 关闭原因 budget_exceeded(事件可查)
      const completed = store.sqlite
        .prepare(`SELECT payload FROM events WHERE event_type = 'agent.turn.completed' ORDER BY created_at DESC LIMIT 1`)
        .get() as { payload: string }
      expect(JSON.parse(completed.payload).endReason).toBe('budget_exceeded')
      void BudgetExceeded
    } finally {
      store.close()
    }
  })
})
