/**
 * S25(WP3.3)验收:§174 Test 7(并行 Workflow:B/C/D 并行,E 等全部完成)+
 * §69 失败策略 / §66 条件 / §65 Tool 节点 / §112+§113 环与上限 / §110+§111 Resume /
 * §80–§82 Director 结构化输出与修复 / §172 Writer/Checker(真实 runAgent)/
 * R-P3-2 单聊快速路径零额外模型调用。
 */
import { describe, expect, it } from 'vitest'
import type { ChatId, ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import { EventBus, SnapshotRegistry, createDatabase, createMessage, createChat, createSqliteEventSink } from '@whispertavern/runtime'
import { WorkflowEngine, WorkflowValidationError, type WorkflowNodeExecutors } from './engine'
import { ConditionSyntaxError } from './condition'
import type { ToolDefinition } from '../tools/types'
import { ToolRegistry } from '../tools/registry'
import { BudgetTracker } from '../tools/budget'
import { runAgent } from '../runtime/run-agent'
import { createAgentDefinition } from '../runtime/definition'

const NOW = '2026-09-26T14:00:00.000Z'

function makeDeps() {
  const store = createDatabase(':memory:')
  const bus = new EventBus(createSqliteEventSink(store))
  return { store, bus }
}

describe('§174 Test 7 — 并行 Workflow(A→B/C/D 并行→E join)', () => {
  it('B/C/D 并发执行,E 等全部完成后汇聚三分支输出', async () => {
    const { store, bus } = makeDeps()
    try {
      const execLog: string[] = []
      const executors: WorkflowNodeExecutors = {
        agent: async (node) => {
          execLog.push(`start:${node.id}`)
          await new Promise((r) => setTimeout(r, 10))
          execLog.push(`done:${node.id}`)
          return { text: `${node.id} 的产出` }
        },
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_test7',
        version: 1,
        nodes: [
          { id: 'A', type: 'agent' as const, agentId: 'a' },
          { id: 'B', type: 'agent' as const, agentId: 'b' },
          { id: 'C', type: 'agent' as const, agentId: 'c' },
          { id: 'D', type: 'agent' as const, agentId: 'd' },
          { id: 'E', type: 'parallel' as const },
        ],
        edges: [
          { from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'A', to: 'D' },
          { from: 'B', to: 'E' }, { from: 'C', to: 'E' }, { from: 'D', to: 'E' },
        ],
      }
      const result = await engine.run(def, { variables: { input: ' kickoff' }, now: NOW })
      expect(result.status).toBe('succeeded')
      // E 等全部完成:三分支输出都进了 E 的汇聚输入
      expect(result.outputs['E']).toHaveLength(3)
      expect(result.outputs['E']).toEqual([
        { text: 'B 的产出' }, { text: 'C 的产出' }, { text: 'D 的产出' },
      ])
      // B/C/D 的 start 都在 A done 之后(并发波次);E 是 join barrier,不调执行器
      const aDone = execLog.indexOf('done:A')
      for (const id of ['B', 'C', 'D']) {
        expect(execLog.indexOf(`start:${id}`)).toBeGreaterThan(aDone)
        expect(execLog.indexOf(`done:${id}`)).toBeLessThan(execLog.length)
      }
      expect(execLog.filter((l) => l.startsWith('start:')).sort()).toEqual(['start:A', 'start:B', 'start:C', 'start:D'])
      // workflow 事件落库(durable)
      const types = (store.sqlite.prepare(`SELECT event_type FROM events WHERE event_type LIKE 'workflow.%' ORDER BY created_at`).all() as { event_type: string }[]).map((r) => r.event_type)
      expect(types[0]).toBe('workflow.started')
      expect(types.at(-1)).toBe('workflow.completed')
    } finally {
      store.close()
    }
  })
})

describe('§69 并行失败策略', () => {
  const failingDef = () => ({
    id: 'wf_fail',
    version: 1,
    nodes: [
      { id: 'A', type: 'agent' as const, agentId: 'a' },
      { id: 'B', type: 'agent' as const, agentId: 'b' },
      { id: 'F', type: 'agent' as const, agentId: 'f' },
      { id: 'J', type: 'parallel' as const },
    ],
    edges: [
      { from: 'A', to: 'B' }, { from: 'A', to: 'F' },
      { from: 'B', to: 'J' }, { from: 'F', to: 'J' },
    ],
  })

  it('fail_fast:分支失败 → Workflow failed(已完成节点保留在账本,§111)', async () => {
    const { store, bus } = makeDeps()
    try {
      const executors: WorkflowNodeExecutors = {
        agent: async (node) => {
          if (node.id === 'F') throw new Error('F 爆了')
          return { text: node.id }
        },
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const result = await engine.run(failingDef(), { now: NOW, parallelFailurePolicy: 'fail_fast' })
      expect(result.status).toBe('failed')
      expect(result.error).toContain('F 爆了')
      expect(result.ledger.completed['A']).toBeDefined()
      expect(result.ledger.completed['B']).toBeDefined()
      expect(result.ledger.failed['F']).toBeDefined()
    } finally {
      store.close()
    }
  })

  it('best_effort:失败记账后继续,join 仍完成', async () => {
    const { store, bus } = makeDeps()
    try {
      const executors: WorkflowNodeExecutors = {
        agent: async (node) => {
          if (node.id === 'F') throw new Error('F 爆了')
          return { text: node.id }
        },
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const result = await engine.run(failingDef(), { now: NOW, parallelFailurePolicy: 'best_effort' })
      // best_effort:J 的入边条件满足但 F 无完成输出 → J 汇聚 [B 的输出, undefined]
      expect(result.status).toBe('succeeded')
      expect(result.ledger.failed['F']).toBeDefined()
      expect(result.outputs['J']).toEqual([{ text: 'B' }, undefined])
    } finally {
      store.close()
    }
  })
})

describe('§66 条件节点 + §67 边条件(受限 DSL)', () => {
  it('分支路由:变量满足哪支走哪支(另一支不执行)', async () => {
    const { store, bus } = makeDeps()
    try {
      const ran: string[] = []
      const executors: WorkflowNodeExecutors = {
        agent: async (node) => {
          ran.push(node.id)
          return { text: node.id }
        },
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_cond',
        version: 1,
        nodes: [
          { id: 'gate', type: 'condition' as const, expression: { op: '==' as const, left: 'mood', right: 'good' }, branches: [{ condition: 'mood == good', nextNode: 'happy' }, { condition: 'mood != good', nextNode: 'sad' }] },
          { id: 'happy', type: 'agent' as const, agentId: 'h' },
          { id: 'sad', type: 'agent' as const, agentId: 's' },
        ],
        edges: [],
      }
      const result = await engine.run(def, { variables: { mood: 'good' }, now: NOW })
      expect(result.status).toBe('succeeded')
      expect(ran).toEqual(['happy'])
      // mood='meh' → 'mood != good' 分支为真 → 走 sad(正常路由,非不可达)
      const alt = await engine.run(def, { variables: { mood: 'meh' }, now: NOW })
      expect(alt.status).toBe('succeeded')
      expect(alt.outputs['sad']).toEqual({ text: 'sad' })
      expect(alt.outputs['happy']).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('DSL 词法安全:and/or 混用与不可解析字面量直接拒绝(§66 禁任意 JS)', () => {
    const { store, bus } = makeDeps()
    try {
      const engine = new WorkflowEngine({ bus, executors: { agent: async () => ({}), tool: async () => undefined }, clock: () => NOW })
      const base = { id: 'wf_bad', version: 1, nodes: [{ id: 'x', type: 'agent' as const, agentId: 'x' }], edges: [] }
      // and/or 混用无优先级语义 → 拒绝解析
      expect(() => engine.validate({ ...base, edges: [{ from: 'x', to: 'x', condition: 'a == 1 and b == 2 or c == 3' }] })).toThrow(ConditionSyntaxError)
      // 带括号/调用形态的字面量不可解析 → 拒绝(不存在任何 eval 路径)
      expect(() => engine.validate({ ...base, edges: [{ from: 'x', to: 'x', condition: 'a == process.exit()' }] })).toThrow(ConditionSyntaxError)
    } finally {
      store.close()
    }
  })
})

describe('§65 Tool 节点(委托 Registry 语义)+ §70 变量通信', () => {
  it('inputMapping 解析 $var 引用,输出经 outputMapping 写回变量', async () => {
    const { store, bus } = makeDeps()
    try {
      const seen: unknown[] = []
      const executors: WorkflowNodeExecutors = {
        agent: async (node) => ({ text: node.id }),
        tool: async (_node, input) => {
          seen.push(input)
          return { temperature: 22 }
        },
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_tool',
        version: 1,
        nodes: [
          { id: 'fetch', type: 'tool' as const, toolId: 'get_weather', inputMapping: { city: '$var.city' }, outputMapping: { temperature: '$var.weather' } },
        ],
        edges: [],
      }
      const result = await engine.run(def, { variables: { city: '北京' }, now: NOW })
      expect(result.status).toBe('succeeded')
      expect(seen[0]).toEqual({ city: '北京' })
      expect(result.variables['weather']).toBe(22)
    } finally {
      store.close()
    }
  })
})

describe('§110/§111 Resume(已完成节点不重执行,失败处续跑)', () => {
  it('首轮 C 失败;Resume 后 A/B 跳过、C 重试成功', async () => {
    const { store, bus } = makeDeps()
    try {
      const calls: string[] = []
      let cShouldFail = true
      const executors: WorkflowNodeExecutors = {
        agent: async (node) => {
          calls.push(node.id)
          if (node.id === 'C' && cShouldFail) throw new Error('C 暂时失败')
          return { text: node.id }
        },
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_resume',
        version: 1,
        nodes: [
          { id: 'A', type: 'agent' as const, agentId: 'a' },
          { id: 'B', type: 'agent' as const, agentId: 'b' },
          { id: 'C', type: 'agent' as const, agentId: 'c' },
        ],
        edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
      }
      const first = await engine.run(def, { now: NOW })
      expect(first.status).toBe('failed')
      expect(first.ledger.completed['A']).toBeDefined()
      expect(first.ledger.completed['B']).toBeDefined()

      cShouldFail = false
      const callsBeforeResume = calls.length
      const second = await engine.run(def, { now: NOW, resumeLedger: first.ledger })
      expect(second.status).toBe('succeeded')
      // §110:A/B 已完成 → 不重执行(本轮 calls 只新增 C)
      expect(calls.slice(callsBeforeResume)).toEqual(['C'])
      expect(second.ledger.completed['C']).toEqual({ text: 'C' })
    } finally {
      store.close()
    }
  })
})

describe('§112/§113 环与上限', () => {
  it('回边无 LoopPolicy → 校验拒绝(§112 只允许有界环)', () => {
    const { store, bus } = makeDeps()
    try {
      const engine = new WorkflowEngine({ bus, executors: { agent: async () => ({}), tool: async () => undefined }, clock: () => NOW })
      const def = {
        id: 'wf_cycle',
        version: 1,
        nodes: [
          { id: 'W', type: 'agent' as const, agentId: 'w' },
          { id: 'K', type: 'agent' as const, agentId: 'k' },
        ],
        edges: [{ from: 'W', to: 'K' }, { from: 'K', to: 'W' }],
      }
      expect(() => engine.validate(def)).toThrow(WorkflowValidationError)
    } finally {
      store.close()
    }
  })

  it('有 LoopPolicy 的环:迭代受 maxIterations 封顶,超限 WorkflowLoopExceeded', async () => {
    const { store, bus } = makeDeps()
    try {
      const executors: WorkflowNodeExecutors = {
        agent: async () => ({ text: 'x' }),
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_loop',
        version: 1,
        nodes: [
          { id: 'W', type: 'agent' as const, agentId: 'w' },
          { id: 'K', type: 'agent' as const, agentId: 'k' },
        ],
        edges: [{ from: 'W', to: 'K' }, { from: 'K', to: 'W', condition: 'keepGoing == true' }],
        loopPolicy: { maxIterations: 2, maxTotalRuns: 100, maxExecutionTimeMs: 10_000 },
      }
      const result = await engine.run(def, { variables: { keepGoing: true }, now: NOW })
      // 超限在波内被 §69 归一 → Workflow failed(错误信息携带 maxIterations)
      expect(result.status).toBe('failed')
      expect(result.error).toContain('maxIterations=2')
    } finally {
      store.close()
    }
  })

  it('回边条件为假 → 不迭代,正常收敛', async () => {
    const { store, bus } = makeDeps()
    try {
      let calls = 0
      const executors: WorkflowNodeExecutors = {
        agent: async () => {
          calls += 1
          return { text: 'x' }
        },
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_loop2',
        version: 1,
        nodes: [
          { id: 'W', type: 'agent' as const, agentId: 'w' },
          { id: 'K', type: 'agent' as const, agentId: 'k' },
        ],
        edges: [{ from: 'W', to: 'K' }, { from: 'K', to: 'W', condition: 'keepGoing == true' }],
        loopPolicy: { maxIterations: 3, maxTotalRuns: 100, maxExecutionTimeMs: 10_000 },
      }
      const result = await engine.run(def, { variables: { keepGoing: false }, now: NOW })
      expect(result.status).toBe('succeeded')
      expect(calls).toBe(2)
    } finally {
      store.close()
    }
  })
})

describe('§80/§81/§82 Director:结构化输出 + Repair', () => {
  it('输出非法 JSON → Repair 再调一次 → 决策写入变量;条件边按 nextAgent 路由(不解析自然语言)', async () => {
    const { store, bus } = makeDeps()
    try {
      const raw: string[] = []
      const executors: WorkflowNodeExecutors = {
        agent: async (node, input) => {
          void node
          const repair = (input as { repair?: boolean } | undefined)?.repair === true
          const payload = repair ? { nextAgent: 'editor', reason: '草稿需润色' } : '我觉得该让编辑说话了'
          const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
          raw.push(text)
          return { text }
        },
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_dir',
        version: 1,
        nodes: [
          { id: 'dir', type: 'agent' as const, agentId: 'director', structuredOutputPolicy: { schema: {}, strict: true, repairAttempts: 1 }, dispatch: true },
          { id: 'editor', type: 'agent' as const, agentId: 'e' },
          { id: 'other', type: 'agent' as const, agentId: 'o' },
        ],
        edges: [
          { from: 'dir', to: 'editor', condition: 'decision.dir.nextAgent == \'editor\'' },
          { from: 'dir', to: 'other', condition: 'decision.dir.nextAgent != \'editor\'' },
        ],
      }
      const result = await engine.run(def, { variables: {}, now: NOW })
      expect(result.status).toBe('succeeded')
      // 3 次 = dir 初次 + dir Repair(§82) + editor 节点(共用执行器);dir 自己只调了 2 次
      expect(raw).toHaveLength(3)
      expect(raw[0]).toBe('我觉得该让编辑说话了')
      expect(raw[1]).toBe('{"nextAgent":"editor","reason":"草稿需润色"}')
      expect((result.variables['decision.dir'] as { nextAgent: string }).nextAgent).toBe('editor')
      // §80:路由 = 结构化字段 + 条件边;editor 执行,other 不执行
      expect(result.outputs['editor']).toBeDefined()
      expect(result.outputs['other']).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('repairAttempts 耗尽仍非法 → 节点失败(§82 预算封顶)', async () => {
    const { store, bus } = makeDeps()
    try {
      const executors: WorkflowNodeExecutors = {
        agent: async () => ({ text: '不是 JSON' }),
        tool: async () => undefined,
      }
      const engine = new WorkflowEngine({ bus, executors, clock: () => NOW })
      const def = {
        id: 'wf_dir2',
        version: 1,
        nodes: [{ id: 'dir', type: 'agent' as const, agentId: 'd', structuredOutputPolicy: { schema: {}, strict: true, repairAttempts: 2 } }],
        edges: [],
      }
      const result = await engine.run(def, { now: NOW })
      expect(result.status).toBe('failed')
      expect(result.error).toContain('repairAttempts=2')
    } finally {
      store.close()
    }
  })
})

describe('§172 Writer/Checker Workflow(真实 runAgent)+ R-P3-2 单聊快速路径', () => {
  class ScriptedAdapter implements ProviderAdapter {
    readonly providerId = 'fake'
    constructor(private readonly text: string) {}
    capabilities(_m: string): ProviderCapabilities {
      return { systemRole: true, tools: false, vision: false, reasoning: false, streaming: true, promptCaching: false, cacheType: 'none', maxContextTokens: 131_072, maxOutputTokens: 4096, structuredOutput: 'none', parallelToolCalls: false, toolChoice: false }
    }
    async *stream(_req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'message_start' }
      yield { type: 'text_delta', text: this.text }
      yield { type: 'usage', usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 10, source: 'reported' } }
      yield { type: 'finish', reason: 'stop' }
    }
  }

  it('Writer → Checker(pass)→ Output;Agent 节点委托真实 runAgent,产物经变量通信(§70)', async () => {
    const store = createDatabase(':memory:')
    try {
      store.sqlite.prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake','fake','fake','{}','{}',?,?)`).run(NOW, NOW)
      const bus = new EventBus(createSqliteEventSink(store))
      const mkAgent = async (name: string) => {
        const def = createAgentDefinition(store, { name, type: 'writer', instructions: name, now: NOW })
        const chat = createChat(store, bus, { title: name, now: NOW })
        if (!chat.ok) throw new Error('chat')
        await createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '请开始', now: NOW })
        return { agentId: def.id, chatId: chat.value.id as string }
      }
      const writer = await mkAgent('Writer')
      const checker = await mkAgent('Checker')
      const adapters = new Map<string, ProviderAdapter>([
        [writer.agentId, new ScriptedAdapter('初稿正文')],
        [checker.agentId, new ScriptedAdapter('{"decision":"pass","reason":"无问题"}')],
      ])

      // —— 真实 runAgent 作为 agent 执行器(§64 落地)——
      const registry = new ToolRegistry({ store, bus, persistApprovalAudit: () => undefined })
      const agentExecutor = async (node: { agentId: string; agentVersion?: number; chatId?: string }) => {
        const adapter = adapters.get(node.agentId)
        if (adapter === undefined || node.chatId === undefined) throw new Error(`节点缺 adapter/chatId: ${node.agentId}`)
        const res = await runAgent({ store, bus, snapshots: new SnapshotRegistry(), registry, clock: () => NOW }, {
          chatId: node.chatId as ChatId,
          agentId: node.agentId as never,
          adapter,
          providerId: 'fake',
          model: 'fake-model',
          now: NOW,
        })
        if (!res.ok) throw new Error(res.error.message)
        // §70:Agent 的产出 = 本 chat 最新 character 消息(不碰另一 Agent 的内部状态)
        const row = store.sqlite.prepare<[string]>(`SELECT content FROM messages WHERE chat_id = ? AND role = 'character' ORDER BY sequence DESC LIMIT 1`).get(node.chatId)
        return { text: row?.content ?? '' }
      }

      // Checker 的输出是 JSON 文本 → 解析为对象,供 outputMapping 取键 + 条件边等值比较
      const checkerExecutor = async (node: { agentId: string; agentVersion?: number; chatId?: string }) => {
        const out = (await agentExecutor(node)) as { text: string }
        return { decision: (JSON.parse(out.text) as { decision: string }).decision, text: out.text }
      }

      const def = {
        id: 'wf_172',
        version: 1,
        nodes: [
          { id: 'writer', type: 'agent' as const, agentId: writer.agentId, chatId: writer.chatId, outputMapping: { text: '$var.draft' } },
          { id: 'checker', type: 'agent' as const, agentId: checker.agentId, chatId: checker.chatId, outputMapping: { decision: '$var.verdict' } },
          { id: 'out', type: 'parallel' as const },
        ],
        edges: [{ from: 'writer', to: 'checker' }, { from: 'checker', to: 'out', condition: 'verdict == pass' }],
      }
      const engine = new WorkflowEngine({
        bus,
        executors: {
          agent: async (node) => (node.id === 'checker' ? checkerExecutor(node as unknown as { agentId: string; chatId?: string }) : agentExecutor(node as unknown as { agentId: string; chatId?: string })),
          tool: async () => undefined,
        },
        clock: () => NOW,
      })
      const result = await engine.run(def, { now: NOW })
      expect(result.status).toBe('succeeded')
      expect(result.variables['draft']).toBe('初稿正文')
      expect(result.variables['verdict']).toBe('pass')
      expect(result.outputs['out']).toEqual([{ decision: 'pass', text: '{"decision":"pass","reason":"无问题"}' }])
    } finally {
      store.close()
    }
  })

  it('R-P3-2 单聊快速路径:不经 Director,模型调用恰好一次', async () => {
    const store = createDatabase(':memory:')
    try {
      store.sqlite.prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake','fake','fake','{}','{}',?,?)`).run(NOW, NOW)
      const bus = new EventBus(createSqliteEventSink(store))
      const def = createAgentDefinition(store, { name: '单聊', type: 'character', instructions: 'x', now: NOW })
      const chat = createChat(store, bus, { title: 't', now: NOW })
      if (!chat.ok) throw new Error('chat')
      await createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: 'hi', now: NOW })
      let modelCalls = 0
      const adapter: ProviderAdapter = {
        providerId: 'fake',
        capabilities: () => ({ systemRole: true, tools: false, vision: false, reasoning: false, streaming: true, promptCaching: false, cacheType: 'none', maxContextTokens: 131_072, maxOutputTokens: 4096, structuredOutput: 'none', parallelToolCalls: false, toolChoice: false }),
        stream: async function* () {
          modelCalls += 1
          yield { type: 'message_start' }
          yield { type: 'text_delta', text: '直接回复' }
          yield { type: 'finish', reason: 'stop' }
        },
      }
      const res = await runAgent({ store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW }, { chatId: chat.value.id, agentId: def.id, adapter, providerId: 'fake', model: 'fake-model', now: NOW })
      expect(res.ok).toBe(true)
      expect(modelCalls).toBe(1) // 单聊路径零额外模型调用(Director 不参与)
    } finally {
      store.close()
    }
  })
})

describe('§65 补充:Tool 节点委托真实 ToolRegistry(五段流水线)', () => {
  it('ToolNode 经 registry.executeOne → 权限/落账/事件全链路', async () => {
    const store = createDatabase(':memory:')
    try {
      store.sqlite.prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake','fake','fake','{}','{}',?,?)`).run(NOW, NOW)
      const bus = new EventBus(createSqliteEventSink(store))
      const tool: ToolDefinition = {
        id: 't', name: 'echo_tool', description: 'echo', inputSchema: {}, permissions: [],
        async execute(input) { return { toolCallId: '', status: 'success', output: { echoed: input } } },
      }
      const registry = new ToolRegistry({ store, bus, persistApprovalAudit: () => undefined })
      registry.register(tool)
      const engine = new WorkflowEngine({
        bus,
        executors: {
          agent: async () => ({}),
          tool: async (node, input) => {
            const call = { id: `tc_${node.id}`, name: node.toolId, arguments: JSON.stringify(input) }
            const budget = new BudgetTracker({ maxTurns: 1, maxToolCalls: 9 })
            const toolCtx = {
              runId: `wf_${node.id}`,
              agentId: 'workflow',
              chatId: 'workflow',
              permissions: new Set(['chat.read']),
              cancellationToken: { isCancelled: () => false, onCancel: () => undefined },
              budgetTracker: budget,
            }
            return registry.executeOne(call, toolCtx)
          },
        },
        clock: () => NOW,
      })
      const def = {
        id: 'wf_toolreg',
        version: 1,
        nodes: [{ id: 'echo', type: 'tool' as const, toolId: 'echo_tool', inputMapping: { city: '$var.city' } }],
        edges: [],
      }
      const result = await engine.run(def, { variables: { city: '上海' }, now: NOW })
      expect(result.status).toBe('succeeded')
      const out = result.outputs['echo'] as { output?: { echoed?: { city?: string } } }
      expect(out.output?.echoed?.city).toBe('上海')
      const row = store.sqlite.prepare(`SELECT status FROM tool_calls WHERE tool_name = 'echo_tool'`).get() as { status: string }
      expect(row.status).toBe('success')
    } finally {
      store.close()
    }
  })
})
