import {
  ChatBranchSchema,
  ChatSchema,
  MessageSchema,
  type ApplicationError,
  type Chat,
  type ChatBranch,
  type Message,
  type MessageRole,
  type Result,
  type Timestamp,
  type ChatId,
  type MessageId,
} from '@desiregrimoire/contracts'
import { eq } from 'drizzle-orm'
import type { EventBus } from '../events/bus'
import type { DesireGrimoireDb } from '../db/database'
import { chatBranches, chats, messages } from '../db/schema'
import { uuidv7 } from '../util/id'

/**
 * 消息树操作 —— api-spec §16–§22 语义 + database-schema §19–§22(p0-plan S5 任务 4)。
 *
 * 树语义铁律:
 * - **活跃指针唯一**:chats.active_branch_id → chat_branches.leaf_message_id;
 *   messages 上没有 is_active(§19 修订),激活 = 移动 leaf,绝不双指针。
 * - Message 是不可变事实:编辑 = 新建变体(variant_group),旧消息内容永不动(§19);
 *   swipe = 在同 variant_group 下新建兄弟(§20/§22)。
 * - 分支不复制聊天:血缘位(fork_message_id + seed_length + is_seeded)记录继承
 *   前缀(§21/决策 25),leaf 切换即分支语义。
 */

type OpResult<T> = Result<T, ApplicationError>

export interface CreateChatInput {
  ownerId?: string
  title?: string
  characterId?: string
  characterVersion?: number
  personaId?: string
  personaVersion?: number
  presetId?: string
  presetVersion?: number
  now: Timestamp
}

/** 创建 chat + 默认主分支(main,is_active),发 chat.created(§18 前置) */
export function createChat(store: DesireGrimoireDb, bus: EventBus, input: CreateChatInput): OpResult<Chat> {
  const chatId = uuidv7() as ChatId
  const branchId = uuidv7()
  store.db.transaction(() => {
    store.db.insert(chats).values({
      id: chatId,
      ownerId: input.ownerId,
      title: input.title,
      characterId: input.characterId,
      characterVersion: input.characterVersion,
      personaId: input.personaId,
      personaVersion: input.personaVersion,
      presetId: input.presetId,
      presetVersion: input.presetVersion,
      activeBranchId: branchId,
      settings: '{}',
      runtimeState: '{}',
      messageSequence: 0,
      createdAt: input.now,
      updatedAt: input.now,
    }).run()
    store.db.insert(chatBranches).values({
      id: branchId,
      chatId,
      name: 'main',
      seedLength: 0,
      isSeeded: false,
      isActive: true,
      metadata: '{}',
      createdAt: input.now,
      updatedAt: input.now,
    }).run()
  })

  bus.publish({
    type: 'chat.created',
    aggregateType: 'chat',
    aggregateId: chatId,
    timestamp: input.now,
    payload: { chatId, branchId },
  })
  return loadChat(store, chatId)
}

export interface CreateMessageInput {
  chatId: ChatId
  /** 缺省挂到当前活跃叶子(§18:Create User Message 的续聊语义) */
  parentId?: MessageId
  role: MessageRole
  content: string
  authorType?: MessageRole
  authorId?: string
  name?: string
  now: Timestamp
}

export interface CreatedMessage {
  message: Message
  activeLeaf: MessageId
}

export function createMessage(
  store: DesireGrimoireDb,
  bus: EventBus,
  input: CreateMessageInput,
): OpResult<CreatedMessage> {
  const chat = loadChat(store, input.chatId)
  if (!chat.ok) return chat
  const branch = activeBranch(store, input.chatId)
  if (!branch.ok) return branch

  const parentId = input.parentId ?? branch.value.leafMessageId
  const sequence = chat.value.messageSequence + 1
  const messageId = uuidv7() as MessageId

  store.db.transaction(() => {
    store.db.insert(messages).values({
      id: messageId,
      chatId: input.chatId,
      parentId,
      sequence,
      role: input.role,
      authorType: input.authorType ?? input.role,
      authorId: input.authorId,
      content: input.content,
      name: input.name,
      metadata: '{}',
      createdAt: input.now,
      updatedAt: input.now,
    }).run()
    store.db.update(chats).set({ messageSequence: sequence, updatedAt: input.now }).where(eq(chats.id, input.chatId)).run()
    store.db
      .update(chatBranches)
      .set({ leafMessageId: messageId, updatedAt: input.now })
      .where(eq(chatBranches.id, branch.value.id))
      .run()
  })

  bus.publish({
    type: 'message.created',
    aggregateType: 'message',
    aggregateId: messageId,
    timestamp: input.now,
    payload: { chatId: input.chatId, messageId, parentId, role: input.role, sequence },
  })
  const loaded = loadMessage(store, messageId)
  if (!loaded.ok) return loaded
  return { ok: true, value: { message: loaded.value, activeLeaf: messageId } }
}

