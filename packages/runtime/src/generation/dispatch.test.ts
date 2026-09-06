import { describe, expect, it } from 'vitest'
import {
  ChatIdSchema,
  SnapshotIdSchema,
  type PromptSnapshot,
  type Timestamp,
} from '@whispertavern/contracts'
import { buildPromptSnapshot, type DeepReadonly } from '@whispertavern/core'
import { FakeProviderAdapter } from '@whispertavern/adapters'
import { EventBus } from '../events/bus'
import {
  assertNoMetadataOnWire,
  assertRequestMatchesSnapshot,
  assertSnapshotRegistered,
  assertWaitingHasDurableEvent,
  buildGenerationRequest,
  dispatchGeneration,
  SnapshotRegistry,
  type GenerationRecord,
} from './dispatch'

const NOW = '2026-09-05T12:00:00Z' as Timestamp
const chatId = ChatIdSchema.parse('chat_s5')
const snapshotId = SnapshotIdSchema.parse('snap_s5')

function snapshotFixture(): DeepReadonly<PromptSnapshot> {
  return buildPromptSnapshot({
    id: snapshotId,
    chatId,
    provider: 'fake',
    model: 'fake-model',
    compilerVersion: '0.1.0',
    ir: {
      schemaVersion: 1,
      segments: [
        {
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
        },
        {
          id: 'runtime:user_input',
          source: { type: 'runtime', key: 'user_input' },
          role: 'user',
          content: '你好',
          semanticPlacement: { type: 'tail', order: 1 },
          cachePlacement: { zone: 'tail' },
          stability: 'volatile',
          order: 1,
          tokenCount: 2,
          dependencies: [],
          enabled: true,
        },
      ],
      zones: [{ name: 'header' }, { name: 'tail' }],
      metadata: {},
    },
    createdAt: NOW,
  })
}

function setup() {
  const bus = new EventBus({ insert: () => undefined })
  const snapshots = new SnapshotRegistry()
  const records: GenerationRecord[] = []
  return { bus, snapshots, records, sink: (record: GenerationRecord) => records.push(record) }
}

describe('dispatchGeneration(§5.5 四不变量闸口 + usage 入库)', () => {
  it('happy path:started/completed durable,usage.recorded deferred,generations 记录分对 reported', async () => {
    const { bus, snapshots, records, sink } = setup()
    const snapshot = snapshotFixture()
    snapshots.register(snapshot)
    const durableTypes: string[] = []
    bus.subscribe('*', (e) => {
      if (e.durability === 'durable') durableTypes.push(e.type)
    })

    const result = await dispatchGeneration(
      { adapter: new FakeProviderAdapter([{ text: '回复内容', delayMs: 0 }]), bus, snapshots, sink },
      { runId: 'run_1', chatId, snapshot, now: NOW },
    )

    expect(result.status).toBe('completed')
    expect(result.text).toBe('回复内容')
    expect(result.finishReason).toBe('stop')
    expect(result.usage?.source).toBe('reported')
    expect(durableTypes).toEqual(['generation.started', 'generation.completed'])
    // §51/§52:usage 字段 + usage_source 区分(reported 入命中率分母,estimated 不入)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      runId: 'run_1',
      snapshotId: snapshot.id,
      status: 'completed',
      usageSource: 'reported',
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    })
  })

  it('PV6:取消 → partial 文本保留 + CANCELLED + generation.failed', async () => {
    const { bus, snapshots, records, sink } = setup()
    const snapshot = snapshotFixture()
    snapshots.register(snapshot)
    const controller = new AbortController()
    controller.abort()

    const result = await dispatchGeneration(
      { adapter: new FakeProviderAdapter([{ text: '不应产出' }]), bus, snapshots, sink },
      { runId: 'run_2', chatId, snapshot, signal: controller.signal, now: NOW },
    )
    expect(result.status).toBe('cancelled')
    expect(result.error?.code).toBe('CANCELLED')
    expect(records[0]?.status).toBe('cancelled')
    expect(records[0]?.error).toMatchObject({ code: 'CANCELLED' })
  })

  it('不变量 1(故意违规变红):未注册的 snapshotId → INVARIANT_VIOLATION,不发请求', async () => {
    const { bus, snapshots, records, sink } = setup()
    const ghost = { ...snapshotFixture(), id: SnapshotIdSchema.parse('snap_ghost') }
    await expect(
      dispatchGeneration(
        { adapter: new FakeProviderAdapter([{ text: 'x' }]), bus, snapshots, sink },
        { runId: 'run_3', chatId, snapshot: ghost, now: NOW },
      ),
    ).rejects.toThrow(/INVARIANT_VIOLATION\[snapshot-attached\]/)
    expect(records).toHaveLength(0)
    expect(bus.durableEvents('run_3')).toHaveLength(0) // 请求确实没有发出
  })

  it('不变量 2(故意违规变红):messages 与快照序列化不一致 → 红;经 buildGenerationRequest 构造则绿', () => {
    const snapshot = snapshotFixture()
    const forged = {
      snapshotId: snapshot.id,
      model: snapshot.model,
      messages: [{ role: 'user' as const, content: '绕过 Compiler 手拼的内容' }],
      sampling: { maxOutputTokens: 16 },
      stream: true as const,
    }
    expect(() => assertRequestMatchesSnapshot(forged, snapshot)).toThrow(
      /INVARIANT_VIOLATION\[model-visible-recorded\]/,
    )
    expect(() => assertRequestMatchesSnapshot(buildGenerationRequest(snapshot, { runId: 'probe' }), snapshot)).not.toThrow()
  })

  it('不变量 3(故意违规变红):message 混入 metadata/遥测键 → 红', () => {
    const snapshot = snapshotFixture()
    const polluted = {
      snapshotId: snapshot.id,
      model: snapshot.model,
      messages: [{ role: 'user' as const, content: 'hi', metadata: { traceId: 't1' } }],
      sampling: { maxOutputTokens: 16 },
      stream: true as const,
    }
    expect(() => assertNoMetadataOnWire(polluted)).toThrow(/INVARIANT_VIOLATION\[metadata-off-wire\]/)
    expect(() => assertNoMetadataOnWire(buildGenerationRequest(snapshot, { runId: 'probe' }))).not.toThrow()
  })

  it('不变量 4(故意违规变红):waiting 无 durable 事件 → 红;有 generation.started → 绿', () => {
    expect(() => assertWaitingHasDurableEvent([], 'run_x')).toThrow(
      /INVARIANT_VIOLATION\[waiting-durable-event\]/,
    )
    const { bus } = setup()
    bus.publish({ type: 'generation.started', runId: 'run_x', payload: {}, timestamp: NOW })
    expect(() => assertWaitingHasDurableEvent(bus.durableEvents('run_x'), 'run_x')).not.toThrow()
  })

  it('不变量 1 正面:已注册快照通过闸口', () => {
    const { snapshots } = setup()
    const snapshot = snapshotFixture()
    snapshots.register(snapshot)
    expect(() => assertSnapshotRegistered(snapshots, snapshot.id)).not.toThrow()
  })
})
