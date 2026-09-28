import type {
  CacheBreakReason,
  PromptContribution,
  PromptIR,
  PromptRole,
  SnapshotId,
  Timestamp,
} from '@whispertavern/contracts'
import type { DeepReadonly } from '../ir/segment'
import type { RuntimeVariables } from '../macro/types'
import { estimateTokens } from '../tokens/estimate'
import { simulateCachePlan, type CacheSimRound, type CacheSimulatorReport } from './cache-simulator'
import { compile } from './pipeline'
import { computePrefixCarry } from './prefix-carry'

/**
 * Cache Scenario Replay —— S21(WP2.6)确定性回放(p2-plan §8 任务 2 + api-spec §43 scenarios)。
 *
 * 定位:api-spec §43 的 `scenarios` 字段(P2 阶段一直回显在 `unsupportedScenarios`)在此落地。
 * 它回答"**继续这样跑 N 轮、期间发生这些事件,缓存表现如何**"——零 Provider 调用、零 DB、
 * 零时钟零随机(X10),同一输入逐字节同输出。
 *
 * ## 与 S20 真实快照回放的边界(不许混为一谈)
 * - S20(`POST /cache/simulate` 无 scenarios):只消费该 chat **已编译快照**序列,不虚构数据;
 * - 本模块(scenarios 非空):按声明的场景族**合成**确定性轮次脚本,喂**真实 `compile()`**
 *   ——排序/分区/宏规则/预算/CachePlan 全部走生产代码。本模块自持的模型只有一处:
 *   世界书条目"本轮新增 → 轮末毕业"(§2.1/§22 入册语义)。此边界必须常记,防把模拟当生产证据。
 *
 * ## KPI 口径(§2.2,与 S20 `theoreticalHitRatio` 不是同一个量)
 * S20 口径只算 header+stableWB 的**连续稳定前缀**;本模块 `hitRatio` 按 §2.2 端到端口径
 * ——缓存承接 = **与前轮逐字节一致的连续字节前缀**,故自然含 append-only 的历史
 * (这正是 §2.2 声称 60–90% 的来源)。两套口径并列输出,绝不互相冒充(§33.2 精神)。
 *
 * ## 事件"声明"语义(二道门禁的判据)
 * 每轮场景都会把对应 `CacheBreakReason` 注入 `compile(cacheInvalidations)`。门禁判"未声明失效"
 * 的口径:**既无本轮场景、又无上轮场景**的轮次里出现原因码或前缀分歧 = 未声明(红灯)。
 * 允许"上轮场景"是因为一次变更会跨两轮显形(触发轮改变字节、恢复轮回到常态)。
 */

/** api-spec §43 scenarios 的八类场景(名字即线格式,不得改写) */
export const CACHE_SCENARIOS = [
  'worldbook-activation',
  'worldbook-edit',
  'macro',
  'swipe',
  'branch',
  'summary',
  'budget',
  'group',
] as const

export type CacheScenarioName = (typeof CACHE_SCENARIOS)[number]

export function isCacheScenarioName(value: unknown): value is CacheScenarioName {
  return typeof value === 'string' && (CACHE_SCENARIOS as readonly string[]).includes(value)
}

/**
 * 确定性触发排程(质数周期 → 100/1000 轮下事件分布稳定且互不共振)。
 * 第 r 轮触发 iff r >= first ∧ (r − first) % period === 0。
 */
const SCHEDULE: Record<CacheScenarioName, { first: number; period: number }> = {
  'worldbook-activation': { first: 5, period: 97 },
  'worldbook-edit': { first: 11, period: 89 },
  macro: { first: 17, period: 83 },
  swipe: { first: 23, period: 79 },
  branch: { first: 29, period: 73 },
  summary: { first: 35, period: 71 },
  budget: { first: 41, period: 67 },
  group: { first: 47, period: 61 },
}

/** 场景 → 其**声明**的失效原因族(§58 CacheBreakReason.type);budget 无原因码(§42 注),靠"裁尾部零分歧"自证 */
const SCENARIO_BREAK_TYPES: Record<CacheScenarioName, readonly string[]> = {
  'worldbook-activation': ['WORLD_BOOK_NEW_ENTRY'],
  'worldbook-edit': ['WORLD_BOOK_CONTENT_CHANGED'],
  macro: ['MACRO_VOLATILE'],
  swipe: ['MESSAGE_EDITED'],
  branch: ['BRANCH_SWITCHED', 'MESSAGE_EDITED'],
  summary: ['SUMMARY_CHECKPOINT'],
  budget: [],
  group: ['CHARACTER_CHANGED', 'PERSONA_CHANGED'],
}

