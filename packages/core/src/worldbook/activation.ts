/**
 * Worldbook Activation Pipeline —— compiler-spec §23 Activation Pipeline、§24 Result、
 * §25 Compatibility、§26 Group、§27 Sticky、§28 Cooldown 的 P1 实现。
 *
 * 阶段边界(S11/WP1.2):本模块只做 **Activation**(§23.1)——从 Recent Messages + Character +
 * Worldbook + Scan Depth + Runtime State 算出激活条目集;Packaging 与 Cache 分区(P2,
 * worldbook-cache-design §2)不在这里。compile() 消费激活结果并接到 freshWB/injection。
 *
 * 纯函数零 IO:注入 RNG(概率掷骰可复现)、注入 sequence(sticky/cooldown/delay 以轮序判定,
 * 非 wall-clock)使其可测、可回放。
 *
 * 未实现的兼容语义(vectorized/triggers 需 embedding;characterFilter 深层对象)按 §25
 * 产出 UNSUPPORTED_SEMANTIC 诊断,不得静默忽略。scan.budget 的超预算裁剪留 P2
 * (implementation-plan §5 挂账:Budget 裁剪 P2 起),本模块仅读取字段。
 */

import type { WorldbookPosition } from '@whispertavern/contracts'
import type { Diagnostic } from '@whispertavern/contracts'

/** 条目激活描述(激活器视角,非资产文件视角)——调用方从 worldbook_entries 行/资产投影 */
export interface ActivationDescriptor {
  id: string
  enabled: boolean
  mode: 'constant' | 'selective' | 'vectorized'
  keys: readonly string[]
  secondaryKeys: readonly string[]
  logic: 'andAny' | 'andAll' | 'notAny' | 'notAll'
  /** 命中后进入 prompt 的概率(0-100);缺省 100 = 恒过 */
  chance: number
  /** 六个 match* 合并:仅列 true 的项;空 = 默认扫描域 = Recent Messages */
  matchScope: readonly string[]
  /** 条目级可空覆盖:null = 跟随书级 scan */
  scanDepthOverride: number | null
  caseSensitiveOverride: boolean | null
  wholeWordOverride: boolean | null
  stickyRounds: number
  cooldown: number
  delay: number
  recursion: {
    excluded: boolean
    prevent: boolean
    delayedUntil: boolean
  }
  group: {
    id: string | null
    override: boolean
    weight: number
    scoring: boolean
  }
  triggers: readonly string[]
  characterFilter: unknown
  /** semantic placement 槽位(§23.2 排位依据;激活层附带不参与判定) */
  slot: WorldbookPosition
  order: number
}

/** 扫描参数(书级 scan;条目级 override 优先) */
export interface ScanParameters {
  scanDepth: number | null
  caseSensitive: boolean | null
  wholeWord: boolean | null
  recursive: boolean
  /** P2 前仅读取不做裁剪(implementation-plan §5) */
  budgetPercent?: number
  budgetCap?: number
}

/** 运行时状态(§27/§28:sticky/cooldown/delay 属 Runtime State,不是 Prompt Segment) */
export interface ActivationRuntimeState {
  /** sticky 维持到含该轮序 */
  stickyUntilSeq: number | null
  /** 冷却到不含该轮序 */
  cooldownUntilSeq: number | null
  /** 命中后延迟注入到不含该轮序;delayUntilRecursion 的递归命中也落此 */
  delayUntilSeq: number | null
}

export interface ScanMessage {
  id: string
  role: string
  content: string
}

export interface ScanContext {
  /** 本轮轮序(单调) */
  sequence: number
  /** Recent Messages(调用方已按 scanDepth 截取前段) */
  messages: readonly ScanMessage[]
  /** matchScope 附加域:名字 → 文本(六 match*) */
  auxiliary: Readonly<Record<string, string>>
  /** 当前角色(characterFilter 用) */
  character?: { id: string }
}

export type ActivationReason = 'keyword' | 'sticky' | 'group' | 'recursive' | 'manual' | 'probability'

