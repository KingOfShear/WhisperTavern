import { z } from 'zod'
import { PromptIRSchema, PromptRoleSchema } from './ir'
import { DiagnosticSchema } from './diagnostics'
import { ChatIdSchema, RunIdSchema, SnapshotIdSchema, MessageIdSchema, TimestampSchema } from './core'

/**
 * Prompt Snapshot 与缓存计划形状 —— compiler-spec §54–§59、§62–§68 的收编落地。
 *
 * Snapshot 不可变(§68):重编译产生新 Snapshot,禁止原地 UPDATE——这是 §5.5
 * "模型可见即已记录"不变量的证据链基底。CachePlan 的**生产者**是 Cache Planner(P2);
 * P0 恒为空(R-P0-4,automatic-prefix 家族无需断点标记),但类型现在就位,
 * 保证 S3 的 Snapshot 构建器与 P2 无缝衔接。
 */

/** 缓存断点(compiler-spec §55;P0 不产出) */
export const CacheCheckpointSchema = z.object({
  id: z.string(),
  afterSegmentId: z.string(),
  prefixHash: z.string(),
  tokenCount: z.number().int().nonnegative(),
  reason: z.enum(['automatic', 'provider-required', 'manual']),
})
export type CacheCheckpoint = z.infer<typeof CacheCheckpointSchema>

/** 缓存失效原因(compiler-spec §58;type 为诊断标签,非 §5.4 事件名,大写系 §58 原文) */
export const CacheBreakReasonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('WORLD_BOOK_NEW_ENTRY'), entryId: z.string(), tokenDelta: z.number() }),
  z.object({ type: z.literal('WORLD_BOOK_RETIREMENT'), entryId: z.string() }),
  z.object({ type: z.literal('WORLD_BOOK_CONTENT_CHANGED'), entryId: z.string() }),
  z.object({ type: z.literal('MACRO_VOLATILE'), segmentId: z.string(), macro: z.string() }),
  z.object({ type: z.literal('SUMMARY_CHECKPOINT'), summaryId: z.string() }),
  z.object({ type: z.literal('HISTORY_COMPACTION') }),
  z.object({ type: z.literal('PRESET_CHANGED'), presetId: z.string() }),
  z.object({ type: z.literal('CHARACTER_CHANGED'), characterId: z.string() }),
  z.object({ type: z.literal('PERSONA_CHANGED'), personaId: z.string() }),
  z.object({ type: z.literal('MESSAGE_EDITED'), messageId: z.string() }),
  z.object({ type: z.literal('MESSAGE_VARIANT_SWITCHED'), messageId: z.string() }),
  z.object({ type: z.literal('BRANCH_SWITCHED'), fromMessageId: z.string(), toMessageId: z.string() }),
  z.object({ type: z.literal('WORLD_BOOK_DEACTIVATED'), entryId: z.string() }),
  z.object({ type: z.literal('MANUAL_INVALIDATION'), reason: z.string() }),
])
export type CacheBreakReason = z.infer<typeof CacheBreakReasonSchema>

/** CachePlan(compiler-spec §54)。P0 恒空(R-P0-4);checkpoints/breakReasons 为空数组 */
export const CachePlanSchema = z.object({
  version: z.number().int(),
  stablePrefixSegments: z.array(z.string()),
  stablePrefixTokens: z.number().int().nonnegative(),
  freshSegments: z.array(z.string()),
  freshTokens: z.number().int().nonnegative(),
  volatileSegments: z.array(z.string()),
  volatileTokens: z.number().int().nonnegative(),
  checkpoints: z.array(CacheCheckpointSchema),
  invalidationRisk: z.enum(['low', 'medium', 'high']),
  breakReasons: z.array(CacheBreakReasonSchema),
  /** 形状随 WP2.4 缓存标记翻译定稿(P2);P0 恒缺省 */
  providerStrategy: z.unknown().optional(),
})
export type CachePlan = z.infer<typeof CachePlanSchema>

/**
 * 序列化片段(compiler-spec §65 parts)。字段形状随 §63 Provider Serialization
 * 实现(S4/WP0.4)定稿,P0 保持开放:role/content 为 chat-messages 格式的已知键,
 * 其余键(Anthropic blocks / Gemini parts)原样保留。
 */
export const SerializedPartSchema = z
  .object({
    role: PromptRoleSchema.optional(),
    content: z.string().optional(),
  })
  .catchall(z.unknown())
export type SerializedPart = z.infer<typeof SerializedPartSchema>

/** 序列化产物(compiler-spec §65);Serializer 只做 IR → provider 形状的翻译(§62) */
export const SerializedPromptSchema = z.object({
  format: z.enum(['chat-messages', 'responses', 'contents', 'custom']),
  parts: z.array(SerializedPartSchema),
  raw: z.unknown().optional(),
  hash: z.string(),
  tokenCount: z.number().int().nonnegative(),
  /** §52 双模式必须记录:exact(Provider tokenizer)/ estimated(本地估算) */
  tokenCountMode: z.enum(['exact', 'estimated']).optional(),
})
export type SerializedPrompt = z.infer<typeof SerializedPromptSchema>

/** 八区哈希(compiler-spec §67):逐字节确定性,同输入必须同哈希(S3 断言) */
export const PromptHashesSchema = z.object({
  header: z.string(),
  stableWB: z.string(),
  freshWB: z.string(),
  summary: z.string(),
  history: z.string(),
  injection: z.string(),
  tail: z.string(),
  final: z.string(),
})
export type PromptHashes = z.infer<typeof PromptHashesSchema>

/** Prompt Snapshot(compiler-spec §66;ImmutableRecord 语义,§68 禁 UPDATE) */
export const PromptSnapshotSchema = z.object({
  id: SnapshotIdSchema,
  chatId: ChatIdSchema,
  runId: RunIdSchema.optional(),
  messageId: MessageIdSchema.optional(),
  provider: z.string(),
  model: z.string(),
  /** compiler-spec §6:破坏性变化必须升 major 并产生新 Golden Snapshot */
  compilerVersion: z.string(),
  ir: PromptIRSchema,
  cachePlan: CachePlanSchema,
  serialized: SerializedPromptSchema,
  hashes: PromptHashesSchema,
  diagnostics: z.array(DiagnosticSchema),
  /** instruction-security §19.1 / §38 决策 30 ⑥:按 (segmentId, authority, trust, scope)
   *  编译序的序列哈希;元数据不进八区字节,故不是第九哈希区 */
  authorityFingerprint: z.string().optional(),
  createdAt: TimestampSchema,
})
export type PromptSnapshot = z.infer<typeof PromptSnapshotSchema>
