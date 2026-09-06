import { z } from 'zod'
import type { SegmentSource } from './ir'

/**
 * 指令安全三元元数据 —— instruction-security-spec §6–§9 的收编落地。
 *
 * 三轴正交(决策 30):authority = 来源权威(只由来源登记投影,内容文本自述
 * 一律无效,I2);trust = 内容可信度;scope = 生效领域。缺省即推导:
 * 提交方不传 instruction,Compiler 从 source 查 instruction-security §10
 * 默认表投影——保证"缺省推导 = 零字节差异"(P0 元数据基线)。
 */

/** 来源权威档(instruction-security §6;全序由高到低,见 AUTHORITY_ORDER) */
export const InstructionAuthoritySchema = z.enum([
  'platform',
  'agent',
  'developer',
  'system',
  'override',
  'character',
  'world',
  'memory',
  'summary',
  'user',
  'tool',
  'untrusted',
])
export type InstructionAuthority = z.infer<typeof InstructionAuthoritySchema>

/**
 * 覆盖全序(instruction-security §6,由高到低)。
 * `developer` 仅作 provider 序列化投影目标存在:编译输入面任何来源都登记不到它(I2 精神)。
 * 覆盖裁决(Override Matrix,§11)按此序执行。
 */
export const AUTHORITY_ORDER = [
  'platform',
  'agent',
  'developer',
  'system',
  'override',
  'character',
  'world',
  'memory',
  'summary',
  'user',
  'tool',
  'untrusted',
] as const satisfies readonly InstructionAuthority[]

/** 内容可信度(instruction-security §7;semi_trusted 为大多数资产的默认档) */
export const InstructionTrustSchema = z.enum(['trusted', 'semi_trusted', 'untrusted'])
export type InstructionTrust = z.infer<typeof InstructionTrustSchema>

/** 生效领域(instruction-security §8;历史消息默认 none——记录性内容不产生指令效力) */
export const InstructionScopeSchema = z.enum([
  'assembly',
  'roleplay',
  'format',
  'request',
  'none',
])
export type InstructionScope = z.infer<typeof InstructionScopeSchema>

/**
 * 编译元数据(instruction-security §9)。
 *
 * `registeredBy` 为溯源信息(Inspector/审计),由 Compiler 内部构造而非外部输入,
 * 故 schema 层只做 passthrough(z.custom);SegmentSource 的完整校验在 ir.ts 的
 * 构造点。type-only 引用 ir.ts 是为了单一来源——运行时无环(ir → instruction 单向)。
 */
export const InstructionMetadataSchema = z.object({
  authority: InstructionAuthoritySchema,
  trust: InstructionTrustSchema,
  scope: InstructionScopeSchema,
  registeredBy: z.custom<SegmentSource>(() => true).optional(),
  /** 可选覆盖细调:仅 override / agent / system 档段可携带,且不得指向更高档(§9) */
  overrides: z.record(z.string(), z.enum(['allow', 'deny'])).optional(),
  origin: z
    .object({
      kind: z.enum(['web', 'file', 'toolResult', 'memoryCandidate', 'import']),
      url: z.string().optional(),
      fileName: z.string().optional(),
      toolCallId: z.string().optional(),
    })
    .optional(),
})
export type InstructionMetadata = z.infer<typeof InstructionMetadataSchema>
