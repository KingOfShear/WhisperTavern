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
 * 注册的诊断码（§71 权威注册表落地 + S16 宏引擎新码）。
 * `DiagnosticCode` 是开放联合:code 基型为 string(§70),新码必须先进 §71 注册表,
 * 穷尽性测试只锁本注册集。MACRO_UNEXPANDED_P0 已于 S16 退役(R-P0-1 宏透传期结束)。
 */
export const DIAGNOSTIC_CODES = [
  'PROMPT_CONTEXT_TOO_LARGE', // R-P0-2:超模型硬上限,报错终止(不裁剪)
  'EMPTY_SEGMENT', // §71:空段
  'DUPLICATE_SEGMENT_ID', // §71:段 ID 冲突
  'STABILITY_OVERRIDE', // §17:手动覆盖稳定性,系统不能假装它真的稳定
  'CACHE_UNSAFE_MACRO', // §43:stable zone 含低于段稳定性的宏
  'UNKNOWN_MACRO', // 未注册宏({{place}} 等):原样保留 + info
  'EVAL_MACRO_REJECTED', // §42:{{eval:...}} 拒绝 + warning
  'WORLD_BOOK_RETIRED', // §31:世界书条目退休(连续未激活超阈值 + 低优先级)
  'WORLD_BOOK_DEACTIVATED', // §30:Compatibility 模式失活条目即时移除
] as const
export type RegisteredDiagnosticCode = (typeof DIAGNOSTIC_CODES)[number]
export type DiagnosticCode = RegisteredDiagnosticCode | (string & {})

export const DiagnosticSchema = z.object({
  level: DiagnosticLevelSchema,
  code: z.string(),
  message: z.string(),
  segmentId: z.string().optional(),
  source: SegmentSourceSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type Diagnostic = z.infer<typeof DiagnosticSchema>
