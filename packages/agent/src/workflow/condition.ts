/**
 * §66/§67 受限条件 DSL —— Workflow 的唯一条件词法(spec 铁律:禁止执行任意 JavaScript)。
 *
 * 字符串形(§67 edge.condition / §66 branches[].condition):
 *
 * ```text
 * name op literal (and|or name op literal)*
 * op      = == | != | >= | <= | > | <
 * literal = number | true | false | 'quoted string' | "quoted string"
 * ```
 *
 * `and` 与 `or` **不得混用**(无优先级表 → 语义歧义直接拒绝,而不是猜)。
 * 对象形(ConditionExpression)与字符串形同词法、同一求值器。
 */
import type { ConditionExpression } from './types'

export class ConditionSyntaxError extends Error {
  constructor(message: string) {
    super(`CONDITION_SYNTAX_ERROR: ${message}`)
    this.name = 'ConditionSyntaxError'
  }
}

const OPS = ['==', '!=', '>=', '<=', '>', '<'] as const
type Op = (typeof OPS)[number]

interface Clause {
  left: string
  op: Op
  right: string | number | boolean
}

/** 求值对象形表达式;变量缺失 = false(fail-closed,不猜) */
export function evaluateExpression(expr: ConditionExpression, variables: Readonly<Record<string, unknown>>): boolean {
  if ('all' in expr) return expr.all.every((e) => evaluateExpression(e, variables))
  if ('any' in expr) return expr.any.some((e) => evaluateExpression(e, variables))
  if ('not' in expr) return !evaluateExpression(expr.not, variables)
  return compareClause({ left: expr.left, op: expr.op, right: expr.right }, variables)
}

/** 求值字符串形;语法错抛 ConditionSyntaxError(不是运行时 false——写错要显式红) */
export function evaluateCondition(raw: string, variables: Readonly<Record<string, unknown>>): boolean {
  const clauses = parse(raw)
  const joiner = raw.includes(' or ') ? 'any' : 'all'
  const results = clauses.map((c) => compareClause(c, variables))
  return joiner === 'any' ? results.some(Boolean) : results.every(Boolean)
}

function parse(raw: string): Clause[] {
  const trimmed = raw.trim()
  if (trimmed === '') throw new ConditionSyntaxError('空条件')
  if (trimmed.includes(' and ') && trimmed.includes(' or ')) {
    throw new ConditionSyntaxError(`and/or 混用无优先级语义,拒绝解析: ${raw}`)
  }
  const parts = trimmed.split(/ (?:and|or) /)
  return parts.map(parseClause)
}

function parseClause(part: string): Clause {
  // 依长度降序试 op(避免 '>' 吃掉 '>=')
  const op = [...OPS].sort((a, b) => b.length - a.length).find((o) => part.includes(` ${o} `))
  if (op === undefined) throw new ConditionSyntaxError(`缺少比较运算符: ${part}`)
  const [leftRaw, rightRaw] = part.split(` ${op} `)
  if (leftRaw === undefined || rightRaw === undefined) throw new ConditionSyntaxError(`无法解析子句: ${part}`)
  const left = leftRaw.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(left)) {
    throw new ConditionSyntaxError(`左侧必须是变量名: ${left}`)
  }
  return { left, op, right: parseLiteral(rightRaw.trim()) }
}

function parseLiteral(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1)
  }
  // 裸词 = 字符串字面量(仅标识符字符;带括号/运算符的一律拒绝——不是可求值代码)
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return raw
  throw new ConditionSyntaxError(`右侧字面量必须是 number/bool/引号或裸标识符字符串: ${raw}`)
}

function compareClause(clause: Clause, variables: Readonly<Record<string, unknown>>): boolean {
  const actual = variables[clause.left]
  if (actual === undefined) return false
  let right: unknown = clause.right
  // 数字比较:两侧都转 number(字符串型数字容错);其余按严格相等
  if (typeof clause.right === 'number' && typeof actual !== 'boolean') {
    const leftNum = Number(actual)
    if (Number.isNaN(leftNum)) return false
    right = clause.right
    switch (clause.op) {
      case '==': return leftNum === right
      case '!=': return leftNum !== right
      case '>': return leftNum > (right as number)
      case '<': return leftNum < (right as number)
      case '>=': return leftNum >= (right as number)
      case '<=': return leftNum <= (right as number)
    }
  }
  switch (clause.op) {
    case '==': return actual === right
    case '!=': return actual !== right
    default:
      throw new ConditionSyntaxError(`运算符 ${clause.op} 只适用于 number 变量: ${clause.left}`)
  }
}