/** 单条条目本轮决策(§24 语义投影 + 状态建议) */
export interface ActivationDecision {
  entryId: string
  activated: boolean
  reason: ActivationReason | null
  matchedKeywords: readonly string[]
  sourceMessageIds: readonly string[]
  /** 组计分/递归的来源权重(§24 score) */
  score?: number
  /** Activation Engine 据建议落库 §15;本模块纯计算,Engine 才写 DB */
  stateDelta: {
    stickyUntilSeq: number | null | undefined
    cooldownUntilSeq: number | null | undefined
    delayUntilSeq: number | null | undefined
  }
}

export interface WorldbookActivationInput {
  entries: readonly ActivationDescriptor[]
  runtimeState: Readonly<Record<string, ActivationRuntimeState>>
  scan: ScanParameters
  context: ScanContext
  /** 缺省 Math.random;测试注入固定 rng 保证概率可复现 */
  rng?: () => number
}

export interface WorldbookActivationOutput {
  decisions: Readonly<Record<string, ActivationDecision>>
  diagnostics: readonly Diagnostic[]
}

/** 递归迭代深度上限(防环;ST 未给硬界,本项目取 3 层缓冲) */
const RECURSION_MAX_DEPTH = 3

export function activateWorldbook(input: WorldbookActivationInput): WorldbookActivationOutput {
  const rng = input.rng ?? Math.random
  const diagnostics: Diagnostic[] = []
  const decisions: Record<string, ActivationDecision> = {}
  const groupPool = new Map<string, { id: string; weight: number; override: boolean }[]>()

  // —— 第一遍:直通判定(constant/sticky gate/关键词/概率)——
  for (const entry of input.entries) {
    decisions[entry.id] = decide(entry, input, rng, diagnostics)
    const groupId = entry.group.id
    const d = decisions[entry.id]!
    if (groupId !== null && entry.group.scoring && d.activated && d.reason !== 'sticky') {
      const pool = groupPool.get(groupId) ?? []
      pool.push({ id: entry.id, weight: entry.group.weight, override: entry.group.override })
      groupPool.set(groupId, pool)
    }
  }

  // —— 第二遍:group 选择(§26:maxScore + override)——
  for (const pool of groupPool.values()) applyGroupSelection(pool, decisions)

  // —— 第三遍:递归重扫(用已激活条目 keys 作额外文本强制命中)——
  if (input.scan.recursive) applyRecursion(input, decisions, diagnostics)

  return { decisions, diagnostics }
}

/** 单条目判定;仅维护本条 decisions 局部状态,group/递归在其后叠加 */
function decide(
  entry: ActivationDescriptor,
  input: WorldbookActivationInput,
  rng: () => number,
  diagnostics: Diagnostic[],
): ActivationDecision {
  const base = baseDecision(entry)
  if (!entry.enabled) return base
  const state: ActivationRuntimeState | undefined = input.runtimeState[entry.id]
  const seq = input.context.sequence

  // —— delay 窗:命中后 delay 轮才实质注入(§25 delay)——
  if (state?.delayUntilSeq !== undefined && state?.delayUntilSeq !== null && seq < state.delayUntilSeq) return base

  // —— sticky:持续窗内无条件激活(§27,无视关键词与 cooldown)——
  if (state?.stickyUntilSeq !== null && state?.stickyUntilSeq !== undefined && seq <= state.stickyUntilSeq) {
    return { ...base, activated: true, reason: 'sticky', score: 1 }
  }

  // —— cooldown:冷却窗内不因关键词重新激活(§28;sticky 已覆盖) ——
  if (state?.cooldownUntilSeq !== null && state?.cooldownUntilSeq !== undefined && seq < state.cooldownUntilSeq) return base

  // —— constant:蓝灯常驻(无关键词;reason=manual:非自动触发注入)——
  if (entry.mode === 'constant') {
    return { ...base, activated: true, reason: 'manual', score: 1, stateDelta: schedule(entry, seq) }
  }

  // —— vectorized / triggers:需 embedding(P1 无)→ UNSUPPORTED_SEMANTIC(§25)——
  if (entry.mode === 'vectorized' || entry.triggers.length > 0) {
    diagnostics.push({
      level: 'warning',
      code: 'UNSUPPORTED_SEMANTIC',
      message: 'vectorized 模式/向量触发词需 embedding,P1 未实现(compiler-spec §25)',
      segmentId: entry.id,
      details: { unsupported: 'vectorized' },
    })
    return base
  }

  // —— selective:关键词匹配(primary → secondary)——
  const resolved = { caseSensitive: entry.caseSensitiveOverride ?? input.scan.caseSensitive ?? false, wholeWord: entry.wholeWordOverride ?? input.scan.wholeWord ?? false }
  const scanTexts = scanDomains(entry, input)
  const hit = keywordHit(entry, scanTexts, resolved)
  if (hit === null) return base

  // —— probability:chance%(§25;100 恒过)——
  const pass = rollChance(entry.chance, rng)
  if (!pass) return { ...base, reason: 'probability' }

  return { ...base, activated: true, reason: 'keyword', matchedKeywords: hit.keys, sourceMessageIds: hit.sourceIds, score: 1, stateDelta: schedule(entry, seq) }
}

