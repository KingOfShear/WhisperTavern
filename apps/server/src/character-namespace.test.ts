import { afterEach, describe, expect, it } from 'vitest'
import { FakeProviderAdapter } from '@whispertavern/adapters'
import { EventBus, SnapshotRegistry, createSqliteEventSink, startRun } from '@whispertavern/runtime'
import { cleanupHarnesses, makeE2eHarness, type E2eHarness } from './harness'

/**
 * S33a(WP4.4)角色身份进 header + per-(chat, character) 缓存命名空间。
 *
 * 本用例守的是一条**此前从未成立**的性质:角色卡内容真的进 prompt,且不同角色
 * 产出不同前缀。S33a 之前:契约 `{type:'character', assetId, field}` 零生产者、
 * `characters.description/personality` 零消费者、10 个真实预设的 charDescription/
 * charPersonality 全是空壳标记 —— 于是"per-(chat, character) 命名空间"即便建起来
 * 也是空转(所有角色 header 逐字节相同)。这四条断言就是那条性质的可复核凭证。
 *
 * 四条各守一件事:
 * 1. slot 填充 —— 标记段原地换成角色卡正文,**位置不动**(§81 顺序即语义序);
 * 2. 未绑定零漂移 —— 不绑角色的 chat 与 S33a 之前逐字节一致(P2 缓存门禁的前提);
 * 3. 命名空间分组 —— 不同角色在**同一 chat** 内不被当成同一条链(§26/§42);
 * 4. 双角色 header 分歧 —— 不同角色前缀确实不同(命名空间有意义的前提)。
 */

const FIXED_NOW = '2026-09-20T00:00:00.000Z'

/**
 * 逐轮推进的注入时钟。§42 取前驱的判据是 `createdAt < 本轮`(严格早于)——
 * 若所有轮共用同一个固定 now,"上一轮"在时间轴上**不早于**本轮,前驱永远取不到,
 * 于是"同命名空间能接上链"的断言会假红(本轮实测踩到)。固定时钟保证确定性,
 * 逐轮 +1s 保证先后关系成立,两者都要。
 */
function nowFor(round: number): string {
  return new Date(Date.parse(FIXED_NOW) + round * 1000).toISOString()
}

/** 5 段预设:两个标记槽(charDescription/charPersonality)夹一条普通段,用于验证"原地填充" */
const ST_PRESET = {
  name: 'S33a 测试预设',
  temperature: 0.8,
  max_context: 8000,
  prompts: [
    { identifier: 'main', role: 'system', content: 'A-系统角色设定', injection_position: 0 },
    { identifier: 'charDescription', role: 'system', content: '', injection_position: 0 },
    { identifier: 'charPersonality', role: 'system', content: '', injection_position: 0 },
    { identifier: 'tailnote', role: 'system', content: 'C-风格约束', injection_position: 0 },
  ],
  prompt_order: [
    { identifier: 'main', order: 0, enabled: true },
    { identifier: 'charDescription', order: 1, enabled: true },
    { identifier: 'charPersonality', order: 2, enabled: true },
    { identifier: 'tailnote', order: 3, enabled: true },
  ],
}

interface Opened {
  harness: E2eHarness
  app: ReturnType<E2eHarness['open']>['app']
  store: ReturnType<E2eHarness['open']>['store']
  bus: EventBus
  providerId: string
}

async function openHarness(): Promise<Opened> {
  const harness = makeE2eHarness()
  const opened = harness.open()
  const bus = new EventBus(createSqliteEventSink(opened.store))
  // generations.provider_id FK:先建 fake provider 取真实 id(与 S15 金样同法)
  await opened.app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({ name: `fake-s33a-${Math.random()}`, type: 'fake', models: ['fake-model'], fakeTurns: [{ text: '回复' }] }),
  })
  const providers = (await (await opened.app.request('/api/v2/providers')).json()) as { data: { id: string }[] }
  return { harness, app: opened.app, store: opened.store, bus, providerId: providers.data[0]?.id ?? '' }
}

