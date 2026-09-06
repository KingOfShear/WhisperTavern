import { z } from 'zod'

/**
 * 双 Placement 与 Stability —— compiler-spec §12–§17 的收编落地。
 *
 * 铁律(总设计 §0.3 / compiler-spec §13):Semantic Placement 与 Cache Placement
 * **必须完全分离**——前者是"按兼容语义应该出现在哪里"(酒馆语义),后者是
 * "落在哪个缓存分区"(物理策略);合并两者 = 为缓存优化改变酒馆语义。
 */

/**
 * 语义槽位(compiler-spec §12)。worldbook position 取值保持 ST 原始拼写
 * (anTop/emTop 等)——它们是酒馆生态的线上协议词,纠正拼写 = 破坏导入兼容。
 */
export const SemanticPlacementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('header'), order: z.number().int() }),
  z.object({
    type: z.literal('worldbook'),
    position: z.enum([
      'before',
      'after',
      'anTop',
      'anBottom',
      'depth',
      'emTop',
      'emBottom',
      'outlet',
    ]),
    depth: z.number().int().optional(),
    outletName: z.string().optional(),
    order: z.number().int(),
  }),
  z.object({ type: z.literal('history'), order: z.number().int() }),
  z.object({ type: z.literal('injection'), depth: z.number().int(), order: z.number().int() }),
  z.object({ type: z.literal('tail'), order: z.number().int() }),
])
export type SemanticPlacement = z.infer<typeof SemanticPlacementSchema>

/** 缓存分区(compiler-spec §13;七区与 §18 Zone Definition 同族) */
export const CachePlacementSchema = z.discriminatedUnion('zone', [
  z.object({ zone: z.literal('header') }),
  z.object({ zone: z.literal('stableWB') }),
  z.object({ zone: z.literal('freshWB') }),
  z.object({ zone: z.literal('summary') }),
  z.object({ zone: z.literal('history') }),
  z.object({ zone: z.literal('injection') }),
  z.object({ zone: z.literal('tail') }),
])
export type CachePlacement = z.infer<typeof CachePlacementSchema>

/**
 * Stability 五级(compiler-spec §15):static > session > request > message > volatile。
 * 稳定内容跨轮逐字节一致才可进稳定前缀(总设计 §0.4);未声明稳定性的挥发内容
 * 一律进 tail(总设计 §0.6)。
 */
export const StabilityClassSchema = z.enum(['static', 'session', 'request', 'message', 'volatile'])
export type StabilityClass = z.infer<typeof StabilityClassSchema>

/** Zone 名(compiler-spec §18;默认顺序 header→stableWB→freshWB→summary→history→injection→tail) */
export const PromptZoneNameSchema = z.enum([
  'header',
  'stableWB',
  'freshWB',
  'summary',
  'history',
  'injection',
  'tail',
])
export type PromptZoneName = z.infer<typeof PromptZoneNameSchema>
