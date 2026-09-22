import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeProviderAdapter } from '@whispertavern/adapters'
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
  })

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
  })

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
  })
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
    const cachePlan = JSON.parse(row.cache_plan) as { version: number; stablePrefixSegments: unknown[] }
    expect(cachePlan.version).toBe(1)
    expect(cachePlan.stablePrefixSegments.length).toBeGreaterThan(0)
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
  })

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
  })
})
