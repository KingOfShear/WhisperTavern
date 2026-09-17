import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHarnesses, makeE2eHarness, type E2eHarness } from './harness'

/**
 * S13(WP1.4)消息树完整交互 —— api-spec §16–§23 逐路由契约 + swipe 生成填充 e2e:
 * - §17 GET message / §19 编辑变体(原内容永不动 + leaf 移动) / §20 swipe 建壳+生成填充
 * - §21 branch(不复制聊天,血缘位) / §22 active-leaf / 删除(软删+message.deleted+指针回退)
 * - §14/§15 chats PATCH(name)/DELETE(soft+purge) / §16 分页(limit/before/after)
 */

type App = ReturnType<E2eHarness['open']>['app']

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function makeChat(app: App, userText = '讲个故事'): Promise<string> {
  const chat = (await (await app.request('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: 'S13' }) })).json()) as {
    data: { id: string }
  }
  await app.request(`/api/v2/chats/${chat.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: userText }),
  })
  return chat.data.id
}

async function makeProvider(app: App, turns: { text: string }[]): Promise<string> {
  const res = await app.request('/api/v2/providers', {
    method: 'POST',
    body: JSON.stringify({ name: `fake-${Date.now()}-${Math.random()}`, type: 'fake', models: ['fake-model'], fakeTurns: turns }),
  })
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function generate(app: App, chatId: string, providerId: string): Promise<void> {
  await app.request(`/api/v2/chats/${chatId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model: 'fake-model' }),
  })
  await wait(80)
}

