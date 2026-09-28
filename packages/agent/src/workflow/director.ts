/**
 * Director Agent 与结构化输出(agent-runtime-spec §80 / §81 / §82)。
 *
 * §80:Director 不生成用户可见内容,输出结构化 `{nextAgent, reason}`;Runtime 走
 * validate → permission → dispatch,**不解析自然语言**。
 * §81:结构化输出 = validate → accept / repair / fail。
 * §82:Repair 受 repairAttempts 预算限制(spec 原文),不允许无限重试。
 */
import type { WorkflowArtifact } from './types'

/** §81 Structured Output Policy(schema = JSON Schema 透传;S25 用最小关键字校验) */
export interface StructuredOutputPolicy {
  schema: unknown
  strict: boolean
  repairAttempts: number
}

/** §80 Director 的结构化决策(引擎按 nextAgent 跳转;reason 仅供审计) */
export interface DirectorDecision {
  nextAgent: string
  reason?: string
}

/** §71 最小 Artifact 形状(§70:Agent 间只经 Artifact/Message/Event/Output 通信) */
export type { WorkflowArtifact }

export class StructuredOutputError extends Error {
  constructor(readonly attempt: number, message: string) {
    super(`STRUCTURED_OUTPUT_ERROR: ${message}(attempt ${attempt})`)
    this.name = 'StructuredOutputError'
  }
}

/** 提取模型输出里的 JSON(容忍 ```json 围栏与前后散文;找不到 JSON → null) */
export function extractJson(raw: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const candidates = [fenced?.[1], raw].filter((s): s is string => typeof s === 'string')
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      // 继续试下一个候选
    }
  }
  return null
}

/**
 * §81/§82:validate → accept / repair / fail。
 * `repair` 由调用方注入(通常 = 带修复指令再调一次模型);次数受 policy.repairAttempts 封顶。
 */
export async function resolveStructuredOutput<T>(input: {
  raw: string
  policy: StructuredOutputPolicy
  validate: (value: unknown) => T | null
  repair?: (raw: string, errors: string[]) => Promise<string>
}): Promise<{ ok: true; value: T } | { ok: false; errors: string[] }> {
  let current = input.raw
  let errors = validateRaw(current, input.validate)
  for (let attempt = 0; attempt <= input.policy.repairAttempts; attempt += 1) {
    if (errors.length === 0) {
      const value = input.validate(extractJson(current) ?? {}) as T
      return { ok: true, value }
    }
    if (attempt === input.policy.repairAttempts || input.repair === undefined) break
    current = await input.repair(current, errors)
    errors = validateRaw(current, input.validate)
  }
  return { ok: false, errors }
}

/** §80 Director 决策的 schema 校验(nextAgent 必须是非空字符串;reason 可选) */
export function validateDirectorDecision(value: unknown): DirectorDecision | null {
  if (typeof value !== 'object' || value === null) return null
  const nextAgent = (value as { nextAgent?: unknown }).nextAgent
  const reason = (value as { reason?: unknown }).reason
  if (typeof nextAgent !== 'string' || nextAgent === '') return null
  return {
    nextAgent,
    ...(typeof reason === 'string' ? { reason } : {}),
  }
}

function validateRaw<T>(raw: string, validate: (value: unknown) => T | null): string[] {
  const value = extractJson(raw)
  if (value === null) return ['输出中未找到 JSON 对象']
  const parsed = validate(value)
  if (parsed === null) return ['JSON 未通过 schema 校验(如缺 nextAgent 非空字符串)']
  return []
}
