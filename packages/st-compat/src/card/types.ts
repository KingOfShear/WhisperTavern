import { z } from 'zod'

/**
 * 原生 .dgcard 模型 —— technical-plan §5.10(格式真相源)。
 * 设计要点:定义与运行态分离(fav/活跃度/统计进 DB,不进卡文件)、资产结构化
 * (assets[] type/emotion 显式绑定)、内嵌书外置(worldbookRef 双向引用)、
 * 未建模字段进 compat(导出回写)。
 */

export const DgCardSchema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    name: z.string().min(1),
    creator: z.string().optional(),
    characterVersion: z.string().optional(),
    tags: z.array(z.string()).default([]),
    attribution: z.string().optional(),
  }),
  persona: z.object({
    description: z.string().default(''),
    personality: z.string().default(''),
    scenario: z.string().default(''),
    mesExample: z.string().default(''),
  }),
  greetings: z.object({
    first: z.string().default(''),
    alternates: z.array(z.string()).default([]),
    groupOnly: z.array(z.string()).default([]),
  }),
  prompts: z.object({
    system: z.string().default(''),
    postHistory: z.string().default(''),
  }),
  /** 结构化资产清单(type/emotion 显式绑定);uri 相对 .dgcard 所在目录 */
  assets: z
    .array(z.object({ id: z.string(), type: z.enum(['avatar', 'icon', 'emotion', 'background']), uri: z.string(), emotion: z.string().optional() }))
    .default([]),
  /** 内嵌书抽取后的独立 .dgworld 资产 id(双向引用);无内嵌书 = undefined */
  worldbookRef: z.string().optional(),
  /** 未建模字段原样暂存(导出回写);路径化键,值保持 JSON */
  compat: z.record(z.string(), z.unknown()).default({}),
})
export type DgCard = z.infer<typeof DgCardSchema>

/** 抽取出的内嵌世界书(P0/S9 为 passthrough 落盘;S10 做全量归一转换) */
export interface ExtractedWorldbook {
  /** .dgworld 资产 id(= worldbookRef 指向) */
  ref: string
  suggestedName: string
  /** ST character_book 原始 JSON(passthrough;S10 归一为原生 entries) */
  raw: unknown
}

// ===== ST 原始卡形状(zod 宽校验:外部输入,narrowing 后取值)=====

/** V2/V3 data{} 层(两代字段并集;可选为主) */
export const StCardDataSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  personality: z.string().optional(),
  scenario: z.string().optional(),
  first_mes: z.string().optional(),
  mes_example: z.string().optional(),
  creator_notes: z.string().optional(),
  system_prompt: z.string().optional(),
  post_history_instructions: z.string().optional(),
  alternate_greetings: z.array(z.string()).optional(),
  group_only_greetings: z.array(z.string()).optional(),
  character_book: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  creator: z.string().optional(),
  character_version: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
})
export type StCardData = z.infer<typeof StCardDataSchema>

/** 顶层:V2/V3 = spec + data{}(顶层旧字段冗余);V1 = 仅旧字段平铺 */
export const StCardRootSchema = z.looseObject({
  spec: z.string().optional(),
  spec_version: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  personality: z.string().optional(),
  scenario: z.string().optional(),
  first_mes: z.string().optional(),
  mes_example: z.string().optional(),
  /** 运行态混入(酒馆把状态写进卡文件):识别后剥离并进报告 */
  avatar: z.unknown().optional(),
  chat: z.unknown().optional(),
  talkativeness: z.unknown().optional(),
  fav: z.unknown().optional(),
})
export type StCardRoot = z.infer<typeof StCardRootSchema>

/** ST 卡内嵌书 entries 的形状(宽校验;S10 全字段归一) */
export const StEmbeddedBookSchema = z.looseObject({
  name: z.string().optional(),
  entries: z.array(z.record(z.string(), z.unknown())).default([]),
})
export type StEmbeddedBook = z.infer<typeof StEmbeddedBookSchema>
