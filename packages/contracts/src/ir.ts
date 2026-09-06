import { z } from 'zod'
import { CachePlacementSchema, SemanticPlacementSchema, StabilityClassSchema } from './placement'
import { InstructionMetadataSchema } from './instruction'

/**
 * Prompt IR —— compiler-spec §7–§11 的收编落地。
 *
 * IR 是 Compiler 的核心中间表示(§7):Serializer 只接受 IR(§62),不接触
 * Character/Worldbook/Chat 等资产;Segment ID 必须稳定(§9,assetId+logicalPath,
 * 禁 randomUUID),否则每轮编译都会产生 IR/Cache/Snapshot Diff。
 */

/** 消息角色(compiler-spec §11;语义属性,禁止从文本前缀推断) */
export const PromptRoleSchema = z.enum(['system', 'user', 'assistant', 'tool'])
export type PromptRole = z.infer<typeof PromptRoleSchema>

/**
 * 段来源登记表(compiler-spec §10)。13 变体覆盖全部注入面;instruction-security
 * §10 的默认推导表按此查表(source → authority/trust/scope)。
 */
export const SegmentSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('character'), assetId: z.string(), field: z.string() }),
  z.object({ type: z.literal('persona'), assetId: z.string() }),
  z.object({ type: z.literal('preset'), presetId: z.string(), segmentId: z.string() }),
  z.object({ type: z.literal('worldbook'), worldbookId: z.string(), entryId: z.string() }),
  z.object({ type: z.literal('summary'), summaryId: z.string() }),
  z.object({ type: z.literal('message'), messageId: z.string() }),
  z.object({ type: z.literal('memory'), memoryId: z.string() }),
  z.object({ type: z.literal('agent'), agentId: z.string() }),
  z.object({ type: z.literal('workflow'), workflowId: z.string(), stageId: z.string() }),
  z.object({ type: z.literal('artifact'), artifactId: z.string(), runId: z.string().optional() }),
  z.object({ type: z.literal('toolResult'), toolCallId: z.string() }),
  z.object({ type: z.literal('plugin'), pluginId: z.string(), contributionId: z.string() }),
  z.object({ type: z.literal('runtime'), key: z.string() }),
])
export type SegmentSource = z.infer<typeof SegmentSourceSchema>

/**
 * Prompt Segment(compiler-spec §8 + §17 stabilityOverride + instruction-security §9
 * 的 `instruction` 扩展位)。
 */
export const PromptSegmentSchema = z.object({
  /** 稳定语义 ID(assetId + logicalPath,§9.1);非 UUID */
  id: z.string().min(1),
  source: SegmentSourceSchema,
  role: PromptRoleSchema,
  content: z.string(),
  semanticPlacement: SemanticPlacementSchema,
  cachePlacement: CachePlacementSchema,
  stability: StabilityClassSchema,
  /** 手动稳定性覆盖(§17):必须伴随 warning 级诊断——系统不能假装它真的稳定 */
  stabilityOverride: StabilityClassSchema.optional(),
  order: z.number().int(),
  tokenCount: z.number().int().nonnegative(),
  dependencies: z.array(z.string()),
  enabled: z.boolean(),
  /** 缺省即推导:不传时 Compiler 按 instruction-security §10 从 source 查表投影 */
  instruction: InstructionMetadataSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type PromptSegment = z.infer<typeof PromptSegmentSchema>

/**
 * Zone 划分(compiler-spec §18)。P0 只携 name(顺序即 §18 默认序);
 * §48 Zone Budget 等扩展字段随 P2 落地,catchall 保持前向兼容。
 */
export const PromptZoneSchema = z
  .object({ name: z.enum(['header', 'stableWB', 'freshWB', 'summary', 'history', 'injection', 'tail']) })
  .catchall(z.unknown())
export type PromptZone = z.infer<typeof PromptZoneSchema>

/**
 * 开放元数据袋。**确定性红线(§5)**:进入 IR 的内容参与哈希,禁止写入
 * wall-clock / 随机值;时间戳只允许出现在 Snapshot 层(§66 createdAt)。
 */
export const PromptMetadataSchema = z.record(z.string(), z.unknown())
export type PromptMetadata = z.infer<typeof PromptMetadataSchema>

/** Prompt IR(compiler-spec §7) */
export const PromptIRSchema = z.object({
  schemaVersion: z.number().int(),
  segments: z.array(PromptSegmentSchema),
  zones: z.array(PromptZoneSchema),
  metadata: PromptMetadataSchema,
})
export type PromptIR = z.infer<typeof PromptIRSchema>