/** §19 编辑:不原地覆盖——新建变体(同父兄弟),leaf 移到新版本,原消息内容永不动 */
export function editMessage(
  store: DesireGrimoireDb,
  bus: EventBus,
  input: { messageId: MessageId; content: string; now: Timestamp },
): OpResult<Message> {
  return createVariant(store, bus, { ...input, kind: 'edited' })
}

/** §20/§22 swipe:同 variant_group 新建兄弟(空内容,由生成填充);S6 将其串接 dispatchGeneration */
export function swipeMessage(
  store: DesireGrimoireDb,
  bus: EventBus,
  input: { messageId: MessageId; now: Timestamp },
): OpResult<Message> {
  return createVariant(store, bus, { ...input, kind: 'swiped' })
}

function createVariant(
  store: DesireGrimoireDb,
  bus: EventBus,
  input: { messageId: MessageId; content?: string; now: Timestamp; kind: 'edited' | 'swiped' },
): OpResult<Message> {
  const original = loadMessage(store, input.messageId)
  if (!original.ok) return original
  const source = original.value
  const chat = loadChat(store, source.chatId as ChatId)
  if (!chat.ok) return chat

  const groupId = source.variantGroupId ?? uuidv7()
  const siblings = store.db
    .select({ variantIndex: messages.variantIndex })
    .from(messages)
    .where(eq(messages.variantGroupId, groupId))
    .all()
    .map((row) => row.variantIndex ?? 0)
  const nextIndex = siblings.length === 0 ? 1 : Math.max(...siblings) + 1
  const variantId = uuidv7() as MessageId
  const sequence = chat.value.messageSequence + 1

  store.db.transaction(() => {
    // 原消息只补结构位(variant_group/index),内容与事实字段不动(不可变事实原则)
    if (source.variantGroupId === undefined) {
      store.db
        .update(messages)
        .set({ variantGroupId: groupId, variantIndex: 0, updatedAt: input.now })
        .where(eq(messages.id, source.id))
        .run()
    }
    store.db.insert(messages).values({
      id: variantId,
      chatId: source.chatId,
      parentId: source.parentMessageId,
      sequence,
      role: source.role,
      authorType: source.authorType,
      authorId: source.authorId,
      content: input.content ?? '',
      name: source.name,
      variantGroupId: groupId,
      variantIndex: nextIndex,
      metadata: '{}',
      createdAt: input.now,
      updatedAt: input.now,
    }).run()
    store.db.update(chats).set({ messageSequence: sequence, updatedAt: input.now }).where(eq(chats.id, source.chatId)).run()
    store.db
      .update(chatBranches)
      .set({ leafMessageId: variantId, updatedAt: input.now })
      .where(eq(chatBranches.id, activeBranchOrThrow(store, source.chatId)))
      .run()
  })

  bus.publish({
    type: input.kind === 'edited' ? 'message.edited' : 'message.swiped',
    aggregateType: 'message',
    aggregateId: variantId,
    timestamp: input.now,
    payload: {
      chatId: source.chatId,
      variantId,
      variantOf: source.id,
      variantGroupId: groupId,
      variantIndex: nextIndex,
    },
  })
  return loadMessage(store, variantId)
}

