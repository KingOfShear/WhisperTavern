import { z } from 'zod'

/**
 * 跨模块基础形状 —— shared-contracts-spec §2 的收编落地。
 *
 * 本模块是依赖方向的最底层(shared-contracts §1):只被引用,不引用任何
 * 工作区包与 Node API(零 IO,ESLint no-restricted-imports 锁定)。
 *
 * 约定(§2):Timestamp = ISO-8601 UTC 字符串(禁 Date 跨边界);
 * 业务 ID 为 branded opaque 字符串;契约一律 JSON-serializable(禁
 * Date/Map/Set/Function/ClassInstance/BigInt);禁 any,unknown 由调用方 narrowing。
 */

/** zod 品牌机制的类型投影;所有业务 ID 经 `z.string().brand<'XxxId'>()` 产出 */
export type Brand<T, B extends string> = T & z.$brand<B>

/**
 * ISO-8601 UTC 时间戳,以 `Z` 结尾(shared-contracts §2)。
 * 正则而非 z.iso.datetime():冻结校验语义,避免随 zod 大版本 API 漂移。
 */
export const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, '必须是 ISO-8601 UTC 字符串(以 Z 结尾)')
export type Timestamp = z.infer<typeof TimestampSchema>

/** 版本化对象(共享契约 §2 Versioned) */
export interface Versioned {
  version: number
}

/** 可变持久化实体基形(database-schema §4 BaseEntity 同构) */
export interface EntityBase<TId> {
  id: TId
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** 创建后不可改的事实记录基形:Message / Run / Snapshot 等(共享契约 §2) */
export interface ImmutableRecord<TId> {
  id: TId
  createdAt: Timestamp
}

/** 贯穿所有 Runtime Operation 的关联位(C5 四层:Run / Attempt / StepRun) */
export interface Correlated {
  traceId: string
  runId?: string
  attemptId?: string
  stepRunId?: string
}

/**
 * Application Boundary 结果类型:禁 throw 作普通控制流(shared-contracts §2)。
 * `ApplicationError.code` 取各域错误码表,禁裸字符串新增码。
 */
export type Result<T, E = ApplicationError> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export interface ApplicationError {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

/** 归一化刻度:默认 0.0–1.0,禁各模块自造 0–100 / −10–10(共享契约 §2) */
export const NormalizedScoreSchema = z.number().min(0).max(1)
export type NormalizedScore = z.infer<typeof NormalizedScoreSchema>

/** P0 业务 ID(shared-contracts §2 ID 清单的 P0 子集;均 UUIDv7 字符串,database-schema §3) */
export const UserIdSchema = z.string().brand<'UserId'>()
export type UserId = z.infer<typeof UserIdSchema>
export const ChatIdSchema = z.string().brand<'ChatId'>()
export type ChatId = z.infer<typeof ChatIdSchema>
export const MessageIdSchema = z.string().brand<'MessageId'>()
export type MessageId = z.infer<typeof MessageIdSchema>
export const ChatBranchIdSchema = z.string().brand<'ChatBranchId'>()
export type ChatBranchId = z.infer<typeof ChatBranchIdSchema>
export const SnapshotIdSchema = z.string().brand<'SnapshotId'>()
export type SnapshotId = z.infer<typeof SnapshotIdSchema>
export const RunIdSchema = z.string().brand<'RunId'>()
export type RunId = z.infer<typeof RunIdSchema>
export const CharacterIdSchema = z.string().brand<'CharacterId'>()
export type CharacterId = z.infer<typeof CharacterIdSchema>
export const PersonaIdSchema = z.string().brand<'PersonaId'>()
export type PersonaId = z.infer<typeof PersonaIdSchema>
export const PresetIdSchema = z.string().brand<'PresetId'>()
export type PresetId = z.infer<typeof PresetIdSchema>
