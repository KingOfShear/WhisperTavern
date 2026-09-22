import { describe, expect, it } from 'vitest'
import {
  ChatIdSchema,
  SnapshotIdSchema,
  type PromptContribution,
} from '@whispertavern/contracts'
import type { RuntimeVariables } from '../macro/types'
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

/** S16:宏展开变量(chatId 固定 → RNG 种子确定性) */
function variables(overrides: Partial<RuntimeVariables> = {}): RuntimeVariables {
  return {
    user: 'User',
    char: '艾琳',
    sessionId: 'sess_s4',
    chatId,
    custom: {},
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
    variables: variables(),
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

describe('S4/S16 管线:确定性 + 宏展开(R-P0-1 退役)', () => {
  it('同输入任意次编译字节级一致(验收;trace 计时除外)', () => {
    const first = compile(request())
    const second = compile(request())
    expect(comparable(first)).toBe(comparable(second))
  })

  it('S16:注册宏 {{char}} 展开为 variables.char;未知宏 {{place}} 原样保留 + UNKNOWN_MACRO', () => {
    const outcome = compile(
      request({ contributions: [presetContribution({
        segment: { role: 'system', content: '你是 {{char}},场景在 {{place}}。{{char}} 保持人设。', zone: 'header' },
      })] }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.diagnostics).toMatchObject([
      { code: 'UNKNOWN_MACRO', level: 'info', details: { macro: 'place' } },
    ])
    // 展开后文本进入 serialized(哈希对象 = 展开后最终文本,R-P2-3)
    const serialized = outcome.value.snapshot.serialized
    expect(serialized.parts[0]?.content).toBe('你是 艾琳,场景在 {{place}}。艾琳 保持人设。')
  })

  it('§43:header 段含 {{time}}(volatile > session)→ strict 档 error → COMPILE_FAILED', () => {
    const outcome = compile(
      request({
        contributions: [presetContribution({
          segment: { role: 'system', content: '当前时间 {{time}}', zone: 'header' },
        })],
      }),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('COMPILE_FAILED')
    expect(outcome.error.diagnostics.some((d) => d.code === 'CACHE_UNSAFE_MACRO' && d.level === 'error')).toBe(true)
  })

  it('§43 normal 档:header 段含 {{time}} → 整段移 tail(zone/stability 改,语义位不变)+ warning', () => {
    const outcome = compile(
      request({
        mode: 'preview', // preview 缺省推导 normal
        contributions: [presetContribution({
          segment: { role: 'system', content: '当前时间 {{time}}', zone: 'header' },
        })],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const segment = outcome.value.ir.segments[0]
    if (segment === undefined) throw new Error('unreachable: 无段')
    expect(segment.cachePlacement.zone).toBe('tail')
    expect(segment.stability).toBe('volatile')
    // §13 双 Placement 分离:semanticPlacement 仍为 header(语义位不动)
    expect(segment.semanticPlacement).toMatchObject({ type: 'header' })
    // 展开后内容仍在(时间已展开为固定 now 的 UTC 时刻)
    expect(segment.content).toBe('当前时间 12:00')
    expect(outcome.value.diagnostics).toMatchObject([
      { code: 'CACHE_UNSAFE_MACRO', level: 'warning', details: { action: 'moved_to_tail' } },
    ])
  })

  it('§43 compat 档:段位置不动 + warning 标记缓存不安全', () => {
    const outcome = compile(
      request({
        macroCachePolicy: 'compat',
        contributions: [presetContribution({
          segment: { role: 'system', content: '当前时间 {{time}}', zone: 'header' },
        })],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const segment = outcome.value.ir.segments[0]
    if (segment === undefined) throw new Error('unreachable: 无段')
    expect(segment.cachePlacement.zone).toBe('header')
    expect(outcome.value.diagnostics).toMatchObject([
      { code: 'CACHE_UNSAFE_MACRO', level: 'warning', details: { action: 'preserved' } },
    ])
  })

  it('§43 边界:header 段含 {{char}}(session == session)不触发;history 段含 {{time}} 不触发', () => {
    // {{char}} session == header 默认 session → 不触发
    const sessionOnly = compile(
      request({ contributions: [presetContribution({
        segment: { role: 'system', content: '你是 {{char}}', zone: 'header' },
      })] }),
    )
    expect(sessionOnly.ok).toBe(true)
    if (sessionOnly.ok) {
      expect(sessionOnly.value.diagnostics.some((d) => d.code === 'CACHE_UNSAFE_MACRO')).toBe(false)
    }

    // {{time}} 在 history 区(不在稳定区)→ 不触发
    const historyVolatile = compile(
      request({ contributions: [presetContribution({
        id: 'chat:1:message:1',
        source: { type: 'message', messageId: 'm1' },
        segment: { role: 'user', content: '看到 {{time}} 了', zone: 'history' },
        semanticPlacement: { type: 'history', order: 0 },
      })] }),
    )
    expect(historyVolatile.ok).toBe(true)
    if (historyVolatile.ok) {
      expect(historyVolatile.value.diagnostics.some((d) => d.code === 'CACHE_UNSAFE_MACRO')).toBe(false)
    }
  })

  it('§43 边界:{{lastMessage}}(message < session)出现在 header → 触发(normal 档移 tail)', () => {
    const outcome = compile(
      request({
        mode: 'preview',
        lastMessage: { id: 'm1', role: 'user', content: '你好' },
        contributions: [presetContribution({
          segment: { role: 'system', content: '刚说:{{lastMessage}}', zone: 'header' },
        })],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.ir.segments[0]?.cachePlacement.zone).toBe('tail')
    expect(outcome.value.diagnostics.some((d) => d.code === 'CACHE_UNSAFE_MACRO')).toBe(true)
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