export interface CacheScenarioReplayInput {
  /** 回放轮数(§43 rounds) */
  rounds: number
  /** 启用的场景族(空数组 = 纯稳态,无事件) */
  scenarios: readonly CacheScenarioName[]
  /** §47 可用上下文上限(缺省 131072) */
  maxContextTokens?: number
}

export interface CacheScenarioRoundResult {
  round: number
  /** 本轮触发的场景 */
  applied: CacheScenarioName[]
  /** 本轮**声明**的失效原因(CacheBreakReason.type) */
  declaredBreaks: string[]
  stableTokens: number
  freshTokens: number
  volatileTokens: number
  /** 本轮计划输入总量(plan 计 = stable + fresh + volatile) */
  planInputTokens: number
  /** 被预算裁掉的段数(>0 = Budget Manager 本轮真实出手) */
  trimmedSegments: number
  /** 本轮 serialized 全量哈希 */
  prefixHash: string
  /** §2.2 口径缓存承接 token(与前轮共享的连续字节前缀) */
  cachedTokens: number
  /** 本轮相对上轮的首个断裂段 ID(无断裂 = null;供诊断/二分复用) */
  firstDivergence: string | null
  /** 未声明的失效(空 = 无意外 CacheBreak)——二道门禁的断言主体 */
  unexpectedBreaks: string[]
}

export interface CacheScenarioReplayReport {
  rounds: CacheScenarioRoundResult[]
  /** §2.2 KPI:Σ 承接 / Σ 计划输入 */
  hitRatio: number
  /** §2.2 KPI:1 − Σ 新鲜 / Σ 计划输入 */
  costReduction: number
  /** 未声明失效总数(应为 0;>0 即门禁红) */
  unexpectedBreakTotal: number
  /** S20 兼容视图:stablePrefix 口径 + Cache Killer 统计(与上面 KPI 是两套口径,不相加减) */
  simulator: CacheSimulatorReport
}

interface SimEntry {
  id: string
  tokens: number
}

interface SimMessage {
  id: string
  role: PromptRole
  tokens: number
}

interface SimWorld {
  /** 已入册(round 1 起即 stableWB 成员) */
  admitted: SimEntry[]
  /** 本轮新增或内容变更(freshWB),轮末毕业并入 admitted */
  fresh: SimEntry[]
  entryGen: Map<string, number>
  /** volatile 宏段的位置:'none' 未出现 / 'header' 首轮(管线会移位并告警)/ 'tail' 已隔离后的常态 */
  macroPlacement: 'none' | 'header' | 'tail'
  summaries: number
  history: SimMessage[]
  /** header 作用域代次(group 换人 → header 字节变化) */
  headerGen: number
  maxContextTokens: number
  activationCount: number
}

const CJK = '字'

/** 确定性正文:token 数 ≈ tokens(全角 1 token/字);tag 保证不同代次/轮次则字节不同 */
function bodyOf(tokens: number, tag: string): string {
  return `${tag}|${CJK.repeat(Math.max(1, tokens))}`
}

function entryContent(world: SimWorld, entry: SimEntry): string {
  return bodyOf(entry.tokens, `${entry.id}@v${world.entryGen.get(entry.id) ?? 1}`)
}

// 合成世界的规模参数。段**数量**保持结构真实(每轮 +2 段历史、世界书按事件增删),
// 但每段正文刻意压到小体积:千轮门禁的成本 ∝ Σ 段字节(见 cacheplan/budget/hash 的
// O(n) 化注释),体积不必要地大只会把门禁拖成分钟级而换不来结构保真。
const SIM_WORLD_GEN = {
  presetSegments: 6,
  presetSegmentTokens: 60,
  systemTokens: 30,
  personaTokens: 40,
  entryTokens: 70,
  baselineEntries: 4,
  injectionTokens: 20,
  tailTokens: 20,
  summaryTokens: 60,
  // 每轮 24 tok:1000 轮 ≈ 2.4 万 ≪ 缺省 131072 → 纯稳态不会被预算被动裁剪
  // (被动裁剪会动稳定前缀,制造非声明分歧,污染门禁结论)
  userTokens: 10,
  assistantTokens: 14,
}

