/**
 * S26(WP3.4)验收:agent-runtime-spec §18–§22(Context Policy 族)/ §71–§72(Artifact +
 * 冻结,C2 缓存纪律)/ §73–§75(Output Commit)/ §104–§106(工具后重编译 + 缓存交互)/
 * §107–§109(State Mutation 显式事务 + StatePatch + VERSION_CONFLICT)。
 */
import { describe, expect, it } from 'vitest'
import type { ChatId, PromptContribution, ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import type { PromptSnapshot } from '@whispertavern/contracts'
import { EventBus, SnapshotRegistry, createDatabase, createMessage, createChat, createSqliteEventSink, type WhisperTavernDb } from '@whispertavern/runtime'
import { compile, diffSnapshots } from '@whispertavern/core'
import {
  DEFAULT_CONTEXT_POLICY,
  resolveContextByPolicy,
  resolveMemoryItems,
  type ContextPolicy,
} from '../index'
import { createArtifact, freezeArtifact, updateArtifactContent, artifactContributions, ArtifactError, listChatArtifacts } from '../index'
import { commitOutput, OutputCommitError } from '../index'
import { applyStatePatches, readAgentState } from '../index'
import { ToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../tools/types'
import { createAgentDefinition } from '../runtime/definition'
import { runAgent } from '../runtime/run-agent'

const NOW = '2026-09-26T18:00:00.000Z'

function makeStore(): WhisperTavernDb {
  const store = createDatabase(':memory:')
  store.sqlite
    .prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake', 'fake', 'fake', '{}', '{}', ?, ?)`)
    .run(NOW, NOW)
  return store
}

function makeBus(store: WhisperTavernDb): EventBus {
  return new EventBus(createSqliteEventSink(store))
}

/** §19/§21/§22 过滤层的最小贡献集合构造器 */
function msgContrib(id: string, role: 'user' | 'assistant' | 'tool', order: number): PromptContribution {
  return {
    id,
    source: { type: 'message', messageId: id },
    segment: { role, content: `content-${id}`, zone: 'history' },
    priority: 0,
    semanticPlacement: { type: 'history', order },
  }
}
function wbContrib(id: string, wbId: string, entryId: string, order: number): PromptContribution {
  return {
    id,
    source: { type: 'worldbook', worldbookId: wbId, entryId },
    segment: { role: 'system', content: `wb-${id}`, zone: 'stableWB' },
    priority: 0,
    semanticPlacement: { type: 'worldbook', position: 'before_char', order },
  } as unknown as PromptContribution
}
function artContrib(id: string, artifactId: string): PromptContribution {
  return {
    id,
    source: { type: 'artifact', artifactId },
    segment: { role: 'user', content: `art-${id}`, zone: 'tail' },
    priority: 0,
    semanticPlacement: { type: 'tail', order: 0 },
  }
}

describe('S26 §19 History Policy', () => {
  it('include 开关与 maxMessages 裁决可追(dropped 审计)', () => {
    const policy: ContextPolicy = {
      ...DEFAULT_CONTEXT_POLICY,
      history: { enabled: true, includeUser: false, includeAssistant: true, includeTools: true, branchMode: 'active', maxMessages: 2 },
    }
    const contributions = [
      wbContrib('wb1', 'book1', 'e1', 0),
      msgContrib('m1', 'user', 1),
      msgContrib('m2', 'assistant', 2),
      msgContrib('m3', 'assistant', 3),
      artContrib('a1', 'art_x'),
    ]
    const result = resolveContextByPolicy(policy, contributions)
    const ids = result.contributions.map((c) => c.id)
    expect(ids).not.toContain('m1') // includeUser=false
    expect(ids).toContain('m2')
    expect(ids).toContain('m3')
    expect(ids).toContain('wb1') // 非消息贡献不受 history 影响
    expect(ids).toContain('a1')
    const drop = result.dropped.find((d) => d.contributionId === 'm1')
    expect(drop?.policy).toBe('history')
  })

  it('history.enabled=false 整族拒绝;pinned 消息豁免', () => {
    const policy: ContextPolicy = {
      ...DEFAULT_CONTEXT_POLICY,
      history: { enabled: false, includeUser: true, includeAssistant: true, includeTools: true, branchMode: 'active', pinnedMessages: ['m_keep'] },
    }
    const result = resolveContextByPolicy(policy, [msgContrib('m1', 'user', 1), msgContrib('m_keep', 'user', 2)])
    // enabled=false = 全拒绝(pinned 只豁免开关与条数,不豁免总闸)
    expect(result.contributions.filter((c) => c.source.type === 'message')).toHaveLength(0)
    expect(result.dropped.length).toBe(2)
  })
})

describe('S26 §21 Worldbook Policy', () => {
  it('白名单过滤 + maxEntries + 总闸', () => {
    const contributions = [wbContrib('w1', 'bookA', 'e1', 0), wbContrib('w2', 'bookB', 'e2', 1), wbContrib('w3', 'bookA', 'e3', 2)]
    const whitelist: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY, worldbook: { enabled: true, worldbookIds: ['bookA'], allowRecursive: true } }
    const r1 = resolveContextByPolicy(whitelist, contributions)
    expect(r1.contributions.map((c) => c.id)).toEqual(['w1', 'w3'])
    expect(r1.dropped.find((d) => d.contributionId === 'w2')?.reason).toContain('白名单')

    const capped: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY, worldbook: { enabled: true, worldbookIds: [], allowRecursive: true, maxEntries: 1 } }
    const r2 = resolveContextByPolicy(capped, contributions)
    expect(r2.contributions.filter((c) => c.source.type === 'worldbook')).toHaveLength(1)

    const off: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY, worldbook: { enabled: false, worldbookIds: [], allowRecursive: true } }
    const r3 = resolveContextByPolicy(off, contributions)
    expect(r3.contributions.filter((c) => c.source.type === 'worldbook')).toHaveLength(0)
  })
})

