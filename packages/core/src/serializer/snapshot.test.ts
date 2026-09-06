import { describe, expect, it } from 'vitest'
import { ChatIdSchema, SnapshotIdSchema, type PromptIR, type PromptSegment } from '@desiregrimoire/contracts'
import { buildPromptSnapshot } from './snapshot'

const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const snapshotId = SnapshotIdSchema.parse('snap_0001')
const chatId = ChatIdSchema.parse('chat_0001')

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

function input(ir: PromptIR) {
  return {
    id: snapshotId,
    chatId,
    provider: 'fake',
    model: 'fake-model',
    compilerVersion: '0.1.0',
    ir,
    createdAt: '2026-09-05T12:00:00Z' as const,
  }
}

const baseIR: PromptIR = {
  schemaVersion: 1,
  segments: [
    segment({ id: 'preset:default:main', cachePlacement: { zone: 'header' } }),
    segment({
      id: 'worldbook:book1:entry:183',
      source: { type: 'worldbook', worldbookId: 'book1', entryId: '183' },
      content: 'stable lore',
      cachePlacement: { zone: 'stableWB' },
      stability: 'static',
      tokenCount: 2,
    }),
    segment({
      id: 'chat:1:message:982',
      source: { type: 'message', messageId: '982' },
      role: 'user',
      content: 'hi',
      cachePlacement: { zone: 'history' },
      stability: 'message',
      tokenCount: 1,
    }),
  ],
  zones: [{ name: 'header' }, { name: 'stableWB' }, { name: 'history' }],
  metadata: {},
}

describe('core/serializer(Snapshot 构建器)', () => {
  it('同输入两次构建:全字段(含八区哈希)逐字节一致(§5/§67 验收)', () => {
    const first = buildPromptSnapshot(input(baseIR))
    const second = buildPromptSnapshot(input(baseIR))
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('createdAt 只进元数据不进哈希:不同时钟同哈希(确定性边界)', () => {
    const a = buildPromptSnapshot(input(baseIR))
    const b = buildPromptSnapshot({ ...input(baseIR), createdAt: '2026-09-06T00:00:00Z' })
    expect(a.hashes.final).toBe(b.hashes.final)
    expect(a.createdAt).not.toBe(b.createdAt)
  })

  it('tail 内容变化只改 tail 与 final,header/stableWB 哈希不动(§56 前缀稳定)', () => {
    const tailChangedIR: PromptIR = {
      ...baseIR,
      segments: [
        ...baseIR.segments,
        segment({
          id: 'runtime:user_input',
          source: { type: 'runtime', key: 'user_input' },
          role: 'user',
          content: 'turn input v1',
          cachePlacement: { zone: 'tail' },
          stability: 'volatile',
          tokenCount: 3,
        }),
      ],
    }
    const withTail = buildPromptSnapshot(input(tailChangedIR))
    const after = buildPromptSnapshot({
      ...input(tailChangedIR),
      ir: {
        ...tailChangedIR,
        segments: tailChangedIR.segments.map((s) =>
          s.id === 'runtime:user_input' ? { ...s, content: 'turn input v2' } : s,
        ),
      },
    })
    expect(withTail.hashes.header).toBe(after.hashes.header)
    expect(withTail.hashes.stableWB).toBe(after.hashes.stableWB)
    expect(withTail.hashes.tail).not.toBe(after.hashes.tail)
    expect(withTail.hashes.final).not.toBe(after.hashes.final)
  })

  it('指令元数据变化不进八区哈希,但反映在 authorityFingerprint(I5/§19.1)', () => {
    const withInstruction: PromptIR = {
      ...baseIR,
      segments: baseIR.segments.map((s) =>
        s.id === 'worldbook:book1:entry:183'
          ? {
              ...s,
              instruction: {
                authority: 'world' as const,
                trust: 'semi_trusted' as const,
                scope: 'roleplay' as const,
              },
            }
          : s,
      ),
    }
    const plain = buildPromptSnapshot(input(withInstruction))
    const fingerprinted = buildPromptSnapshot(input(withInstruction))
    expect(fingerprinted.hashes.final).toBe(plain.hashes.final)
    expect(fingerprinted.authorityFingerprint).toBeDefined()

    const reRanked: PromptIR = {
      ...withInstruction,
      segments: withInstruction.segments.map((s) =>
        s.id === 'worldbook:book1:entry:183' && s.instruction
          ? { ...s, instruction: { ...s.instruction, authority: 'memory' as const } }
          : s,
      ),
    }
    const changed = buildPromptSnapshot(input(reRanked))
    expect(changed.hashes.final).toBe(plain.hashes.final)
    expect(changed.authorityFingerprint).not.toBe(plain.authorityFingerprint)
  })

  it('无 instruction 的段不产指纹;全空 IR 全区哈希 = SHA-256(空字节)外部基准', () => {
    const emptyIR: PromptIR = { schemaVersion: 1, segments: [], zones: [], metadata: {} }
    const snapshot = buildPromptSnapshot(input(emptyIR))
    expect(snapshot.authorityFingerprint).toBe(SHA256_EMPTY)
    expect(snapshot.hashes.header).toBe(SHA256_EMPTY)
    expect(snapshot.hashes.stableWB).toBe(SHA256_EMPTY)
    expect(snapshot.hashes.final).toBe(SHA256_EMPTY)
  })

  it('cachePlan 为 P0 空形状(R-P0-4);serialized 为规范 custom 格式', () => {
    const snapshot = buildPromptSnapshot(input(baseIR))
    expect(snapshot.cachePlan.checkpoints).toHaveLength(0)
    expect(snapshot.cachePlan.version).toBe(0)
    expect(snapshot.serialized.format).toBe('custom')
    expect(snapshot.serialized.parts).toHaveLength(3)
    expect(snapshot.serialized.tokenCount).toBe(6)
    expect(snapshot.serialized.tokenCountMode).toBe('estimated')
  })

  it('返回值深冻结(§68:Snapshot 不可变的运行期兜底)', () => {
    const snapshot = buildPromptSnapshot(input(baseIR))
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.hashes)).toBe(true)
    expect(Object.isFrozen(snapshot.ir)).toBe(true)
    expect(() => {
      ;(snapshot.hashes as { final: string }).final = 'tampered'
    }).toThrow(TypeError)
  })
})
