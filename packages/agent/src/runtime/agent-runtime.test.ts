/**
 * S23(WP3.1b)集成测试:agent-runtime-spec §174 的 Test 1(普通聊天)与
 * Test 9(每次真实 Provider Request 都有 Prompt Snapshot),外加 Turn 记账
 * (§37.1 空 Turn 必须留痕)与 Instance 状态机接线。
 *
 * B4 白名单:agent 只依赖 contracts/core/runtime,故 fake adapter **内联实现**
 * ProviderAdapter(contracts 形状),不引 adapters 包。
 */
import { describe, expect, it } from 'vitest'
import type { ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { EventBus, SnapshotRegistry, createMessage, createSqliteEventSink, createDatabase, createChat, type WhisperTavernDb } from '@whispertavern/runtime'
import { createAgentDefinition, loadAgentDefinition } from './definition'
import { getOrCreateAgentInstance } from './instance'
import { runAgent } from './run-agent'
import type { ChatId, Timestamp } from '@whispertavern/contracts'

const NOW = '2026-09-26T10:00:00.000Z' as Timestamp

/** 最小脚本化 adapter:单轮固定回复(§174 Test 1 只需"模型回了话") */
class ScriptedAdapter implements ProviderAdapter {
  readonly providerId = 'fake'
  constructor(private readonly text: string) {}
  capabilities(_model: string): ProviderCapabilities {
    return {
      systemRole: true,
      tools: false,
      vision: false,
      reasoning: false,
      streaming: true,
      promptCaching: false,
      cacheType: 'none',
      maxContextTokens: 131_072,
      maxOutputTokens: 4096,
      structuredOutput: 'none',
      parallelToolCalls: false,
      toolChoice: false,
    }
  }
  async *stream(_req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    yield { type: 'message_start' }
    yield { type: 'text_delta', text: this.text }
    yield { type: 'usage', usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 24, source: 'reported' } }
    yield { type: 'finish', reason: 'stop' }
  }
}

function makeStore(): WhisperTavernDb {
  const store = createDatabase(':memory:')
  // generations.provider_id → providers 的 FK 需要一行 provider(服务端由 API 建;此处种子化,id 与 providerId 传参一致)
  store.sqlite
    .prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake', 'fake', 'fake', '{}', '{}', ?, ?)`)
    .run(NOW, NOW)
  return store
}

function makeChat(store: WhisperTavernDb, bus: EventBus, userContent: string): ChatId {
  const chat = createChat(store, bus, { title: 'agent-e2e', now: NOW })
  if (!chat.ok) throw new Error(`建 chat 失败: ${JSON.stringify(chat)}`)
  const msg = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: userContent, now: NOW })
  if (!msg.ok) throw new Error(`建消息失败: ${JSON.stringify(msg)}`)
  return chat.value.id as ChatId
}

