import { describe, expect, it } from 'vitest'
import {
  CachePlacementSchema,
  SemanticPlacementSchema,
  StabilityClassSchema,
} from './placement'
import { PromptIRSchema, PromptSegmentSchema, SegmentSourceSchema, type PromptSegment } from './ir'
import { InstructionMetadataSchema } from './instruction'

/** 构造一个合法段(其余字段最小化),供变体替换 */
function segment(overrides: Partial<PromptSegment>): PromptSegment {
  const base: PromptSegment = {
    id: 'preset:default:main',
    source: { type: 'preset', presetId: 'default', segmentId: 'main' },
    role: 'system',
    content: 'You are {{char}}.',
    semanticPlacement: { type: 'header', order: 0 },
    cachePlacement: { zone: 'header' },
    stability: 'session',
    order: 0,
    tokenCount: 6,
    dependencies: [],
    enabled: true,
  }
  const merged = { ...base, ...overrides }
  return PromptSegmentSchema.parse(merged)
}

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)))
}

describe('contracts/placement(双 Placement + Stability)', () => {
  it('SemanticPlacement 五变体逐一 round-trip(worldbook 保留 ST 拼写 anTop/emTop)', () => {
    const variants = [
      { type: 'header', order: 0 },
      { type: 'worldbook', position: 'anTop', order: 1 },
      { type: 'history', order: 2 },
      { type: 'injection', depth: 4, order: 3 },
      { type: 'tail', order: 9 },
    ] as const
    for (const variant of variants) {
      expect(roundTrip(SemanticPlacementSchema, variant)).toEqual(variant)
    }
    expect(SemanticPlacementSchema.safeParse({ type: 'worldbook', position: 'atTop' }).success).toBe(false)
  })

  it('CachePlacement 七区穷尽且与 Semantic Placement 独立', () => {
    const zones = ['header', 'stableWB', 'freshWB', 'summary', 'history', 'injection', 'tail'] as const
    for (const zone of zones) {
      expect(CachePlacementSchema.safeParse({ zone }).success).toBe(true)
    }
    expect(CachePlacementSchema.safeParse({ zone: 'stableWb' }).success).toBe(false)
  })

  it('StabilityClass 五级穷尽', () => {
    for (const s of ['static', 'session', 'request', 'message', 'volatile'] as const) {
      expect(StabilityClassSchema.safeParse(s).success).toBe(true)
    }
    expect(StabilityClassSchema.safeParse('persistent').success).toBe(false)
  })
})

describe('contracts/ir(Prompt IR)', () => {
  it('SegmentSource 十三变体可解析(抽验带副字段的变体)', () => {
    const sources = [
      { type: 'character', assetId: 'char_1', field: 'description' },
      { type: 'worldbook', worldbookId: 'book1', entryId: '183' },
      { type: 'artifact', artifactId: 'art_1', runId: 'run_1' },
      { type: 'toolResult', toolCallId: 'tc_1' },
      { type: 'runtime', key: 'user_input' },
    ] as const
    for (const source of sources) {
      expect(roundTrip(SegmentSourceSchema, source)).toEqual(source)
    }
    expect(SegmentSourceSchema.safeParse({ type: 'character' }).success).toBe(false)
  })

  it('段缺省 instruction 时不阻断解析(缺省即推导,instruction-security §9)', () => {
    const parsed = segment({})
    expect(parsed.instruction).toBeUndefined()
  })

  it('段携带 instruction 元数据与 stabilityOverride 时 round-trip', () => {
    const instruction = InstructionMetadataSchema.parse({
      authority: 'character',
      trust: 'semi_trusted',
      scope: 'roleplay',
    })
    const parsed = roundTrip(
      PromptSegmentSchema,
      segment({ instruction, stabilityOverride: 'session', id: 'worldbook:book1:entry:183' }),
    )
    expect(parsed.instruction?.authority).toBe('character')
    expect(parsed.stabilityOverride).toBe('session')
  })

  it('PromptIR:segments/zones/metadata round-trip,禁缺 zones', () => {
    const ir = {
      schemaVersion: 1,
      segments: [segment({})],
      zones: [{ name: 'header' }, { name: 'history' }],
      metadata: { chatId: 'chat_0001' },
    }
    expect(roundTrip(PromptIRSchema, ir)).toEqual(ir)
    expect(PromptIRSchema.safeParse({ ...ir, zones: undefined }).success).toBe(false)
  })
})