function createWorld(maxContextTokens: number): SimWorld {
  const admitted: SimEntry[] = []
  for (let i = 0; i < SIM_WORLD_GEN.baselineEntries; i += 1) {
    admitted.push({ id: `wb-base-${i + 1}`, tokens: SIM_WORLD_GEN.entryTokens })
  }
  return {
    admitted,
    fresh: [],
    entryGen: new Map(),
    macroPlacement: 'none',
    summaries: 0,
    history: [],
    headerGen: 1,
    maxContextTokens,
    activationCount: 0,
  }
}

function header(world: SimWorld): PromptContribution[] {
  const out: PromptContribution[] = [
    {
      id: 'header:system',
      source: { type: 'runtime', key: 'sim-system' },
      segment: { role: 'system', content: bodyOf(SIM_WORLD_GEN.systemTokens, 'sys'), zone: 'header' },
      priority: 0,
      semanticPlacement: { type: 'header', order: 0 },
    },
    {
      id: 'header:persona',
      source: { type: 'persona', assetId: 'sim-persona' },
      segment: {
        role: 'system',
        content: bodyOf(SIM_WORLD_GEN.personaTokens, `persona-g${world.headerGen}`),
        zone: 'header',
      },
      priority: 0,
      semanticPlacement: { type: 'header', order: 1 },
    },
  ]
  for (let i = 0; i < SIM_WORLD_GEN.presetSegments; i += 1) {
    out.push({
      id: `preset:seg-${i + 1}`,
      source: { type: 'preset', presetId: 'sim-preset', segmentId: `seg-${i + 1}` },
      segment: {
        role: 'system',
        content: bodyOf(SIM_WORLD_GEN.presetSegmentTokens, `seg${i + 1}`),
        zone: 'header',
      },
      priority: 0,
      semanticPlacement: { type: 'header', order: 10 + i },
    })
  }
  if (world.macroPlacement === 'header') {
    out.push({
      id: 'header:macro',
      source: { type: 'runtime', key: 'sim-macro' },
      segment: { role: 'system', content: '进度骰:{{random}}', zone: 'header' },
      priority: 0,
      semanticPlacement: { type: 'header', order: 90 },
    })
  }
  return out
}

function worldbookZone(world: SimWorld): PromptContribution[] {
  const mk = (entry: SimEntry, zone: 'stableWB' | 'freshWB', order: number): PromptContribution => ({
    id: `worldbook:${entry.id}`,
    source: { type: 'worldbook', worldbookId: 'sim-wb', entryId: entry.id },
    segment: { role: 'system', content: entryContent(world, entry), zone },
    priority: 0,
    semanticPlacement: { type: 'worldbook', position: 'before', order },
  })
  return [
    ...world.admitted.map((e, i) => mk(e, 'stableWB', i)),
    ...world.fresh.map((e, i) => mk(e, 'freshWB', 100 + i)),
  ]
}

function volatileZones(world: SimWorld): PromptContribution[] {
  const out: PromptContribution[] = [
    {
      id: 'injection:depth-1',
      source: { type: 'runtime', key: 'sim-injection' },
      segment: { role: 'system', content: bodyOf(SIM_WORLD_GEN.injectionTokens, 'inj'), zone: 'injection' },
      priority: 0,
      semanticPlacement: { type: 'injection', depth: 4, order: 0 },
    },
    {
      id: 'tail:volatile',
      source: { type: 'runtime', key: 'sim-tail' },
      segment: { role: 'system', content: bodyOf(SIM_WORLD_GEN.tailTokens, 'tail'), zone: 'tail' },
      priority: 0,
      semanticPlacement: { type: 'tail', order: 0 },
    },
  ]
  if (world.macroPlacement === 'tail') {
    out.push({
      id: 'header:macro',
      source: { type: 'runtime', key: 'sim-macro' },
      segment: { role: 'system', content: '进度骰:{{random}}', zone: 'tail' },
      priority: 0,
      semanticPlacement: { type: 'tail', order: 90 },
    })
  }
  for (let i = 0; i < world.summaries; i += 1) {
    out.push({
      id: `summary:block-${i + 1}`,
      source: { type: 'summary', summaryId: `sim-summary-${i + 1}` },
      segment: {
        role: 'system',
        content: bodyOf(SIM_WORLD_GEN.summaryTokens, `sum${i + 1}`),
        zone: 'summary',
      },
      priority: 0,
      semanticPlacement: { type: 'history', order: i },
    })
  }
  return out
}

