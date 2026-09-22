/**
 * 宏引擎模块出口 —— compiler-spec §37–§45(S16)。
 *
 * 依赖方向:core → contracts(纯 TS、零 IO);宏引擎不 import 其余工作区包。
 */
export {
  DEFAULT_MACRO_REGISTRY,
  lookupMacro,
  formatDate,
  formatTime,
} from './macro-registry'
export { seededRng } from './rng'
export { parseMacros, type ParsedMacro } from './parser'
export { analyze, expand, expandWithAnalysis, macroEngine } from './engine'
export type {
  CharacterContext,
  ChatContext,
  ExpandedContent,
  MacroAnalysis,
  MacroContext,
  MacroDefinition,
  MacroEngine,
  MacroMode,
  MacroOccurrence,
  MessageContext,
  Rng,
  RuntimeVariables,
} from './types'
