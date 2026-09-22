import { z } from 'zod'
import {
  WorldbookPositionSchema,
  WORLDBOOK_SLOT_BY_ST_POSITION as ST_POSITION_TO_SLOT,
  ST_POSITION_BY_SLOT as SLOT_TO_ST_POSITION,
} from '@whispertavern/contracts'

// 映射表单一真相源已上收 contracts(placement.ts, C4);此处仅为 st-compat / 服务端回库保留同名导出。
export { ST_POSITION_TO_SLOT, SLOT_TO_ST_POSITION }

/**
 * 原生 .dgworld 模型 —— technical-plan §5.3(格式真相源)。
 *
 * 设计前提:真实生态形态跨度极大(老 8 字段 uid 键对象 ↔ 现代 42 字段平铺),
 * 原生格式**语义不变、结构重组**——不是语义重设计,是重新序列化。三条硬约束:
 * - **往返无损**:ST 数值 uid 原样保留(映射键);未建模字段进 entry.compat,
 *   导出回写,故"无损"不依赖我们恰好建模了全部字段(42 字段还会继续进化)。
 * - **零魔数**:position 0-7 → slot 枚举;selectiveLogic 0-3 → logic 枚举;
 *   disable → enabled 极性反转;comment → title 语义正名。
 * - **不重造同义类型**:slot 直接复用 contracts WorldbookPositionSchema(C4)。
 */

// ===== 枚举映射表(ST 魔数 → 原生枚举)=====
// 映射表单一真相源已上收 contracts(placement.ts, C4);此处仅为 st-compat / 服务端回库保留同名导出。

/** ST selectiveLogic 0-3 → 原生 logic(database-schema §13 keyword_logic) */
export const ST_SELECTIVE_LOGIC = ['andAny', 'andAll', 'notAny', 'notAll'] as const

/** ST 六个 match* 布尔 → 原生 matchScope 名称(合并为"扫描范围内额外参与匹配的区域") */
export const ST_MATCH_SCOPE_FIELDS = [
  ['matchPersonaDescription', 'personaDescription'],
  ['matchCharacterDescription', 'charDescription'],
  ['matchCharacterPersonality', 'charPersonality'],
  ['matchCharacterDepthPrompt', 'charDepthPrompt'],
  ['matchScenario', 'scenario'],
  ['matchCreatorNotes', 'creatorNotes'],
] as const

// ===== 原生模型 =====

