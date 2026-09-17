import { z } from 'zod'
import { PromptIRSchema, PromptRoleSchema, SegmentSourceSchema } from './ir'
import { DiagnosticSchema } from './diagnostics'
import { PromptZoneNameSchema, StabilityClassSchema } from './placement'
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
  createdAt: TimestampSchema,
})
export type PromptSnapshot = z.infer<typeof PromptSnapshotSchema>

// ===== Prompt Diff(api-spec §38;S14/WP1.5 Inspector 相邻两轮对比的线格式)=====

/**
 * 单段 diff 判定(api-spec §38 SegmentDiff)。kind:
 * - same      段 id 相同且 contentHash 一致(可命中缓存前缀);
 * - changed   段 id 相同但内容变化(缓存从该段起失效);
 * - added     B 新增段;removed   A 独有段(被删/被裁剪)。
 * order 变化不单独判定——物理序变化表现为新增+移除的组合。
 */
export const SegmentDiffKindSchema = z.enum(['same', 'changed', 'added', 'removed'])
export type SegmentDiffKind = z.infer<typeof SegmentDiffKindSchema>

/** 段投影:Inspector 展示与 diff 共用(八区哈希口径,§67 修订) */
export const SegmentProjectionSchema = z.object({
  id: z.string().min(1),
  source: SegmentSourceSchema,
  role: PromptRoleSchema,
  zone: PromptZoneNameSchema,
  stability: StabilityClassSchema,
  tokenCount: z.number().int().nonnegative(),
  contentHash: z.string(),
})
export type SegmentProjection = z.infer<typeof SegmentProjectionSchema>

export const SegmentDiffSchema = z.object({
  kind: SegmentDiffKindSchema,
  segmentId: z.string(),
  /** added/removed 时缺省一侧;changed 时两侧都带 */
  before: SegmentProjectionSchema.optional(),
  after: SegmentProjectionSchema.optional(),
})
export type SegmentDiff = z.infer<typeof SegmentDiffSchema>

export const PromptDiffSchema = z.object({
  snapshotAId: SnapshotIdSchema,
  snapshotBId: SnapshotIdSchema,
  segments: z.array(SegmentDiffSchema),
  /** 首个非 same 段(api-spec §38 firstDivergence;byteOffset 为该段内容内偏移,P0 省略) */
  firstDivergence: z.object({ segmentId: z.string() }).optional(),
  /** tokenDelta.fresh = 新增 token − 移除 token 的净值口径太粗,P0 给三项实测量 */
  tokenDelta: z.object({
    input: z.number().int(),
    cached: z.number().int().nonnegative(),
    fresh: z.number().int(),
  }),
  /** P0 启发式:首分歧段落在 worldbook 族区 → WORLD_BOOK_CONTENT_CHANGED;history → MESSAGE_EDITED */
  cacheBreak: CacheBreakReasonSchema.optional(),
})
export type PromptDiff = z.infer<typeof PromptDiffSchema>

// ===== Sanitized Debug Export(还账 #15;总设计 §19/§32,provider-adapter §17.2 PV5)=====

/** 脱敏模式:sanitized(默认,去用户内容+匿名化)/ full(仅显式要求,保留原文) */
export const RedactionModeSchema = z.enum(['sanitized', 'full'])
export type RedactionMode = z.infer<typeof RedactionModeSchema>

export const RedactionPolicySchema = z.object({
  mode: RedactionModeSchema,
  /** true = 用户/角色发言以 [user-content removed] 占位(P0 默认 true,§19 脱敏红线) */
  stripUserContent: z.boolean(),
  /** true = 消息/资产 ID 替换为稳定匿名别名(redact-1, redact-2 …) */
  anonymizeIds: z.boolean(),
  /** PV5 兜底:残留文本过密钥 redact(Bearer/sk- 形态;真实密钥表由 server 注入) */
  redactSecrets: z.boolean(),
})
export type RedactionPolicy = z.infer<typeof RedactionPolicySchema>

/**
 * 导出请求体(api-spec §60 debug 分支的形状化)。resourceType 仅 'snapshot':
 * 快照是 §19.2 所见即所发的证据链,P0 不导出会话全量。
 */
export const DebugExportRequestSchema = z.object({
  resourceType: z.literal('snapshot'),
  resourceId: SnapshotIdSchema,
  policy: RedactionPolicySchema.partial({ mode: true }).optional(),
})
export type DebugExportRequest = z.infer<typeof DebugExportRequestSchema>

/**
 * 可回放 bundle:serialized.parts 经策略处理后的消息序列 + 逐段投影。
 * 「可回放」口径:parts 按 buildGenerationRequest 同一投影规则还原为
 * ProviderMessage 序列,可直接喂 FakeProviderAdapter 重放(S14 验收)。
 */
export const DebugExportBundleSchema = z.object({
  format: z.literal('whispertavern-debug-bundle'),
  version: z.number().int(),
  exportedAt: TimestampSchema,
  policy: RedactionPolicySchema,
  snapshot: z.object({
    id: SnapshotIdSchema,
    chatId: z.string(),
    runId: z.string().optional(),
    provider: z.string(),
    model: z.string(),
    compilerVersion: z.string(),
    hashes: PromptHashesSchema,
    tokenCount: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  }),
  /** 脱敏后的段投影(顺序即发送序);full 模式含 content 原文,sanitized 去内容 */
  segments: z.array(
    SegmentProjectionSchema.extend({ content: z.string().optional() }),
  ),
  /** 回放脚本:role/content 消息序列(策略处理后的 serialized.parts) */
  messages: z.array(
    z.object({
      role: PromptRoleSchema,
      content: z.string(),
      segmentId: z.string().optional(),
    }),
  ),
  /** ID 匿名化映射(仅 anonymizeIds=true 时非空;原始 ID 不出现) */
  idMap: z.record(z.string(), z.string()),
  diagnostics: z.array(DiagnosticSchema),
})
export type DebugExportBundle = z.infer<typeof DebugExportBundleSchema>
