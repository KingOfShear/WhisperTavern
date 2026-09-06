import { describe, expect, it } from 'vitest'
import { ChatIdSchema, NormalizedScoreSchema, TimestampSchema, type ChatId } from './core'

describe('contracts/core(基础形状)', () => {
  it('Timestamp 只接受以 Z 结尾的 ISO-8601 UTC 字符串', () => {
    expect(TimestampSchema.safeParse('2026-09-05T12:00:00Z').success).toBe(true)
    expect(TimestampSchema.safeParse('2026-09-05T12:00:00.123Z').success).toBe(true)
    expect(TimestampSchema.safeParse('2026-09-05T12:00:00+08:00').success).toBe(false)
    expect(TimestampSchema.safeParse('2026-09-05').success).toBe(false)
  })

  it('branded ID 经 parse 保持品牌且不可裸 string 互换(类型层)', () => {
    const id: ChatId = ChatIdSchema.parse('chat_0001')
    expect(id).toBe('chat_0001')
    // @ts-expect-error 品牌 ID 不可由未品牌 string 直接赋值(共享契约 §2 opaque)
    const misuse: ChatId = 'chat_0001'
    expect(misuse).toBeDefined()
  })

  it('NormalizedScore 锁定 0.0–1.0 刻度', () => {
    expect(NormalizedScoreSchema.safeParse(0.5).success).toBe(true)
    expect(NormalizedScoreSchema.safeParse(1.0).success).toBe(true)
    expect(NormalizedScoreSchema.safeParse(-0.1).success).toBe(false)
    expect(NormalizedScoreSchema.safeParse(50).success).toBe(false)
  })
})
