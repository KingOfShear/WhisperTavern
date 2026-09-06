import { describe, expect, it } from 'vitest'
import { DiagnosticSchema, P0_DIAGNOSTIC_CODES } from './diagnostics'

describe('contracts/diagnostics(诊断体系)', () => {
  it('P0 码表注册完整(R-P0-1 / R-P0-3 / compiler-spec §71)', () => {
    for (const code of [
      'MACRO_UNEXPANDED_P0',
      'PROMPT_CONTEXT_TOO_LARGE',
      'AUTHORITY_OVERRIDE_DENIED',
      'UNTRUSTED_IN_STABLE_ZONE',
      'EMPTY_SEGMENT',
      'DUPLICATE_SEGMENT_ID',
      'STABILITY_OVERRIDE',
    ]) {
      expect(P0_DIAGNOSTIC_CODES).toContain(code)
    }
  })

  it('P0 注册码无重复', () => {
    expect(new Set(P0_DIAGNOSTIC_CODES).size).toBe(P0_DIAGNOSTIC_CODES.length)
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
