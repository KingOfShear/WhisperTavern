import { PromptSegmentSchema, type InstructionMetadata, type PromptIR, type PromptSegment } from '@whispertavern/contracts'

/**
 * 不可变性保证 —— p0-plan S3 任务 1(总设计 §7:core 纯 TS 无 IO)。
 *
 * contracts 的 zod 类型只保证"解析后的形状";core 的构造器在**验证之后深冻结**,
 * 使 IR 对象在运行期物理不可变——这是 compiler-spec §5(确定性)与 §68
 * (Snapshot 不可变)的运行期兜底,而非仅靠纪律。
 */

/** 递归只读投影(类型层);运行期由 deepFreeze 兑现。原始类型(含品牌 ID)原样保留 */
type Primitive = string | number | boolean | bigint | symbol | undefined | null
export type DeepReadonly<T> = T extends Primitive
  ? T
  : T extends (infer R)[]
    ? readonly DeepReadonly<R>[]
    : T extends (...args: never[]) => unknown
      ? T
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T

/** 递归冻结:数组、普通对象一律冻结;内建对象与函数跳过 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze)
    Object.freeze(value)
    return value as DeepReadonly<T>
  }
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

/**
 * 段构造器:过 contracts PromptSegmentSchema 验证后深冻结;非法输入在构造点即抛。
 * 入参接受只读变体(可变 → 只读天然可赋值),便于管线串联冻结值。
 */
export function createPromptSegment(
  segment: DeepReadonly<PromptSegment>,
): DeepReadonly<PromptSegment> {
  return deepFreeze(PromptSegmentSchema.parse(segment))
}

/** IR 构造器:段逐一冻结后整体冻结(§5:IR 是后续一切哈希的事实源) */
export function createPromptIR(ir: DeepReadonly<PromptIR>): DeepReadonly<PromptIR> {
  return deepFreeze(ir)
}

/** 指令元数据构造器(instruction 元数据随段冻结,authorityFingerprint 的输入) */
export function createInstructionMetadata(
  metadata: DeepReadonly<InstructionMetadata>,
): DeepReadonly<InstructionMetadata> {
  return deepFreeze(metadata)
}