async function importPreset(app: ReturnType<E2eHarness['open']>['app']): Promise<string> {
  const res = await app.request('/api/v2/presets/import', {
    method: 'POST',
    body: JSON.stringify({
      filename: 'preset.json',
      base64: Buffer.from(JSON.stringify(ST_PRESET), 'utf8').toString('base64'),
      name: 'S33a',
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { preset: { id: string } } }).data.preset.id
}

async function createCharacter(
  app: ReturnType<E2eHarness['open']>['app'],
  body: { name: string; description?: string; personality?: string; scenario?: string },
): Promise<string> {
  const res = await app.request('/api/v2/characters', { method: 'POST', body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** 建 chat(可带 characterId)→ 绑预设 → 追加一条 user 消息 */
async function makeChat(
  app: ReturnType<E2eHarness['open']>['app'],
  options: { presetId: string; characterId?: string; message?: string },
): Promise<string> {
  const res = await app.request('/api/v2/chats', {
    method: 'POST',
    body: JSON.stringify({
      title: 'S33a',
      systemPrompt: 'S33a 系统提示',
      ...(options.characterId !== undefined ? { characterId: options.characterId } : {}),
    }),
  })
  expect(res.status).toBe(201)
  const chatId = ((await res.json()) as { data: { id: string } }).data.id
  await app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ presetId: options.presetId }) })
  await app.request(`/api/v2/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: options.message ?? '你好' }),
  })
  return chatId
}

interface Compiled {
  snapshotId: string
  round: { parts: unknown }
  /**
   * 段形状照**编译产物**原样:区落在 `cachePlacement.zone`,不是平铺 `zone`。
   * 口径与 P2 门禁 `cache-stability.test.ts` 一致。平铺 `zone` 恒为 undefined,
   * 而 filter 一个 undefined 只会静默返回空集 —— 断言随之变成空转(本轮踩过)。
   */
  segments: {
    id: string
    role: string
    content: string
    enabled: boolean
    cachePlacement: { zone: string }
    source: { type: string; field?: string; assetId?: string }
  }[]
  characterId: string | null
  /** 快照 createdAt —— §42 前驱判据是 `createdAt < 本轮`,故断言需要它 */
  createdAt: string
}

/** 追加一条 user 消息 —— startRun 要求链尾为 user(§24 续聊语义) */
async function postUserMessage(
  app: ReturnType<E2eHarness['open']>['app'],
  chatId: string,
  content: string,
): Promise<void> {
  const res = await app.request(`/api/v2/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content }),
  })
  expect(res.status).toBe(201)
}

/** 固定时钟 startRun → 读回该快照的 ir 段 + 命名空间键(P2 门禁/金样同法) */
async function compile(ctx: Opened, chatId: string, now: string = FIXED_NOW): Promise<Compiled> {
  const result = startRun(
    { store: ctx.store, bus: ctx.bus, snapshots: new SnapshotRegistry() },
    {
      chatId: chatId as never,
      adapter: new FakeProviderAdapter([{ text: '回复' }], { maxContextTokens: 131_072 }),
      providerId: ctx.providerId,
      model: 'fake-model',
      now: now as never,
    },
  )
  if (!result.ok) throw new Error(`startRun 失败: ${result.error.message}`)
  await result.value.completion
  const row = ctx.store.sqlite
    .prepare('SELECT serialized, ir, character_id, created_at FROM prompt_snapshots WHERE id = ?')
    .get(result.value.snapshotId) as
    | { serialized: string; ir: string; character_id: string | null; created_at: string }
    | undefined
  if (row === undefined) throw new Error('快照未落库')
  const ir = JSON.parse(row.ir) as { segments: Compiled['segments'] }
  return {
    snapshotId: result.value.snapshotId,
    round: { parts: (JSON.parse(row.serialized) as { parts: unknown }).parts },
    segments: ir.segments,
    characterId: row.character_id,
    createdAt: row.created_at,
  }
}

/** header 区(含 stableWB)段的 `role|content` 拼接 —— 与 P2 门禁同口径 */
function headerBytes(c: Compiled): string {
  return c.segments
    .filter((s) => s.enabled && (s.cachePlacement.zone === 'header' || s.cachePlacement.zone === 'stableWB'))
    .map((s) => `${s.role}|${s.content}`)
    .join('\u0000')
}