describe('S26 §22 Artifact Policy', () => {
  it('enabled=false 与 maxItems 裁决;allowedTypes 在贡献构造面执行', () => {
    const r1 = resolveContextByPolicy(
      { ...DEFAULT_CONTEXT_POLICY, artifacts: { enabled: false, promoteFrozenArtifacts: true } },
      [artContrib('a1', 'x'), msgContrib('m1', 'user', 1)],
    )
    expect(r1.contributions.map((c) => c.id)).toEqual(['m1'])

    const r2 = resolveContextByPolicy(
      { ...DEFAULT_CONTEXT_POLICY, artifacts: { enabled: true, promoteFrozenArtifacts: true, maxItems: 1 } },
      [artContrib('a1', 'x'), artContrib('a2', 'y')],
    )
    expect(r2.contributions.map((c) => c.id)).toEqual(['a1'])
    expect(r2.dropped.find((d) => d.contributionId === 'a2')?.reason).toContain('maxItems')
  })
})

describe('S26 §20 Memory Policy(R-P3-9 空实现)', () => {
  it('检索恒空且带说明', () => {
    const r = resolveMemoryItems(DEFAULT_CONTEXT_POLICY.memory)
    expect(r.items).toHaveLength(0)
    expect(r.note).toContain('R-P3-9')
  })
})

