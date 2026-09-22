import type { MacroOccurrence } from './types'

/**
 * 宏解析器 —— compiler-spec §39(occurrence 形状)+ §41(args 形态,S16 修订)。
 *
 * 纯语法解析,与注册表无关(未知宏是否保留由 engine 裁决);analyze/expand 共用
 * 一次 parse(expandWithAnalysis 合并入口)。start/end 为原始文本偏移(occurrence
 * 自身语义,供未来 Inspector 定位)。
 */

/** 匹配 {{...}}:inner 允许除花括号外任意字符(含 ':',如 {{roll:1d20}}) */
const MACRO_PATTERN = /\{\{([^{}]+)\}\}/g

/** 解析结果:occurrence + 参数位(args 为 ':' 后部分;无参数宏为 undefined) */
export interface ParsedMacro extends MacroOccurrence {
  args?: string
}

export function parseMacros(content: string): ParsedMacro[] {
  const occurrences: ParsedMacro[] = []
  for (const match of content.matchAll(MACRO_PATTERN)) {
    const raw = match[0]
    const inner = match[1] ?? ''
    const start = match.index ?? 0
    const colonIndex = inner.indexOf(':')
    const name = (colonIndex >= 0 ? inner.slice(0, colonIndex) : inner).trim()
    const args = colonIndex >= 0 ? inner.slice(colonIndex + 1).trim() : undefined
    occurrences.push({
      name,
      args,
      raw,
      start,
      end: start + raw.length,
      // volatility/dependencies 由 engine 查注册表后填充
      volatility: 'static',
      dependencies: [],
    })
  }
  return occurrences
}
