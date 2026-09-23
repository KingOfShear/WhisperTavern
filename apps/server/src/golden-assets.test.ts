import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeProviderAdapter } from '@whispertavern/adapters'
import { projectSegment, simulateCachePlan, type CacheSimRound } from '@whispertavern/core'
import { EventBus, SnapshotRegistry, createSqliteEventSink, startRun } from '@whispertavern/runtime'
import { cleanupHarnesses, makeE2eHarness } from './harness'

/**
 * S15(WP1.6)金样测试体系 —— P1 出场验收(technical-plan §8.2 / p1-plan §9)。
 *
 * 金样资产(tests/fixtures/assets/,由 sanitize-assets.mjs 从 酒馆参考文件/ 结构等价脱敏生成,
 * R-P1-4)导入 → 编译 → 序列化 → 字节级快照,防语义回归:
 *
 * 1. **导入层(HTTP)**:全部 49 产物(10 卡 × v3/png/charx + 6 预设 + 2 世界书 + 1 表格)
 *    走真实导入路由,断言 201 + report(fieldMap/compatFields/sourceFormat)——这是
 *    Import Compatibility Report 的机器可复核数据源(R-P1-6)。
 * 2. **三载体同源**:同一张真实卡的 v3.json / png / charx 导入出同一原生卡(name 一致)。
 * 3. **字节快照**:代表资产(老代书/现代书/主预设/表格/卡内嵌书)绑定 chat → startRun
 *    (固定 now,确定性编译) → prompt_snapshots.serialized 与 golden 基线比对;
 *    无基线则生成(首次运行写盘,之后严格比对 = 防语义回归)。
 *
 * 纪律:测试只读 tests/fixtures/assets/(脱敏金样),不引用 酒馆参考文件/(AGENTS X3)。
 */

const REPO_ROOT = join(__dirname, '../../..')
const ASSETS = join(REPO_ROOT, 'tests/fixtures/assets')
const GOLDEN_DIR = join(REPO_ROOT, 'tests/fixtures/golden')
const MANIFEST = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8')) as {
  source: string
  output: string
  type: string
  carrier?: string
  sanitizedFields: number
}[]

/** 固定注入时钟:同输入 + 同 now → 逐字节同 serialized(compiler-spec §94 确定性) */
const FIXED_NOW = '2026-09-20T00:00:00.000Z'

function readAsset(rel: string): Buffer {
  return readFileSync(join(ASSETS, rel))
}

