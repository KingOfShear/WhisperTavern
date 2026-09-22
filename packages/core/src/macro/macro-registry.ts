import type { MacroContext, MacroDefinition } from './types'

/**
 * 默认宏注册表 —— compiler-spec §40(默认表)+ §41(MacroDefinition)。
 *
 * 铁律:Macro 表属于 macro-registry.ts,**不在 Compiler 硬编码**(§40)——新增宏
 * 只需注册进本表,引擎与管线零改动。S16 覆盖 §40 默认八宏;时间/日期为 UTC
 * 确定性格式(§40 S16 口径),random/roll 走 context.rng 种子流。
 */

function zeroPad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** §40:{{date}} → UTC YYYY-MM-DD */
export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${zeroPad(d.getUTCMonth() + 1)}-${zeroPad(d.getUTCDate())}`
}

/** §40:{{time}} → UTC HH:MM(24 小时制) */
export function formatTime(d: Date): string {
  return `${zeroPad(d.getUTCHours())}:${zeroPad(d.getUTCMinutes())}`
}

/** {{roll:NdM(±K)}} 骰子求和;无效参数保留原文(不报错,§40 S16 口径) */
function rollDice(context: MacroContext, args?: string): string {
  const raw = args?.trim()
  if (!raw) return `{{roll}}`
  const match = /^(\d*)d(\d+)([+-]\d+)?$/.exec(raw)
  if (!match) return `{{roll:${raw}}}`
  const count = match[1] === '' ? 1 : Number(match[1])
  const sides = Number(match[2])
  const mod = match[3] ? Number(match[3]) : 0
  if (count < 1 || count > 100 || sides < 2) return `{{roll:${raw}}}`
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    sum += 1 + Math.floor(context.rng.next() * sides)
  }
  return String(sum + mod)
}

/** §40 默认宏表(顺序即注册序;lookupMacro 按名查) */
export const DEFAULT_MACRO_REGISTRY: readonly MacroDefinition[] = [
  { name: 'user', volatility: 'session', evaluate: (c) => c.variables.user },
  { name: 'char', volatility: 'session', evaluate: (c) => c.variables.char },
  {
    name: 'persona',
    volatility: 'session',
    evaluate: (c) => String(c.variables.custom.persona ?? ''),
  },
  {
    name: 'lastMessage',
    volatility: 'message',
    evaluate: (c) => c.message?.content ?? '',
    dependencies: ['message'],
  },
  {
    name: 'time',
    volatility: 'volatile',
    evaluate: (c) => c.variables.time ?? formatTime(c.now),
    dependencies: ['now'],
  },
  {
    name: 'date',
    volatility: 'volatile',
    evaluate: (c) => c.variables.date ?? formatDate(c.now),
    dependencies: ['now'],
  },
  {
    name: 'random',
    volatility: 'volatile',
    evaluate: (c) => String(1 + Math.floor(c.rng.next() * 100)),
    dependencies: ['rng'],
  },
  {
    name: 'roll',
    volatility: 'request',
    evaluate: rollDice,
    dependencies: ['rng'],
  },
]

export function lookupMacro(name: string): MacroDefinition | undefined {
  return DEFAULT_MACRO_REGISTRY.find((m) => m.name === name)
}
