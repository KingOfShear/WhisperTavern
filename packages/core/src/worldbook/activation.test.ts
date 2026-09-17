import { describe, expect, it } from 'vitest'
import {
  activateWorldbook,
  type ActivationDescriptor,
  type ScanParameters,
  type ScanContext,
} from './activation'

const scan: ScanParameters = { scanDepth: null, caseSensitive: null, wholeWord: null, recursive: false }

function ctx(overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    sequence: 1,
    messages: [{ id: 'm1', role: 'user', content: '剑宗弟子与星辰剑宗对峙' }],
    auxiliary: {},
    ...overrides,
  }
}

function entry(overrides: Partial<ActivationDescriptor> = {}): ActivationDescriptor {
  return {
    id: 'e1',
    enabled: true,
    mode: 'selective',
    keys: [],
    secondaryKeys: [],
    logic: 'andAny',
    chance: 100,
    matchScope: [],
    scanDepthOverride: null,
    caseSensitiveOverride: null,
    wholeWordOverride: null,
    stickyRounds: 0,
    cooldown: 0,
    delay: 0,
    recursion: { excluded: false, prevent: false, delayedUntil: false },
    group: { id: null, override: false, weight: 0, scoring: false },
    triggers: [],
    characterFilter: undefined,
    slot: 'before',
    order: 0,
    ...overrides,
  }
}

describe('§23/§25 keyword activation 触发语义', () => {
  it('constant 蓝灯 → 常驻激活(reason=manual)', () => {
    const out = activateWorldbook({ entries: [entry({ mode: 'constant' })], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(true)
    expect(out.decisions.e1!.reason).toBe('manual')
  })

  it('andAny: 任一主键命中 → keyword 激活', () => {
    const out = activateWorldbook({ entries: [entry({ keys: ['剑宗'] })], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(true)
    expect(out.decisions.e1!.reason).toBe('keyword')
    expect(out.decisions.e1!.matchedKeywords).toContain('剑宗')
  })

  it('andAny: 无命中则不激活', () => {
    const out = activateWorldbook({ entries: [entry({ keys: ['不存在'] })], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(false)
  })

  it('andAll: 全部命中才激活', () => {
    const e = entry({ keys: ['剑宗', '星辰'], logic: 'andAll' })
    const hit = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx() })
    expect(hit.decisions.e1!.activated).toBe(true)
    const miss = activateWorldbook({ entries: [entry({ keys: ['剑宗', '不存在'], logic: 'andAll' })], runtimeState: {}, scan, context: ctx() })
    expect(miss.decisions.e1!.activated).toBe(false)
  })

  it('notAny: 全都不在 → 激活', () => {
    const e = entry({ keys: ['无影', '极光'], logic: 'notAny' })
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(true)
    const present = activateWorldbook({ entries: [entry({ keys: ['剑宗', '极光'], logic: 'notAny' })], runtimeState: {}, scan, context: ctx() })
    expect(present.decisions.e1!.activated).toBe(false)
  })

  it('notAll: 有任一不在 → 激活', () => {
    const out = activateWorldbook({ entries: [entry({ keys: ['剑宗', '不存在'], logic: 'notAll' })], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(true)
  })

  it('secondaryKeys: 主键未命中时副键兜底', () => {
    const e = entry({ keys: ['无影'], secondaryKeys: ['星辰'] })
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(true)
    expect(out.decisions.e1!.matchedKeywords).toContain('星辰')
  })

  it('caseSensitive: 覆盖 true 时区分大小写', () => {
    const e = entry({ keys: ['剑宗'], caseSensitiveOverride: true })
    const text = 'jian zong SwordMaster'
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx({ messages: [{ id: 'x', role: 'user', content: text }] }) })
    expect(out.decisions.e1!.activated).toBe(false)
  })

  it('wholeWord: 覆盖 true 时全词不匹配子串', () => {
    const e = entry({ keys: ['剑宗'], wholeWordOverride: true })
    // "剑宗弟子" 中 "剑宗" 非独立词边界(后随汉字) → 不中
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(false)
    const standalone = activateWorldbook({
      entries: [e],
      runtimeState: {},
      scan,
      context: ctx({ messages: [{ id: 'x', role: 'user', content: '「剑宗」降临。' }] }),
    })
    expect(standalone.decisions.e1!.activated).toBe(true)
  })

  it('matchScope: 附加域参与匹配', () => {
    const e = entry({ keys: ['御剑术'], matchScope: ['scenario'] })
    const out = activateWorldbook({
      entries: [e],
      runtimeState: {},
      scan,
      context: ctx({ auxiliary: { scenario: '御剑术传承之地' } }),
    })
    expect(out.decisions.e1!.activated).toBe(true)
  })
})

describe('§25 probability 概率掷骰', () => {
  it('chance 缺省 100 恒过', () => {
    const out = activateWorldbook({ entries: [entry({ keys: ['剑宗'] })], runtimeState: {}, scan, context: ctx(), rng: () => 1 })
    expect(out.decisions.e1!.activated).toBe(true)
  })
  it('chance 低于 rng → 未通过(reason=probability, 未激活)', () => {
    const e = entry({ keys: ['剑宗'], chance: 30 })
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx(), rng: () => 0.5 })
    expect(out.decisions.e1!.activated).toBe(false)
    expect(out.decisions.e1!.reason).toBe('probability')
  })
  it('chance 高于 rng → 通过', () => {
    const e = entry({ keys: ['剑宗'], chance: 80 })
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx(), rng: () => 0.5 })
    expect(out.decisions.e1!.activated).toBe(true)
  })
})