async function listMessages(app: App, chatId: string, query = ''): Promise<{ id: string; role: string; content: string; variantGroupId?: string | null; variantIndex?: number | null }[]> {
  const res = await app.request(`/api/v2/chats/${chatId}/messages${query}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { id: string; role: string; content: string; variantGroupId?: string | null; variantIndex?: number | null }[] }).data
}

afterEach(() => cleanupHarnesses())

describe('S13 §19 编辑变体', () => {
  it('编辑 = 新建变体:原消息内容不动,leaf 移到新版本,GET 单条可见两代', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const msgs = await listMessages(app, chatId)
    const userMsg = msgs[0]!

    const res = await app.request(`/api/v2/messages/${userMsg.id}/edit`, {
      method: 'POST',
      body: JSON.stringify({ content: '讲个科幻故事' }),
    })
    expect(res.status).toBe(201)
    const edited = (await res.json()) as { data: { id: string; variantGroupId: string; variantIndex: number; content: string } }
    expect(edited.data.content).toBe('讲个科幻故事')
    expect(edited.data.variantIndex).toBe(1)

    // 原消息内容永不动(不可变事实)
    const original = (await (await app.request(`/api/v2/messages/${userMsg.id}`)).json()) as {
      data: { content: string; variantGroupId: string; variantIndex: number }
    }
    expect(original.data.content).toBe('讲个故事')
    expect(original.data.variantIndex).toBe(0)
    // 兄弟链:同 variant_group
    expect(original.data.variantGroupId).toBe(edited.data.variantGroupId)

    // leaf 已移到新版本:活跃链尾 = 编辑版
    const chain = await listMessages(app, chatId)
    expect(chain.at(-1)?.id).toBe(edited.data.id)
  })

  it('空 content → VALIDATION_ERROR(400);消息不存在 → 404', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const empty = await app.request(`/api/v2/messages/nope/edit`, { method: 'POST', body: JSON.stringify({ content: 'x' }) })
    expect(empty.status).toBe(404)
    const msgs = await listMessages(app, chatId)
    const bad = await app.request(`/api/v2/messages/${msgs[0]!.id}/edit`, { method: 'POST', body: JSON.stringify({}) })
    expect(bad.status).toBe(400)
  })
})

describe('S13 §20 swipe 生成填充(P0 挂账解除)', () => {
  it('先常规生成填充 A → swipe 建壳 B → 生成写入 B(非新消息)→ 双变体共存 + 编译历史不含空壳', async () => {
    const { app, store } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    // fake 轮次按 provider 回放(adapter 每请求新建):第一轮与 swipe 各用一个 provider
    const providerA = await makeProvider(app, [{ text: '变体A 正文' }])
    const providerB = await makeProvider(app, [{ text: '变体B 正文' }])

    // 第一轮:常规生成 → A 入树
    await generate(app, chatId, providerA)
    const afterFirst = await listMessages(app, chatId)
    expect(afterFirst).toHaveLength(2)
    const assistantA = afterFirst[1]!
    expect(assistantA.content).toBe('变体A 正文')

    // §20 swipe A → 建壳 B + 触发生成;返回 { runId, messageId }
    const swipeRes = await app.request(`/api/v2/messages/${assistantA.id}/swipe`, {
      method: 'POST',
      body: JSON.stringify({ providerId: providerB, model: 'fake-model' }),
    })
    expect(swipeRes.status).toBe(201)
    const swiped = (await swipeRes.json()) as { data: { runId: string; messageId: string } }
    expect(swiped.data.messageId).not.toBe(assistantA.id)
    await wait(100)

    // 生成完成写入壳 B(非新消息):树里仍是 2 条活跃链,B 已填充
    const chain = await listMessages(app, chatId)
    expect(chain).toHaveLength(2)
    expect(chain[1]!.id).toBe(swiped.data.messageId)
    expect(chain[1]!.content).toBe('变体B 正文')

    // §22 双变体共存:A 内容不动;兄弟链可回切
    const a = (await (await app.request(`/api/v2/messages/${assistantA.id}`)).json()) as { data: { content: string; variantGroupId: string | null } }
    expect(a.data.content).toBe('变体A 正文')
    const b = (await (await app.request(`/api/v2/messages/${swiped.data.messageId}`)).json()) as { data: { variantGroupId: string | null } }
    expect(a.data.variantGroupId).not.toBeNull()
    expect(b.data.variantGroupId).toBe(a.data.variantGroupId)

    // 编译历史口径:swipe 轮的快照不含空壳(历史以 user 结尾,tail 区是用户消息)
    const runs = store.sqlite.prepare('SELECT id, snapshot_id FROM runs ORDER BY created_at').all() as { id: string; snapshot_id: string }[]
    const swipeRun = runs.at(-1)!
    const snap = store.sqlite.prepare('SELECT serialized FROM prompt_snapshots WHERE id = ?').get(swipeRun.snapshot_id) as { serialized: string }
    expect(snap.serialized).not.toContain('变体A 正文') // 壳的兄弟不进 prompt
    expect(snap.serialized).toContain('讲个故事')
  })

  it('对 user/system 消息 swipe → 400 VALIDATION_ERROR(§20:只允许 assistant/character)', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const msgs = await listMessages(app, chatId)
    // §20"如果该消息是 assistant":user 消息在 swipeMessage 层即拒绝,不建壳不触发生成
    const res = await app.request(`/api/v2/messages/${msgs[0]!.id}/swipe`, { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })
})

describe('S13 删除(软删 + message.deleted)', () => {
  it('删除链中消息:软删事实保留、活跃链不再可见、leaf 回退最近未删祖先、事件落库', async () => {
    const { app, store } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, [{ text: '回复正文' }])
    await generate(app, chatId, providerId)
    const chain = await listMessages(app, chatId)
    const userMsg = chain[0]!
    const reply = chain[1]!

    // 删中间消息(user):活跃 leaf 在 reply 上,链含被删消息 → 回退
    const res = await app.request(`/api/v2/messages/${userMsg.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { deletedAt: string; activeLeaf: string | null } }
    expect(body.data.deletedAt).toBeTruthy()

    // 活跃链跳过已删消息(§19 软删:历史里不可见)
    const after = await listMessages(app, chatId)
    expect(after.some((m) => m.id === userMsg.id)).toBe(false)

    // 事实行保留(软删),GET 单条仍可见 deletedAt
    const row = store.sqlite.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(userMsg.id) as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull()
    const single = (await (await app.request(`/api/v2/messages/${userMsg.id}`)).json()) as { data: { deletedAt: string | undefined } }
    expect(single.data.deletedAt).toBeTruthy()
    void reply

    // message.deleted 事件落库(durable)
    const evt = store.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'message.deleted'").get() as { n: number }
    expect(evt.n).toBe(1)
  })

  it('删除叶子消息:leaf 回退父消息;幂等重删返回 200', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, [{ text: '回复正文' }])
    await generate(app, chatId, providerId)
    const chain = await listMessages(app, chatId)
    const reply = chain[1]!

    const res = await app.request(`/api/v2/messages/${reply.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { activeLeaf: string | null } }
    expect(body.data.activeLeaf).toBe(chain[0]!.id)

    const again = await app.request(`/api/v2/messages/${reply.id}`, { method: 'DELETE' })
    expect(again.status).toBe(200)

    // 回复被删后活跃链只剩 user;生成校验(不以 user 结尾)拦截的是"最后一条必须是 user"——
    // user 是链尾,可再生成
    const provider2 = await makeProvider(app, [{ text: '再来一条' }])
    await generate(app, chatId, provider2)
    const refreshed = await listMessages(app, chatId)
    expect(refreshed).toHaveLength(2)
    expect(refreshed[1]!.content).toBe('再来一条')
  })

  it('消息不存在 → 404', async () => {
    const { app } = makeE2eHarness().open()
    const res = await app.request('/api/v2/messages/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('S13 §21/§22 分支与激活', () => {
  it('POST branch:不复制聊天、新分支即活跃、activeLeafId = fork 点;§22 切回原链', async () => {
    const { app, store } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, [{ text: '主线回复' }])
    await generate(app, chatId, providerId)
    const chain = await listMessages(app, chatId)
    const userMsg = chain[0]!
    const branchCountBefore = (store.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_branches').get() as { n: number }).n

    const res = await app.request(`/api/v2/chats/${chatId}/branch`, {
      method: 'POST',
      body: JSON.stringify({ fromMessageId: userMsg.id }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { branchId: string; activeLeafId: string } }
    expect(body.data.activeLeafId).toBe(userMsg.id)

    // 不复制聊天:分支行 +1,消息行不变
    const branchCountAfter = (store.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_branches').get() as { n: number }).n
    expect(branchCountAfter).toBe(branchCountBefore + 1)
    const msgCount = (store.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
    expect(msgCount).toBe(2)

    // 血缘位(决策 25):seed_length = 前缀长度,is_seeded = true
    const branch = store.sqlite.prepare('SELECT seed_length, is_seeded, fork_message_id FROM chat_branches WHERE id = ?').get(body.data.branchId) as {
      seed_length: number
      is_seeded: number
      fork_message_id: string
    }
    expect(branch.seed_length).toBe(1)
    expect(branch.is_seeded).toBe(1)
    expect(branch.fork_message_id).toBe(userMsg.id)

    // §22 切回原链尾(主线回复)
    const back = await app.request(`/api/v2/chats/${chatId}/active-leaf`, {
      method: 'POST',
      body: JSON.stringify({ messageId: chain[1]!.id }),
    })
    expect(back.status).toBe(200)
    const chainAfter = await listMessages(app, chatId)
    expect(chainAfter).toHaveLength(2)
  })

  it('分支后续写:新分支里发消息不影响原分支链', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, [{ text: '主线' }])
    await generate(app, chatId, providerId)
    const mainChain = await listMessages(app, chatId)
    const userMsg = mainChain[0]!

    await app.request(`/api/v2/chats/${chatId}/branch`, { method: 'POST', body: JSON.stringify({ fromMessageId: userMsg.id }) })
    // 分支里追加消息
    await app.request(`/api/v2/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: '分支线消息' }),
    })
    const branchChain = await listMessages(app, chatId)
    expect(branchChain).toHaveLength(2)
    expect(branchChain[1]!.content).toBe('分支线消息')
  })

  it('fromMessageId 缺失 → 400;不属于该 chat 的消息 → 400 VALIDATION', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const bad = await app.request(`/api/v2/chats/${chatId}/branch`, { method: 'POST', body: JSON.stringify({}) })
    expect(bad.status).toBe(400)
    const other = await makeChat(app)
    const otherMsgs = await listMessages(app, other)
    const cross = await app.request(`/api/v2/chats/${chatId}/branch`, {
      method: 'POST',
      body: JSON.stringify({ fromMessageId: otherMsgs[0]!.id }),
    })
    expect(cross.status).toBe(400)
  })
})

