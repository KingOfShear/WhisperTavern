import { describe, expect, it } from 'vitest'
import {
  ChatIdSchema,
  SnapshotIdSchema,
  type PromptContribution,
} from '@whispertavern/contracts'
import { compile, type CompileRequest } from './pipeline'

const chatId = ChatIdSchema.parse('chat_s4')
const snapshotId = SnapshotIdSchema.parse('snap_s4')

function presetContribution(overrides: Partial<PromptContribution> = {}): PromptContribution {
  return {
    id: 'preset:default:main',
    source: { type: 'preset', presetId: 'default', segmentId: 'main' },
    segment: { role: 'system', content: 'main prompt', zone: 'header' },
    priority: 0,
    semanticPlacement: { type: 'header', order: 0 },
    ...overrides,
  }
}

function request(overrides: Partial<CompileRequest> = {}): CompileRequest {
  return {
    chatId,
    snapshotId,
    provider: 'fake',
    model: 'fake-model',
    compilerVersion: '0.1.0',
    now: '2026-09-05T12:00:00Z',
    maxContextTokens: 8192,
    mode: 'strict',
    contributions: [presetContribution()],
    ...overrides,
  }
}

/** 确定性比较面:显式字段组装,trace 含计时排除在外(§101) */
function comparable(outcome: ReturnType<typeof compile>) {
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error('unreachable')
  const value = outcome.value
  return JSON.stringify({
    ir: value.ir,
    cachePlan: value.cachePlan,
    serialized: value.serialized,
    snapshot: value.snapshot,
    diagnostics: value.diagnostics,
  })
}

describe('S4 管线:确定性与 R-P0-1 宏透传', () => {
  it('同输入任意次编译字节级一致(验收;trace 计时除外)', () => {
    const first = compile(request())
    const second = compile(request())
    expect(comparable(first)).toBe(comparable(second))
  })

  it('R-P0-1:{{macro}} 原样透传(content 不变)+ info 级 MACRO_UNEXPANDED_P0', () => {
    const outcome = compile(
      request({ contributions: [presetContribution({
        segment: { role: 'system', content: '你是 {{char}},场景在 {{place}}。{{char}} 保持人设。', zone: 'header' },
      })] }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.diagnostics).toMatchObject([
      { code: 'MACRO_UNEXPANDED_P0', level: 'info', details: { macros: ['{{char}}', '{{place}}'] } },
    ])
    const serialized = outcome.value.snapshot.serialized
    expect(serialized.parts[0]?.content).toBe('你是 {{char}},场景在 {{place}}。{{char}} 保持人设。')
  })

  it('§93/§94:zone 序主导排序,同序按提交序与 stable ID 决胜', () => {
    const outcome = compile(
      request({
        contributions: [
          { ...presetContribution({ id: 'runtime:tail:a', priority: 0 }), source: { type: 'runtime', key: 'a' }, segment: { role: 'user', content: 'tail a', zone: 'tail' }, semanticPlacement: { type: 'tail', order: 0 } },
          presetContribution({ id: 'preset:second', segment: { role: 'system', content: 'b', zone: 'header' }, semanticPlacement: { type: 'header', order: 1 } }),
          presetContribution(),
        ],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.ir.segments.map((s) => s.id)).toEqual([
      'preset:default:main',
      'preset:second',
      'runtime:tail:a',
    ])
  })

  it('R-P0-2 硬上限:超限报 PROMPT_CONTEXT_TOO_LARGE 终止,不裁剪(两种模式一致)', () => {
    // 'main prompt' = 11 字符 → 估算 3 tokens;上限 2 触发超限
    for (const mode of ['strict', 'preview'] as const) {
      const outcome = compile(request({ mode, maxContextTokens: 2 }))
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.error.code).toBe('PROMPT_CONTEXT_TOO_LARGE')
      expect(outcome.error.diagnostics.some((d) => d.code === 'PROMPT_CONTEXT_TOO_LARGE')).toBe(true)
    }
  })

  it('normalize:段 ID 重复直接失败(§9 稳定性前提);P0 不支持的模式被拒', () => {
    const dup = compile(
      request({ contributions: [presetContribution(), presetContribution()] }),
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.code).toBe('DUPLICATE_SEGMENT_ID')

    const replay = compile(request({ mode: 'replay' }))
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.error.code).toBe('UNSUPPORTED_MODE')
  })

  it('§101:trace 含阶段计时且 cacheHits=0(P2 前无 Compiler Cache)', () => {
    const outcome = compile(request())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.trace.stages.map((s) => s.name)).toEqual([
      'normalize',
      'resolve',
      'macro-scan',
      'sorting',
      'budget-limit',
      'ir-assembly',
      'snapshot',
    ])
    expect(outcome.value.trace.cacheHits).toBe(0)
  })
})