async function importAsset(app: ReturnType<ReturnType<typeof makeE2eHarness>['open']>['app'], route: string, bytes: Buffer, name?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      base64: bytes.toString('base64'),
      ...(name !== undefined ? { name } : {}),
    }),
  })
  const body = (await res.json()) as Record<string, unknown>
  if (res.status !== 201) console.log(`  [导入失败] ${route} → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  return { status: res.status, body }
}

/** golden 基线读写:存在 → 返回内容;不存在 → 写盘并返回 undefined(首跑生成) */
function golden(rel: string, content?: string): string | undefined {
  const file = join(GOLDEN_DIR, rel)
  if (content === undefined) {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  }
  mkdirSync(join(GOLDEN_DIR, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return content
}

describe('S15 金样:导入层(Import Compatibility Report 数据源)', () => {
  let ctx: ReturnType<typeof makeE2eHarness>
  let app: ReturnType<ReturnType<typeof makeE2eHarness>['open']>['app']

  beforeAll(() => {
    ctx = makeE2eHarness()
    const opened = ctx.open()
    app = opened.app
  })
  afterAll(() => cleanupHarnesses())

  // —— 卡三载体:10 张真实卡 × (v3.json / png / charx) ——
  const cardSources = [...new Set(MANIFEST.filter((m) => m.type === 'card' && m.carrier === 'png').map((m) => m.source))]
  const cardOutputs = (source: string): { v3?: string; png?: string; charx?: string } => {
    const out: { v3?: string; png?: string; charx?: string } = {}
    for (const m of MANIFEST.filter((m) => m.source === source)) {
      if (m.carrier === 'json-v3') out.v3 = m.output
      if (m.carrier === 'png') out.png = m.output
      if (m.carrier === 'charx') out.charx = m.output
    }
    return out
  }

  // 重 IO 测试:30 次真实导入(10 卡 × 3 载体)/6 预设/2 书,全量并行下曾超 vitest 默认 5s,
  // 显式放宽超时防并行 CPU 争抢误报(2026-09-22 S19 全量回归实测)
  const GOLDEN_IO_TIMEOUT = 60_000

  it(`卡三载体同源导入(${cardSources.length} 张)`, async () => {
    for (const source of cardSources) {
      const { v3, png, charx } = cardOutputs(source)
      expect(v3 !== undefined && png !== undefined && charx !== undefined).toBe(true)
      const names = new Set<string>()
      for (const rel of [v3, png, charx]) {
        if (rel === undefined) continue
        const { status, body } = await importAsset(app, '/api/v2/characters/import', readAsset(rel), `golden-${source}`)
        expect(status).toBe(201)
        const data = body.data as { character: { name: string }; report: { asset: { sourceFormat: string }; compatFields: string[] } }
        names.add(data.character.name)
        expect(data.report.asset.sourceFormat).toMatch(/^(st-v2|st-v3|png-v2|png-v3|charx)$/)
      }
      // 三载体指向同一原生卡(同源)
      expect(names.size).toBe(1)
    }
  }, GOLDEN_IO_TIMEOUT)

  it('世界书两代导入:老 8 字段(地点) + 现代 42 字段(Table)', async () => {
    const wbs = MANIFEST.filter((m) => m.type === 'worldbook')
    expect(wbs.length).toBe(2)
    for (const m of wbs) {
      const { status, body } = await importAsset(app, '/api/v2/worldbooks/import', readAsset(m.output))
      expect(status).toBe(201)
      const data = body.data as { worldbook: { entryCount: number }; report: { asset: { sourceFormat: string }; compatFields: string[] } }
      expect(data.worldbook.entryCount).toBeGreaterThan(0)
      console.log(`  书 ${m.output}: entries=${data.worldbook.entryCount} sourceFormat=${data.report.asset.sourceFormat} compat=${data.report.compatFields.join(',')}`)
    }
  }, GOLDEN_IO_TIMEOUT)

  it('预设导入(6 预设)segmentCount > 0', async () => {
    // 注:manifest 的 type=table 资产是 ST "AI Table" 扩展格式(非 prompt-manager 预设,
    // S12 §80–§81 范围外),不进预设导入断言。
    const presets = MANIFEST.filter((m) => m.type === 'preset')
    expect(presets.length).toBe(6)
    for (const m of presets) {
      const { status, body } = await importAsset(app, '/api/v2/presets/import', readAsset(m.output))
      expect(status).toBe(201)
      const data = body.data as { preset: { segmentCount: number }; report: { compatFields: string[] } }
      expect(data.preset.segmentCount).toBeGreaterThan(0)
      console.log(`  预设 ${m.output}: segments=${data.preset.segmentCount} compat=${data.report.compatFields.join(',')}`)
    }
  }, GOLDEN_IO_TIMEOUT)
})

describe('S15 金样:字节快照(导入→编译→序列化,防语义回归)', () => {
  let ctx: ReturnType<typeof makeE2eHarness>
  let app: ReturnType<ReturnType<typeof makeE2eHarness>['open']>['app']
  let store: ReturnType<ReturnType<typeof makeE2eHarness>['open']>['store']
  let bus: EventBus
  let providerId: string

  beforeAll(async () => {
    ctx = makeE2eHarness()
    const opened = ctx.open()
    app = opened.app
    store = opened.store
    bus = new EventBus(createSqliteEventSink(store))
    // generations.provider_id FK 指向 providers 表:先建 fake provider 取真实 id(S15 金样)
    await app.request('/api/v2/providers', { method: 'POST', body: JSON.stringify({ name: 'fake-golden', type: 'fake', fakeTurns: [{ text: '金样回放' }] }) })
    const providers = (await (await app.request('/api/v2/providers')).json()) as { data: { id: string }[] }
    providerId = providers.data[0]?.id ?? ''
    expect(providerId).not.toBe('')
  })
  afterAll(() => cleanupHarnesses())

  async function setupChat(chain: { role: 'user' | 'assistant'; content: string }[], bindings: { presetId?: string }): Promise<string> {
    const chat = (await (await app.request('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: 'golden', systemPrompt: '金样系统提示' }) })).json()) as { data: { id: string } }
    for (const m of chain) {
      await app.request(`/api/v2/chats/${chat.data.id}/messages`, { method: 'POST', body: JSON.stringify({ role: m.role, content: m.content }) })
    }
    if (bindings.presetId !== undefined) {
      await app.request(`/api/v2/chats/${chat.data.id}`, { method: 'PATCH', body: JSON.stringify({ presetId: bindings.presetId }) })
    }
    return chat.data.id
  }

  /** 直接 startRun(固定 now)→ 返回 serialized 的 parts(role/content,防语义回归基线)。
   *  注:不比对完整 serialized——hash/id 含每次导入新建的 UUID(presetId/worldbookId),
   *  跨 harness 必不同;金样锁的是"同输入 → 同内容字节",id 属运行标识非语义。
   *  S18:顺带断言 CachePlan 真实装配(version=1,stablePrefix 非空,R-P0-4 退役)。 */
  async function compileOnce(chatId: string): Promise<string> {
    const result = startRun(
      { store, bus, snapshots: new SnapshotRegistry() },
      {
        chatId: chatId as never,
        // 大上下文:真实预设/世界书金样会超 fake 保守默认 8192(S15 金样)
        adapter: new FakeProviderAdapter([{ text: '金样回放' }], { maxContextTokens: 131072 }),
        providerId,
        model: 'fake-model',
        now: FIXED_NOW as never,
      },
    )
    if (!result.ok) {
      console.log('[startRun 失败]', JSON.stringify(result.error).slice(0, 500))
      throw new Error(result.error.message)
    }
    await result.value.completion
    const row = store.sqlite.prepare('SELECT serialized, cache_plan FROM prompt_snapshots WHERE id = ?').get(result.value.snapshotId) as {
      serialized: string
      cache_plan: string
    }
    const serialized = JSON.parse(row.serialized) as { parts: unknown }
    // 金样 serialized 含 CachePlan(S18 验收):真实装配 + stablePrefix 非空
    const cachePlan = JSON.parse(row.cache_plan) as {
      version: number
      stablePrefixSegments: unknown[]
      providerStrategy?: { version: number; breakpoints: unknown[]; stableZoneTokens: number }
    }
    expect(cachePlan.version).toBe(1)
    expect(cachePlan.stablePrefixSegments.length).toBeGreaterThan(0)
    // S19 验收:providerStrategy 翻译指令随快照持久化(§16;adapter 按自家 cacheType 决定消费)
    expect(cachePlan.providerStrategy?.version).toBe(1)
    expect(cachePlan.providerStrategy?.breakpoints.length).toBeGreaterThan(0)
    expect(typeof cachePlan.providerStrategy?.stableZoneTokens).toBe('number')
    return JSON.stringify(serialized.parts)
  }

  it('预设字节金样:狐神抚主预设(217 段)序列化稳定', async () => {
    const presetFile = MANIFEST.find((m) => m.output === 'preset/主预设_V182_狐神抚_毓忻.json')
    expect(presetFile).toBeDefined()
    const imported = await importAsset(app, '/api/v2/presets/import', readAsset(presetFile!.output))
    expect(imported.status).toBe(201)
    const presetId = ((imported.body.data as { preset: { id: string } }).preset.id)
    const chatId = await setupChat([{ role: 'user', content: '你好' }], { presetId })
    const serialized = await compileOnce(chatId)
    const rel = 'preset/hushen-fu-v182.serialized.json'
    const baseline = golden(rel)
    if (baseline === undefined) {
      golden(rel, serialized) // 首跑生成基线
      console.log(`  [基线生成] ${rel} (${serialized.length} 字节)`)
      return
    }
    expect(serialized).toBe(baseline)
  }, 60_000)

  it('世界书字节金样:现代书(Table)激活进 prompt 序列化稳定', async () => {
    const wb = MANIFEST.find((m) => m.output === 'worldbook/Table_v2011.json')
    expect(wb).toBeDefined()
    const imported = await importAsset(app, '/api/v2/worldbooks/import', readAsset(wb!.output))
    expect(imported.status).toBe(201)
    const wbId = ((imported.body.data as { worldbook: { id: string } }).worldbook.id)
    const chatId = await setupChat([{ role: 'user', content: '你好' }], {})
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId: wbId }) })
    const serialized = await compileOnce(chatId)
    const rel = 'worldbook/table-v2011.serialized.json'
    const baseline = golden(rel)
    if (baseline === undefined) {
      golden(rel, serialized)
      console.log(`  [基线生成] ${rel} (${serialized.length} 字节)`)
      return
    }
    expect(serialized).toBe(baseline)
  }, 60_000)

  /**
   * S20 验收「Simulator 输出对齐金样」(p2-plan §7 任务 3 / 总设计 §20)。
   * 真实金样资产(狐神抚主预设 217 段 + Table 世界书)绑定同一 chat 跑 3 轮真实编译,
   * 逐轮 CachePlan + 段级 contentHash 喂 `simulateCachePlan`(零 API 成本:只消费已编译产物),
   * 报告对金样基线严格比对。
   *
   * 归一化口径:段 ID 内嵌每次导入新建的 chatId/presetId UUID,跨 harness 必不同——
   * 金样只锁**语义量**(token 数 / 命中率 / 削减率 / 分歧段在稳定前缀中的**位序**)与
   * 失效归因(breakReasons),不锁运行标识(与 S15 字节金样同一纪律)。
   *
   * 读法提示:基线里 `actualHitRatio` 极低不是 KPI 失败——FakeProviderAdapter 用
   * "字符数 / 4" 合成 usage(ASCII 取向),而 plan 计对中文 ≈ 1 token/汉字,两套口径
   * 天然差 ~3.6 倍;真实 provider 的 cached_tokens/prompt_tokens 才是有意义的实际层。
   * 本用例锁的是**理论层**(theoreticalHitRatio/inputCostReduction)与两口径的分离性。
   */
  it('S20 缓存模拟金样:真实预设+世界书 3 轮 → simulateCachePlan 报告对齐', async () => {
    const presetFile = MANIFEST.find((m) => m.output === 'preset/主预设_V182_狐神抚_毓忻.json')
    const wbFile = MANIFEST.find((m) => m.output === 'worldbook/Table_v2011.json')
    expect(presetFile).toBeDefined()
    expect(wbFile).toBeDefined()
    const importedPreset = await importAsset(app, '/api/v2/presets/import', readAsset(presetFile!.output))
    expect(importedPreset.status).toBe(201)
    const presetId = (importedPreset.body.data as { preset: { id: string } }).preset.id
    const importedWb = await importAsset(app, '/api/v2/worldbooks/import', readAsset(wbFile!.output))
    expect(importedWb.status).toBe(201)
    const wbId = (importedWb.body.data as { worldbook: { id: string } }).worldbook.id

    const chatId = await setupChat([{ role: 'user', content: '你好' }], { presetId })
    await app.request(`/api/v2/chats/${chatId}/worldbooks`, { method: 'POST', body: JSON.stringify({ worldbookId: wbId }) })

    const simRounds: CacheSimRound[] = []
    /** 每轮稳定前缀段 ID 序(把分歧段 ID 归一化为位序) */
    const prefixOrders: string[][] = []
    for (let i = 0; i < 3; i += 1) {
      await app.request(`/api/v2/chats/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: `第${i + 1}轮输入内容` }),
      })
      const result = startRun(
        { store, bus, snapshots: new SnapshotRegistry() },
        {
          chatId: chatId as never,
          adapter: new FakeProviderAdapter([{ text: '金样回放', cachedInputTokens: i === 0 ? 0 : 96 }], {
            maxContextTokens: 131072,
          }),
          providerId,
          model: 'fake-model',
          now: FIXED_NOW as never,
        },
      )
      if (!result.ok) throw new Error(result.error.message)
      await result.value.completion

      const snap = store.sqlite
        .prepare('SELECT cache_plan, ir FROM prompt_snapshots WHERE id = ?')
        .get(result.value.snapshotId) as { cache_plan: string; ir: string }
      const plan = JSON.parse(snap.cache_plan) as CacheSimRound['plan']
      const ir = JSON.parse(snap.ir) as { segments: unknown[] }
      const hashes: Record<string, string> = {}
      for (const seg of ir.segments) {
        const p = projectSegment(seg as never)
        hashes[p.id] = p.contentHash
      }
      const usage = store.sqlite
        .prepare('SELECT input_tokens, cached_tokens FROM generations WHERE run_id = ?')
        .get(result.value.runId) as { input_tokens: number | null; cached_tokens: number | null }
      prefixOrders.push([...plan.stablePrefixSegments])
      simRounds.push({
        round: i + 1,
        plan,
        stablePrefixHashes: hashes,
        actualCachedTokens: usage.cached_tokens ?? undefined,
        providerInputTokens: usage.input_tokens ?? undefined,
      })
    }

    const report = simulateCachePlan(simRounds)
    // 语义量归一化:分歧段 ID → 该轮稳定前缀中的位序(不锁 UUID)
    const normalized = {
      rounds: report.rounds.map((r, index) => ({
        round: r.round,
        theoreticalStableTokens: r.theoreticalStableTokens,
        theoreticalCachedTokens: r.theoreticalCachedTokens,
        theoreticalFreshTokens: r.theoreticalFreshTokens,
        planInputTokens: r.planInputTokens,
        providerInputTokens: r.providerInputTokens ?? null,
        actualCachedTokens: r.actualCachedTokens ?? null,
        hitRatio: r.hitRatio,
        actualHitRatio: r.actualHitRatio ?? null,
        cacheBreak: r.cacheBreak,
        breakReasons: r.breakReasons,
        divergenceAt: r.firstDivergenceSegment === undefined ? null : prefixOrders[index]!.indexOf(r.firstDivergenceSegment),
      })),
      theoreticalHitRatio: report.theoreticalHitRatio,
      actualHitRatio: report.actualHitRatio ?? null,
      baselineInputTokens: report.baselineInputTokens,
      uncachedInputTokens: report.uncachedInputTokens,
      inputCostReduction: report.inputCostReduction,
      topCacheKillers: report.topCacheKillers,
    }
    const serializedReport = JSON.stringify(normalized, null, 2)

    const rel = 'cache-simulator/hushen-fu-table.report.json'
    const baseline = golden(rel)
    if (baseline === undefined) {
      golden(rel, serializedReport)
      console.log(`  [基线生成] ${rel} (${serializedReport.length} 字节)`)
    } else {
      expect(serializedReport).toBe(baseline)
    }
    // §20 口径:理论缓存率与成本削减为真实量(第 1 轮无基线,第 2 轮起稳定前缀承接)
    expect(report.rounds[0]!.theoreticalCachedTokens).toBe(0)
    expect(report.rounds[1]!.theoreticalCachedTokens).toBeGreaterThan(0)
    expect(report.theoreticalHitRatio).toBeGreaterThan(0)
    expect(report.inputCostReduction).toBeGreaterThan(0)
    // §33.2:actual 只统计真实回传轮次(第 1 轮 0、第 2/3 轮 96)
    expect(report.actualHitRatio).toBeGreaterThan(0)
  }, 60_000)
})
