import { describe, expect, it } from 'vitest'
import { ChatIdSchema, SnapshotIdSchema, type PromptIR, type PromptSnapshot, type PromptSegment } from '@whispertavern/contracts'
import { buildPromptSnapshot } from './snapshot'
import { diffSnapshots, projectSegment } from './diff'

/**
 * S14(WP1.5)Snapshot Diff 单测 —— api-spec §38 口径:
 * 对齐键 = 段 ID;内容一致性 = (id,role,content) 框架哈希;
 * firstDivergence = 第一个非 same 段;tokenDelta 三项;cacheBreak 启发式标签。
 */

const chatId = ChatIdSchema.parse('chat_diff_0001')

function segment(overrides: Partial<PromptSegment>): PromptSegment {
  return {
    id: 'preset:default:main',
    source: { type: 'preset', presetId: 'default', segmentId: 'main' },
    role: 'system',
    content: 'main prompt',
    semanticPlacement: { type: 'header', order: 0 },
    cachePlacement: { zone: 'header' },
    stability: 'session',
    order: 0,
    tokenCount: 3,
    dependencies: [],
    enabled: true,
    ...overrides,
  }
}

function ir(segments: PromptSegment[]): PromptIR {
  return {
    schemaVersion: 1,
    segments,
    zones: [...new Set(segments.map((s) => s.cachePlacement.zone))].map((name) => ({ name })),
    metadata: {},
  }
}

function snapshotOf(segments: PromptSegment[], suffix = 'a'): PromptSnapshot {
  return buildPromptSnapshot({
    id: SnapshotIdSchema.parse(`snap_diff_${suffix}`),
    chatId,
    provider: 'fake',
    model: 'fake-model',
    compilerVersion: '0.1.0',
    ir: ir(segments),
    createdAt: '2026-09-16T12:00:00Z',
  }) as PromptSnapshot
}

const baseSegments: PromptSegment[] = [
  segment({ id: 'runtime:chat:system', content: '系统头部' }),
  segment({
    id: 'chat:1:message:982',
    source: { type: 'message', messageId: '982' },
    role: 'user',
    content: '上一轮输入',
    cachePlacement: { zone: 'history' },
    stability: 'message',
    order: 1,
    tokenCount: 4,
  }),
  segment({
    id: 'chat:1:message:983',
    source: { type: 'message', messageId: '983' },
    role: 'user',
    content: '本轮输入',
    cachePlacement: { zone: 'tail' },
    stability: 'volatile',
    order: 2,
    tokenCount: 4,
  }),
]

describe('core/serializer diff(api-spec §38)', () => {
  it('同 IR:全段 same,无 firstDivergence,tokenDelta 全 0', () => {
    const a = snapshotOf(baseSegments, 'a1')
    const b = snapshotOf(baseSegments, 'b1')
    const diff = diffSnapshots(a, b)
    expect(diff.segments.every((d) => d.kind === 'same')).toBe(true)
    expect(diff.firstDivergence).toBeUndefined()
    expect(diff.tokenDelta).toEqual({ input: 0, cached: a.ir.segments.reduce((s, x) => s + x.tokenCount, 0), fresh: 0 })
    expect(diff.cacheBreak).toBeUndefined()
  })

  it('tail 内容变化:只 changed 该段;firstDivergence 指向它;cacheBreak = MANUAL_INVALIDATION 兜底之外的来源归类', () => {
    const a = snapshotOf(baseSegments, 'a2')
    const b = snapshotOf(
      baseSegments.map((s) => (s.id === 'chat:1:message:983' ? { ...s, content: '本轮输入(重写)' } : s)),
      'b2',
    )
    const diff = diffSnapshots(a, b)
    const changed = diff.segments.filter((d) => d.kind === 'changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.segmentId).toBe('chat:1:message:983')
    expect(diff.firstDivergence?.segmentId).toBe('chat:1:message:983')
    // 来源是 message → MESSAGE_EDITED 疑似
    expect(diff.cacheBreak?.type).toBe('MESSAGE_EDITED')
    // fresh 含 changed.after 的 token
    expect(diff.tokenDelta.fresh).toBeGreaterThan(0)
  })

  it('新增历史消息:added 段入 diff;firstDivergence 指向新增段;input = token 差', () => {
    const a = snapshotOf(baseSegments, 'a3')
    const b = snapshotOf([
      ...baseSegments.slice(0, 2),
      segment({
        id: 'chat:1:message:990',
        source: { type: 'message', messageId: '990' },
        role: 'assistant',
        content: '回复正文',
        cachePlacement: { zone: 'history' },
        stability: 'message',
        order: 3,
        tokenCount: 6,
      }),
      baseSegments[2]!,
    ], 'b3')
    const diff = diffSnapshots(a, b)
    const added = diff.segments.filter((d) => d.kind === 'added')
    expect(added.map((d) => d.segmentId)).toEqual(['chat:1:message:990'])
    expect(diff.firstDivergence?.segmentId).toBe('chat:1:message:990')
    expect(diff.tokenDelta.input).toBe(6)
    expect(diff.tokenDelta.cached).toBe(a.ir.segments.reduce((s, x) => s + x.tokenCount, 0))
  })

  it('移除段:removed 记录 before;前缀稳定段仍 same', () => {
    const a = snapshotOf(baseSegments, 'a4')
    const b = snapshotOf(baseSegments.slice(0, 2), 'b4')
    const diff = diffSnapshots(a, b)
    expect(diff.segments.filter((d) => d.kind === 'removed').map((d) => d.segmentId)).toEqual(['chat:1:message:983'])
    expect(diff.segments.find((d) => d.segmentId === 'runtime:chat:system')?.kind).toBe('same')
  })

  it('段框架哈希:role 变化也视为 changed(序列化字节变)', () => {
    const a = snapshotOf([segment({ role: 'system' })], 'a5')
    const b = snapshotOf([segment({ role: 'assistant', stability: 'static', cachePlacement: { zone: 'header' }, semanticPlacement: { type: 'header', order: 0 } })], 'b5')
    const diff = diffSnapshots(a, b)
    expect(diff.segments[0]?.kind).toBe('changed')
  })

  it('projectSegment:contentHash 对同内容段稳定、异内容段不同', () => {
    const s1 = projectSegment(baseSegments[0]!)
    const s2 = projectSegment({ ...baseSegments[0]!, content: '变了' })
    expect(s1.contentHash).toBe(projectSegment(baseSegments[0]!).contentHash)
    expect(s1.contentHash).not.toBe(s2.contentHash)
  })
})
