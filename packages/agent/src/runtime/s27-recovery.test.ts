/**
 * S27(WP3.5)验收:agent-runtime-spec §174 Test 5(Resume)/ Test 6(Crash Recovery)/
 * Test 10(Deterministic Replay)+ §55 兼容性(RESUME_INCOMPATIBLE / force)+
 * §50 non-idempotent reconciliation(还账 #11)+ Zombie Run 清零(§97)。
 */
import { describe, expect, it } from 'vitest'
import type { ChatId, ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { EventBus, SnapshotRegistry, createDatabase, createMessage, createChat, createSqliteEventSink, createExecutionRun, recordCheckpoint, transitionRun, type WhisperTavernDb } from '@whispertavern/runtime'
import { runAgent, resumeRun, scanInterruptedRuns, planRecovery, reconcileToolCalls, ReplayAdapter } from '../index'
import { ToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import { createAgentDefinition } from './definition'

const NOW = '2026-09-27T10:00:00.000Z'

interface ScriptedRound {
  text?: string
  tool?: { id: string; name: string; args: string }
}

/** 脚本化 adapter:逐轮回放;text = Final 轮,tool = 工具轮 */
class ScriptedAdapter implements ProviderAdapter {
  readonly providerId = 'fake'
  private cursor = 0
  constructor(private readonly rounds: readonly ScriptedRound[]) {}
  capabilities(_model: string): ProviderCapabilities {
    return {
      systemRole: true, tools: true, vision: false, reasoning: false, streaming: true,
      promptCaching: false, cacheType: 'none', maxContextTokens: 131_072, maxOutputTokens: 4096,
      structuredOutput: 'none', parallelToolCalls: true, toolChoice: false,
    }
  }
  get executedRounds(): number {
    return this.cursor
  }
  async *stream(_req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    const round = this.rounds[this.cursor]
    this.cursor += 1
    yield { type: 'message_start' }
    if (round === undefined) throw new Error('脚本耗尽')
    if (round.tool !== undefined) {
      yield { type: 'tool_call_delta', index: 0, id: round.tool.id, name: round.tool.name, argsFragment: round.tool.args }
      yield { type: 'finish', reason: 'tool_use' }
      return
    }
    yield { type: 'text_delta', text: round.text ?? '' }
    yield { type: 'finish', reason: 'stop' }
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
  const chat = createChat(store, bus, { title: 's27', now: NOW })
  if (!chat.ok) throw new Error(`建 chat 失败: ${JSON.stringify(chat)}`)
  const msg = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: userContent, now: NOW })
  if (!msg.ok) throw new Error(`建消息失败: ${JSON.stringify(msg)}`)
  return chat.value.id
}

/** 只读工具(§50 sideEffectLevel=idempotent:重试/重执行安全) */
const QUERY_TOOL: ToolDefinition = {
  id: 't_query',
  name: 'query_state',
  description: '读状态',
  inputSchema: {},
  permissions: [],
  sideEffectLevel: 'idempotent',
  async execute() {
    return { toolCallId: '', status: 'success' as const, output: { value: 42 } }
  },
}

function makeRegistry(store: WhisperTavernDb, bus: EventBus): ToolRegistry {
  const registry = new ToolRegistry({ store, bus, persistApprovalAudit: () => undefined })
  registry.register(QUERY_TOOL)
  return registry
}

const rid = (r: Awaited<ReturnType<typeof runAgent>>): import('@whispertavern/contracts').RunId => {
  if (!r.ok) throw new Error(r.error.message)
  return r.value.runId
}

const serializedPartsOfRun = (store: WhisperTavernDb, runId: string): unknown[] => {
  const rows = store.sqlite.prepare(`SELECT serialized FROM prompt_snapshots WHERE run_id = ? ORDER BY created_at`).all(runId) as { serialized: string }[]
  return rows.map((r) => (JSON.parse(r.serialized) as { parts: unknown[] }).parts)
}

describe('S27 §174 Test 5 — Resume(Turn3 暂停 → 重启 → 续跑)', () => {
  it('Turn1/2 完成、Turn3 暂停;Resume 后 Turn3 续跑至 Final', async () => {
    const store = makeStore()
    const bus = new EventBus(createSqliteEventSink(store))
    try {
      const chatId = makeChat(store, bus, '连续跑三轮')
      const def = createAgentDefinition(store, { name: 'x', type: 'tool-agent', instructions: 'y', now: NOW })
      const registry = makeRegistry(store, bus)
      const adapter = new ScriptedAdapter([
        { tool: { id: 'c1', name: 'query_state', args: '{}' } },
        { tool: { id: 'c2', name: 'query_state', args: '{}' } },
        { text: '第三轮 Final' },
      ])
      // 暂停令牌:前两轮放行,第 3 轮模型调用前请求暂停
      const pauseToken = { isPauseRequested: (): boolean => adapter.executedRounds >= 2 }

      const first = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry },
        { chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', pauseToken, now: NOW },
      )
      expect(first.ok).toBe(true)
      expect(first.ok && first.value.status).toBe('paused')
      const runA = rid(first)
      const pausedRow = store.sqlite.prepare(`SELECT status, last_heartbeat_at FROM runs WHERE id = ?`).get(runA) as { status: string; last_heartbeat_at: string | null }
      expect(pausedRow.status).toBe('paused')
      expect(pausedRow.last_heartbeat_at).not.toBeNull()
      // §53/§54:before_pause 检查点在账
      const checkpoints = store.sqlite.prepare(`SELECT reason FROM runtime_checkpoints WHERE run_id = ? ORDER BY created_at`).all(runA) as { reason: string }[]
      expect(checkpoints.map((c) => c.reason)).toContain('before_pause')
      expect(checkpoints.map((c) => c.reason)).toContain('after_tool')

      // —— §55:不兼容模型默认拒绝 ——
      const incompatible = await resumeRun(
        { store, bus, snapshots: new SnapshotRegistry(), registry },
        { runId: runA, chatId, agentId: def.id, adapter: new ScriptedAdapter([{ text: 'x' }]), providerId: 'fake', model: 'other-model', now: NOW },
      )
      expect(incompatible.ok).toBe(false)
      expect(!incompatible.ok && incompatible.error.code).toBe('RESUME_INCOMPATIBLE')

      // —— 重启 = 同库新进程;Resume 续跑(前两轮产物在树里,不重执行)——
      const resumed = await resumeRun(
        { store, bus, snapshots: new SnapshotRegistry(), registry },
        { runId: runA, chatId, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(resumed.ok).toBe(true)
      expect(resumed.ok && resumed.value.status).toBe('succeeded')
      const finalRow = store.sqlite.prepare(`SELECT status, attempt FROM runs WHERE id = ?`).get(runA) as { status: string; attempt: number }
      expect(finalRow.status).toBe('succeeded')
      expect(finalRow.attempt).toBe(2) // Resume = 新 Attempt(§4.2),不是重开 Run(§12)
      // 最终消息已入树(role=character,§74 缺省 policy)
      const finalMsg = store.sqlite.prepare(`SELECT content FROM messages WHERE role = 'character' ORDER BY sequence DESC LIMIT 1`).get() as { content: string }
      expect(finalMsg.content).toBe('第三轮 Final')
      // 只发了 3 轮模型调用(Turn1/2 未重执行)
      expect(adapter.executedRounds).toBe(3)
    } finally {
      store.close()
    }
  })
})

describe('S27 §174 Test 6 — Crash Recovery(running → interrupted → recover)', () => {
  it('Zombie 清零 + planRecovery → resume 续跑;非幂等未决阻塞对账', async () => {
    const store = makeStore()
    const bus = new EventBus(createSqliteEventSink(store))
    try {
      const chatId = makeChat(store, bus, '崩溃恢复')
      const def = createAgentDefinition(store, { name: 'x', type: 'tool-agent', instructions: 'y', now: NOW })
      const registry = makeRegistry(store, bus)

      // 模拟崩溃现场:run 停在 running、heartbeat 停在 NOW(此后进程死亡)
      const crashedRunId = createExecutionRun(store, { chatId, agentId: def.id, agentVersion: def.version, provider: 'fake', model: 'fake-model', now: NOW })
      transitionRun(store, crashedRunId, 'running', { now: NOW })
      recordCheckpoint(store, { runId: crashedRunId, turnIndex: 1, reason: 'before_provider', stateHash: 'bp:1', now: NOW })
      // 非幂等未决工具(崩溃时正在执行)
      store.sqlite
        .prepare(`INSERT INTO tool_calls (id, run_id, tool_name, arguments, status, started_at) VALUES ('tc_x', ?, 'send_webhook', '{}', 'running', ?)`)
        .run(crashedRunId, NOW)

      // —— §96/§97:Recovery 扫描(超 30 分钟无心跳)→ interrupted;Zombie 清零 ——
      const scan = scanInterruptedRuns(store, bus, { now: '2026-09-27T11:00:00.000Z', recoveryTimeoutMs: 30 * 60_000 })
      expect(scan.interruptedRunIds).toContain(crashedRunId)
      const zombie = store.sqlite.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('running','waiting')`).get() as { n: number }
      expect(zombie.n).toBe(0) // §97:崩溃后不产生永久 Zombie Run(§173 Recovery 组)

      // —— §96 裁决:非幂等未决 → fail(需对账);reconcile 阻塞 → allow 后放行 ——
      const blockedPlan = planRecovery(store, crashedRunId)
      expect(blockedPlan.action).toBe('fail')
      expect(blockedPlan.reason).toContain('NON_IDEMPOTENT')
      const blockedRecon = reconcileToolCalls(store, { runId: crashedRunId, now: NOW })
      expect(blockedRecon.ok).toBe(false)
      expect(blockedRecon.blocked.map((b) => b.toolName)).toEqual(['send_webhook'])
      const allowedRecon = reconcileToolCalls(store, { runId: crashedRunId, now: NOW, allowNonIdempotent: true })
      expect(allowedRecon.ok).toBe(true)
      expect(allowedRecon.reconciled).toEqual(['tc_x'])

      // 对账放行后:planRecovery → resume → Resume 续跑至 Final
      const plan = planRecovery(store, crashedRunId)
      expect(plan.action).toBe('resume')
      const recovered = await resumeRun(
        { store, bus, snapshots: new SnapshotRegistry(), registry },
        { runId: crashedRunId, chatId, agentId: def.id, adapter: new ScriptedAdapter([{ text: '恢复完成' }]), providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(recovered.ok).toBe(true)
      expect(recovered.ok && recovered.value.status).toBe('succeeded')
      const row = store.sqlite.prepare(`SELECT status FROM runs WHERE id = ?`).get(crashedRunId) as { status: string }
      expect(row.status).toBe('succeeded')
    } finally {
      store.close()
    }
  })

  it('幂等未决工具 → 重执行安全(planRecovery=resume + orphaned 标记)', () => {
    const store = makeStore()
    try {
      const chatId = makeChat(store, new EventBus(createSqliteEventSink(store)), '幂等')
      const runId = createExecutionRun(store, { chatId, now: NOW })
      transitionRun(store, runId, 'running', { now: NOW })
      recordCheckpoint(store, { runId, turnIndex: 1, reason: 'before_provider', stateHash: 'bp:1', now: NOW })
      store.sqlite
        .prepare(`INSERT INTO tool_calls (id, run_id, tool_name, arguments, status, started_at) VALUES ('tc_q', ?, 'query_state', '{}', 'running', ?)`)
        .run(runId, NOW)
      // 重启后工具注册表未就绪 → 调用方显式给幂等分类(§50;未知 = non_idempotent 保守)
      const plan = planRecovery(store, runId, { toolSideEffects: { query_state: 'idempotent' } })
      expect(plan.action).toBe('resume')
      expect(plan.reason).toContain('幂等')
      const recon = reconcileToolCalls(store, { runId, now: NOW, toolSideEffects: { query_state: 'idempotent' } })
      expect(recon.ok).toBe(true)
      expect(recon.retried).toEqual(['tc_q'])
      const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE id = 'tc_q'`).get() as { status: string }
      expect(row.status).toBe('orphaned')
    } finally {
      store.close()
    }
  })
})

describe('S27 §174 Test 10 — Deterministic Replay(X14 逐字节一致)', () => {
  const decideOfRun = (store: WhisperTavernDb, runId: string): { tools: string[]; final: string } => {
    const tools = (store.sqlite.prepare(`SELECT tool_name FROM tool_calls WHERE run_id = ? ORDER BY started_at`).all(runId) as { tool_name: string }[]).map((r) => r.tool_name)
    const final = (store.sqlite.prepare(`SELECT content FROM messages WHERE role = 'character' ORDER BY sequence DESC LIMIT 1`).get() as { content: string } | undefined)?.content ?? ''
    return { tools, final }
  }

  it('同种子/时钟/脚本两次执行:决策一致 + 快照 serialized 逐字节一致', async () => {
    const store = makeStore()
    const bus = new EventBus(createSqliteEventSink(store))
    try {
      const def = createAgentDefinition(store, { name: 'x', type: 'tool-agent', instructions: 'y', now: NOW })
      const registry = makeRegistry(store, bus)
      const runOnce = async (): Promise<string> => {
        const chatId = makeChat(store, bus, '确定性回放')
        const res = await runAgent(
          { store, bus, snapshots: new SnapshotRegistry(), registry },
          { chatId, agentId: def.id, adapter: new ScriptedAdapter([{ tool: { id: 'c1', name: 'query_state', args: '{}' } }, { text: '终稿' }]), providerId: 'fake', model: 'fake-model', now: NOW },
        )
        if (!res.ok) throw new Error(res.error.message)
        return res.value.runId
      }
      const runA = await runOnce()
      const runB = await runOnce()
      expect(decideOfRun(store, runA)).toEqual(decideOfRun(store, runB))
      // X14:所有轮次的 serialized.parts 逐字节一致(两轮数、每轮内容)
      const partsA = serializedPartsOfRun(store, runA)
      const partsB = serializedPartsOfRun(store, runB)
      expect(partsA.length).toBe(partsB.length)
      expect(JSON.stringify(partsA)).toBe(JSON.stringify(partsB))
    } finally {
      store.close()
    }
  })

  it('Replay 模式:ReplayAdapter 回放录制响应 + 工具读录制结果,决策与序列化同源一致', async () => {
    const store = makeStore()
    const bus = new EventBus(createSqliteEventSink(store))
    try {
      const def = createAgentDefinition(store, { name: 'x', type: 'tool-agent', instructions: 'y', now: NOW })
      const registry = makeRegistry(store, bus)
      // —— 源 Run:live 两轮(工具 + Final)——
      const chatA = makeChat(store, bus, '录制源')
      const srcAdapter = new ScriptedAdapter([{ tool: { id: 'c1', name: 'query_state', args: '{"q":1}' } }, { text: '录制终稿' }])
      const src = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry },
        { chatId: chatA, agentId: def.id, adapter: srcAdapter, providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(src.ok).toBe(true)
      const sourceRunId = rid(src)

      // —— Replay Run:ReplayAdapter(§144)+ 工具读录制(§145),无真实执行 ——
      // 与源 Run 相同的用户输入(回放 = 同输入重执行;chat id 只进段 id,不进 parts)
      const chatB = makeChat(store, bus, '录制源')
      const replay = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry },
        { chatId: chatB, agentId: def.id, adapter: new ReplayAdapter(store, sourceRunId), providerId: 'fake', model: 'fake-model', mode: 'replay', replaySourceRunId: sourceRunId, now: NOW },
      )
      expect(replay.ok).toBe(true)
      // 决策一致(§143):Final 文本相同;工具决策经 serialized 逐字节断言(下行)承载——
      // 回放 Run 不写 tool_calls 行(§145 工具从未执行),决策面在快照序列化里
      expect(decideOfRun(store, rid(replay)).final).toBe(decideOfRun(store, sourceRunId).final)
      // §146:Replay 模式不写新 tool_calls 行(工具从未执行)
      const replayToolRows = store.sqlite.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ?`).get(rid(replay)) as { n: number }
      expect(replayToolRows.n).toBe(0)
      // X14:重放轮的 serialized.parts 与源 Run 逐字节一致
      const partsSrc = serializedPartsOfRun(store, sourceRunId)
      const partsReplay = serializedPartsOfRun(store, rid(replay))
      expect(partsReplay.length).toBe(partsSrc.length)
      expect(JSON.stringify(partsReplay)).toBe(JSON.stringify(partsSrc))
    } finally {
      store.close()
    }
  })
})
