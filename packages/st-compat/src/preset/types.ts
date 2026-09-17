import { z } from 'zod'

/**
 * 原生 .dgpreset 模型 —— technical-plan §5.5(格式真相源)。
 *
 * 设计前提:酒馆预设是三段式分散结构(~52 个顶层散键 + `prompts[]` + 按 `character_id`
 * 魔数分组的 `prompt_order[]`),无稳定性元数据、无开关组概念、机制靠 `extensions` 走私。
 * 原生格式**语义不变、结构重组**——纯声明式提示词配置:段列表 + 顺序 + 插槽 + 稳定性
 * 标注 + 采样参数。三条硬约束(镜像 worldbook 模块):
 * - **往返无损**:ST `identifier` 原样保留(稳定映射键);未建模字段进 segment.compat / preset.compat。
 * - **零魔数**:injection_position 0/1 → header/injection 分区;marker identifier → slot 枚举。
 * - **不重造同义类型**:zone 直接复用 contracts PromptZoneName 概念(C4),slot 命名沿用 ST 线上协议词。
 */

/**
 * 原生预设段插槽(marker 枚举,替代 ST 魔法 identifier)。
 * null = 无插槽(纯 prompt 段);其余为 ST 动态插槽名(chatHistory / worldInfoBefore /
 * personaDescription …)——编译时由对应子系统填充,本模块只保留语义标记。
 */
export const DgPresetSlotSchema = z.enum([
  'charDescription',
  'charPersonality',
  'worldInfoBefore',
  'worldInfoAfter',
  'chatHistory',
  'personaDescription',
  'storyString',
  'systemPrompt',
])
export type DgPresetSlot = z.infer<typeof DgPresetSlotSchema>

/** 原生预设段 placement(compiler-spec §81:先 SemanticPlacement 再 CachePlacement) */
export const DgPresetPlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header'), order: z.number().int() }),
  z.object({ kind: z.literal('tail'), order: z.number().int() }),
  z.object({ kind: z.literal('injection'), depth: z.number().int().nonnegative(), order: z.number().int() }),
])
export type DgPresetPlacement = z.infer<typeof DgPresetPlacementSchema>

export const DgPresetSegmentSchema = z.object({
  /** 原生稳定 id(= ST identifier;§9 稳定 ID,非 UUID) */
  id: z.string().min(1),
  name: z.string().default(''),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().default(''),
  enabled: z.boolean(),
  /** 显式插槽枚举(替代 ST 魔法 identifier);null = 无插槽 */
  slot: DgPresetSlotSchema.nullable(),
  placement: DgPresetPlacementSchema,
  /** 稳定性标注;缺省由编译期按区推断(§16) */
  stability: z.enum(['static', 'session', 'request', 'message', 'volatile']).optional(),
  /** 原生"选一"开关组(替代 ST setvar 惯例) */
  group: z.object({ id: z.string().nullable(), exclusive: z.boolean() }).optional(),
  /** 未建模字段原样暂存(导出回写) */
  compat: z.record(z.string(), z.unknown()).default({}),
})
export type DgPresetSegment = z.infer<typeof DgPresetSegmentSchema>

export const DgPresetParamsSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  maxContext: z.number().optional(),
  maxTokens: z.number().optional(),
  stream: z.boolean().optional(),
})
export type DgPresetParams = z.infer<typeof DgPresetParamsSchema>

export const DgPresetSchema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    name: z.string().min(1),
    author: z.string().optional(),
    attribution: z.string().optional(),
    tags: z.array(z.string()).default([]),
  }),
  segments: z.array(DgPresetSegmentSchema),
  params: DgPresetParamsSchema.default({}),
  /** 机制引用(不内嵌任何代码;P2 落地) */
  bindings: z.record(z.string(), z.unknown()).default({}),
  /** 预设级未建模字段(如 extensions.*)原样暂存 */
  compat: z.record(z.string(), z.unknown()).default({}),
})
export type DgPreset = z.infer<typeof DgPresetSchema>

// ===== ST 原始形状(zod 宽校验:外部输入,取值前 narrowing)=====

/** ST prompt manager 单条 prompts[] 项——全部 optional(缺省按酒馆默认补齐) */
export const StPresetSegmentSchema = z.looseObject({
  identifier: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
  /** 0 = before(注入系统提示前),1 = after(注入历史末尾前 depth 楼);缺省 = 纯 prompt 段 */
  injection_position: z.number().optional(),
  injection_depth: z.number().optional(),
  /** prompt_order 内序号(部分格式有;无则按 prompt_order 数组序补足) */
  order: z.number().optional(),
  /** 未建模字段(绑定、marker、注释等)→ compat */
})
export type StPresetSegment = z.infer<typeof StPresetSegmentSchema>

/**
 * ST 预设根:三段式分散结构——~52 个顶层散键 + `prompts[]` + `prompt_order[]`。
 * 采样参数散落顶层(temperature / max_context / top_p …),键名方言多(下划线/驼峰)。
 */
export const StPresetRootSchema = z.looseObject({
  name: z.string().optional(),
  // 采样参数(键名方言:下划线 ↔ 驼峰)
  temperature: z.number().optional(),
  max_context: z.number().optional(),
  maxContext: z.number().optional(),
  max_tokens: z.number().optional(),
  maxTokens: z.number().optional(),
  top_p: z.number().optional(),
  topP: z.number().optional(),
  top_k: z.number().optional(),
  topK: z.number().optional(),
  stream: z.boolean().optional(),
  // prompt manager
  prompts: z.array(z.record(z.string(), z.unknown())).optional(),
  prompt_order: z.array(z.unknown()).optional(),
})
export type StPresetRoot = z.infer<typeof StPresetRootSchema>

/**
 * ST 已知 marker identifier → 原生 slot 枚举(technical-plan §5.5;§80 原文未建模字段
 * 进 compat,marker 仅作语义标记保留)。命中即标 slot,不命中 = null(纯 prompt 段)。
 */
export const ST_MARKER_TO_SLOT: Record<string, DgPresetSlot> = {
  charDescription: 'charDescription',
  'main/persona': 'charDescription',
  charPersonality: 'charPersonality',
  worldInfoBefore: 'worldInfoBefore',
  worldInfoAfter: 'worldInfoAfter',
  chatHistory: 'chatHistory',
  personaDescription: 'personaDescription',
  persona: 'personaDescription',
  storyString: 'storyString',
  story_string: 'storyString',
  systemPrompt: 'systemPrompt',
  '*': 'systemPrompt',
}
