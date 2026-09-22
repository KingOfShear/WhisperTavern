import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_CODES, DiagnosticSchema } from './diagnostics'

describe('contracts/diagnostics(诊断体系)', () => {
  it('诊断码注册完整(R-P0-2 / compiler-spec §71 + S16 宏引擎新码)', () => {
    for (const code of [
      'PROMPT_CONTEXT_TOO_LARGE',
      'EMPTY_SEGMENT',
      'DUPLICATE_SEGMENT_ID',
      'STABILITY_OVERRIDE',
      'CACHE_UNSAFE_MACRO',
      'UNKNOWN_MACRO',
      'EVAL_MACRO_REJECTED',
      'WORLD_BOOK_RETIRED',
      'WORLD_BOOK_DEACTIVATED',
      'BUDGET_TRIM',
    ]) {
      expect(DIAGNOSTIC_CODES).toContain(code)
    }
  })

  it('R-P0-1 退役:MACRO_UNEXPANDED_P0 不在注册集(S16 宏引擎取代)', () => {
    expect(DIAGNOSTIC_CODES).not.toContain('MACRO_UNEXPANDED_P0')
  })

  it('注册码无重复', () => {
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length)
  })

  it('Diagnostic round-trip,可挂 segmentId/source/details', () => {
    const diagnostic = {
      level: 'warning',
      code: 'STABILITY_OVERRIDE',
      message: 'User manually marked {{time}} as session-stable.',
      segmentId: 'preset:default:main',
      source: { type: 'preset', presetId: 'default', segmentId: 'main' },
      details: { from: 'volatile', to: 'session' },
    }
    expect(DiagnosticSchema.parse(JSON.parse(JSON.stringify(diagnostic)))).toEqual(diagnostic)
    expect(DiagnosticSchema.safeParse({ ...diagnostic, level: 'fatal' }).success).toBe(false)
  })
})