/** §21 分支:不复制聊天,只记录血缘位(继承前缀 = 可复用缓存前缀,决策 25) */
export function createBranch(
  store: DesireGrimoireDb,
  bus: EventBus,
  input: { chatId: ChatId; fromMessageId: MessageId; name?: string; now: Timestamp },
): OpResult<ChatBranch> {
  const chat = loadChat(store, input.chatId)
  if (!chat.ok) return chat
  const fork = loadMessage(store, input.fromMessageId)
  if (!fork.ok) return fork
  if (fork.value.chatId !== input.chatId) {
    return opError('VALIDATION', 'fromMessageId 不属于该 chat')
  }
  const active = activeBranch(store, input.chatId)
  if (!active.ok) return active

  const seedLength = chainDepth(store, input.fromMessageId)
  const branchId = uuidv7()

  store.db.transaction(() => {
    store.db.insert(chatBranches).values({
      id: branchId,
      chatId: input.chatId,
      parentBranchId: active.value.id,
      rootMessageId: input.fromMessageId,
      leafMessageId: input.fromMessageId,
      forkMessageId: input.fromMessageId,
      seedLength,
      isSeeded: seedLength > 0,
      name: input.name,
      isActive: true,
      metadata: '{}',
      createdAt: input.now,
      updatedAt: input.now,
    }).run()
    // §21"只改变 active leaf":建分支即把活跃指针切到新分支(fork-and-continue)
    store.db
      .update(chatBranches)
      .set({ isActive: false, updatedAt: input.now })
      .where(eq(chatBranches.chatId, input.chatId))
      .run()
    store.db
      .update(chatBranches)
      .set({ isActive: true, updatedAt: input.now })
      .where(eq(chatBranches.id, branchId))
      .run()
    store.db
      .update(chats)
      .set({ activeBranchId: branchId, updatedAt: input.now })
      .where(eq(chats.id, input.chatId))
      .run()
  })

  bus.publish({
    type: 'chat.updated',
    aggregateType: 'chat',
    aggregateId: input.chatId,
    timestamp: input.now,
    payload: { action: 'branch_created', branchId, forkMessageId: input.fromMessageId, seedLength },
  })
  return loadBranch(store, branchId)
}

/**
 * §22 激活:leaf 指针唯一移动。优先当前活跃分支(若消息在其覆盖域内),
 * 否则取覆盖该消息链的其他分支,最后落到主分支(root 未设 = 全树)。
 */
export function activateMessage(
  store: DesireGrimoireDb,
  bus: EventBus,
  input: { chatId: ChatId; messageId: MessageId; now: Timestamp },
): OpResult<{ branchId: string; activeLeafId: MessageId }> {
  const target = loadMessage(store, input.messageId)
  if (!target.ok) return target
  if (target.value.chatId !== input.chatId) {
    return opError('VALIDATION', 'messageId 不属于该 chat')
  }
  const chain = ancestorChain(store, input.messageId)

  const branches = store.db
    .select()
    .from(chatBranches)
    .where(eq(chatBranches.chatId, input.chatId))
    .all()
    .map((row) => ChatBranchSchema.parse(rowToBranch(row)))

  const current = branches.find((b) => b.id === chat_activeBranchId(store, input.chatId))
  const covers = (b: ChatBranch): boolean => b.rootMessageId === undefined || chain.includes(b.rootMessageId)
  const branch = (current !== undefined && covers(current) ? current : undefined) ??
    branches.find(covers) ??
    branches[0]
  if (branch === undefined) {
    return opError('NOT_FOUND', 'chat 无可用分支')
  }

  store.db.transaction(() => {
    store.db.update(chatBranches).set({ isActive: false, updatedAt: input.now }).where(eq(chatBranches.chatId, input.chatId)).run()
    store.db
      .update(chatBranches)
      .set({ isActive: true, leafMessageId: input.messageId, updatedAt: input.now })
      .where(eq(chatBranches.id, branch.id))
      .run()
    store.db
      .update(chats)
      .set({ activeBranchId: branch.id, updatedAt: input.now })
      .where(eq(chats.id, input.chatId))
      .run()
  })

  bus.publish({
    type: 'chat.updated',
    aggregateType: 'chat',
    aggregateId: input.chatId,
    timestamp: input.now,
    payload: { action: 'activate_leaf', messageId: input.messageId, branchId: branch.id },
  })
  return { ok: true, value: { branchId: branch.id, activeLeafId: input.messageId } }
}

// —— 查询与映射 ——

export function loadChat(store: DesireGrimoireDb, chatId: ChatId): OpResult<Chat> {
  const row = store.db.select().from(chats).where(eq(chats.id, chatId)).get()
  if (row === undefined) return opError('NOT_FOUND', `chat 不存在: ${chatId}`)
  return { ok: true, value: ChatSchema.parse(rowToChat(row)) }
}

export function loadMessage(store: DesireGrimoireDb, messageId: MessageId): OpResult<Message> {
  const row = store.db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (row === undefined) return opError('NOT_FOUND', `message 不存在: ${messageId}`)
  return { ok: true, value: MessageSchema.parse(rowToMessage(row)) }
}

