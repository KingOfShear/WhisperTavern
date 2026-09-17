import { z } from 'zod'
import { PromptRoleSchema, SegmentSourceSchema } from './ir'
import { SemanticPlacementSchema, StabilityClassSchema, PromptZoneNameSchema } from './placement'

/**
 * Compiler 对外输入契约 —— compiler-spec §88(Prompt Contribution API)、§72
 * (CompileMode)、§101(Compile Trace)的收编落地。
 *
 * 铁律:Plugin/Agent 不直接修改 Prompt,只提交 Contribution(§88)。
 */

/** 贡献段载荷:内容 + 角色 + 缓存分区声明。tokenCount 缺省由本地估算器填充(§52) */
export const PromptContributionSegmentSchema = z.object({
  role: PromptRoleSchema,
  content: z.string(),
  /**
   * 缓存分区声明(P0:提交方声明,Compiler 校验与排序;stableWB 的
   * 毕业/退休策略为 P1/P2,分区机制本身已就位)
   */
  zone: PromptZoneNameSchema,
  /** 缺省按区推导(P0 占位推导表;宏感知推断 §16 归 P2) */
  stability: StabilityClassSchema.optional(),
  /** 缺省 estimateTokens(content)(core tokens);native 钩子 WP0.5 */
  tokenCount: z.number().int().nonnegative().optional(),
})
export type PromptContributionSegment = z.infer<typeof PromptContributionSegmentSchema>

/**
 * Prompt Contribution(compiler-spec §88)。id 必须稳定(assetId + logicalPath,
 * §9),禁 randomUUID。
 */
export const PromptContributionSchema = z.object({
  id: z.string().min(1),
  source: SegmentSourceSchema,
  segment: PromptContributionSegmentSchema,
  /** 冲突裁决优先级(§89);不参与排序键(§93 用 placement order) */
  priority: z.number().int(),
  semanticPlacement: SemanticPlacementSchema,
})
export type PromptContribution = z.infer<typeof PromptContributionSchema>

/** 编译模式(compiler-spec §72 全集注册;P0 管线只接受 strict / preview) */
export const CompileModeSchema = z.enum([
  'compatibility',
  'performance',
  'strict',
  'preview',
  'simulation',
  'replay',
])
export type CompileMode = z.infer<typeof CompileModeSchema>

/** 编译轨迹(compiler-spec §101;Inspector 性能数据源,不参与哈希与确定性比较) */
export const CompileTraceSchema = z.object({
  startedAt: z.number(),
  stages: z.array(z.object({ name: z.string(), durationMs: z.number().nonnegative() })),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
})
export type CompileTrace = z.infer<typeof CompileTraceSchema>
