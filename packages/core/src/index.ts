/**
 * packages/core —— 纯 TS、零 IO(总设计 §7):IR 构造器 / 规范序列化与八区哈希 /
 * Snapshot 构建器 / token 计数双模式。
 *
 * 依赖方向(provider-adapter-spec §4):core → contracts(+ @noble/hashes 纯 JS
 * 哈希);禁 node:* 与其余工作区包(import 约束测试 + ESLint 双重锁定)。
 *
 * S3 落地;S4(WP0.4)在此之上接 Compiler 管线(compiler/)。
 */
export {
  createPromptSegment,
  createPromptIR,
  createInstructionMetadata,
  deepFreeze,
  type DeepReadonly,
} from './ir/segment'
export {
  buildPromptSnapshot,
  type BuildPromptSnapshotInput,
} from './serializer/snapshot'
export {
  estimateTokens,
  createTokenCounter,
  type TokenCount,
  type TokenCountMode,
  type TokenCounter,
  type NativeTokenCounter,
} from './tokens/estimate'
export {
  compile,
  type CompileRequest,
  type CompileSuccess,
  type CompileFailure,
  type CompileFailureCode,
  type CompileOutcome,
} from './compiler/pipeline'
export {
  deriveInstruction,
  resolveInstruction,
  outranks,
  type DerivedInstruction,
} from './compiler/derive'
