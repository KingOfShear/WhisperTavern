/**
 * S28(WP3.6)还账 #17 Agent Tree 递归护栏 —— agent-runtime-spec §39(四护栏字段)/§93(assertCanSpawn)。
 *
 * 覆盖:x根 Run 恒放行;depth=1 禁二阶 spawn(§160 A→B→A);children 上限;totalAgents 整树计数;
 * runtime 上限(注入 now 保 X14 确定性);parent 不存在 → 拒;四字段全缺 = 不限制。
 */
import { describe, expect, it } from 'vitest'
import type { ChatId } from '@whispertavern/contracts'
import { createDatabase, createExecutionRun, type WhisperTavernDb } from '@whispertavern/runtime'
import { assertCanSpawn } from '../index'

const NOW = '2026-09-27T12:00:00.000Z'

function makeStore(): WhisperTavernDb {
  const store = createDatabase(':memory:')
  store.sqlite
    .prepare(`INSERT INTO providers (id, name, type, config, capabilities, created_at, updated_at) VALUES ('fake', 'fake', 'fake', '{}', '{}', ?, ?)`)
    .run(NOW, NOW)
  return store
}

/** runs.chat_id REFERENCES chats(id):建真实 chat 行满足 FK */
function ensureChat(store: WhisperTavernDb, chatId: string): void {
  store.sqlite
    .prepare(`INSERT OR IGNORE INTO chats (id, title, created_at, updated_at) VALUES (?, 's28', ?, ?)`)
    .run(chatId, NOW, NOW)
}

/** 建一条 Run;parentRunId 可省略(根) */
function seedRun(store: WhisperTavernDb, chatId: string, parentRunId?: string, at = NOW): string {
  ensureChat(store, chatId)
  return createExecutionRun(store, {
    chatId: chatId as ChatId,
    parentRunId: parentRunId as never,
    agentId: undefined,
    now: at,
  })
}

describe('S28 §93/§39 Agent Tree 递归护栏(assertCanSpawn)', () => {
  it('根 Run(无 parent)恒放行,四栏全缺不限制', () => {
    const store = makeStore()
    const chatId = 'chat_s28_root' as ChatId
    const root = seedRun(store, chatId)
    const r = assertCanSpawn(store, { limits: {} })
    expect(r.allowed).toBe(true)
    const r2 = assertCanSpawn(store, { parentRunId: root as never, limits: { maxDepth: 0 } })
    expect(r2.allowed).toBe(false)
  })

  it('maxDepth:二阶 spawn 被拒(§160 A→B→A),一阶放行', () => {
    const store = makeStore()
    const chatId = 'chat_s28_depth' as ChatId
    // A(root) → B(depth1);A 的子代是 B ⇒ maxDepth=1 时 B 的子树可存在但 B 不能再有子
    const a = seedRun(store, chatId)
    const r1 = assertCanSpawn(store, { parentRunId: a as never, limits: { maxDepth: 1 } })
    expect(r1.allowed).toBe(true)
    expect(r1.stats.depth).toBe(1)
    const b = seedRun(store, chatId, a)
    const r2 = assertCanSpawn(store, { parentRunId: b as never, limits: { maxDepth: 1 } })
    expect(r2.allowed).toBe(false)
    expect(r2.reason).toContain('maxDepth')
  })

  it('maxChildren:直接子数达到上限即拒', () => {
    const store = makeStore()
    const chatId = 'chat_s28_children' as ChatId
    const a = seedRun(store, chatId)
    seedRun(store, chatId, a)
    seedRun(store, chatId, a)
    const r = assertCanSpawn(store, { parentRunId: a as never, limits: { maxChildren: 2 } })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('maxChildren')
    // 未达上限 → 放行
    const r2 = assertCanSpawn(store, { parentRunId: a as never, limits: { maxChildren: 3 } })
    expect(r2.allowed).toBe(true)
    expect(r2.stats.children).toBe(2)
  })

  it('maxTotalAgents:整棵 Run Tree 累计 Agent 数含子孙', () => {
    const store = makeStore()
    const chatId = 'chat_s28_total' as ChatId
    const root = seedRun(store, chatId)
    const mid = seedRun(store, chatId, root)
    seedRun(store, chatId, mid) // 孙
    const r = assertCanSpawn(store, { parentRunId: mid as never, limits: { maxTotalAgents: 3 } })
    expect(r.allowed).toBe(false)
    expect(r.stats.totalAgents).toBe(3)
    const r2 = assertCanSpawn(store, { parentRunId: mid as never, limits: { maxTotalAgents: 4 } })
    expect(r2.allowed).toBe(true)
  })

  it('maxRuntimeMs:注入 now 超 root 创建时距即拒(时间护栏)', () => {
    const store = makeStore()
    const chatId = 'chat_s28_runtime' as ChatId
    const root = seedRun(store, chatId, undefined, '2026-09-27T12:00:00.000Z')
    const r = assertCanSpawn(store, {
      parentRunId: root as never,
      limits: { maxRuntimeMs: 1000 },
      now: '2026-09-27T12:00:01.500Z',
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('maxRuntimeMs')
    expect(r.stats.rootStartedAt).toBe('2026-09-27T12:00:00.000Z')
    const r2 = assertCanSpawn(store, {
      parentRunId: root as never,
      limits: { maxRuntimeMs: 2000 },
      now: '2026-09-27T12:00:01.500Z',
    })
    expect(r2.allowed).toBe(true)
  })

  it('parent Run 不存在 → 拒(不可判定不放行,防逃逸护栏)', () => {
    const store = makeStore()
    const r = assertCanSpawn(store, {
      parentRunId: 'run_missing' as never,
      limits: { maxDepth: 1, maxChildren: 1, maxTotalAgents: 1, maxRuntimeMs: 1000 },
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('不存在')
  })
})