export const DgWorldbookEntrySchema = z.object({
  /** 原生稳定 id(导入生成,文件内唯一;非 ST uid) */
  id: z.string().min(1),
  /** ST 数值 uid 原样保留 = 往返映射键(§5.3);无 uid 的老书 = undefined */
  uid: z.number().int().optional(),
  /** 条目标题(ST comment 的语义正名——它实际就是标题,不是注释) */
  title: z.string().default(''),
  content: z.string().default(''),
  /** ST disable 极性反转(true = 启用) */
  enabled: z.boolean(),
  activation: z.object({
    mode: z.enum(['constant', 'selective', 'vectorized']),
    keys: z.array(z.string()),
    secondaryKeys: z.array(z.string()),
    logic: z.enum(['andAny', 'andAll', 'notAny', 'notAll']),
    /** 概率(0-100);ST 无该字段时为 100 */
    chance: z.number(),
    /** 六个 match* 合并:仅列 true 的项;空 = 默认扫描域(语义解释属 S11 激活层) */
    matchScope: z.array(z.string()),
    /** 向量触发词(vectorized 模式) */
    triggers: z.array(z.string()),
    /** 角色过滤(ST 对象形态原样保留;空对象 = 无过滤) */
    characterFilter: z.record(z.string(), z.unknown()),
    /** 条目级覆盖:null = 跟随书级 scan(§5.3 书随走的默认口径) */
    scanDepth: z.number().int().nullable(),
    caseSensitive: z.boolean().nullable(),
    matchWholeWords: z.boolean().nullable(),
  }),
  /** 定时效应(ST 语义为整数轮数,非布尔) */
  lifecycle: z.object({
    sticky: z.number().int(),
    cooldown: z.number().int(),
    delay: z.number().int(),
  }),
  recursion: z.object({
    /** excludeRecursion:不被递归激活 */
    excluded: z.boolean(),
    /** preventRecursion:不递归激活他人 */
    prevent: z.boolean(),
    /** delayUntilRecursion:仅递归激活 */
    delayedUntil: z.boolean(),
  }),
  placement: z.object({
    slot: WorldbookPositionSchema,
    order: z.number().int(),
    depth: z.number().int(),
    role: z.enum(['system', 'user', 'assistant']),
    outletName: z.string().nullable(),
  }),
  budget: z.object({ ignore: z.boolean() }),
  /** 酒馆"包含组"计分语义(≠ 预设的"选一"开关组) */
  group: z.object({
    id: z.string().nullable(),
    override: z.boolean(),
    weight: z.number(),
    /** useGroupScoring:本条目是否参与组计分(database-schema §13 use_group_scoring) */
    scoring: z.boolean(),
  }),
  /**
   * 缓存分区策略覆盖(P2 Cache Engine 落语义,worldbook-cache-design §7/§90)。
   * retirement = auto 时跟随会话退休策略(默认关闭,见缓存设计 §7)。
   */
  zoning: z.object({
    retirement: z.enum(['auto', 'never']),
    pin: z.boolean(),
  }),
  /** 未建模字段原样暂存(导出回写);键 = ST 原字段名 */
  compat: z.record(z.string(), z.unknown()).default({}),
})
export type DgWorldbookEntry = z.infer<typeof DgWorldbookEntrySchema>

export const DgWorldbookScanSchema = z.object({
  /** null = 跟随会话配置(酒馆把扫描参数放在全局 settings.json,跨用户不可移植) */
  scanDepth: z.number().int().nullable(),
  caseSensitive: z.boolean().nullable(),
  matchWholeWords: z.boolean().nullable(),
  recursive: z.boolean(),
  budget: z.object({ percent: z.number().int(), cap: z.number().int().nullable() }),
})
export type DgWorldbookScan = z.infer<typeof DgWorldbookScanSchema>

export const DgWorldbookSchema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    author: z.string().optional(),
    attribution: z.string().optional(),
    tags: z.array(z.string()).default([]),
  }),
  /** 书级触发配置随书走(§5.3)——跨用户可移植的关键差异 */
  scan: DgWorldbookScanSchema,
  entries: z.array(DgWorldbookEntrySchema),
  /** 书级未建模字段(如 extensions.*)原样暂存 */
  compat: z.record(z.string(), z.unknown()).default({}),
})
export type DgWorldbook = z.infer<typeof DgWorldbookSchema>

// ===== ST 原始形状(zod 宽校验:外部输入,取值前 narrowing)=====

/**
 * ST 世界书条目(两代字段并集:老 8 字段 + 现代 42 字段平铺)。
 * 全部 optional —— 缺省按酒馆默认值补齐(§5.3 要点)。
 * 刻意不声明 `addMemo` / `automationId` 等无原生语义的字段:未进本表即进 compat,
 * 由 compat 保证往返,避免"声明了却没处放"的静默丢失。
 */