function baseDecision(entry: ActivationDescriptor): ActivationDecision {
  return {
    entryId: entry.id,
    activated: false,
    reason: null,
    matchedKeywords: [],
    sourceMessageIds: [],
    stateDelta: { stickyUntilSeq: undefined, cooldownUntilSeq: undefined, delayUntilSeq: undefined },
  }
}

/** 激活后的状态排程(§27/§28):stickyUntil=seq+stickyRounds(>0 才设)、cooldownUntil=seq+cooldown */
function schedule(entry: ActivationDescriptor, sequence: number): ActivationDecision['stateDelta'] {
  return {
    stickyUntilSeq: entry.stickyRounds > 0 ? sequence + entry.stickyRounds : null,
    cooldownUntilSeq: entry.cooldown > 0 ? sequence + entry.cooldown : null,
    delayUntilSeq: entry.delay > 0 ? sequence + entry.delay : null,
  }
}

/** 扫描文本域:Recent Messages(+按 scanDepth 截取不在此,调用方已截) + matchScope auxiliary */
function scanDomains(entry: ActivationDescriptor, input: WorldbookActivationInput): readonly ScanMessage[] {
  const texts: ScanMessage[] = input.context.messages.slice()
  for (const name of entry.matchScope) {
    const auxiliary = input.context.auxiliary[name]
    if (auxiliary !== undefined) texts.push({ id: `aux:${name}`, role: 'aux', content: auxiliary })
  }
  return texts
}

interface Hit {
  keys: readonly string[]
  sourceIds: readonly string[]
}

/** 主键命中即返回;否则尝试副键(§23.1 行为顺序) */
function keywordHit(entry: ActivationDescriptor, texts: readonly ScanMessage[], resolved: { caseSensitive: boolean; wholeWord: boolean }): Hit | null {
  if (entry.keys.length > 0) {
    const hit = matchKeys(entry.keys, entry.logic, texts, resolved)
    if (hit !== null) return hit
  }
  if (entry.secondaryKeys.length > 0) {
    const hit = matchKeys(entry.secondaryKeys, entry.logic, texts, resolved)
    if (hit !== null) return hit
  }
  return null
}

/** 按 logic(ANY/ALL/NOT)匹配一组键 */
function matchKeys(keys: readonly string[], logic: ActivationDescriptor['logic'], texts: readonly ScanMessage[], resolved: { caseSensitive: boolean; wholeWord: boolean }): Hit | null {
  const found: string[] = []
  const sourceIds: string[] = []
  for (const text of texts) {
    for (const key of keys) {
      if (contains(text.content, key, resolved.caseSensitive, resolved.wholeWord) && !found.includes(key)) {
        found.push(key)
        if (!sourceIds.includes(text.id)) sourceIds.push(text.id)
      }
    }
  }
  switch (logic) {
    case 'andAny':
      return found.length > 0 ? { keys: found, sourceIds } : null
    case 'andAll':
      return keys.every((k) => found.includes(k)) ? { keys: found, sourceIds } : null
    case 'notAny':
      return found.length === 0 ? { keys: [], sourceIds: [] } : null
    case 'notAll':
      return found.length < keys.length ? { keys: [], sourceIds: [] } : null
  }
}

