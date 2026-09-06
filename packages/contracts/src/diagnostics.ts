import { z } from 'zod'
import { SegmentSourceSchema } from './ir'

/**
 * Compiler 诊断体系 —— compiler-spec §70–§71 的收编落地。
 *
 * Compiler 不以 throw 表达编译期问题(§70),而是产出 Diagnostic;strict 模式下
 * error 级诊断升格为 compile fail(§75)。诊断码注册表唯一权威 = compiler-spec §71,
 * 新码进表须同步修订该规格并落 §38。
 */

export const DiagnosticLevelSchema = z.enum(['info', 'warning', 'error'])
export type DiagnosticLevel = z.infer<typeof DiagnosticLevelSchema>

/**
 * P0 注册的诊断码(R-P0-1 / R-P0-3 + §71 既有码)。
 * `DiagnosticCode` 是开放联合:code 基型为 string(§70),新码必须先进 §71 注册表,
 * 穷尽性测试只锁 P0 注册集。
 */
export const P0_DIAGNOSTIC_CODES = [
  'MACRO_UNEXPANDED_P0', // R-P0-1:宏引擎不在 P0,{{macro}} 原样透传 + info
  'PROMPT_CONTEXT_TOO_LARGE', // R-P0-2:超模型硬上限,报错终止(不裁剪)
  'AUTHORITY_OVERRIDE_DENIED', // 决策 30:低档段试图覆盖高档
  'UNTRUSTED_IN_STABLE_ZONE', // 决策 30:I3 违例;P0 无 untrusted 源,注册但不可触发
  'OVERRIDE_SLOT_ACTIVE', // instr-sec §12.5/§21:本轮编译含 override 槽(info,审计)
  'EMPTY_SEGMENT', // §71:空段
  'DUPLICATE_SEGMENT_ID', // §71:段 ID 冲突
  'STABILITY_OVERRIDE', // §17:手动覆盖稳定性,系统不能假装它真的稳定
] as const
export type P0DiagnosticCode = (typeof P0_DIAGNOSTIC_CODES)[number]
export type DiagnosticCode = P0DiagnosticCode | (string & {})

export const DiagnosticSchema = z.object({
  level: DiagnosticLevelSchema,
  code: z.string(),
  message: z.string(),
  segmentId: z.string().optional(),
  source: SegmentSourceSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type Diagnostic = z.infer<typeof DiagnosticSchema>
