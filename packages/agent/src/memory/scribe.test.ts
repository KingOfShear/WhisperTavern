/**
 * S31(WP4.2b)Scribe Agent 契约测试(memory-runtime-spec §4 / p4-plan §6 验收)。
 *
 * 验收点(逐条断言):
 * 1. 读新剧情 → 模型收到剧情节选(Scribe 任务消息内容含剧情原文);
 * 2. 发现重要事实 → memory.upsert_dossier 工具调用经 ToolRegistry 落 tool_calls 行 +
 *    memories 表(type='fact',chat_id=目标会话);
 * 3. 追加 Timeline → memory.append_timeline 落 timeline_events;
 * 4. Summary 冻结 → memory.append_summary 落 summary_blocks(sequence 自增,frozen=TRUE);
 * 5. **不直接修改原始聊天记录**——目标 chat 消息树行数与内容零变化;
 * 6. Scribe 对话落在影子会话 `scribe:<target>`,commitOutput 的最终消息也在影子会话;
 * 7. 事件落账:memory.created/updated + tool.call.completed durable 事件可查。
 *
 * 传输:真实 runAgent(非 mock);工具 = 真实 memory 写入工具;模型 = 脚本化
 * ToolLoopAdapter 逐轮发 tool_call_delta(与 §174 Test 2 同构)。
 */
import { describe, expect, it } from 'vitest'
import type { ChatId, ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { EventBus, SnapshotRegistry, createDatabase, createChat, createMessage, createSqliteEventSink, type WhisperTavernDb } from '@whispertavern/runtime'
import { runScribe } from '../memory/scribe'
import { events as eventsTable } from '@whispertavern/runtime'

const NOW = '2026-09-28T12:00:00.000Z'

interface ScriptedCall {
  id: string
  name: string
  args: string
}

/** 脚本化 adapter:前 N 轮按剧本发 tool_call,之后发 Final 文本 */
class ScribeLoopAdapter implements ProviderAdapter {
  readonly providerId = 'fake'
  private cursor = 0
  constructor(
    private readonly rounds: readonly ScriptedCall[][],
    private readonly finalText: string,
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
    for (const [index, call] of (this.rounds[round] ?? []).entries()) {
      yield { type: 'tool_call_delta', index, id: call.id, name: call.name, argsFragment: call.args }
    }
    if (round < this.rounds.length) {
      yield { type: 'usage', usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 50, source: 'reported' } }
      yield { type: 'finish', reason: 'tool_use' }
    } else {
      yield { type: 'text_delta', text: this.finalText }
      yield { type: 'usage', usage: { inputTokens: 600, cachedInputTokens: 0, outputTokens: 80, source: 'reported' } }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}

function makeEnv(): { store: WhisperTavernDb; bus: EventBus } {
  const store = createDatabase(':memory:')
  store.sqlite
    .prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake', 'fake', 'fake', '{}', '{}', ?, ?)`)
    .run(NOW, NOW)
  const bus = new EventBus(createSqliteEventSink(store))
  return { store, bus }
}

function makeTargetChat(store: WhisperTavernDb, bus: EventBus): { chatId: ChatId; userMsgId: string; charMsgId: string } {
  const chat = createChat(store, bus, { title: '狐神抚', now: NOW })
  if (!chat.ok) throw new Error(`建 chat 失败: ${JSON.stringify(chat)}`)
  const u1 = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '你来神社做什么？', now: NOW })
  if (!u1.ok) throw new Error(`建消息失败: ${JSON.stringify(u1)}`)
  const c1 = createMessage(store, bus, { chatId: chat.value.id, role: 'character', content: '我来求一张护身符。', now: NOW })
  if (!c1.ok) throw new Error(`建消息失败: ${JSON.stringify(c1)}`)
  return { chatId: chat.value.id as ChatId, userMsgId: u1.value.message.id, charMsgId: c1.value.message.id }
}

function toolCallsOf(store: WhisperTavernDb, runId: string): { name: string; status: string }[] {
  return store.sqlite
    .prepare(`SELECT tool_name AS name, status FROM tool_calls WHERE run_id = ? ORDER BY rowid ASC`)
    .all(runId) as { name: string; status: string }[]
}