describe('S13 §14/§15 chats PATCH/DELETE', () => {
  it('PATCH name → title 更新并回显;空体 → 400', async () => {
    const { app } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const res = await app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ name: '新标题' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { name: string | null } }
    expect(body.data.name).toBe('新标题')

    const got = (await (await app.request(`/api/v2/chats/${chatId}`)).json()) as { data: { title: string } }
    expect(got.data.title).toBe('新标题')

    const empty = await app.request(`/api/v2/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({}) })
    expect(empty.status).toBe(400)
  })

  it('DELETE 默认软删:列表消失、GET 仍可达(事实保留);purge=true 彻底删除', async () => {
    const { app, store } = makeE2eHarness().open()
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, [{ text: '回复' }])
    await generate(app, chatId, providerId)

    const soft = await app.request(`/api/v2/chats/${chatId}`, { method: 'DELETE' })
    expect(soft.status).toBe(200)
    const list = ((await (await app.request('/api/v2/chats')).json()) as { data: { id: string }[] }).data
    expect(list.some((c) => c.id === chatId)).toBe(false)
    // 软删后事实仍在
    const stillThere = (store.sqlite.prepare('SELECT deleted_at FROM chats WHERE id = ?').get(chatId) as { deleted_at: string | null })
    expect(stillThere.deleted_at).not.toBeNull()

    const purge = await app.request(`/api/v2/chats/${chatId}?purge=true`, { method: 'DELETE' })
    expect(purge.status).toBe(200)
    const gone = store.sqlite.prepare('SELECT COUNT(*) AS n FROM chats WHERE id = ?').get(chatId) as { n: number }
    expect(gone.n).toBe(0)
    const msgsGone = (store.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').all() as { n: number }[])[0]!
    expect(msgsGone.n).toBe(0)
    const runsGone = (store.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').all() as { n: number }[])[0]!
    expect(runsGone.n).toBe(0)
  })

  it('删除不存在的 chat → 404', async () => {
    const { app } = makeE2eHarness().open()
    const res = await app.request('/api/v2/chats/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('S13 §16 messages 分页', () => {
  async function seedChain(app: App, n: number): Promise<{ chatId: string; ids: string[] }> {
    const chatId = await makeChat(app)
    const providerId = await makeProvider(app, Array.from({ length: n }, (_, i) => ({ text: `回复${i}` })))
    for (let i = 0; i < n; i += 1) {
      await generate(app, chatId, providerId)
      if (i < n - 1) {
        await app.request(`/api/v2/chats/${chatId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ role: 'user', content: `追问${i}` }),
        })
      }
    }
    const chain = await listMessages(app, chatId)
    return { chatId, ids: chain.map((m) => m.id) }
  }

  it('limit 裁剪链尾;before/after 游标正确;非法参数 → 400', async () => {
    const { app } = makeE2eHarness().open()
    const { chatId, ids } = await seedChain(app, 3) // 6 条:u/r/u/r/u/r

    const tail2 = await listMessages(app, chatId, '?limit=2')
    expect(tail2.map((m) => m.id)).toEqual(ids.slice(-2))

    const before = await listMessages(app, chatId, `?before=${ids[3]}&limit=100`)
    expect(before.map((m) => m.id)).toEqual(ids.slice(0, 3))

    const after = await listMessages(app, chatId, `?after=${ids[3]}`)
    expect(after.map((m) => m.id)).toEqual(ids.slice(4))

    const badCursor = await app.request(`/api/v2/chats/${chatId}/messages?before=nope`)
    expect(badCursor.status).toBe(400)
    const both = await app.request(`/api/v2/chats/${chatId}/messages?before=${ids[1]}&after=${ids[1]}`)
    expect(both.status).toBe(400)
    const badLimit = await app.request(`/api/v2/chats/${chatId}/messages?limit=0`)
    expect(badLimit.status).toBe(400)
    const badBranch = await app.request(`/api/v2/chats/${chatId}/messages?branch=main`)
    expect(badBranch.status).toBe(400)
  })
})