function historyZone(world: SimWorld): PromptContribution[] {
  return world.history.map((m, i) => ({
    id: `message:${m.id}`,
    source: { type: 'message', messageId: m.id },
    segment: { role: m.role, content: bodyOf(m.tokens, m.id), zone: 'history' as const },
    priority: 0,
    semanticPlacement: { type: 'history' as const, order: i },
  }))
}

function buildRoundContributions(world: SimWorld): PromptContribution[] {
  return [...header(world), ...worldbookZone(world), ...volatileZones(world), ...historyZone(world)]
}

function firedScenarios(round: number, enabled: readonly CacheScenarioName[]): CacheScenarioName[] {
  return enabled.filter((name) => {
    const s = SCHEDULE[name]
    return round >= s.first && (round - s.first) % s.period === 0
  })
}

/** 推进本轮世界状态;返回本轮**声明**的失效原因(交 compile 注入 cacheInvalidations) */
function applyRound(world: SimWorld, round: number, applied: readonly CacheScenarioName[]): CacheBreakReason[] {
  const declared: CacheBreakReason[] = []
  for (const name of applied) {
    switch (name) {
      case 'worldbook-activation': {
        world.activationCount += 1
        const entry: SimEntry = { id: `wb-new-${world.activationCount}`, tokens: SIM_WORLD_GEN.entryTokens }
        world.fresh.push(entry)
        declared.push({ type: 'WORLD_BOOK_NEW_ENTRY', entryId: entry.id, tokenDelta: entry.tokens })
        break
      }
      case 'worldbook-edit': {
        const target = world.admitted[round % world.admitted.length]
        if (target !== undefined) {
          // 内容变更 → 哈希失效 → 退出已入册集、重注入(§2.1:不在 chatCache 即 fresh)
          world.admitted = world.admitted.filter((e) => e.id !== target.id)
          world.entryGen.set(target.id, (world.entryGen.get(target.id) ?? 1) + 1)
          world.fresh.push(target)
          declared.push({ type: 'WORLD_BOOK_CONTENT_CHANGED', entryId: target.id })
        }
        break
      }
      case 'macro':
        // 首轮声明在 header → 真实 Macro Cache Rule 会整段移到 tail 并告警;此后常驻 tail(不再告警)
        world.macroPlacement = 'header'
        break
      case 'swipe': {
        const last = world.history[world.history.length - 1]
        if (last !== undefined && last.role === 'assistant') {
          last.tokens = SIM_WORLD_GEN.assistantTokens + 40
          declared.push({ type: 'MESSAGE_EDITED', messageId: last.id })
        }
        break
      }
      case 'branch': {
        // 从较早的点分叉:回退两点历史 + 追加替代回复(历史不再是对上轮的延长)
        const from = world.history[world.history.length - 3]
        world.history.splice(-2, 2)
        world.history.push({ id: `msg-r${round}-alt`, role: 'assistant', tokens: 140 })
        declared.push({
          type: 'BRANCH_SWITCHED',
          fromMessageId: from?.id ?? 'root',
          toMessageId: `msg-r${round}-alt`,
        })
        break
      }
      case 'summary':
        world.summaries += 1
        declared.push({ type: 'SUMMARY_CHECKPOINT', summaryId: `sim-summary-${world.summaries}` })
        break
      case 'budget':
        // 无原因码(api-spec §42 注):本场景只压掉尾部,见主循环 override 计算
        break
      case 'group':
        world.headerGen += 1
        declared.push({ type: 'CHARACTER_CHANGED', characterId: `sim-char-${world.headerGen}` })
        break
    }
  }
  return declared
}

function advanceHistory(world: SimWorld, round: number): void {
  world.history.push({ id: `u${round}`, role: 'user', tokens: SIM_WORLD_GEN.userTokens })
  world.history.push({ id: `a${round}`, role: 'assistant', tokens: SIM_WORLD_GEN.assistantTokens })
}