describe('S26 §71/§72 Artifact + 冻结(C2 缓存纪律)', () => {
  it('冻结显式、冻结后拒改、frozen→injection / working→tail', () => {
    const store = makeStore()
    const bus = makeBus(store)
    try {
      const working = createArtifact(store, bus, { chatId: 'c1', type: 'outline', content: '大纲 v1', now: NOW })
      expect(working.frozen).toBe(false)
      expect(working.contentHash).toBeDefined()

      const updated = updateArtifactContent(store, bus, working.id, '大纲 v2', NOW)
      expect(updated.content).toBe('大纲 v2')

      const frozen = freezeArtifact(store, bus, working.id, NOW)
      expect(frozen.frozen).toBe(true)
      expect(() => updateArtifactContent(store, bus, working.id, '大纲 v3', NOW)).toThrow(ArtifactError)

      // C2:frozen → zone 'injection'(不是 header/stableWB);working → zone 'tail'
      const proj = artifactContributions([frozen, createArtifact(store, bus, { chatId: 'c1', type: 'draft', content: '草稿', now: NOW })], {
        enabled: true,
        promoteFrozenArtifacts: true,
      })
      expect(proj.contributions).toHaveLength(2)
      expect(proj.contributions[0]!.segment.zone).toBe('injection')
      expect(proj.contributions[1]!.segment.zone).toBe('tail')
      expect(listChatArtifacts(store, 'c1')).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  it('冻结产物不进稳定前缀:compile 后 artifact 段落后于全部 history(缓存纪律)', () => {
    const store = makeStore()
    const bus = makeBus(store)
    try {
      const frozen = freezeArtifact(store, bus, createArtifact(store, bus, { chatId: 'c1', type: 'outline', content: '【冻结大纲】 StableContent', now: NOW }).id, NOW)
      const proj = artifactContributions([frozen], { enabled: true, promoteFrozenArtifacts: true })
      const contributions: PromptContribution[] = [
        { id: 'rt:sys', source: { type: 'runtime', key: 'system' }, segment: { role: 'system', content: '系统头', zone: 'header' }, priority: 0, semanticPlacement: { type: 'header', order: 0 } },
        msgContrib('m1', 'user', 1),
        ...proj.contributions,
      ]
      const outcome = compile({
        chatId: 'c1' as never,
        snapshotId: 'snap_s26' as never,
        provider: 'fake',
        model: 'fake-model',
        compilerVersion: 'test',
        now: NOW,
        maxContextTokens: 131_072,
        maxOutputTokens: 4096,
        providerCacheType: 'none',
        mode: 'preview',
        contributions,
        variables: { user: 'u', char: 'c', sessionId: 's', chatId: 'c1', custom: {} },
      })
      if (!outcome.ok) throw new Error(`compile 失败: ${JSON.stringify(outcome.error)}`)
      const snapshot = outcome.value.snapshot
      const parts = snapshot.serialized.parts
      const artifactIdx = parts.findIndex((p) => (p.content ?? '').includes('【冻结大纲】'))
      const historyIdx = parts.findIndex((p) => (p.content ?? '').includes('content-m1'))
      const headerIdx = parts.findIndex((p) => (p.content ?? '').includes('系统头'))
      expect(artifactIdx).toBeGreaterThan(historyIdx) // 在 history 之后(injection 区)
      expect(artifactIdx).toBeGreaterThan(headerIdx) // 绝不在 header(稳定前缀)
    } finally {
      store.close()
    }
  })
})

describe('S26 §73/§74/§75 Output Commit', () => {
  it('四模式:message 落树 / artifact 落表 / silent 不落 / custom 未注册 fail-closed', () => {
    const store = makeStore()
    const bus = makeBus(store)
    try {
      const chat = createChat(store, bus, { title: 'commit', now: NOW })
      if (!chat.ok) throw new Error('建 chat 失败')
      const chatId = chat.value.id as string
      const runId = 'run_oc'

      const m = commitOutput(store, bus, { chatId, runId, output: { text: '最终回复' }, policy: { mode: 'message', role: 'character' }, now: NOW })
      expect(m.messageId).not.toBeNull()

      const a = commitOutput(store, bus, { chatId, runId, output: { text: '检查报告', structured: { pass: true } }, policy: { mode: 'artifact' }, now: NOW })
      expect(a.artifact?.type).toBe('agent-output')

      const s = commitOutput(store, bus, { chatId, runId, output: { text: '不该出现' }, policy: { mode: 'silent' }, now: NOW })
      expect(s.messageId).toBeNull()
      expect(s.artifact).toBeNull()

      expect(() => commitOutput(store, bus, { chatId, runId, output: { text: 'x' }, policy: { mode: 'custom' }, now: NOW })).toThrow(OutputCommitError)
      // 空输出 message 模式 = 无可提交,不报错
      const empty = commitOutput(store, bus, { chatId, runId, output: {}, policy: { mode: 'message' }, now: NOW })
      expect(empty.messageId).toBeNull()
    } finally {
      store.close()
    }
  })
})

describe('S26 §107/§108/§109 State Mutation', () => {
  it('五操作 + 版本递增 + 显式事务落库', () => {
    const store = makeStore()
    try {
      const v1 = applyStatePatches(store, {
        chatId: 'c1', agentId: 'ag1', expectedVersion: 0, now: NOW,
        patches: [
          { path: 'counters.chapter', operation: 'increment', value: 1 },
          { path: 'hero.name', operation: 'set', value: '陈远' },
          { path: 'log', operation: 'append', value: '第一章' },
        ],
      })
      expect(v1.ok).toBe(true)
      if (v1.ok) {
        expect(v1.version).toBe(1)
        expect(v1.state.counters).toEqual({ chapter: 1 })
        expect(v1.state.hero).toEqual({ name: '陈远' })
        expect(v1.state.log).toBe('第一章')
      }
      const v2 = applyStatePatches(store, {
        chatId: 'c1', agentId: 'ag1', expectedVersion: 1, now: NOW,
        patches: [
          { path: 'log', operation: 'append', value: '、第二章' },
          { path: 'tags', operation: 'append', value: ['a', 'b'] },
          { path: 'tags', operation: 'remove', value: 'a' },
          { path: 'hero.title', operation: 'delete' },
          { path: 'counters.chapter', operation: 'increment', value: 2 },
        ],
      })
      expect(v2.ok).toBe(true)
      if (v2.ok) {
        expect(v2.state.log).toBe('第一章、第二章')
        expect(v2.state.tags).toEqual(['b'])
        expect(v2.state.hero).toEqual({ name: '陈远' })
        expect(v2.state.counters).toEqual({ chapter: 3 })
        expect(v2.version).toBe(2)
        expect(readAgentState(store, 'c1', 'ag1').version).toBe(2)
      }
    } finally {
      store.close()
    }
  })

  it('§109 VERSION_CONFLICT:过期版本写者被拒,不覆盖(reload/merge/retry 归调用方)', () => {
    const store = makeStore()
    try {
      const first = applyStatePatches(store, { chatId: 'c', agentId: 'a', expectedVersion: 0, now: NOW, patches: [{ path: 'x', operation: 'set', value: 1 }] })
      expect(first.ok).toBe(true)
      // 两个写者都基于 v1:先到者成功,后到者冲突
      const w1 = applyStatePatches(store, { chatId: 'c', agentId: 'a', expectedVersion: 1, now: NOW, patches: [{ path: 'x', operation: 'set', value: 2 }] })
      const w2 = applyStatePatches(store, { chatId: 'c', agentId: 'a', expectedVersion: 1, now: NOW, patches: [{ path: 'x', operation: 'set', value: 99 }] })
      expect(w1.ok).toBe(true)
      expect(w2).toEqual({ ok: false, code: 'VERSION_CONFLICT', currentVersion: 2, state: { x: 2 } })
    } finally {
      store.close()
    }
  })

  it('§107 Validate:非法 patch 整笔拒绝(不部分提交)', () => {
    const store = makeStore()
    try {
      const r = applyStatePatches(store, {
        chatId: 'c', agentId: 'a', expectedVersion: 0, now: NOW,
        patches: [{ path: 'ok', operation: 'set', value: 1 }, { path: 'bad', operation: 'increment', value: 'not-a-number' }],
      })
      expect(r).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: expect.stringContaining('increment') })
      expect(readAgentState(store, 'c', 'a').state).toEqual({}) // 整笔拒绝,无部分提交
    } finally {
      store.close()
    }
  })
})

/** 脚本化 adapter:第 0 轮发 tool_call,第 1 轮发 Final */
class MutateLoopAdapter implements ProviderAdapter {
  readonly providerId = 'fake'
  private cursor = 0
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
    if (round === 0) {
      yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'wb_mutate', argsFragment: '{}' }
      yield { type: 'finish', reason: 'tool_use' }
    } else {
      yield { type: 'text_delta', text: 'final' }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}

describe('S26 §104/§105/§106 工具后重编译 + 缓存交互(runAgent 端到端)', () => {
  it('世界书变更工具 → cache.invalidated 事件 + 下轮重编译 + 前后快照可 diff', async () => {
    const store = makeStore()
    const bus = makeBus(store)
    try {
      const chat = createChat(store, bus, { title: 's26-e2e', now: NOW })
      if (!chat.ok) throw new Error('建 chat 失败')
      const msg = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '改一下世界书', now: NOW })
      if (!msg.ok) throw new Error('建消息失败')
      const def = createAgentDefinition(store, { name: 'x', type: 'tool-agent', instructions: 'y', now: NOW })
      const chatId = chat.value.id as ChatId

      const mutateTool: ToolDefinition = {
        id: 't_wb',
        name: 'wb_mutate',
        description: '改世界书',
        inputSchema: {},
        permissions: [],
        async execute(_input, ctx) {
          ctx.reportWorldbookMutation?.('entry_9') // §106 上报面
          return { toolCallId: '', status: 'success' as const, output: { done: true } }
        },
      }
      const registry = new ToolRegistry({ store, bus, persistApprovalAudit: () => undefined })
      registry.register(mutateTool)

      const res = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), registry },
        { chatId, agentId: def.id, adapter: new MutateLoopAdapter(), providerId: 'fake', model: 'fake-model', now: NOW },
      )
      expect(res.ok).toBe(true)

      bus.flush() // cache.invalidated 是 deferred-durable:先冲刷缓冲再查表
      // §106:失效事件已发布(events 表可见)
      const invalidations = store.sqlite.prepare(`SELECT payload FROM events WHERE event_type = 'cache.invalidated'`).all() as { payload: string }[]
      expect(invalidations.length).toBe(1)
      expect(invalidations[0]!.payload).toContain('entry_9')

      // §104:工具后存在第 2 次编译 → 前后快照可 diff(core diffSnapshots)
      const snapRows = store.sqlite
        .prepare(`SELECT id, ir FROM prompt_snapshots WHERE run_id = (SELECT id FROM runs ORDER BY created_at DESC LIMIT 1) ORDER BY created_at`)
        .all() as { id: string; ir: string }[]
      expect(snapRows.length).toBeGreaterThanOrEqual(2)
      const before = { id: snapRows[0]!.id, ir: JSON.parse(snapRows[0]!.ir) } as unknown as PromptSnapshot
      const after = { id: snapRows[1]!.id, ir: JSON.parse(snapRows[1]!.ir) } as unknown as PromptSnapshot
      const diff = diffSnapshots(before, after)
      // 工具结果消息使 history 增加(tool part);先于其前的段保持 same
      expect(diff.segments.some((s) => s.kind === 'added')).toBe(true)
      // 稳定前缀(header + stableWB)逐段 same —— §104 可复用面的直证
      const prefixSegs = diff.segments.filter((s) => s.kind === 'same')
      expect(prefixSegs.length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })
})