export const StWorldbookEntrySchema = z.looseObject({
  uid: z.number().optional(),
  // 主键:老格式/对象容器用 key,卡内嵌书与现代导出用 keys
  key: z.unknown().optional(),
  keys: z.unknown().optional(),
  // 副键:老格式 keysecondary,部分导出写作 secondary_keys
  keysecondary: z.unknown().optional(),
  secondary_keys: z.unknown().optional(),
  comment: z.string().optional(),
  content: z.string().optional(),
  // 蓝灯 / 绿灯 / 向量化
  constant: z.boolean().optional(),
  selective: z.boolean().optional(),
  vectorized: z.boolean().optional(),
  /** 极性差异:酒馆 lorebook 用 disable(反转),V3 character_book 用 enabled(正向) */
  enabled: z.boolean().optional(),
  disable: z.boolean().optional(),
  selectiveLogic: z.number().optional(),
  // 排序:现代 order,老格式 insertion_order(同义,§5.3 要点)
  order: z.number().optional(),
  insertion_order: z.number().optional(),
  // position:真实 ST 生态存在 number(现代导出)与 string(多数卡内嵌书/老书)两种方言,
  // 如 "0".."7" 数字字符串;normalize 做字符串→数字归一再映射 slot(S15 金样抓出)
  position: z.union([z.number(), z.string()]).optional(),
  ignoreBudget: z.boolean().optional(),
  // 递归控制
  excludeRecursion: z.boolean().optional(),
  preventRecursion: z.boolean().optional(),
  delayUntilRecursion: z.boolean().optional(),
  // 匹配与扫描
  scanDepth: z.number().nullable().optional(),
  // 现代导出用 null 表示"未设置"(与缺省同义);normalize 按 null=跟随书级处理
  caseSensitive: z.boolean().nullable().optional(),
  matchWholeWords: z.boolean().nullable().optional(),
  useGroupScoring: z.boolean().nullable().optional(),
  // 定时效应
  sticky: z.number().optional(),
  cooldown: z.number().optional(),
  delay: z.number().optional(),
  // 分组计分
  group: z.string().optional(),
  groupOverride: z.boolean().optional(),
  groupWeight: z.number().optional(),
  // 概率(现代 probability,部分卡内嵌书用 chance)
  probability: z.number().optional(),
  chance: z.number().optional(),
  triggers: z.array(z.unknown()).optional(),
  // 六个 match* 匹配范围
  matchPersonaDescription: z.boolean().optional(),
  matchCharacterDescription: z.boolean().optional(),
  matchCharacterPersonality: z.boolean().optional(),
  matchCharacterDepthPrompt: z.boolean().optional(),
  matchScenario: z.boolean().optional(),
  matchCreatorNotes: z.boolean().optional(),
  characterFilter: z.unknown().optional(),
  outletName: z.string().optional(),
  // ST role 魔数(0/1/2 → system/user/assistant)或直接字符串;normalize 归一
  role: z.union([z.number(), z.string()]).optional(),
  depth: z.number().optional(),
})
export type StWorldbookEntry = z.infer<typeof StWorldbookEntrySchema>

/**
 * ST 两种写入方言(同语义、不同字段名)。导出回写必须挑一个,否则往返会串味:
 * lorebook 用 key/disable/order,V3 内嵌书用 keys/enabled/insertion_order。
 */
export interface StEntryDialect {
  keyField: 'key' | 'keys'
  secondaryField: 'keysecondary' | 'secondary_keys'
  orderField: 'order' | 'insertion_order'
  enabledField: 'disable' | 'enabled'
}

export const LOREBOOK_DIALECT: StEntryDialect = {
  keyField: 'key',
  secondaryField: 'keysecondary',
  orderField: 'order',
  enabledField: 'disable',
}

/** 老 lorebook 导出:order 字段名是 insertion_order,其余同现代 lorebook */
export const LEGACY_LOREBOOK_DIALECT: StEntryDialect = { ...LOREBOOK_DIALECT, orderField: 'insertion_order' }

export const EMBEDDED_DIALECT: StEntryDialect = {
  keyField: 'keys',
  secondaryField: 'secondary_keys',
  orderField: 'insertion_order',
  enabledField: 'enabled',
}

/**
 * ST 世界书根:三种容器形态都要吃进——
 * - `{ entries: [...] }`(现代平铺数组)
 * - `{ entries: { "0": {...} } }`(uid 键对象,ST 传统落盘形态)
 * - `{ "0": {...} }`(裸 uid 键对象,老 lorebook 导出)
 */
export const StWorldbookRootSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  entries: z.union([
    z.array(z.record(z.string(), z.unknown())),
    z.record(z.string(), z.record(z.string(), z.unknown())),
  ]).optional(),
})
export type StWorldbookRoot = z.infer<typeof StWorldbookRootSchema>
