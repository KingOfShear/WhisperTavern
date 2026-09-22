import type { Diagnostic, MessageRole, StabilityClass } from '@whispertavern/contracts'

/**
 * 宏引擎类型 —— compiler-spec §37–§45 的 S16 落地（macro/ 模块）。
 *
 * 归属决策(见 S16 计划 §2):这些类型放 core 而非 contracts——MacroDefinition.evaluate
 * 是函数、MacroContext.now 是 Date、rng 是对象,三者均违反 contracts
 * "契约一律 JSON-serializable(禁 Date/Map/Set/Function)"铁律;唯一消费方是
 * server/runtime 构造 RuntimeVariables 传 core compile(),经 core index 导出即可。
 *
 * MessageContext 取 contracts Message 字段子集(不造同义类型,C4);Character/Chat
 * 为最小占位,S16 仅 {{lastMessage}} 消费 message,随对应宏落地扩展。
 */

/** §44 RuntimeVariables。time/date 可预置(chat_state 按聊天冻结取值,R-P2-4 另一路径) */
export interface RuntimeVariables {
  /** 无 persona 绑定 → 'User'(ST 默认 persona 名,spec §44) */
  user: string
  char: string
  sessionId: string
  chatId: string
  messageId?: string
  time?: string
  date?: string
  /** persona 等自定义位:{{persona}} 取 custom.persona */
  custom: Record<string, unknown>
}

/** §45 MacroContext 的 S16 最小实现。rng 为引擎内部注入位,调用方不构造 */
export interface MacroContext {
  variables: RuntimeVariables
  /** S16 仅 {{lastMessage}} 消费 */
  message?: MessageContext
  /** 最小占位,随宏落地扩展 */
  character?: CharacterContext
  /** 最小占位,随宏落地扩展 */
  chat?: ChatContext
  now: Date
  mode: MacroMode
  /** 引擎注入:按 (now, chatId) 确定性播种的流式 RNG;replay 用 seed 冻结 */
  rng: Rng
  /** replay 冻结位:非 replay 时由引擎按 now+chatId 派生 */
  seed?: string
}

/** §45 message/character/chat 最小占位(contracts Message 字段子集) */
export interface MessageContext {
  id: string
  role: MessageRole
  content: string
}
export interface CharacterContext {
  name: string
  description?: string
}
export interface ChatContext {
  id: string
  title?: string
}

/** 确定性 RNG 流(seededRng 产出;整次 expand 共享一条流) */
export interface Rng {
  next(): number
}

/** §45 模式。S16 的 pipeline 只映射 compile/preview;replay 由引擎层直接覆盖 */
export type MacroMode = 'compile' | 'preview' | 'simulation' | 'replay'

/** §41。evaluate 增可选 args(S16 修订):参数化宏 {{roll:1d20}} 以 ':' 后部分作 args */
export interface MacroDefinition {
  name: string
  volatility: StabilityClass
  evaluate(context: MacroContext, args?: string): string
  dependencies?: string[]
}

/** §39 */
export interface MacroOccurrence {
  name: string
  raw: string
  start: number
  end: number
  volatility: StabilityClass
  dependencies: string[]
}

/** §38 */
export interface MacroAnalysis {
  macros: MacroOccurrence[]
  /** 聚合 = 最不稳 occurrence 的 volatility */
  stability: StabilityClass
  dependencies: string[]
  diagnostics: Diagnostic[]
}

/** §37 ExpandedContent 形状(S16 补定义,spec 修订登记) */
export interface ExpandedContent {
  content: string
  diagnostics: readonly Diagnostic[]
}

/** 宏引擎(§37)。analyze/expand 各自独立;expandWithAnalysis 为管线合并入口 */
export interface MacroEngine {
  analyze(content: string, context: MacroContext): MacroAnalysis
  expand(content: string, context: MacroContext): ExpandedContent
}