describe('Agent Runtime(S23 / §174 Test 1 + Test 9)', () => {
  it('§174 Test 1 普通聊天:User → Character Agent → Prompt → Model → Message(端到端成功)', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, {
        name: '测试角色',
        type: 'character',
        instructions: '你是一个安静的测试角色。',
        now: NOW,
      })
      const chatId = makeChat(store, bus, '你好')

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        { chatId, agentId: def.id, adapter: new ScriptedAdapter('你好,我是测试回复。'), providerId: 'fake', model: 'fake-model', now: NOW },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Run 收口:§4.3 succeeded;Turn 正常关闭
      expect(result.value.status).toBe('succeeded')
      expect(result.value.turn.endReason).toBe('completed')
      expect(result.value.turn.stepCount).toBeGreaterThan(0)
      expect(result.value.messageId).not.toBeNull()
      // 回复入树:最后一条消息 = assistant 的脚本正文
      const rows = store.sqlite
        .prepare<[string]>(`SELECT role, content FROM messages WHERE chat_id = ? ORDER BY sequence DESC LIMIT 1`)
        .all(chatId) as { role: string; content: string }[]
      expect(rows[0]?.role).toBe('character')
      expect(rows[0]?.content).toBe('你好,我是测试回复。')
      // Instance 复位回 idle(Run 终态聚合,§4.3 末条)
      const inst = getOrCreateAgentInstance(store, { chatId, agentId: def.id, agentVersion: def.version, now: NOW })
      expect(inst.status).toBe('idle')
    } finally {
      store.close()
    }
  })

  it('§174 Test 9:每次真实 Provider Request 都有 Prompt Snapshot(generation.snapshotId 非空且快照落库)', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '快照角色', type: 'character', instructions: '快照。', now: NOW })
      const chatId = makeChat(store, bus, '触发一次生成')

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        { chatId, agentId: def.id, adapter: new ScriptedAdapter('收到。'), providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // §5.5 不变量:Run 行挂 snapshotId;generation 行也挂
      const runRow = store.sqlite.prepare<[string]>(`SELECT snapshot_id, status FROM runs WHERE id = ?`).get(result.value.runId) as
        | { snapshot_id: string | null; status: string }
        | undefined
      expect(runRow?.snapshot_id).toBe(result.value.snapshotId)
      expect(runRow?.status).toBe('succeeded')
      const genRow = store.sqlite
        .prepare<[string]>(`SELECT snapshot_id FROM generations WHERE run_id = ?`)
        .get(result.value.runId) as { snapshot_id: string | null } | undefined
      expect(genRow?.snapshot_id).not.toBeNull()
      // 快照本体落库(prompt_snapshots)
      const snapRow = store.sqlite.prepare<[string]>(`SELECT id FROM prompt_snapshots WHERE id = ?`).get(result.value.snapshotId ?? '')
      expect(snapRow).toBeDefined()
      // Turn 关闭事件携带快照与 generation 归因(§37 payload)
      const turnEvents = store.sqlite
        .prepare<[]>(`SELECT event_type, payload FROM events WHERE event_type LIKE 'agent.turn.%' ORDER BY created_at`)
        .all() as { event_type: string; payload: string }[]
      expect(turnEvents.map((e) => e.event_type)).toEqual(['agent.turn.started', 'agent.turn.completed'])
      const completed = JSON.parse(turnEvents[1]!.payload) as { endReason: string; stepCount: number }
      expect(completed.endReason).toBe('completed')
      expect(completed.stepCount).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('§37.1 空 Turn 记账:空白输入 → skipped Run + stepCount=0 + endReason=empty_input,不发 Provider', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '空转角色', type: 'character', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '   ')

      let providerCalled = false
      const base = new ScriptedAdapter('不该被调用')
      const adapter: ProviderAdapter = {
        providerId: base.providerId,
        capabilities: base.capabilities.bind(base),
        stream: (req) => {
          providerCalled = true
          return base.stream(req)
        },
      }

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('skipped')
      expect(result.value.snapshotId).toBeNull()
      expect(result.value.messageId).toBeNull()
      expect(result.value.turn.stepCount).toBe(0)
      expect(result.value.turn.endReason).toBe('empty_input')
      expect(providerCalled).toBe(false)
      // Run 判 skipped(§4.3"开了但没活可干")
      const runRow = store.sqlite.prepare<[string]>(`SELECT status FROM runs WHERE id = ?`).get(result.value.runId) as
        | { status: string }
        | undefined
      expect(runRow?.status).toBe('skipped')
      // 空 Turn 也要留下配对的 started/completed 事件(不留悬空 started)
      const types = (
        store.sqlite.prepare<[]>(`SELECT event_type FROM events WHERE event_type LIKE 'agent.turn.%' ORDER BY created_at`).all() as {
          event_type: string
        }[]
      ).map((r) => r.event_type)
      expect(types).toEqual(['agent.turn.started', 'agent.turn.completed'])
    } finally {
      store.close()
    }
  })

  it('pre-step 拒绝 → rejected 空 Turn(不建 Run 之外的任何生成痕迹)', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '权限角色', type: 'tool-agent', instructions: 'x', now: NOW })
      const chatId = makeChat(store, bus, '正常输入')

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        {
          chatId,
          agentId: def.id,
          adapter: new ScriptedAdapter('不该被调用'),
          providerId: 'fake',
          model: 'fake-model',
          preStepRejection: '权限闸门拒绝',
          now: NOW,
        },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('skipped')
      expect(result.value.turn.endReason).toBe('rejected')
      expect(result.value.turn.stepCount).toBe(0)
    } finally {
      store.close()
    }
  })

  it('Definition 版本钉住(§163):创建后读回同版本;Instance get-or-create 幂等', () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '幂等角色', type: 'director', instructions: '导演。', now: NOW })
      const reloaded = loadAgentDefinition(store, def.id)
      expect(reloaded?.version).toBe(def.version)
      expect(reloaded?.instructions).toBe('导演。')

      const chatId = makeChat(store, bus, 'x')
      const first = getOrCreateAgentInstance(store, { chatId, agentId: def.id, agentVersion: def.version, now: NOW })
      const second = getOrCreateAgentInstance(store, { chatId, agentId: def.id, agentVersion: def.version, now: NOW })
      expect(second.id).toBe(first.id)
    } finally {
      store.close()
    }
  })
})
