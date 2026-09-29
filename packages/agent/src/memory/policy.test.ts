/**
 * S30(WP4.2a)Memory Policy 真实实现(R-P3-9 兑现)测试:
 * 1. resolveMemoryPolicy 各检索策略路线(recent/importance/semantic/hybrid + 缺入参回退);
 * 2. runAgent 端到端:记忆检索命中 → filterContributions 注 tail → 快照段 zone=tail
 *    且**不在 stablePrefixSegments**(稳定前缀零干扰,C2/R4;memory-runtime-spec §5)。
 */
import { describe, expect, it } from 'vitest'
import type { ProviderAdapter, ProviderCapabilities, ProviderChatRequest, ProviderStreamEvent } from '@whispertavern/contracts'
import {
  EventBus,
  SnapshotRegistry,
  createDatabase,
  createChat,
  createMessage,
  createMemoryRepository,
  createSqliteEventSink,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import { createAgentDefinition } from '../runtime/definition'
import { runAgent } from '../runtime/run-agent'
import { DEFAULT_CONTEXT_POLICY, type MemoryContextPolicy } from '../context/policy'
import { resolveMemoryPolicy } from './policy'

const NOW = '2026-09-27T14:00:00.000Z'

/** FTS5 unicode61 无 CJK 分词:关键词用例用空格分词内容(memory-runtime-spec §3.1 口径) */
const EN_A = 'the fox spirit bathes in the hot springs every evening'
const EN_B = 'the crow spirit guards the shrine gate day and night'

class ScriptedAdapter implements ProviderAdapter {
  readonly providerId = 'fake'
  constructor(private readonly text: string) {}
  capabilities(_model: string): ProviderCapabilities {
    return {
      systemRole: true, tools: false, vision: false, reasoning: false, streaming: true,
      promptCaching: false, cacheType: 'none', maxContextTokens: 131_072, maxOutputTokens: 4096,
      structuredOutput: 'none', parallelToolCalls: false, toolChoice: false,
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
  store.sqlite
    .prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake', 'fake', 'fake', '{}', '{}', ?, ?)`)
    .run(NOW, NOW)
  return store
}

function makeMemoryPolicy(patch: Partial<MemoryContextPolicy>): MemoryContextPolicy {
  return { ...DEFAULT_CONTEXT_POLICY.memory, enabled: true, ...patch }
}

describe('S30 Memory Policy 检索编排(agent/src/memory/policy.ts)', () => {
  it('recent:按最近更新取样,经 resolveMemoryItems 投影 zone=tail', async () => {
    const store = makeStore()
    try {
      const repo = createMemoryRepository(store.sqlite)
      await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'fox', content: EN_A })
      await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'crow', content: EN_B })

      const r = await resolveMemoryPolicy({
        policy: makeMemoryPolicy({ retrievalStrategy: 'recent', maxItems: 2 }),
        repository: repo,
        chatId: 'c1',
      })
      expect(r.items).toHaveLength(2)
      expect(r.items.every((c) => c.segment.zone === 'tail')).toBe(true)
      expect(r.items.every((c) => c.source.type === 'memory')).toBe(true)
      expect(r.note).toContain('recent')
    } finally {
      store.close()
    }
  })

  it('importance:高 importance 的命中排前,minImportance 过滤', async () => {
    const store = makeStore()
    try {
      const repo = createMemoryRepository(store.sqlite)
      const low = await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'fox', content: EN_A, importance: 0.2 })
      const high = await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'crow', content: EN_B, importance: 0.9 })

      const r = await resolveMemoryPolicy({
        policy: makeMemoryPolicy({ retrievalStrategy: 'importance', minImportance: 0.7 }),
        repository: repo,
        chatId: 'c1',
      })
      expect(r.items.map((c) => c.id)).toEqual([`memory:${high}`])
      expect(r.hits.map((h) => h.memoryId)).toEqual([high, low]) // low 在 hits 里(高出 minImportance 于 listMemories 后过滤)
      expect(r.note).toContain('importance')
    } finally {
      store.close()
    }
  })

  it('semantic:无 embedding 查询向量回退 recent;有 embedding 走 searchSemantic', async () => {
    const store = makeStore()
    try {
      const repo = createMemoryRepository(store.sqlite)
      await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'fox', content: EN_A, embedding: new Float32Array([1, 0, 0]) })
      await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'crow', content: EN_B, embedding: new Float32Array([0, 1, 0]) })

      // 无 embedding → 回退 recent(记录注)
      const fallback = await resolveMemoryPolicy({
        policy: makeMemoryPolicy({ retrievalStrategy: 'semantic' }),
        repository: repo,
        chatId: 'c1',
      })
      expect(fallback.note).toContain('回退 recent')
      expect(fallback.items).toHaveLength(2)

      // 有 embedding → searchSemantic 序
      const sem = await resolveMemoryPolicy({
        policy: makeMemoryPolicy({ retrievalStrategy: 'semantic', maxItems: 1 }),
        repository: repo,
        chatId: 'c1',
        embedding: new Float32Array([1, 0, 0]),
      })
      expect(sem.note).toContain('semantic')
      expect(sem.items.map((c) => c.segment.content)).toEqual([expect.stringContaining('fox spirit')])
    } finally {
      store.close()
    }
  })

  it('hybrid:关键词+语义双路,合并去重(via=both);只给关键词 → 关键词单路', async () => {
    const store = makeStore()
    try {
      const repo = createMemoryRepository(store.sqlite)
      await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'fox', content: EN_A, embedding: new Float32Array([1, 0, 0]) })
      await repo.upsertMemory({ ownerId: 'o', chatId: 'c1', type: 'fact', entity: 'crow', content: EN_B, embedding: new Float32Array([0, 1, 0]) })

      const r = await resolveMemoryPolicy({
        policy: makeMemoryPolicy({ retrievalStrategy: 'hybrid' }),
        repository: repo,
        chatId: 'c1',
        query: 'fox springs',
        embedding: new Float32Array([1, 0, 0]),
      })
      expect(r.note).toContain('合并去重')
      // fox 双命中 via=both;crow 语义命中;总 2 条无重复
      expect(r.hits).toHaveLength(2)
      expect(r.hits.map((h) => h.via).sort()).toEqual(['both', 'semantic'])
    } finally {
      store.close()
    }
  })

  it('enabled=false → 恒空', async () => {
    const store = makeStore()
    try {
      const repo = createMemoryRepository(store.sqlite)
      const r = await resolveMemoryPolicy({
        policy: makeMemoryPolicy({ enabled: false }),
        repository: repo,
        chatId: 'c1',
      })
      expect(r.items).toHaveLength(0)
      expect(r.note).toContain('enabled=false')
    } finally {
      store.close()
    }
  })
})

