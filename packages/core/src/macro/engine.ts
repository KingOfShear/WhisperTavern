import type { Diagnostic, StabilityClass } from '@whispertavern/contracts'
import { lookupMacro } from './macro-registry'
import { parseMacros, type ParsedMacro } from './parser'
import type { MacroAnalysis, MacroContext, MacroEngine, ExpandedContent } from './types'

/**
 * 宏引擎 —— compiler-spec §37(analyze/expand)+ §38(analysis 形状)。
 *
 * 一次 parse 两用:expandWithAnalysis 是管线合并入口(展开文本 + 逐 occurrence
 * 分析同源)。逐 occurrence 处置(§42/§40 + S16 口径):
 *   - 未注册宏 → 原样保留文本,volatility='static'(字面跨轮不变,不威胁缓存),
 *     推 UNKNOWN_MACRO(info);
 *   - {{eval:...}}(name==='eval')→ §42 安全拒绝:替换为空串,推 EVAL_MACRO_REJECTED(warning);
 *   - 注册宏 → evaluate(context, args) 替换原文。
 * 聚合 stability = 最不稳 occurrence 的 volatility(§38);诊断挂 details {macro, raw}。
 */

/** §15 稳定性阶梯:rank 越高越不稳(static < session < request < message < volatile) */
const STABILITY_RANK: Record<StabilityClass, number> = {
  static: 0,
  session: 1,
  request: 2,
  message: 3,
  volatile: 4,
}

function resolveOccurrence(
  macro: ParsedMacro,
  context: MacroContext,
  diagnostics: Diagnostic[],
): { replacement: string; volatility: StabilityClass; dependencies: string[] } {
  // §42:{{eval:...}} 安全拒绝(除非经 Plugin Tool 权限体系——S16 无此通道)
  if (macro.name === 'eval') {
    diagnostics.push({
      level: 'warning',
      code: 'EVAL_MACRO_REJECTED',
      message: '宏引擎不执行任意代码,{{eval:...}} 被拒绝(compiler-spec §42)',
      details: { macro: macro.name, raw: macro.raw },
    })
    return { replacement: '', volatility: 'volatile', dependencies: [] }
  }

  const definition = lookupMacro(macro.name)
  if (!definition) {
    diagnostics.push({
      level: 'info',
      code: 'UNKNOWN_MACRO',
      message: `未注册宏,原样保留: {{${macro.name}}}`,
      details: { macro: macro.name, raw: macro.raw },
    })
    // 未知宏视为 static:字面文本跨轮不变,不威胁前缀缓存(S16 决策)
    return { replacement: macro.raw, volatility: 'static', dependencies: [] }
  }

  const replacement = definition.evaluate(context, macro.args)
  return {
    replacement,
    volatility: definition.volatility,
    dependencies: definition.dependencies ?? [],
  }
}

/** 逐 occurrence 求值;返回按原偏移拼接的展开文本 + 聚合 volatility/dependencies */
function expandAll(
  content: string,
  context: MacroContext,
  diagnostics: Diagnostic[],
): { expanded: string; macros: MacroAnalysis['macros']; stability: StabilityClass; dependencies: string[] } {
  const parsed = parseMacros(content)
  if (parsed.length === 0) {
    return { expanded: content, macros: [], stability: 'static', dependencies: [] }
  }

  const macros: MacroAnalysis['macros'] = parsed.map((m) => ({ ...m }))
  let stability: StabilityClass = 'static'
  const dependencies = new Set<string>()
  let cursor = 0
  let expanded = ''

  for (let i = 0; i < parsed.length; i += 1) {
    const macro = parsed[i] as ParsedMacro
    const { replacement, volatility, dependencies: macroDeps } = resolveOccurrence(macro, context, diagnostics)
    // 回填注册表 volatility/dependencies(parser 只填语法位,§39 语义由 registry 裁决)
    macros[i] = {
      name: macro.name,
      raw: macro.raw,
      start: macro.start,
      end: macro.end,
      volatility,
      dependencies: macroDeps,
    }
    if (STABILITY_RANK[volatility] > STABILITY_RANK[stability]) stability = volatility
    for (const dep of macroDeps) dependencies.add(dep)
    expanded += content.slice(cursor, macro.start) + replacement
    cursor = macro.end
  }
  expanded += content.slice(cursor)

  return { expanded, macros, stability, dependencies: [...dependencies] }
}

export const macroEngine: MacroEngine = {
  analyze(content: string, context: MacroContext): MacroAnalysis {
    const diagnostics: Diagnostic[] = []
    const { macros, stability, dependencies } = expandAll(content, context, diagnostics)
    return { macros, stability, dependencies, diagnostics }
  },

  expand(content: string, context: MacroContext): ExpandedContent {
    const diagnostics: Diagnostic[] = []
    const { expanded } = expandAll(content, context, diagnostics)
    return { content: expanded, diagnostics }
  },
}

export function analyze(content: string, context: MacroContext): MacroAnalysis {
  return macroEngine.analyze(content, context)
}

export function expand(content: string, context: MacroContext): ExpandedContent {
  return macroEngine.expand(content, context)
}

/** 管线专用合并入口:一次 parse 同时产出展开文本与逐 occurrence 分析(§37/§38) */
export function expandWithAnalysis(
  content: string,
  context: MacroContext,
): { content: string; analysis: MacroAnalysis } {
  const diagnostics: Diagnostic[] = []
  const { expanded, macros, stability, dependencies } = expandAll(content, context, diagnostics)
  return { content: expanded, analysis: { macros, stability, dependencies, diagnostics } }
}