describe('§27/§28 sticky / cooldown / delay 定时效应', () => {
  it('sticky: 激活后 stickyRounds 内在后续轮维持激活(reason=sticky)', () => {
    const e = entry({ keys: ['剑宗'], stickyRounds: 2 })
    const first = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx({ sequence: 1 }) })
    expect(first.decisions.e1!.reason).toBe('keyword')
    // 轮 2、3 在 stickyUntil=3 窗口内;关键词不再命中仍激活
    const st = (n: number) =>
      activateWorldbook({
        entries: [entry({ keys: ['无'] })],
        runtimeState: { e1: { stickyUntilSeq: 3, cooldownUntilSeq: null, delayUntilSeq: null } },
        scan,
        context: ctx({ sequence: n }),
      })
    expect(st(2).decisions.e1!.reason).toBe('sticky')
    expect(st(3).decisions.e1!.activated).toBe(true)
    expect(st(4).decisions.e1!.activated).toBe(false)
  })

  it('cooldown: 激活后冷却窗口内关键词不重新激活', () => {
    const e = entry({ keys: ['剑宗'], cooldown: 3 })
    const soft = 0.0
    const out = activateWorldbook({
      entries: [e],
      runtimeState: { e1: { stickyUntilSeq: null, cooldownUntilSeq: 3, delayUntilSeq: null } },
      scan,
      context: ctx({ sequence: 2 }),
      rng: () => soft,
    })
    expect(out.decisions.e1!.activated).toBe(false)
  })

  it('delay: 命中后 delay 轮内延迟注入,窗口后激活', () => {
    const e = entry({ keys: ['剑宗'], delay: 1 })
    const inside = activateWorldbook({
      entries: [e],
      runtimeState: { e1: { stickyUntilSeq: null, cooldownUntilSeq: null, delayUntilSeq: 2 } },
      scan,
      context: ctx({ sequence: 1 }),
    })
    expect(inside.decisions.e1!.activated).toBe(false)
    const after = activateWorldbook({
      entries: [entry({ keys: ['剑宗'] })],
      runtimeState: {},
      scan,
      context: ctx({ sequence: 2 }),
    })
    expect(after.decisions.e1!.activated).toBe(true)
  })
})

