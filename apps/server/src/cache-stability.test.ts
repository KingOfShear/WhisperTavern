import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeProviderAdapter } from '@whispertavern/adapters'
import { computePrefixCarry, type PrefixCarry } from '@whispertavern/core'
import { EventBus, SnapshotRegistry, createSqliteEventSink, editMessage, startRun, swipeMessage } from '@whispertavern/runtime'
import { cleanupHarnesses, makeE2eHarness } from './harness'

/**
 * S21(WP2.6)缓存稳定性硬门禁 —— p2-plan §8 / technical-plan §8.1。
 *
 * 两道断言合一,全部走**真实管线**(导入 → 编译 → 序列化 → 快照落库,fake provider 零 API 成本):
 *
 * 1. **前缀稳定性**:稳轮里 header+stableWB 序列化字节逐轮**逐字节前缀一致**(毕业条目字节原位)、
 *    history 追加式、每轮"预期失效 token"记账并在稳轮设阈值;
 * 2. **KPI 预演**(§2.2 端到端口径,`computePrefixCarry`):真实缓存友好资产
 *    (狐神抚预设 + 地点书@before_char)上命中率 ≥70% / 成本削减 ≥60%;
 *    并以 Table 书(4 条全 @D 深度注入)作**反面对照**——它按 §3.6 不参与分区,
 *    落在 history 之后,永不进前缀缓存,故 KPI 显著低于门禁线。对照不是摆设:
 *    它把"KPI 达标取决于资产布局"这一事实钉成可复跑的断言。
 *
 * 确定性(X10):全程注入固定 now(逐轮 +60s 的 UTC 基),fake provider 脚本固定,
 * 资产取 tests/fixtures 脱敏金样;不依赖 wall-clock(故不走 HTTP /generate 路由,
 * 那条路径内部用 nowIso())。
 */

const REPO_ROOT = join(__dirname, '../../..')
const ASSETS = join(REPO_ROOT, 'tests/fixtures/assets')
const FIXED_BASE_MS = Date.UTC(2026, 0, 1)

/** 逐轮注入时钟:同轮同 now → 逐字节同 serialized(compiler-spec §94) */
function nowFor(round: number): string {
  return new Date(FIXED_BASE_MS + round * 60_000).toISOString()
}

interface WbEntry {
  key: string[]
  content: string
  position: number | string
}

function readWorldbook(rel: string): WbEntry[] {
  const raw = JSON.parse(readFileSync(join(ASSETS, rel), 'utf8')) as { entries?: Record<string, WbEntry> }
  return Object.values(raw.entries ?? {})
}

/** 地点书:12 条全 before_char(参与 freshWB/stableWB 分区)→ 缓存友好参照资产 */
const PLACE_ENTRIES = readWorldbook('worldbook/地点.json')
const PLACE_KEYWORDS = PLACE_ENTRIES.map((e) => e.key[0] ?? '')

interface RoundFacts {
  round: number
  event: string | null
  totalTokens: number
  cachedTokens: number
  invalidatedTokens: number
  carry: PrefixCarry
  /** header+stableWB 段的 role|content 拼接(逐字节前缀断言的被比对象) */
  headerStableBytes: string
  /** history 段 ID 序(追加式断言的被比对象) */
  historyIds: string[]
  trimmedSegments: number
}

type App = ReturnType<ReturnType<typeof makeE2eHarness>['open']>['app']

async function importAsset(app: App, route: string, rel: string, name?: string): Promise<string> {
  const bytes = readFileSync(join(ASSETS, rel))
  const res = await app.request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base64: bytes.toString('base64'), ...(name !== undefined ? { name } : {}) }),
  })
  const body = (await res.json()) as { data: Record<string, unknown> }
  expect(res.status, `${route} 导入 ${rel} 失败: ${JSON.stringify(body).slice(0, 200)}`).toBe(201)
  const first = Object.values(body.data)[0] as { id: string } | undefined
  if (first === undefined) throw new Error(`${route} 响应缺少导入产物(${rel})`)
  return first.id
}

/** 场景脚本:round → 事件。预算事件跨两轮(触发 + 恢复),编辑单轮,激活单轮 */
const EVENTS = new Map<number, string>([
  [10, 'worldbook-activation'],
  [20, 'worldbook-activation'],
  [30, 'worldbook-activation'],
  [45, 'message-edit'],
  [60, 'budget-trim'],
  [61, 'budget-recover'],
  [75, 'worldbook-activation'],
  [85, 'swipe'],
])

