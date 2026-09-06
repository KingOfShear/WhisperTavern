import { z } from 'zod'
import {
  ChatBranchIdSchema,
  ChatIdSchema,
  CharacterIdSchema,
  MessageIdSchema,
  PersonaIdSchema,
  PresetIdSchema,
  TimestampSchema,
  UserIdSchema,
} from './core'

/**
 * chat 面运行态契约 —— database-schema P0 表清单(chats / messages / chat_branches,
 * §17/§19/§21)的 TS 投影,命名映射遵循 shared-contracts-spec C3。
 *
 * C3 映射:Conversation = chats 别名(不引平行行话);MessageRole.character ≠
 * assistant,与 messages.author_type 对齐;消息 = 不可变事实(编辑 = 新事实,
 * 见 §31 血缘与消息树语义)。
 */

/**
 * 消息角色(shared-contracts §3)。`character` 是 RP 客户端的一等角色,
 * 不与 `assistant` 合并——两者在缓存语义、author_type、UI 呈现上都不同。
 */
export const MessageRoleSchema = z.enum([
  'system',
  'user',
  'character',
  'assistant',
  'tool',
  'narrator',
])
export type MessageRole = z.infer<typeof MessageRoleSchema>

/** chats 表投影(database-schema §17)。P0 单聊:character_* 绑定即 §18 资产版本快照 */
export const ChatSchema = z.object({
  id: ChatIdSchema,
  ownerId: UserIdSchema.optional(),
  title: z.string().optional(),
  characterId: CharacterIdSchema.optional(),
  characterVersion: z.number().int().optional(),
  personaId: PersonaIdSchema.optional(),
  personaVersion: z.number().int().optional(),
  presetId: PresetIdSchema.optional(),
  presetVersion: z.number().int().optional(),
  /** 活跃指针唯一来源 = chats.active_branch_id → chat_branches.leaf_message_id(§19 修订/§21) */
  activeBranchId: ChatBranchIdSchema.optional(),
  modelProvider: z.string().optional(),
  modelName: z.string().optional(),
  settings: z.record(z.string(), z.unknown()),
  runtimeState: z.record(z.string(), z.unknown()),
  /** DB 为 BIGINT;P0 以 number 承载(< 2^53),S5 Drizzle 建表时同口径 */
  messageSequence: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.optional(),
})
export type Chat = z.infer<typeof ChatSchema>

/** messages 表投影(database-schema §19)。Message = 不可变事实;活跃性不落在本表(§19 修订) */
export const MessageSchema = z.object({
  id: MessageIdSchema,
  chatId: ChatIdSchema,
  /** 消息树父指针(§20):无父 = 根;branch 语义经 parent chain 走历史 */
  parentMessageId: MessageIdSchema.optional(),
  sequence: z.number().int().nonnegative(),
  role: MessageRoleSchema,
  /** 作者归属(C3:与 author_type 对齐);群聊(P4)依赖此位区分多角色 */
  authorType: MessageRoleSchema.optional(),
  authorId: z.string().optional(),
  content: z.string(),
  name: z.string().optional(),
  /** swipe 血缘(database-schema §22):同 variant_group 下的兄弟即 swipe 候选 */
  variantGroupId: z.string().optional(),
  variantIndex: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.optional(),
})
export type Message = z.infer<typeof MessageSchema>

/** chat_branches 表投影(database-schema §21),含分支血缘位(§38 决策 25) */
export const ChatBranchSchema = z.object({
  id: ChatBranchIdSchema,
  chatId: ChatIdSchema,
  parentBranchId: ChatBranchIdSchema.optional(),
  rootMessageId: MessageIdSchema.optional(),
  leafMessageId: MessageIdSchema.optional(),
  /** 血缘位(决策 25):继承前缀 = 可复用缓存前缀,沿父分支 snapshot_id 链命中 */
  forkMessageId: MessageIdSchema.optional(),
  seedLength: z.number().int().nonnegative(),
  isSeeded: z.boolean(),
  name: z.string().optional(),
  isActive: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ChatBranch = z.infer<typeof ChatBranchSchema>