/** 大小写 + 全词包含(§25);全词用词边界否定断言 */
function contains(haystack: string, needle: string, caseSensitive: boolean, wholeWord: boolean): boolean {
  const text = caseSensitive ? haystack : haystack.toLocaleLowerCase()
  const key = caseSensitive ? needle : needle.toLocaleLowerCase()
  if (!wholeWord) return text.includes(key)
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(text)
}

/** chance%(0-100):注入 rng 返回[0,1) */
function rollChance(chance: number, rng: () => number): boolean {
  if (chance >= 100) return true
  if (chance <= 0) return false
  return rng() * 100 < chance
}

/** §26 组选择:override 条目强制保留并抑制他人;否则只留权重最高者 */
function applyGroupSelection(pool: { id: string; weight: number; override: boolean }[], decisions: Record<string, ActivationDecision>): void {
  const hasOverride = pool.some((p) => p.override)
  const first = pool[0]!
  const winner = pool.reduce((best, member) => (hasOverride ? (member.override && !best.override ? member : best) : member.weight > best.weight ? member : best), first)
  for (const member of pool) {
    const keep = hasOverride ? member.override : member.id === winner.id
    if (keep) continue
    decisions[member.id] = { ...decisions[member.id]!, activated: false, reason: 'group', matchedKeywords: [] }
  }
}

/**
 * 递归重扫(§25 recursive + exclude/prevent/delayUntilRecursion):把已激活条目的 keys
 * 并入额外文本池,对"未激活且允许被递归命中"的条目再跑关键词。迭代至无新增或深度上限。
 */
function applyRecursion(input: WorldbookActivationInput, decisions: Record<string, ActivationDecision>, _diagnostics: Diagnostic[]): void {
  const extra: ScanMessage[] = []
  const activatedIds = new Set<string>()
  for (let depth = 0; depth < RECURSION_MAX_DEPTH; depth++) {
    // 用当前已激活、未 prevent/exclude 的条目 keys 作递归文本源
    const candidates = input.entries.filter((e) => {
      const decision = decisions[e.id]
      return decision?.activated && !e.recursion.excluded && !e.recursion.prevent && !e.recursion.delayedUntil
    })
    const before = activatedIds.size
    for (const entry of candidates) {
      if (activatedIds.has(entry.id)) continue
      activatedIds.add(entry.id)
      if (entry.keys.length > 0) extra.push({ id: `rec:${entry.id}`, role: 'aux', content: entry.keys.join(' ') })
    }
    if (activatedIds.size === before) break
    // 用扩大的文本池对未激活条目重扫
    const texts = input.context.messages.concat(extra)
    for (const entry of input.entries) {
      const current = decisions[entry.id]!
      if (current.activated) continue
      if (entry.recursion.excluded) continue
      // delayedUntilRecursion:仅当被递归文本命中才激活(普通扫描已跳过其 keys)
      const resolved = { caseSensitive: entry.caseSensitiveOverride ?? input.scan.caseSensitive ?? false, wholeWord: entry.wholeWordOverride ?? input.scan.wholeWord ?? false }
      const hit = matchKeys(entry.keys, entry.logic, texts, resolved)
      if (hit === null) continue
      decisions[entry.id] = {
        ...current,
        activated: true,
        reason: 'recursive',
        matchedKeywords: hit.keys,
        sourceMessageIds: hit.sourceIds,
        score: 1,
        stateDelta: schedule(entry, input.context.sequence),
      }
    }
  }
}