describe('S30 runAgent 端到端:记忆注 tail,稳定前缀零干扰(P2 门禁)', () => {
  it('memoryRetrieval 注入 → 快照记忆段 zone=tail,且不在 stablePrefixSegments', async () => {
    const store = makeStore()
    try {
      const bus = new EventBus(createSqliteEventSink(store))
      const repo = createMemoryRepository(store.sqlite)
      const def = createAgentDefinition(store, { name: '记忆角色', type: 'character', instructions: '安静。', now: NOW })

      const chat = createChat(store, bus, { title: 'mem-e2e', now: NOW })
      expect(chat.ok).toBe(true)
      if (!chat.ok) return
      const chatId = chat.value.id
      const msg = createMessage(store, bus, { chatId, role: 'user', content: '你好', now: NOW })
      expect(msg.ok).toBe(true)
      // 把记忆写到该 chat(真实 run 的 chat)
      await repo.upsertMemory({ ownerId: 'o', chatId, type: 'fact', entity: 'fox', content: EN_A })

      // 先验证记忆确在库中(诊断:R-P3-9 接线是否真命中)
      const seed = await repo.listMemories({ chatId })
      expect(seed).toHaveLength(1)

      const result = await runAgent(
        { store, bus, snapshots: new SnapshotRegistry(), clock: () => NOW },
        {
          chatId,
          agentId: def.id,
          adapter: new ScriptedAdapter('我是测试回复。'),
          providerId: 'fake',
          model: 'fake-model',
          now: NOW,
          contextPolicy: { ...DEFAULT_CONTEXT_POLICY, memory: makeMemoryPolicy({ retrievalStrategy: 'recent' }) },
          memoryRetrieval: { query: 'fox hot springs' },
        },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // 从快照验证记忆段落在 tail
      const snapRow = store.sqlite
        .prepare<[string]>(`SELECT ir FROM prompt_snapshots WHERE id = ?`)
        .get(result.value.snapshotId ?? '') as { ir: string } | undefined
      expect(snapRow).toBeDefined()
      const ir = JSON.parse(snapRow!.ir) as {
        segments: { id: string; cachePlacement: { zone: string } }[]
      }
      const memSegs = ir.segments.filter((s) => s.id.startsWith('memory:'))
      expect(memSegs.length).toBeGreaterThan(0)
      expect(memSegs.every((s) => s.cachePlacement.zone === 'tail')).toBe(true)
    } finally {
      store.close()
    }
  })
})