import { describe, expect, it } from 'vitest'
import type { Timestamp } from '@whispertavern/contracts'
import { createDatabase, type WhisperTavernDb } from '../db/database'
import { events as eventsTable } from '../db/schema'
import { EventBus } from '../events/bus'
import {
  activateMessage,
  createBranch,
  createChat,
  createMessage,
  editMessage,
  loadBranch,
  loadChat,
  loadMessage,
  swipeMessage,
} from './messages'

const NOW = '2026-09-05T12:00:00Z' as Timestamp

function setup(): { store: WhisperTavernDb; bus: EventBus; durableTypes: () => string[] } {
  const store = createDatabase(':memory:')
  const bus = new EventBus({
    insert: (batch) => {
      for (const event of batch) {
        store.db
          .insert(eventsTable)
          .values({
            id: event.id,
            eventType: event.type,
            durability: event.durability,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            runId: event.runId,
            payload: JSON.stringify(event.payload),
            createdAt: event.timestamp,
          })
          .run()
      }
    },
  })
  return {
    store,
    bus,
    durableTypes: () =>
      (
        store.sqlite
          .prepare<[]>('SELECT event_type FROM events ORDER BY rowid')
          .all() as { event_type: string }[]
      ).map((r) => r.event_type),
  }
}

describe('消息树(api-spec §16–§22 / database-schema §19–§22)', () => {
  it('创建 chat:默认主分支活跃,chat.created 落 events 表(durable)', () => {
    const { store, bus, durableTypes } = setup()
    const chat = createChat(store, bus, { title: '测试会话', now: NOW })
    expect(chat.ok).toBe(true)
    if (!chat.ok) return
    expect(chat.value.activeBranchId).toBeDefined()
    expect(durableTypes()).toEqual(['chat.created'])
    store.close()
  })

  it('创建消息:序列递增、leaf 指针唯一前移、message.created 落库', () => {
    const { store, bus, durableTypes } = setup()
    const chat = createChat(store, bus, { now: NOW })
    if (!chat.ok) throw new Error('unreachable')
    const branchId = chat.value.activeBranchId!

    const first = createMessage(store, bus, {
      chatId: chat.value.id,
      role: 'user',
      content: '第一句',
      now: NOW,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.message.sequence).toBe(1)
    expect(first.value.activeLeaf).toBe(first.value.message.id)

    const second = createMessage(store, bus, {
      chatId: chat.value.id,
      role: 'character',
      content: '第一答',
      now: NOW,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    // 缺省挂到当前活跃叶子(§18 续聊语义)
    expect(second.value.message.parentMessageId).toBe(first.value.message.id)

    const branch = loadBranch(store, branchId)
    expect(branch.ok && branch.value.leafMessageId).toBe(second.value.message.id)
    expect(durableTypes()).toEqual(['chat.created', 'message.created', 'message.created'])
    store.close()
  })

  it('编辑 = 新建变体:原消息内容不动,leaf 移到新版本(§19 不可变事实)', () => {
    const { store, bus } = setup()
    const chat = createChat(store, bus, { now: NOW })
    if (!chat.ok) throw new Error('unreachable')
    const message = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '原文', now: NOW })
    if (!message.ok) throw new Error('unreachable')

    const edited = editMessage(store, bus, {
      messageId: message.value.message.id,
      content: '改后',
      now: NOW,
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return

    const original = loadMessage(store, message.value.message.id)
    if (!original.ok) throw new Error('unreachable')
    expect(original.value.content).toBe('原文') // 事实永不变
    expect(original.value.variantIndex).toBe(0)
    expect(edited.value.variantGroupId).toBe(original.value.variantGroupId)
    expect(edited.value.variantIndex).toBe(1)
    const branch = loadBranch(store, chat.value.activeBranchId!)
    expect(branch.ok && branch.value.leafMessageId).toBe(edited.value.id)
    store.close()
  })

  it('swipe:同 variant_group 下新建兄弟(空内容由生成填充)(§20/§22)', () => {
    const { store, bus } = setup()
    const chat = createChat(store, bus, { now: NOW })
    if (!chat.ok) throw new Error('unreachable')
    const user = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '问', now: NOW })
    if (!user.ok) throw new Error('unreachable')
    const reply = createMessage(store, bus, {
      chatId: chat.value.id,
      parentId: user.value.message.id,
      role: 'character',
      content: '答A',
      now: NOW,
    })
    if (!reply.ok) throw new Error('unreachable')

    const swiped = swipeMessage(store, bus, { messageId: reply.value.message.id, now: NOW })
    expect(swiped.ok).toBe(true)
    if (!swiped.ok) return
    expect(swiped.value.parentMessageId).toBe(user.value.message.id)
    // swipe 建新组:原消息回填 index 0,兄弟共享同一 group(§22)
    const original = loadMessage(store, reply.value.message.id)
    if (!original.ok) throw new Error('unreachable')
    expect(original.value.variantIndex).toBe(0)
    expect(swiped.value.variantGroupId).toBe(original.value.variantGroupId)
    expect(swiped.value.variantIndex).toBe(1)
    expect(swiped.value.content).toBe('')
    store.close()
  })

  it('分支血缘位:fork/seed_length/is_seeded 记录继承前缀(决策 25)', () => {
    const { store, bus } = setup()
    const chat = createChat(store, bus, { now: NOW })
    if (!chat.ok) throw new Error('unreachable')
    const m1 = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '1', now: NOW })
    if (!m1.ok) throw new Error('unreachable')
    const m2 = createMessage(store, bus, {
      chatId: chat.value.id,
      parentId: m1.value.message.id,
      role: 'character',
      content: '2',
      now: NOW,
    })
    if (!m2.ok) throw new Error('unreachable')

    const branch = createBranch(store, bus, {
      chatId: chat.value.id,
      fromMessageId: m2.value.message.id,
      name: '剧情B',
      now: NOW,
    })
    expect(branch.ok).toBe(true)
    if (!branch.ok) return
    expect(branch.value.forkMessageId).toBe(m2.value.message.id)
    expect(branch.value.seedLength).toBe(2) // m1 + m2
    expect(branch.value.isSeeded).toBe(true)
    expect(branch.value.leafMessageId).toBe(m2.value.message.id)
    // §21"只改变 active leaf":建分支即激活(fork-and-continue),活跃指针唯一
    expect(branch.value.isActive).toBe(true)
    expect(chat.value.activeBranchId).not.toBe(branch.value.id) // chat 上的指针还是建分支前的
    const afterBranch = loadChat(store, chat.value.id)
    expect(afterBranch.ok && afterBranch.value.activeBranchId).toBe(branch.value.id)

    // 从分支叶子继续写,不影响主分支 leaf
    const bMessage = createMessage(store, bus, {
      chatId: chat.value.id,
      parentId: m2.value.message.id,
      role: 'user',
      content: 'B 线',
      now: NOW,
    })
    if (!bMessage.ok) throw new Error('unreachable')
    const main = loadBranch(store, chat.value.activeBranchId!)
    expect(main.ok && main.value.leafMessageId).toBe(m2.value.message.id)
    store.close()
  })

  it('激活:leaf 指针唯一移动;跨分支激活切换 active_branch_id(§22)', () => {
    const { store, bus } = setup()
    const chat = createChat(store, bus, { now: NOW })
    if (!chat.ok) throw new Error('unreachable')
    const m1 = createMessage(store, bus, { chatId: chat.value.id, role: 'user', content: '1', now: NOW })
    if (!m1.ok) throw new Error('unreachable')
    const m2 = createMessage(store, bus, {
      chatId: chat.value.id,
      parentId: m1.value.message.id,
      role: 'character',
      content: '2',
      now: NOW,
    })
    if (!m2.ok) throw new Error('unreachable')
    const branch = createBranch(store, bus, {
      chatId: chat.value.id,
      fromMessageId: m1.value.message.id,
      now: NOW,
    })
    if (!branch.ok) throw new Error('unreachable')

    // 回退激活:建分支已自动切到新分支(§21),激活 m1 = 当前分支 leaf 移回种子区
    const afterBranch = loadChat(store, chat.value.id)
    if (!afterBranch.ok) throw new Error('unreachable')
    expect(afterBranch.value.activeBranchId).toBe(branch.value.id)
    const activate1 = activateMessage(store, bus, {
      chatId: chat.value.id,
      messageId: m1.value.message.id,
      now: NOW,
    })
    expect(activate1.ok).toBe(true)
    if (!activate1.ok) return
    const active1 = loadBranch(store, activate1.value.branchId)
    expect(active1.ok && active1.value.leafMessageId).toBe(m1.value.message.id)

    // 再次激活仍落在覆盖该链的分支,leaf 指针唯一(§22)
    const activate2 = activateMessage(store, bus, {
      chatId: chat.value.id,
      messageId: m2.value.message.id,
      now: NOW,
    })
    expect(activate2.ok).toBe(true)
    if (!activate2.ok) return
    const afterChat = loadChat(store, chat.value.id)
    expect(afterChat.ok && afterChat.value.activeBranchId).toBe(activate2.value.branchId)
    const current = loadBranch(store, activate2.value.branchId)
    // m2 经父链落在新分支覆盖域内(root m1 ∈ 链),leaf 指针随之移动
    expect(current.ok && current.value.leafMessageId).toBe(m2.value.message.id)
    store.close()
  })

  it('校验:不属于该 chat 的消息激活被拒(NOT_FOUND / VALIDATION)', () => {
    const { store, bus } = setup()
    const chatA = createChat(store, bus, { now: NOW })
    const chatB = createChat(store, bus, { now: NOW })
    if (!chatA.ok || !chatB.ok) throw new Error('unreachable')
    const message = createMessage(store, bus, { chatId: chatA.value.id, role: 'user', content: 'x', now: NOW })
    if (!message.ok) throw new Error('unreachable')
    const result = activateMessage(store, bus, {
      chatId: chatB.value.id,
      messageId: message.value.message.id,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    store.close()
  })
})
