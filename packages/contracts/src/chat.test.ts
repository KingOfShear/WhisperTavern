import { describe, expect, it } from 'vitest'
import { ChatBranchSchema, ChatSchema, MessageRoleSchema, MessageSchema } from './chat'

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)))
}

const chat = {
  id: 'chat_0001',
  ownerId: 'user_0001',
  characterId: 'char_0001',
  characterVersion: 3,
  activeBranchId: 'branch_0001',
  modelProvider: 'openai-compat',
  modelName: 'deepseek-chat',
  settings: {},
  runtimeState: {},
  messageSequence: 42,
  createdAt: '2026-09-05T12:00:00Z',
  updatedAt: '2026-09-05T12:30:00Z',
}

const message = {
  id: 'msg_0001',
  chatId: 'chat_0001',
  parentMessageId: 'msg_0000',
  sequence: 1,
  role: 'character',
  authorType: 'character',
  content: '……',
  metadata: {},
  createdAt: '2026-09-05T12:00:00Z',
  updatedAt: '2026-09-05T12:00:00Z',
}

describe('contracts/chat(运行态契约)', () => {
  it('MessageRole 六值穷尽,character ≠ assistant(C3)', () => {
    expect(MessageRoleSchema.options).toHaveLength(6)
    expect(MessageRoleSchema.options).toContain('character')
    expect(MessageRoleSchema.options).toContain('assistant')
  })

  it('Chat round-trip:资产版本绑定与活跃指针在位(database-schema §17/§18)', () => {
    expect(roundTrip(ChatSchema, chat)).toEqual(chat)
    expect(ChatSchema.safeParse({ ...chat, messageSequence: -1 }).success).toBe(false)
  })

  it('Message round-trip:无活跃字段(messages 上不设 is_active,§19 修订)', () => {
    const parsed = roundTrip(MessageSchema, message)
    expect(parsed).toEqual(message)
    expect('isActive' in parsed).toBe(false)
  })

  it('ChatBranch round-trip:血缘位齐全(决策 25)', () => {
    const branch = {
      id: 'branch_0002',
      chatId: 'chat_0001',
      parentBranchId: 'branch_0001',
      leafMessageId: 'msg_0002',
      forkMessageId: 'msg_0001',
      seedLength: 5,
      isSeeded: true,
      isActive: false,
      metadata: {},
      createdAt: '2026-09-05T12:00:00Z',
      updatedAt: '2026-09-05T12:00:00Z',
    }
    expect(roundTrip(ChatBranchSchema, branch)).toEqual(branch)
  })
})