describe('S33a 角色身份进 header + per-character 命名空间', () => {
  afterEach(() => cleanupHarnesses())

  /**
   * ① slot 填充:ST 的 charDescription/charPersonality 是**空壳标记**(只声明位置),
   * 正文由角色卡子系统提供。断言两点:**内容进来了** + **位置没动**
   * ——后者是"原地填充"相对"另发贡献"的关键差异(§81 顺序即语义序)。
   */
  it('标记段原地填充角色卡正文(位置不动),并另发 source=character 的 header 贡献', async () => {
    const ctx = await openHarness()
    const presetId = await importPreset(ctx.app)
    const characterId = await createCharacter(ctx.app, {
      name: '狐神抚',
      description: '九尾狐神,性喜戏弄人。',
      personality: '慵懒、促狭、记仇。',
    })
    const chatId = await makeChat(ctx.app, { presetId, characterId })
    const compiled = await compile(ctx, chatId)

    const byId = new Map(compiled.segments.map((s) => [s.id, s]))
    // 填充命中:两段空壳各拿到对应字段
    expect(byId.get('preset:' + presetId + ':charDescription')?.content).toBe('九尾狐神,性喜戏弄人。')
    expect(byId.get('preset:' + presetId + ':charPersonality')?.content).toBe('慵懒、促狭、记仇。')
    // 未登记槽的段不受影响
    expect(byId.get('preset:' + presetId + ':main')?.content).toBe('A-系统角色设定')
    expect(byId.get('preset:' + presetId + ':tailnote')?.content).toBe('C-风格约束')
    // source 仍是 preset(段确实是预设声明的);角色卡的溯源由独立贡献承载
    expect(byId.get('preset:' + presetId + ':charDescription')?.source.type).toBe('preset')

    // 另发贡献:全仓第一个 `{type:'character'}` 生产者,且 ID/字段口径稳定
    const characterSegs = compiled.segments.filter((s) => s.source.type === 'character')
    expect(characterSegs.map((s) => s.id).sort()).toEqual([
      `character:${characterId}:description`,
      `character:${characterId}:personality`,
    ])
    for (const s of characterSegs) {
      expect(s.cachePlacement.zone).toBe('header')
      expect(s.source.assetId).toBe(characterId)
      expect(s.enabled).toBe(true)
    }

    // 位置断言:两个标记段在 header 区内仍处于 main 之后、tailnote 之前(未被挪位)
    const headerOrder = compiled.segments
      .filter((s) => s.enabled && s.cachePlacement.zone === 'header' && s.id.startsWith(`preset:${presetId}:`))
      .map((s) => s.id.slice(`preset:${presetId}:`.length))
    expect(headerOrder.indexOf('charDescription')).toBeGreaterThan(headerOrder.indexOf('main'))
    expect(headerOrder.indexOf('charPersonality')).toBeGreaterThan(headerOrder.indexOf('charDescription'))
    expect(headerOrder.indexOf('tailnote')).toBeGreaterThan(headerOrder.indexOf('charPersonality'))
  })

  /**
   * ② 未绑定零漂移:S33a 的**唯一**安全保证 —— 没绑角色的 chat 必须与改动前逐字节一致。
   * 这是 P2 百轮缓存门禁与 S15 金样基线能不红的前提(它们的 chat 都不绑角色)。
   * 两个未绑定 chat 的 header 也必须相同(证明 character 贡献集为空,未引入随机/空串段)。
   */
  it('未绑定角色:不产 character 贡献,header 逐字节等同另一未绑定 chat', async () => {
    const ctx = await openHarness()
    const presetId = await importPreset(ctx.app)
    const a = await compile(ctx, await makeChat(ctx.app, { presetId }))
    const b = await compile(ctx, await makeChat(ctx.app, { presetId }))

    expect(a.segments.filter((s) => s.source.type === 'character')).toEqual([])
    expect(a.segments.filter((s) => s.id.startsWith('character:'))).toEqual([])
    // 命名空间键为 NULL(= 沿用 chat 级语义)
    expect(a.characterId).toBeNull()
    expect(b.characterId).toBeNull()
    // 空壳标记段保持空串(未被填充)
    expect(a.segments.find((s) => s.id.endsWith(':charDescription'))?.content).toBe('')
    expect(headerBytes(a)).toBe(headerBytes(b))
    expect(JSON.stringify(a.round.parts)).toBe(JSON.stringify(b.round.parts))
  })

  /**
   * ③ 命名空间分组(§26/§42):不同角色在**同一 chat** 内是两条独立链。
   * 断言的是"前驱取不到"——这正是修复的具体缺陷:此前只按 chat 取前驱,
   * 群聊里会拿 A 的快照去比 B,于是每轮都报一次无意义的 CacheBreak。
   */
  it('同 chat 内两个角色互为独立链:后者的 cache-break 不得把前者当前驱', async () => {
    const ctx = await openHarness()
    const presetId = await importPreset(ctx.app)
    const charA = await createCharacter(ctx.app, { name: '角色A', description: 'A 的描述' })
    const charB = await createCharacter(ctx.app, { name: '角色B', description: 'B 的描述' })

    const chatId = await makeChat(ctx.app, { presetId, characterId: charA })
    const a1 = await compile(ctx, chatId)
    expect(a1.characterId).toBe(charA)

    // 同 chat 换绑角色 B → 编译。B 首轮**无同命名空间前驱**。
    const patched = await ctx.app.request(`/api/v2/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ characterId: charB }),
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { data: { characterId: string | null } }).data.characterId).toBe(charB)

    // startRun 要求链尾是 user(§24 续聊语义):上一轮已把 assistant 回复追进树,
    // 故每次重新编译前都必须补一条 user 消息,否则报"生成必须以 user 消息结尾"。
    // 时钟逐轮推进:B 的发言在 A 之后(真实群聊同构),否则 §42 的严格 `created_at <`
    // 判据下两者时间轴并列,前驱对照会失效。
    await postUserMessage(ctx.app, chatId, 'B 登场')
    const b1 = await compile(ctx, chatId, nowFor(1))
    expect(b1.characterId).toBe(charB)

    // 关键断言:B 的首轮不得把 A 的快照当基线(否则会报一次无意义的 CacheBreak)
    const res = await ctx.app.request(`/api/v2/runs/run-nonexistent/cache-break`)
    expect(res.status).toBe(404)

    // 直接跑真实的 cache-break 面:B 这一轮的 run
    const runRow = ctx.store.sqlite
      .prepare('SELECT id FROM runs WHERE snapshot_id = ?')
      .get(b1.snapshotId) as { id: string } | undefined
    expect(runRow).toBeDefined()
    const breakRes = await ctx.app.request(`/api/v2/runs/${runRow!.id}/cache-break`)
    expect(breakRes.status).toBe(200)
    const diagnosis = (await breakRes.json()) as {
      data: { broken: boolean; affectedTokens: number; suggestions: string[] }
    }
    expect(diagnosis.data.broken).toBe(false)
    expect(diagnosis.data.affectedTokens).toBe(0)
    // 提示语必须指向"该角色尚无前置快照",而非"A 的缓存被破坏"
    expect(diagnosis.data.suggestions.join('')).toContain('该角色在本会话尚无前置快照')

    // 同命名空间内第二次编译则**能**取到前驱(A1 是 A2 的基线)
    await ctx.app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ characterId: charA }) })
    await postUserMessage(ctx.app, chatId, '继续')
    const a2 = await compile(ctx, chatId, nowFor(2))
    expect(a2.characterId).toBe(charA)
    const a2Run = ctx.store.sqlite
      .prepare('SELECT id FROM runs WHERE snapshot_id = ?')
      .get(a2.snapshotId) as { id: string } | undefined
    const a2Break = (await (await ctx.app.request(`/api/v2/runs/${a2Run!.id}/cache-break`)).json()) as {
      data: { suggestions: string[] }
    }
    expect(a2Break.data.suggestions.join('')).not.toContain('该角色在本会话尚无前置快照')

    // 直接核验前驱选择本身(比读提示语更强):A2 的前驱必须是 A1,而非 B1 或 NULL。
    // 这条同时钉住 NULL 安全的反向分支 —— 若实现用了 `= NULL`,这里选出的会是空集。
    const expectedPrior = ctx.store.sqlite
      .prepare(
        `SELECT id FROM prompt_snapshots
          WHERE chat_id = ? AND character_id = ? AND created_at < ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chatId, charA, a2.createdAt) as { id: string } | undefined
    expect(expectedPrior?.id).toBe(a1.snapshotId)

    // 反向:B 的命名空间里没有早于 B1 的快照(A1 在同一 chat 但在**另一条链**上)
    const bPrior = ctx.store.sqlite
      .prepare(
        `SELECT id FROM prompt_snapshots
          WHERE chat_id = ? AND character_id = ? AND created_at < ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chatId, charB, b1.createdAt) as { id: string } | undefined
    expect(bPrior).toBeUndefined()

    // 反面对照:若误按 chat 取前驱(旧口径),B1 会错误地接到 A1 —— 证明修复不是空转
    const chatOnlyPrior = ctx.store.sqlite
      .prepare(
        `SELECT id FROM prompt_snapshots
          WHERE chat_id = ? AND created_at < ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chatId, b1.createdAt) as { id: string } | undefined
    expect(chatOnlyPrior?.id).toBe(a1.snapshotId)
  })

  /**
   * ④ 双角色 header 分歧:命名空间有意义的**前提** —— 不同角色的前缀确实不同。
   * S33a 之前角色卡不进 prompt,这条断言必然失败(所有角色 header 逐字节相同)。
   */
  it('两个角色的 header 前缀确实不同(命名空间非空转),且命名空间键各自独立', async () => {
    const ctx = await openHarness()
    const presetId = await importPreset(ctx.app)
    const charA = await createCharacter(ctx.app, { name: '角色A', description: 'A 的独有描述' })
    const charB = await createCharacter(ctx.app, { name: '角色B', description: 'B 的独有描述' })

    const chatA = await makeChat(ctx.app, { presetId, characterId: charA })
    const chatB = await makeChat(ctx.app, { presetId, characterId: charB })
    const a = await compile(ctx, chatA)
    const b = await compile(ctx, chatB)

    expect(a.characterId).toBe(charA)
    expect(b.characterId).toBe(charB)
    expect(headerBytes(a)).not.toBe(headerBytes(b))
    // 差异必须来自角色卡字段,不是别的噪声
    expect(headerBytes(a)).toContain('A 的独有描述')
    expect(headerBytes(b)).toContain('B 的独有描述')
    expect(headerBytes(a)).not.toContain('B 的独有描述')
  })

  /** 绑定 API 契约:characterId 存在性校验(404)+ null 解绑 + 空体仍在 400 档 */
  it('绑定 API:characterId 不存在 → CHARACTER_NOT_FOUND 404;null 解绑;空体 400', async () => {
    const ctx = await openHarness()
    const presetId = await importPreset(ctx.app)
    const characterId = await createCharacter(ctx.app, { name: '角色', description: '描述' })
    const chatId = await makeChat(ctx.app, { presetId, characterId })

    const bad = await ctx.app.request(`/api/v2/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ characterId: 'char_nope' }),
    })
    expect(bad.status).toBe(404)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('CHARACTER_NOT_FOUND')

    // 建 chat 时校验同样生效
    const badCreate = await ctx.app.request('/api/v2/chats', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', characterId: 'char_nope' }),
    })
    expect(badCreate.status).toBe(404)

    // 解绑:characterId=null → 命名空间回到 NULL
    const unbound = await ctx.app.request(`/api/v2/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ characterId: null }),
    })
    expect(unbound.status).toBe(200)
    const data = (await unbound.json()) as { data: { characterId: string | null; characterVersion: number | null } }
    expect(data.data.characterId).toBeNull()
    expect(data.data.characterVersion).toBeNull()
    // 解绑后编译:命名空间回到 NULL(chain 尾需补 user 消息,§24 续聊语义)
    await postUserMessage(ctx.app, chatId, '解绑后继续')
    const u1 = await compile(ctx, chatId, nowFor(1))
    expect(u1.characterId).toBeNull()

    // NULL 命名空间的**前驱必须能找到**:未绑定角色的单聊仍是一条连续链。
    // 这条专钉 `sameNamespaceCondition` 的 isNull 分支 —— 若改用 `eq(col, NULL)`,
    // SQL 里恒为 UNKNOWN,前驱永远取不到,却**不报任何错**,只是每轮静默退化成"首轮"。
    await postUserMessage(ctx.app, chatId, '第二轮')
    const u2 = await compile(ctx, chatId, nowFor(2))
    expect(u2.characterId).toBeNull()
    const u2Run = ctx.store.sqlite
      .prepare('SELECT id FROM runs WHERE snapshot_id = ?')
      .get(u2.snapshotId) as { id: string } | undefined
    const u2Break = (await (await ctx.app.request(`/api/v2/runs/${u2Run!.id}/cache-break`)).json()) as {
      data: { suggestions: string[] }
    }
    // 能取到前驱 → 不再走"首轮"分支(该分支只在 prior 为空集时触发)
    expect(u2Break.data.suggestions.join('')).not.toContain('无前置缓存可破坏')

    const nullPrior = ctx.store.sqlite
      .prepare(
        `SELECT id FROM prompt_snapshots
          WHERE chat_id = ? AND character_id IS NULL AND created_at < ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chatId, u2.createdAt) as { id: string } | undefined
    expect(nullPrior?.id).toBe(u1.snapshotId)

    // 空体仍报 400 并提示三个绑定字段
    const empty = await ctx.app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({}) })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: { message: string } }).error.message).toContain('characterId')
  })

  /**
   * ⑤ 遥测按命名空间分组(§41 + §26):这是命名空间修复的**第二个**消费点。
   *
   * 遥测此前把所有 run 压成一条平铺序列(round 1..N 跨角色递增),于是角色 B 的首轮
   * 被当成角色 A 的延续轮 —— 理论承接基数错位、CacheBreak 计数虚假、Simulator 的
   * 跨轮前缀比对恒不命中。断言:按角色过滤后各自从 round=1 起编号,且轮里带
   * characterId 供 UI 标注(per-character 链温度显示)。
   */
  it('遥测按 (chat, character) 分链:各链独立编号,且轮上带 characterId', async () => {
    const ctx = await openHarness()
    const presetId = await importPreset(ctx.app)
    const charA = await createCharacter(ctx.app, { name: '遥测A', description: 'A 描述' })
    const charB = await createCharacter(ctx.app, { name: '遥测B', description: 'B 描述' })
    const chatId = await makeChat(ctx.app, { presetId, characterId: charA })

    // A 两轮
    await compile(ctx, chatId, nowFor(0))
    await postUserMessage(ctx.app, chatId, 'A 第二轮')
    await compile(ctx, chatId, nowFor(1))
    // 换 B 一轮
    await ctx.app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ characterId: charB }) })
    await postUserMessage(ctx.app, chatId, 'B 登场')
    await compile(ctx, chatId, nowFor(2))

    type Watched = { data: { rounds: { round: number; characterId: string | null }[]; runCount: number } }
    // 不过滤:旧口径——4 条 run 平铺,round 1..4 混在一起
    const all = (await (await ctx.app.request(`/api/v2/chats/${chatId}/cache/telemetry`)).json()) as Watched
    expect(all.data.runCount).toBe(3)
    expect(all.data.rounds.map((r) => r.round)).toEqual([1, 2, 3])

    // 只看 A:A 的链是从 1 开始的两轮,A 的第 1 轮**不是**第 2 轮的下标错位
    const onlyA = (await (
      await ctx.app.request(`/api/v2/chats/${chatId}/cache/telemetry?characterId=${charA}`)
    ).json()) as Watched
    expect(onlyA.data.runCount).toBe(2)
    expect(onlyA.data.rounds.map((r) => r.round)).toEqual([1, 2])
    expect(onlyA.data.rounds.every((r) => r.characterId === charA)).toBe(true)

    // 只看 B:B 只有 1 轮,且**从 1 开始**——不是全局第 3 轮
    const onlyB = (await (
      await ctx.app.request(`/api/v2/chats/${chatId}/cache/telemetry?characterId=${charB}`)
    ).json()) as Watched
    expect(onlyB.data.runCount).toBe(1)
    expect(onlyB.data.rounds.map((r) => r.round)).toEqual([1])
    expect(onlyB.data.rounds.every((r) => r.characterId === charB)).toBe(true)

    // A 的过滤结果里绝不能出现 B 的轮(反向隔离)
    expect(onlyA.data.rounds.some((r) => r.characterId === charB)).toBe(false)
  })
})