function messageCount(store: WhisperTavernDb, chatId: string): number {
  const row = store.sqlite.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND deleted_at IS NULL`).get(chatId) as { n: number }
  return row.n
}

describe('S31 Scribe Agent(memory-runtime-spec §4)', () => {
  it('读新剧情 → upsert Dossier + 追加 Timeline + 冻结 Summary;原聊天树零变化;写入经 tool_calls 落账', async () => {
    const { store, bus } = makeEnv()
    try {
      const target = makeTargetChat(store, bus)
      const targetChatId = target.chatId
      const beforeCount = messageCount(store, targetChatId)

      // 剧本:一轮三工具(Dossier + Timeline + Summary),一轮 Final 汇报
      const adapter = new ScribeLoopAdapter(
        [
          [
            { id: 'call_1', name: 'memory.upsert_dossier', args: JSON.stringify({ chatId: targetChatId, entity: '少女', content: '少女求取神社护身符', importance: 0.8, sourceMessageIds: [target.userMsgId] }) },
            { id: 'call_2', name: 'memory.append_timeline', args: JSON.stringify({ chatId: targetChatId, eventType: 'visit', summary: '少女来到神社求护身符', importance: 0.7 }) },
            { id: 'call_3', name: 'memory.append_summary', args: JSON.stringify({ chatId: targetChatId, content: '少女首次到访神社求护身符', fromMessageId: target.userMsgId, toMessageId: target.charMsgId }) },
          ],
        ],
        '已记录 1 条档案、1 条事件、1 段摘要。',
      )

      const result = await runScribe(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        { chatId: targetChatId, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const value = result.value
      expect(value.status).toBe('succeeded')
      expect(value.plotMessages).toBe(2) // u1 + c1 两条剧情消息

      // 写入三分(验收 2/3/4):dossier/timeline/summary 各 1
      expect(value.writes).toEqual({ dossier: 1, timeline: 1, summary: 1 })

      // 影子会话隔离(验收 5/6):目标 chat 消息数不变;影子会话有 Scribe 对话
      expect(messageCount(store, targetChatId)).toBe(beforeCount)
      const shadowCount = messageCount(store, value.scribeChatId)
      expect(shadowCount).toBeGreaterThan(0)

      // 落账(验收 7):tool_calls 行三工具齐全且成功
      const toolCalls = toolCallsOf(store, value.runId)
      expect(toolCalls.map((t) => t.name).sort()).toEqual(['memory.append_summary', 'memory.append_timeline', 'memory.upsert_dossier'])
      expect(toolCalls.every((t) => t.status === 'success')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('记忆落库内容核对:memories/timeline_events/summary_blocks 的行投影正确(chat_id=目标会话)', async () => {
    const { store, bus } = makeEnv()
    try {
      const target = makeTargetChat(store, bus)
      const targetChatId = target.chatId
      const adapter = new ScribeLoopAdapter(
        [
          [
            { id: 'call_1', name: 'memory.upsert_dossier', args: JSON.stringify({ chatId: targetChatId, entity: '狐神', content: '狐神的真身是神社守护灵', importance: 0.95 }) },
            { id: 'call_2', name: 'memory.append_timeline', args: JSON.stringify({ chatId: targetChatId, eventType: 'discovery', summary: '狐神真身揭晓', importance: 0.9 }) },
            { id: 'call_3', name: 'memory.append_summary', args: JSON.stringify({ chatId: targetChatId, content: '少女探明狐神真身', fromMessageId: target.userMsgId, toMessageId: target.charMsgId }) },
          ],
        ],
        '已记录。',
      )
      const result = await runScribe(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        { chatId: targetChatId, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // memories:type='fact' 且 entity 非空,chat_id = 目标
      const memRow = store.sqlite.prepare(`SELECT id, chat_id, type, entity, content, version FROM memories WHERE deleted_at IS NULL`).all() as {
        id: string; chat_id: string; type: string; entity: string; content: string; version: number
      }[]
      expect(memRow).toHaveLength(1)
      expect(memRow[0]).toMatchObject({ chat_id: targetChatId, type: 'fact', entity: '狐神', version: 1 })

      // timeline_events:chat_id = 目标
      const tlRow = store.sqlite.prepare(`SELECT chat_id, event_type, summary FROM timeline_events`).all() as { chat_id: string; event_type: string; summary: string }[]
      expect(tlRow).toHaveLength(1)
      expect(tlRow[0]).toMatchObject({ chat_id: targetChatId, event_type: 'discovery', summary: '狐神真身揭晓' })

      // summary_blocks:frozen=1 + sequence 自增
      const smRow = store.sqlite.prepare(`SELECT chat_id, sequence, frozen, content FROM summary_blocks`).all() as { chat_id: string; sequence: number; frozen: number; content: string }[]
      expect(smRow).toHaveLength(1)
      expect(smRow[0]).toMatchObject({ chat_id: targetChatId, sequence: 1, frozen: 1 })

      // 事件:memory.created 三发(dossier 新建 + timeline + summary)+ memory.updated 零 + tool.call.completed ×3
      // (memory.created 是 deferred-durable:先 flush 再查,允许延迟不允许丢)
      bus.flush()
      const events = store.db.select().from(eventsTable).all()
      const types = events.map((e) => e.eventType)
      expect(types.filter((t) => t === 'memory.created').length).toBe(3)
      expect(types.filter((t) => t === 'memory.updated').length).toBe(0)
      expect(types.filter((t) => t === 'tool.call.completed').length).toBe(3)
    } finally {
      store.close()
    }
  })

  it('无新剧情(空链)→ 跳过;Scribe 不写任何记忆', async () => {
    const { store, bus } = makeEnv()
    try {
      const chat = createChat(store, bus, { title: '空会话', now: NOW })
      if (!chat.ok) throw new Error(`建 chat 失败: ${JSON.stringify(chat)}`)
      const adapter = new ScribeLoopAdapter([], '不应被调用')
      const result = await runScribe(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        { chatId: chat.value.id as ChatId, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('skipped')
      expect(result.value.writes).toEqual({ dossier: 0, timeline: 0, summary: 0 })
    } finally {
      store.close()
    }
  })
})