import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compile, type RuntimeVariables } from '@whispertavern/core'
import { ChatIdSchema, type PromptContribution, type Timestamp } from '@whispertavern/contracts'
import { createDatabase } from '../db/database'
import { createMemoryRepository } from './repository'
import { buildSummaryContributions } from './summary-contributions'

const NOW = '2026-09-27T13:00:00.000Z' as Timestamp
const CHAT = 'chat-s30'
const CHAT_ID = ChatIdSchema.parse(CHAT)

const VARS: RuntimeVariables = {
  user: 'User',
  char: '狐神',
  sessionId: 'sess-1',
  chatId: CHAT_ID,
  custom: {},
}

const dirs: string[] = []
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dg-sum-'))
  dirs.push(dir)
  return createDatabase(join(dir, 'sum.sqlite'))
}
function seedChat(store: ReturnType<typeof tempDb>, messageIds: string[]) {
  store.sqlite
    .prepare('INSERT INTO chats (id, settings, runtime_state, message_sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(CHAT, '{}', '{}', messageIds.length, NOW, NOW)
  const ins = store.sqlite.prepare(
    'INSERT INTO messages (id, chat_id, sequence, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  messageIds.forEach((m, i) => ins.run(m, CHAT, i + 1, 'user', 'm', NOW, NOW))
}
function headerContribution(): PromptContribution {
  return {
    id: 'runtime:header',
    source: { type: 'runtime', key: 'header' },
    segment: { role: 'system', content: 'HEADER\n', zone: 'header' },
    priority: 0,
    semanticPlacement: { type: 'header', order: 0 },
  }
}
function tailMemoryContribution(): PromptContribution {
  return {
    id: 'memory:mem-tail-1',
    source: { type: 'memory', memoryId: 'mem-tail-1' },
    segment: { role: 'system', content: '【记忆】狐神喜欢温泉与山风\n', zone: 'tail' },
    priority: 0,
    semanticPlacement: { type: 'tail', order: 0 },
  }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Summary 链 → 贡献(compiler-spec §32/§33;S30)', () => {
  it('summuary 块落在 summary 区、位于 history 之前、按 sequence 排序', async () => {
    const store = tempDb()
    try {
      seedChat(store, ['m-1', 'm-20', 'm-21', 'm-40'])
      const repo = createMemoryRepository(store.sqlite)
      await repo.appendSummaryBlock({ chatId: CHAT, content: '第 1 章:狐神苏醒于温泉', fromMessageId: 'm-1', toMessageId: 'm-20' })
      await repo.appendSummaryBlock({ chatId: CHAT, content: '第 2 章:乌鸦占领神社', fromMessageId: 'm-21', toMessageId: 'm-40' })

      const { contributions, diagnostics } = buildSummaryContributions(store, CHAT)
      expect(diagnostics).toEqual([])
      expect(contributions).toHaveLength(2)
      // zone = summary(semanticPlacement 无 summary 变体 → history 变体携 sequence;§13 双 Placement 分离)
      expect(contributions.every((c) => c.segment.zone === 'summary')).toBe(true)
      const orders = contributions.map((c) => c.semanticPlacement.order)
      expect(orders).toEqual(expect.arrayContaining([1, 2]))

      // 真实 compile:summary 区段在 header 之后、history 之前
      const outcomes = compile({
        chatId: CHAT_ID,
        snapshotId: 'snap-s30-1' as never,
        provider: 'fake',
        model: 'fake-model',
        compilerVersion: '0.1.0',
        now: NOW,
        maxContextTokens: 8192,
        mode: 'preview',
        contributions: [headerContribution(), ...contributions, tailMemoryContribution()],
        variables: VARS,
      })
      expect(outcomes.ok).toBe(true)
      const zones = outcomes.ok ? outcomes.value.ir.zones.map((z) => z.name) : []
      expect(zones).toEqual(['header', 'summary', 'tail'])
      const summarySegs = outcomes.ok ? outcomes.value.ir.segments.filter((s) => s.id.startsWith('summary:')) : []
      expect(summarySegs).toHaveLength(2)
      expect(summarySegs.every((s) => s.cachePlacement.zone === 'summary')).toBe(true)
      // 稳定区枚举包含 summary → summary 段在 stable 前缀内(compiler §43 stable zone)
      expect(summarySegs.every((s) => s.stability !== 'volatile')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('稳定前缀零干扰:tail 记忆贡献不在 stablePrefixSegments,不改变既有稳定前缀字节', async () => {
    const store = tempDb()
    try {
      seedChat(store, ['m-1', 'm-20'])
      const repo = createMemoryRepository(store.sqlite)
      await repo.appendSummaryBlock({ chatId: CHAT, content: '第 1 章:狐神苏醒于温泉', fromMessageId: 'm-1', toMessageId: 'm-20' })
      const { contributions: summary } = buildSummaryContributions(store, CHAT)

      const baseInput = {
        chatId: CHAT_ID,
        provider: 'fake',
        model: 'fake-model',
        compilerVersion: '0.1.0',
        now: NOW,
        maxContextTokens: 8192,
        mode: 'preview' as const,
        variables: VARS,
      }
      // 无记忆 vs 有 tail 记忆:稳定前缀段集合一致(记忆只落 tail,stable 前缀零干扰)
      const without = compile({ ...baseInput, snapshotId: 'snap-a' as never, contributions: [headerContribution(), ...summary] })
      const withMemory = compile({ ...baseInput, snapshotId: 'snap-b' as never, contributions: [headerContribution(), ...summary, tailMemoryContribution()] })
      expect(without.ok && withMemory.ok).toBe(true)
      if (!without.ok || !withMemory.ok) return
      const stableA = without.value.cachePlan.stablePrefixSegments
      const stableB = withMemory.value.cachePlan.stablePrefixSegments
      expect(stableB).toEqual(stableA)
      // 记忆段本身绝不在稳定前缀里
      expect(stableB.some((id) => id.startsWith('memory:'))).toBe(false)
    } finally {
      store.close()
    }
  })

  it('SUMMARY_CHECKPOINT 是显式失效事件:追加块后注入它,缓存 Plan 正确重算(compiler-spec §33)', async () => {
    const store = tempDb()
    try {
      seedChat(store, ['m-1', 'm-20', 'm-21', 'm-40'])
      const repo = createMemoryRepository(store.sqlite)
      await repo.appendSummaryBlock({ chatId: CHAT, content: '块 1', fromMessageId: 'm-1', toMessageId: 'm-20' })
      const before = buildSummaryContributions(store, CHAT)
      const r1 = compile({
        chatId: CHAT_ID,
        snapshotId: 'snap-1' as never,
        provider: 'fake',
        model: 'fake-model',
        compilerVersion: '0.1.0',
        now: NOW,
        maxContextTokens: 8192,
        mode: 'preview',
        contributions: [headerContribution(), ...before.contributions],
        variables: VARS,
      })
      expect(r1.ok).toBe(true)

      // 追加块 2(sequence=2):summary 区内容增长
      const b2 = await repo.appendSummaryBlock({ chatId: CHAT, content: '块 2', fromMessageId: 'm-21', toMessageId: 'm-40' })
      const after = buildSummaryContributions(store, CHAT)
      expect(after.contributions).toHaveLength(2)
      const r2 = compile({
        chatId: CHAT_ID,
        snapshotId: 'snap-2' as never,
        provider: 'fake',
        model: 'fake-model',
        compilerVersion: '0.1.0',
        now: NOW,
        maxContextTokens: 8192,
        mode: 'preview',
        contributions: [headerContribution(), ...after.contributions],
        variables: VARS,
        // 追加 = 显式失效(compiler-spec §33;R-P4-4 禁止无事件语义的摘要回写)
        cacheInvalidations: [{ type: 'SUMMARY_CHECKPOINT', summaryId: b2.id }],
      })
      expect(r2.ok).toBe(true)
      if (!r1.ok || !r2.ok) return
      // 显式失效被 CachePlan 识别:breakReasons 含 SUMMARY_CHECKPOINT(compiler-spec §33)
      const breakReasons = r2.value.cachePlan.breakReasons
      expect(breakReasons.some((r) => r.type === 'SUMMARY_CHECKPOINT')).toBe(true)
      // 追加后 summary 区段数翻倍,列表反映新块
      const summarySeqs = r2.value.ir.segments.filter((s) => s.id.startsWith('summary:')).map((s) => s.order)
      expect(summarySeqs.sort((a, b) => a - b)).toEqual([1, 2])
    } finally {
      store.close()
    }
  })
})