/** 轮末:本轮 fresh 毕业并入 admitted(§2.1/§22;因 freshWB 紧邻 stableWB 尾部,毕业字节原位不动) */
function graduate(world: SimWorld): void {
  world.admitted.push(...world.fresh)
  world.fresh = []
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

const SIM_VARIABLES: RuntimeVariables = {
  user: 'User',
  char: 'Sim',
  sessionId: 'sim-session',
  chatId: 'sim-chat',
  custom: {},
}

export function replayCacheScenarios(input: CacheScenarioReplayInput): CacheScenarioReplayReport {
  const world = createWorld(input.maxContextTokens ?? 131_072)
  const rounds = Math.max(0, Math.floor(input.rounds))
  const enabled = input.scenarios.filter(isCacheScenarioName)

  const results: CacheScenarioRoundResult[] = []
  const simRounds: CacheSimRound[] = []
  let prevIr: DeepReadonly<PromptIR> | undefined
  let prevApplied: readonly CacheScenarioName[] = []
  let totalCached = 0
  let totalInput = 0
  let unexpectedBreakTotal = 0

  for (let round = 1; round <= rounds; round += 1) {
    const applied = firedScenarios(round, enabled)
    const declared = applyRound(world, round, applied)
    advanceHistory(world, round)
    const contributions = buildRoundContributions(world)

    // budget 场景:把可用上下文压到略低于本轮总量(保留 header 兜底,防空 prompt),
    // 让真实 Budget Manager 出手;它按 §49 序从 tail 端裁,不碰可缓存区
    let maxContextTokens = world.maxContextTokens
    if (applied.includes('budget')) {
      const nominal = contributions.reduce((sum, c) => sum + estimateTokens(c.segment.content), 0)
      const headerTokens = contributions
        .filter((c) => c.segment.zone === 'header')
        .reduce((sum, c) => sum + estimateTokens(c.segment.content), 0)
      maxContextTokens = Math.max(headerTokens + 1, nominal - 45)
    }

    const outcome = compile({
      chatId: 'sim-chat' as never,
      snapshotId: `sim-snap-${round}` as SnapshotId,
      provider: 'sim',
      model: 'sim-model',
      compilerVersion: 'sim',
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, round)).toISOString() as Timestamp,
      maxContextTokens,
      mode: 'preview',
      contributions,
      variables: SIM_VARIABLES,
      cacheInvalidations: declared,
      providerCacheType: 'explicit-breakpoint',
    })
    if (!outcome.ok) {
      throw new Error(`scenario replay 第 ${round} 轮编译失败: ${outcome.error.code} ${outcome.error.message}`)
    }

    const { cachePlan: plan, ir, serialized } = outcome.value
    const carry = computePrefixCarry(prevIr, ir)
    const planInputTokens = plan.stablePrefixTokens + plan.freshTokens + plan.volatileTokens
    const reasons = plan.breakReasons.map((r: DeepReadonly<CacheBreakReason>) => r.type)

    // 未声明判据:本轮与**上轮**都不含场景时,出现原因码或前缀分歧即未声明(一次变更跨两轮显形)
    const attributionWindow = [...applied, ...prevApplied]
    const expected = new Set(attributionWindow.flatMap((name) => SCENARIO_BREAK_TYPES[name]))
    const undeclaredReasons = applied.length === 0 && prevApplied.length === 0 ? reasons.filter((t) => !expected.has(t)) : []
    const structuralDivergence =
      round > 1 && attributionWindow.length === 0 && carry.firstDivergence !== null ? carry.firstDivergence : undefined
    const unexpectedBreaks =
      structuralDivergence === undefined
        ? undeclaredReasons
        : [...undeclaredReasons, `PREFIX_DIVERGED_UNDECLARED@${structuralDivergence}`]
    const divergenceId = round > 1 ? carry.firstDivergence : null

    results.push({
      round,
      applied,
      declaredBreaks: declared.map((r) => r.type),
      stableTokens: plan.stablePrefixTokens,
      freshTokens: plan.freshTokens,
      volatileTokens: plan.volatileTokens,
      planInputTokens,
      trimmedSegments: ir.segments.filter((s) => !s.enabled).length,
      prefixHash: serialized.hash,
      cachedTokens: carry.cachedTokens,
      firstDivergence: round === 1 ? null : divergenceId,
      unexpectedBreaks,
    })
    simRounds.push({ round, plan, stablePrefixHashes: carry.hashes })

    totalCached += carry.cachedTokens
    totalInput += planInputTokens
    unexpectedBreakTotal += unexpectedBreaks.length
    prevIr = ir
    prevApplied = applied
    graduate(world)
    if (world.macroPlacement === 'header') world.macroPlacement = 'tail'
  }

  return {
    rounds: results,
    hitRatio: ratio(totalCached, totalInput),
    costReduction: ratio(totalCached, totalInput),
    unexpectedBreakTotal,
    simulator: simulateCachePlan(simRounds),
  }
}
