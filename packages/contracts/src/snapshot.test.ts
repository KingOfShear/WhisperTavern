import { describe, expect, it } from 'vitest'
import {
  CacheBreakReasonSchema,
  CachePlanSchema,
  PromptHashesSchema,
  PromptSnapshotSchema,
  SerializedPromptSchema,
} from './snapshot'
import { DiagnosticSchema } from './diagnostics'
import type { PromptIR } from './ir'

const minimalIR: PromptIR = {
  schemaVersion: 1,
  segments: [],
  zones: [{ name: 'header' }],
  metadata: {},
}

const emptyCachePlan = CachePlanSchema.parse({
  version: 0,
  stablePrefixSegments: [],
  stablePrefixTokens: 0,
  freshSegments: [],
  freshTokens: 0,
  volatileSegments: [],
  volatileTokens: 0,
  checkpoints: [],
  invalidationRisk: 'low',
  breakReasons: [],
})

const serialized = SerializedPromptSchema.parse({
  format: 'chat-messages',
  parts: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ],
  hash: 'a'.repeat(64),
  tokenCount: 5,
})

const hashes = PromptHashesSchema.parse({
  header: 'h1',
  stableWB: 'h2',
  freshWB: 'h3',
  summary: 'h4',
  history: 'h5',
  injection: 'h6',
  tail: 'h7',
  final: 'h8',
})

describe('contracts/snapshot(Prompt Snapshot)', () => {
  it('P0 CachePlan 恒空形状合法且不含 checkpoints(R-P0-4)', () => {
    expect(emptyCachePlan.checkpoints).toHaveLength(0)
    expect(emptyCachePlan.breakReasons).toHaveLength(0)
    expect('providerStrategy' in emptyCachePlan).toBe(false)
  })

  it('八区哈希缺一不可(compiler-spec §67)', () => {
    const partial = { header: 'h1', final: 'h8' }
    expect(PromptHashesSchema.safeParse(partial).success).toBe(false)
  })

  it('SerializedPart 保留未知键(Anthropic blocks / Gemini parts 前向兼容)', () => {
    const parsed = SerializedPromptSchema.parse({
      ...serialized,
      parts: [{ type: 'thinking', text: 'hmm', signature: 'sig' }],
    })
    expect(parsed.parts[0]).toMatchObject({ type: 'thinking', signature: 'sig' })
  })

  it('PromptSnapshot round-trip:不可变证据链字段齐全(§66)', () => {
    const snapshot = {
      id: 'snap_0001',
      chatId: 'chat_0001',
      runId: 'run_0001',
      provider: 'fake',
      model: 'fake-model',
      compilerVersion: '0.1.0',
      ir: minimalIR,
      cachePlan: emptyCachePlan,
      serialized,
      hashes,
      diagnostics: [
        DiagnosticSchema.parse({ level: 'info', code: 'MACRO_UNEXPANDED_P0', message: '{{char}} 透传' }),
      ],
      createdAt: '2026-09-05T12:00:00Z',
    }
    const parsed = PromptSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))
    expect(parsed).toEqual(snapshot)
    expect(PromptSnapshotSchema.safeParse({ ...snapshot, createdAt: '2026-09-05' }).success).toBe(false)
  })

  it('CacheBreakReason 14 变体抽验(含无载荷变体)', () => {
    expect(CacheBreakReasonSchema.safeParse({ type: 'HISTORY_COMPACTION' }).success).toBe(true)
    expect(CacheBreakReasonSchema.safeParse({ type: 'MESSAGE_EDITED', messageId: 'm1' }).success).toBe(true)
    expect(CacheBreakReasonSchema.safeParse({ type: 'MESSAGE_EDITED' }).success).toBe(false)
  })
})