describe('§26 group 组计分', () => {
  it('maxScore: 组内只保留权重最高者,其余抑制(reason=group)', () => {
    const a = entry({ id: 'a', keys: ['剑宗'], group: { id: 'g', override: false, weight: 10, scoring: true } })
    const b = entry({ id: 'b', keys: ['星辰'], group: { id: 'g', override: false, weight: 30, scoring: true } })
    const out = activateWorldbook({ entries: [a, b], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.b!.activated).toBe(true) // 权重 30 胜出
    expect(out.decisions.a!.activated).toBe(false)
    expect(out.decisions.a!.reason).toBe('group')
  })

  it('group.override 条目强制保留并抑制同组其余', () => {
    const override = entry({ id: 'o', keys: ['剑宗'], group: { id: 'g', override: true, weight: 1, scoring: true } })
    const heavy = entry({ id: 'w', keys: ['星辰'], group: { id: 'g', override: false, weight: 100, scoring: true } })
    const out = activateWorldbook({ entries: [heavy, override], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.o!.activated).toBe(true)
    expect(out.decisions.w!.activated).toBe(false)
  })

  it('非 scoring 条目不参与组抑制', () => {
    const a = entry({ id: 'a', keys: ['剑宗'], group: { id: 'g', override: false, weight: 10, scoring: true } })
    const lone = entry({ id: 'lone', keys: ['星辰'], group: { id: 'g', override: false, weight: 100, scoring: false } })
    const out = activateWorldbook({ entries: [a, lone], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.lone!.activated).toBe(true) // 不计分故不被抑制
  })
})

describe('§25 recursive 递归扫描', () => {
  // 递归测试用独立消息域 — 不出现任何递归触发词,确保 B 只可能在递归文本池命中
  const recCtx = () => ctx({ messages: [{ id: 'rm', role: 'user', content: '剑宗驻守山门。' }] })
  it('递归: 命中条目 A 以其 keys 作为文本源命中 B(reason=recursive)', () => {
    // A 在消息命中"剑宗"→ 激活;A 的 keys 含"神秘词汇",激活后并入递归文本池,
    // B(keys=['神秘词汇'])只可能被递归命中。
    const a = entry({ id: 'a', keys: ['剑宗', '神秘词汇'] })
    const b = entry({ id: 'b', keys: ['神秘词汇'] })
    const out = activateWorldbook({
      entries: [a, b],
      runtimeState: {},
      scan: { ...scan, recursive: true },
      context: recCtx(),
    })
    expect(out.decisions.a!.activated).toBe(true)
    expect(out.decisions.b!.activated).toBe(true)
    expect(out.decisions.b!.reason).toBe('recursive')
  })
  it('excludeRecursion: 该条目不被递归激活', () => {
    const a = entry({ id: 'a', keys: ['剑宗', '神秘词汇'] })
    const e = entry({ id: 'ex', keys: ['神秘词汇'], recursion: { excluded: true, prevent: false, delayedUntil: false } })
    const out = activateWorldbook({ entries: [a, e], runtimeState: {}, scan: { ...scan, recursive: true }, context: recCtx() })
    expect(out.decisions.a!.activated).toBe(true)
    expect(out.decisions.ex!.activated).toBe(false)
  })
})

describe('§25 UNSUPPORTED_SEMANTIC 未实现语义', () => {
  it('vectorized 模式产出诊断且不静默激活', () => {
    const e = entry({ mode: 'vectorized', keys: ['剑宗'] })
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(false)
    expect(out.diagnostics.some((d) => d.code === 'UNSUPPORTED_SEMANTIC')).toBe(true)
  })
  it('triggers 非空产出 UNSUPPORTED_SEMANTIC', () => {
    const e = entry({ keys: ['剑宗'], triggers: ['t'] })
    const out = activateWorldbook({ entries: [e], runtimeState: {}, scan, context: ctx() })
    expect(out.decisions.e1!.activated).toBe(false)
    expect(out.diagnostics.some((d) => d.code === 'UNSUPPORTED_SEMANTIC')).toBe(true)
  })
})