export function loadBranch(store: DesireGrimoireDb, branchId: string): OpResult<ChatBranch> {
  const row = store.db.select().from(chatBranches).where(eq(chatBranches.id, branchId)).get()
  if (row === undefined) return opError('NOT_FOUND', `branch 不存在: ${branchId}`)
  return { ok: true, value: ChatBranchSchema.parse(rowToBranch(row)) }
}

/** 活跃叶子消息 id(§21:active_branch_id → branch.leaf_message_id);无消息返回 undefined */
export function activeLeafId(store: DesireGrimoireDb, chatId: ChatId): string | undefined {
  const branchId = chat_activeBranchId(store, chatId)
  if (branchId === undefined) return undefined
  const row = store.db.select({ leaf: chatBranches.leafMessageId }).from(chatBranches).where(eq(chatBranches.id, branchId)).get()
  return row?.leaf ?? undefined
}

function activeBranch(store: DesireGrimoireDb, chatId: ChatId): OpResult<ChatBranch> {
  const branchId = chat_activeBranchId(store, chatId)
  if (branchId === undefined) return opError('NOT_FOUND', 'chat 无活跃分支')
  return loadBranch(store, branchId)
}

function activeBranchOrThrow(store: DesireGrimoireDb, chatId: string): string {
  const branchId = chat_activeBranchId(store, chatId as ChatId)
  if (branchId === undefined) throw new Error(`INVARIANT_VIOLATION: chat ${chatId} 无活跃分支`)
  return branchId
}

function chat_activeBranchId(store: DesireGrimoireDb, chatId: ChatId): string | undefined {
  const row = store.db.select({ activeBranchId: chats.activeBranchId }).from(chats).where(eq(chats.id, chatId)).get()
  return row?.activeBranchId ?? undefined
}

/** 从消息沿父链到根;返回 [messageId, ..., root](含自身) */
export function ancestorChain(store: DesireGrimoireDb, messageId: MessageId): string[] {
  const chain: string[] = []
  let cursor: string | undefined = messageId
  const guard = new Set<string>()
  while (cursor !== undefined && cursor !== null && !guard.has(cursor)) {
    guard.add(cursor)
    chain.push(cursor)
    const row = store.db
      .select({ parentId: messages.parentId })
      .from(messages)
      .where(eq(messages.id, cursor))
      .get()
    cursor = row?.parentId ?? undefined
  }
  return chain
}

function chainDepth(store: DesireGrimoireDb, messageId: MessageId): number {
  return ancestorChain(store, messageId).length
}

type ChatRow = typeof chats.$inferSelect
type MessageRow = typeof messages.$inferSelect
type BranchRow = typeof chatBranches.$inferSelect

function rowToChat(row: ChatRow): Record<string, unknown> {
  return {
    ...row,
    ownerId: row.ownerId ?? undefined,
    title: row.title ?? undefined,
    characterId: row.characterId ?? undefined,
    characterVersion: row.characterVersion ?? undefined,
    personaId: row.personaId ?? undefined,
    personaVersion: row.personaVersion ?? undefined,
    presetId: row.presetId ?? undefined,
    presetVersion: row.presetVersion ?? undefined,
    activeBranchId: row.activeBranchId ?? undefined,
    modelProvider: row.modelProvider ?? undefined,
    modelName: row.modelName ?? undefined,
    settings: JSON.parse(row.settings) as Record<string, unknown>,
    runtimeState: JSON.parse(row.runtimeState) as Record<string, unknown>,
    deletedAt: row.deletedAt ?? undefined,
  }
}

function rowToMessage(row: MessageRow): Record<string, unknown> {
  return {
    ...row,
    parentMessageId: row.parentId ?? undefined,
    authorType: row.authorType ?? undefined,
    authorId: row.authorId ?? undefined,
    name: row.name ?? undefined,
    variantGroupId: row.variantGroupId ?? undefined,
    variantIndex: row.variantIndex ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    deletedAt: row.deletedAt ?? undefined,
  }
}

function rowToBranch(row: BranchRow): Record<string, unknown> {
  return {
    ...row,
    parentBranchId: row.parentBranchId ?? undefined,
    rootMessageId: row.rootMessageId ?? undefined,
    leafMessageId: row.leafMessageId ?? undefined,
    forkMessageId: row.forkMessageId ?? undefined,
    name: row.name ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  }
}

function opError<T>(code: string, message: string): OpResult<T> {
  return { ok: false, error: { code, message, retryable: false } }
}