interface RunContext {
  app: App
  store: ReturnType<ReturnType<typeof makeE2eHarness>['open']>['store']
  bus: EventBus
  chatId: string
  providerId: string
  maxContextTokens: number
}

/** 跑一轮真实编译并返回事实;返回 null 表示该轮无快照 */
async function runRound(
  ctx: RunContext,
  round: number,
  prevIr: unknown,
  variantMessageId?: string,
): Promise<RoundFacts | null> {
  const adapter = new FakeProviderAdapter([{ text: `第${round}轮回复` }], {
    maxContextTokens: round === 60 ? 14_000 : ctx.maxContextTokens,
  })
  const started = startRun(
    { store: ctx.store, bus: ctx.bus, snapshots: new SnapshotRegistry() },
    {
      chatId: ctx.chatId as never,
      ...(variantMessageId !== undefined ? { variantMessageId: variantMessageId as never } : {}),
      adapter,
      providerId: ctx.providerId,
      model: 'fake-model',
      now: nowFor(round) as never,
    },
  )
  if (!started.ok) throw new Error(`第 ${round} 轮 startRun 失败: ${started.error.message}`)
  await started.value.completion
  const row = ctx.store.sqlite
    .prepare('SELECT serialized, ir FROM prompt_snapshots WHERE id = ?')
    .get(started.value.snapshotId) as { serialized: string; ir: string } | undefined
  if (row === undefined) return null
  const ir = JSON.parse(row.ir) as { segments: { id: string; role: string; content: string; enabled: boolean; cachePlacement: { zone: string } }[] }
  const carry = computePrefixCarry(prevIr as never, ir as never)
  const sent = ir.segments.filter((s) => s.enabled)
  const headerStable = sent.filter((s) => s.cachePlacement.zone === 'header' || s.cachePlacement.zone === 'stableWB')
  const history = sent.filter((s) => s.cachePlacement.zone === 'history')
  return {
    round,
    event: EVENTS.get(round) ?? null,
    totalTokens: carry.totalTokens,
    cachedTokens: carry.cachedTokens,
    invalidatedTokens: carry.totalTokens - carry.cachedTokens,
    carry,
    headerStableBytes: headerStable.map((s) => `${s.role}|${s.content}`).join('\u0000'),
    historyIds: history.map((s) => s.id),
    trimmedSegments: ir.segments.filter((s) => !s.enabled).length,
  }
}

