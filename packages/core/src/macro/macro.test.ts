import { describe, expect, it } from 'vitest'
import { analyze, expand, expandWithAnalysis } from './engine'
import { parseMacros } from './parser'
import { formatDate, formatTime, lookupMacro } from './macro-registry'
import { seededRng } from './rng'
import type { MacroContext, RuntimeVariables } from './types'

/** 测试 context 构造器:固定 now/chatId → 确定性 RNG(§45 冻结口径的引擎级镜像) */
function context(overrides: Partial<MacroContext> = {}): MacroContext {
  const variables: RuntimeVariables = {
    user: 'User',
    char: '艾琳',
    sessionId: 'sess_s16',
    chatId: 'chat_s16',
    custom: { persona: '一名来自北境的猎人。' },
  }
  const now = new Date('2026-09-20T14:05:00Z')
  return {
    variables,
    now,
    mode: 'compile',
    rng: seededRng(`${now.toISOString()}|${variables.chatId}`),
    ...overrides,
  }
}

describe('S16 宏引擎:§37–§39 形状', () => {
  it('§37/§38:analyze 产出 macros/stability/dependencies/diagnostics', () => {
    const result = analyze('你是 {{char}},现在 {{time}}。', context())
    expect(result.macros.map((m) => m.name)).toEqual(['char', 'time'])
    expect(result.stability).toBe('volatile') // 聚合 = 最不稳(time)
    expect(result.diagnostics).toHaveLength(0)
  })

  it('§39:occurrence 携带 name/raw/start/end(原始偏移)', () => {
    const [first, second] = parseMacros('A{{char}}B{{time}}')
    expect(first).toMatchObject({ name: 'char', raw: '{{char}}', start: 1, end: 9 })
    expect(second).toMatchObject({ name: 'time', raw: '{{time}}', start: 10, end: 18 })
  })

  it('§41:参数化宏 args 解析({{roll:1d20}} → args=1d20)', () => {
    const [roll] = parseMacros('{{roll:1d20}}')
    expect(roll).toBeDefined()
    expect(roll?.name).toBe('roll')
    expect(roll?.args).toBe('1d20')
  })
})

describe('S16 宏引擎:§40 默认宏表', () => {
  it('默认表覆盖 §40 八宏', () => {
    expect(
      ['user', 'char', 'persona', 'lastMessage', 'time', 'date', 'random', 'roll'].every(
        (name) => lookupMacro(name) !== undefined,
      ),
    ).toBe(true)
  })

  it('{{user}}/{{char}}/{{persona}} SESSION 展开', () => {
    const ctx = context()
    expect(expand('{{user}} 推门而入', ctx).content).toBe('User 推门而入')
    expect(expand('你是 {{char}}', ctx).content).toBe('你是 艾琳')
    expect(expand('{{persona}}', ctx).content).toBe('一名来自北境的猎人。')
    expect(analyze('{{char}}', ctx).stability).toBe('session')
  })

  it('{{lastMessage}} MESSAGE 展开(无 message 时空串)', () => {
    const ctx = context({ message: { id: 'm1', role: 'user', content: '你好,冒险者。' } })
    expect(expand('收到:{{lastMessage}}', ctx).content).toBe('收到:你好,冒险者。')
    expect(analyze('{{lastMessage}}', context()).stability).toBe('message')
    expect(expand('{{lastMessage}}', context()).content).toBe('')
  })

  it('§40 S16 口径:{{date}} UTC YYYY-MM-DD / {{time}} UTC HH:MM', () => {
    const now = new Date('2026-09-20T14:05:00Z')
    expect(formatDate(now)).toBe('2026-09-20')
    expect(formatTime(now)).toBe('14:05')
    expect(expand('{{date}} {{time}}', context()).content).toBe('2026-09-20 14:05')
  })

  it('§40 S16 口径:{{random}} [1,100] 且同输入确定性、同轮两值不同', () => {
    const a = expand('{{random}} {{random}}', context()).content
    const b = expand('{{random}} {{random}}', context()).content
    expect(a).toBe(b) // 确定性:同输入同 now 同 chat → 逐字节一致
    const [x, y] = a.split(' ').map(Number)
    expect(x).toBeGreaterThanOrEqual(1)
    expect(x).toBeLessThanOrEqual(100)
    expect(x).not.toBe(y) // ST 语义:同轮内两个 {{random}} 不同值
  })

  it('{{roll:NdM}} 骰子求和;无效参数保留原文', () => {
    const ctx = context()
    const result = expand('{{roll:1d20}}', ctx).content
    expect(Number(result)).toBeGreaterThanOrEqual(1)
    expect(Number(result)).toBeLessThanOrEqual(20)
    expect(expand('{{roll:2d6}}', ctx).content).toMatch(/^\d{1,2}$/)
    expect(expand('{{roll:not-a-dice}}', ctx).content).toBe('{{roll:not-a-dice}}')
  })
})

describe('S16 宏引擎:§42 安全 + 未知宏', () => {
  it('§42:{{eval:...}} 拒绝 → 空串 + EVAL_MACRO_REJECTED warning', () => {
    const result = expandWithAnalysis('{{eval:process.exit()}}', context())
    expect(result.content).toBe('')
    expect(result.analysis.diagnostics).toMatchObject([
      { level: 'warning', code: 'EVAL_MACRO_REJECTED' },
    ])
  })

  it('未知宏({{place}})原样保留 + UNKNOWN_MACRO info + volatility=static', () => {
    const result = expandWithAnalysis('场景在 {{place}}', context())
    expect(result.content).toBe('场景在 {{place}}')
    expect(result.analysis.stability).toBe('static') // 未知宏不威胁缓存
    expect(result.analysis.diagnostics).toMatchObject([
      { level: 'info', code: 'UNKNOWN_MACRO', details: { macro: 'place' } },
    ])
  })
})

describe('S16 宏引擎:§45 Replay 冻结 + 确定性', () => {
  it('§45:replay 模式冻结 now 与 random seed(同输入逐字节一致)', () => {
    const replayCtx = context({ mode: 'replay', seed: 'fixed-seed' })
    const run = () => expand('{{random}} {{date}}', { ...replayCtx, rng: seededRng('fixed-seed') }).content
    expect(run()).toBe(run())
  })

  it('§5:同输入任意次编译逐字节一致(variables/chatId 固定 → RNG 种子稳定)', () => {
    const first = expandWithAnalysis('你是 {{char}},掷骰 {{roll:1d20}}', context())
    const second = expandWithAnalysis('你是 {{char}},掷骰 {{roll:1d20}}', context())
    expect(first.content).toBe(second.content)
  })
})
