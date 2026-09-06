import { describe, expect, it } from 'vitest'
import { createPromptSegment, createPromptIR, deepFreeze } from './segment'
import type { PromptSegment } from '@desiregrimoire/contracts'

const validSegment: PromptSegment = {
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

describe('core/ir(段模型与不可变性)', () => {
  it('createPromptSegment 验证后深冻结:顶层与嵌套对象均 frozen', () => {
    const segment = createPromptSegment(validSegment)
    expect(Object.isFrozen(segment)).toBe(true)
    expect(Object.isFrozen(segment.semanticPlacement)).toBe(true)
    expect(Object.isFrozen(segment.dependencies)).toBe(true)
  })

  it('冻结对象变更在 strict 模式下抛 TypeError(§68 不可变的运行期兜底)', () => {
    const segment = createPromptSegment(validSegment)
    expect(() => {
      ;(segment as { content: string }).content = 'tampered'
    }).toThrow(TypeError)
    expect(() => {
      ;(segment.dependencies as string[]).push('x')
    }).toThrow(TypeError)
  })

  it('非法段(缺 order)在构造点抛 ZodError,不产出半成品 IR', () => {
    const broken = { ...validSegment } as Partial<PromptSegment>
    delete broken.order
    expect(() => createPromptSegment(broken as PromptSegment)).toThrow()
  })

  it('deepFreeze 幂等且对原始类型无害', () => {
    const obj = deepFreeze({ a: { b: 1 } })
    expect(deepFreeze(obj)).toBe(obj)
    expect(deepFreeze(42)).toBe(42)
  })

  it('createPromptIR 整体冻结(段数组不可增删)', () => {
    const ir = createPromptIR({
      schemaVersion: 1,
      segments: [validSegment],
      zones: [{ name: 'header' }],
      metadata: {},
    })
    expect(Object.isFrozen(ir)).toBe(true)
    expect(Object.isFrozen(ir.segments)).toBe(true)
    expect(() => {
      ;(ir.segments as unknown[]).push({})
    }).toThrow(TypeError)
  })
})