/** 100 轮脚本:稳轮 = 追加一条普通 user 消息;事件轮按 EVENTS 注入世界书激活/编辑/swipe/预算 */
async function runGate(ctx: RunContext, rounds: number): Promise<{ facts: RoundFacts[]; irs: unknown[] }> {
  const facts: RoundFacts[] = []
  const irs: unknown[] = []
  let prevIr: unknown = undefined
  let lastAssistantId: string | null = null

  for (let round = 1; round <= rounds; round += 1) {
    const event = EVENTS.get(round) ?? null
    // 新条目触发:把该条目关键词写进本轮 user 消息(地点书 selective + constant:false)
    const activationIndex = event === 'worldbook-activation' ? facts.filter((f) => f.event === 'worldbook-activation').length : -1
    const text = activationIndex >= 0 ? `第${round}轮：我们在${PLACE_KEYWORDS[activationIndex] ?? '此地'}过夜` : `第${round}轮输入`
    const created = await ctx.app.request(`/api/v2/chats/${ctx.chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: text }),
    })
    expect(created.status).toBe(201)

    if (event === 'message-edit' && lastAssistantId !== null) {
      // 编辑上一轮的 assistant 回复 → 命中处产生 MESSAGE_EDITED 前缀断裂(单轮显形)
      const edited = editMessage(ctx.store, ctx.bus, {
        messageId: lastAssistantId as never,
        content: `第${round}轮：改写后的既有回复`,
        now: nowFor(round) as never,
      })
      expect(edited.ok).toBe(true)
    }

    // swipe:新建变体壳并让生成写入壳本身(§20;与 server 路由同构,只是 now 固定)
    let variantMessageId: string | undefined
    if (event === 'swipe' && lastAssistantId !== null) {
      const swiped = swipeMessage(ctx.store, ctx.bus, {
        messageId: lastAssistantId as never,
        now: nowFor(round) as never,
      })
      expect(swiped.ok).toBe(true)
      if (swiped.ok) variantMessageId = swiped.value.id
    }

    const fact = await runRound(ctx, round, prevIr, variantMessageId)
    if (fact === null) continue
    facts.push(fact)
    const snapshotIr = JSON.parse(
      (
        ctx.store.sqlite.prepare('SELECT ir FROM prompt_snapshots WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1').get(ctx.chatId) as {
          ir: string
        }
      ).ir,
    ) as unknown
    irs.push(snapshotIr)
    prevIr = snapshotIr
    const chain = ctx.store.sqlite
      .prepare('SELECT id, role FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(ctx.chatId) as { id: string; role: string } | undefined
    if (chain !== undefined && chain.role === 'assistant') lastAssistantId = chain.id
  }
  return { facts, irs }
}

describe('S21 缓存稳定性门禁(WP2.6)', () => {
  let ctx: ReturnType<typeof makeE2eHarness>
  let opened: ReturnType<ReturnType<typeof makeE2eHarness>['open']>

  beforeAll(async () => {
    ctx = makeE2eHarness()
    opened = ctx.open()
  })
  afterAll(() => cleanupHarnesses())

  /** 预设导入很贵(狐神抚 217 prompts),两个场景共用一份 */
  let presetOnce: Promise<string> | null = null
  const gatePresetId = (): Promise<string> =>
    (presetOnce ??= importAsset(opened.app, '/api/v2/presets/import', 'preset/主预设_V182_狐神抚_毓忻.json', 'gate-preset'))

  /** 建 chat + 绑定预设/世界书 + 跑 N 轮真实编译(记忆化:同一重活只做一次) */
  async function runScenario(worldbookRel: string, rounds: number): Promise<{ facts: RoundFacts[]; irs: unknown[] }> {
    const { app, store } = opened
    const presetId = await gatePresetId()
    const wbId = await importAsset(app, '/api/v2/worldbooks/import', worldbookRel)
    const chatRes = await app.request('/api/v2/chats', {
      method: 'POST',
      body: JSON.stringify({ title: 'cache-gate', systemPrompt: '你是测试叙事者。' }),
    })
    const chatId = ((await chatRes.json()) as { data: { id: string } }).data.id
    await app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ presetId }) })
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId: wbId }) })
    const provRes = await app.request('/api/v2/providers', {
      method: 'POST',
      body: JSON.stringify({ name: `gate-${chatId}`, type: 'fake', models: ['fake-model'], fakeTurns: [{ text: '回放' }] }),
    })
    const providerId = ((await provRes.json()) as { data: { id: string } }).data.id
    const bus = new EventBus(createSqliteEventSink(store))
    const run: RunContext = { app, store, bus, chatId, providerId, maxContextTokens: 131_072 }
    return runGate(run, rounds)
  }

  let placeOnce: Promise<{ facts: RoundFacts[]; irs: unknown[] }> | null = null
  let tableOnce: Promise<{ facts: RoundFacts[]; irs: unknown[] }> | null = null
  const placeRun = (): Promise<{ facts: RoundFacts[]; irs: unknown[] }> =>
    (placeOnce ??= runScenario('worldbook/地点.json', 100))
  const tableRun = (): Promise<{ facts: RoundFacts[]; irs: unknown[] }> =>
    (tableOnce ??= runScenario('worldbook/Table_v2011.json', 20))

  it('100 轮真实管线:稳轮 header+stableWB 逐字节前缀稳定 + history 追加式 + 失效 token 记账', async () => {
    const { facts } = await placeRun()
    expect(facts.length).toBe(100)

    const steady = facts.filter((f) => f.event === null)
    expect(steady.length).toBeGreaterThan(85)

    // 逐轮稳定不变量:稳轮必须"上轮可缓存区是本轮前缀"(无未声明断裂)
    for (const f of steady) {
      if (f.round === 1) continue
      expect(f.carry.appendOnly, `轮 ${f.round} 出现未声明前缀断裂 @${f.carry.firstDivergence}`).toBe(true)
      expect(f.carry.firstDivergence).toBeNull()
      expect(f.trimmedSegments).toBe(0)
    }

    // header+stableWB 字节:稳轮之间逐字节前缀一致(毕业条目字节原位)
    for (let i = 1; i < steady.length; i += 1) {
      const prev = steady[i - 1]!
      const curr = steady[i]!
      if (curr.round !== prev.round + 1) continue
      expect(prev.headerStableBytes.length).toBeGreaterThan(0)
      expect(curr.headerStableBytes.startsWith(prev.headerStableBytes), `轮 ${prev.round}→${curr.round} 稳定区字节前缀被破坏`).toBe(true)
    }

    // history 追加式:稳轮之间历史段 ID 序是前一轮的位置前缀
    for (let i = 1; i < steady.length; i += 1) {
      const prev = steady[i - 1]!
      const curr = steady[i]!
      if (curr.round !== prev.round + 1) continue
      const prefix = curr.historyIds.slice(0, prev.historyIds.length)
      expect(prefix, `轮 ${prev.round}→${curr.round} history 非追加式`).toEqual(prev.historyIds)
    }

    // 失效 token 记账:稳轮失效量应为"本轮新增历史 + 尾部",占总量小头
    for (const f of steady) {
      if (f.round === 1) continue
      expect(f.cachedTokens).toBeGreaterThan(0)
      expect(f.invalidatedTokens).toBeLessThan(f.totalTokens * 0.3)
    }

    // 事件轮必须真的产生可归因的变化
    const activation = facts.filter((f) => f.event === 'worldbook-activation')
    expect(activation.length).toBe(4)
    for (const f of activation) {
      // 新条目进 freshWB → 可缓存区出现分歧(新段插入)
      expect(f.carry.firstDivergence).not.toBeNull()
    }
    const budget = facts.find((f) => f.event === 'budget-trim')
    expect(budget).toBeDefined()
    expect(budget!.trimmedSegments).toBeGreaterThan(0)
  }, 180_000)

  it('KPI 预演(§2.2 端到端口径):缓存友好资产命中率 ≥70% / 成本削减 ≥60%', async () => {
    const { facts } = await placeRun()
    const total = facts.reduce((s, f) => s + f.totalTokens, 0)
    const cached = facts.reduce((s, f) => s + f.cachedTokens, 0)
    const hitRatio = cached / total
    console.log(`  [KPI 预演] 狐神抚预设 + 地点书(before_char):${facts.length} 轮,理论命中率 ${(hitRatio * 100).toFixed(1)}%,成本削减 ${((1 - (total - cached) / total) * 100).toFixed(1)}%`)
    // §2.2:命中率以 token 计 = cached_tokens / prompt_tokens
    expect(hitRatio).toBeGreaterThanOrEqual(0.7)
    expect(hitRatio).toBeLessThan(1)
    // 成本削减 = 1 − 未承接占比(同一口径,单价的线性推论)
    expect(1 - (total - cached) / total).toBeGreaterThanOrEqual(0.6)
    // 逐轮稳态:第 2 轮起每轮承接应高于门禁线
    for (const f of facts) {
      if (f.round === 1 || f.event !== null) continue
      expect(f.cachedTokens / f.totalTokens).toBeGreaterThan(0.7)
    }
  }, 180_000)

  it('反面对照:Table 书(5 条全 @D 深度注入)不进前缀缓存 → KPI 显著低于门禁线', async () => {
    const { facts } = await tableRun()
    const total = facts.reduce((s, f) => s + f.totalTokens, 0)
    const cached = facts.reduce((s, f) => s + f.cachedTokens, 0)
    const hitRatio = cached / total
    console.log(`  [KPI 对照] 狐神抚预设 + Table 书(全 @D 深度注入):${facts.length} 轮,理论命中率 ${(hitRatio * 100).toFixed(1)}%`)
    // @D 条目按 §3.6 直接进 injection 区(位于 history 之后)→ 永不进前缀缓存,
    // 且约占本轮 token 的 2/3 → 命中率被压到门禁线以下(与 S20 金样 19.7% 同源)
    expect(hitRatio).toBeLessThan(0.7)
    expect(facts.every((f) => f.trimmedSegments === 0)).toBe(true)
  }, 180_000)
})
