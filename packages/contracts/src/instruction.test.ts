import { describe, expect, it } from 'vitest'
import {
  AUTHORITY_ORDER,
  InstructionAuthoritySchema,
  InstructionMetadataSchema,
  InstructionScopeSchema,
  InstructionTrustSchema,
} from './instruction'

describe('contracts/instruction(指令安全元数据)', () => {
  it('authority 12 档穷尽且全序无重复(instruction-security §6)', () => {
    expect(InstructionAuthoritySchema.options).toHaveLength(12)
    expect(new Set(AUTHORITY_ORDER).size).toBe(12)
    // 全序必须覆盖全部档位,不遗漏 developer(仅投影档)
    expect([...AUTHORITY_ORDER].sort()).toEqual([...InstructionAuthoritySchema.options].sort())
    expect(AUTHORITY_ORDER[0]).toBe('platform')
    expect(AUTHORITY_ORDER[AUTHORITY_ORDER.length - 1]).toBe('untrusted')
  })

  it('trust 三档 / scope 五档穷尽', () => {
    expect(InstructionTrustSchema.options).toHaveLength(3)
    expect(InstructionScopeSchema.options).toHaveLength(5)
  })

  it('InstructionMetadata round-trip(含 origin 溯源)', () => {
    const metadata = {
      authority: 'world',
      trust: 'semi_trusted',
      scope: 'roleplay',
      origin: { kind: 'web', url: 'https://example.com/page' },
    }
    expect(InstructionMetadataSchema.parse(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata)
  })

  it('overrides 只接受 allow/deny 值', () => {
    const parsed = InstructionMetadataSchema.parse({
      authority: 'system',
      trust: 'trusted',
      scope: 'assembly',
      overrides: { character: 'deny' },
    })
    expect(parsed.overrides).toEqual({ character: 'deny' })
    expect(
      InstructionMetadataSchema.safeParse({
        authority: 'system',
        trust: 'trusted',
        scope: 'assembly',
        overrides: { character: 'grant' },
      }).success,
    ).toBe(false)
  })
})
