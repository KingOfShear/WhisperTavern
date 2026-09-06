/**
 * packages/contracts —— 核心类型 + Zod Schema **单一真相源**(shared-contracts-spec C2)。
 *
 * 模块清单(S2/WP0.2 落地,长期 §2 目录树在 P3+ 渐次归位):
 *   core         基础形状(Brand / Timestamp / Result / ID)
 *   placement    双 Placement + Stability + Zone(compiler-spec §12–§18)
 *   instruction  指令安全三元元数据(instruction-security §6–§9)
 *   ir           Prompt IR / Segment / Source / Role(compiler-spec §7–§11)
 *   diagnostics  诊断形状与 P0 码表(compiler-spec §70–§71)
 *   snapshot     Snapshot / 八区哈希 / CachePlan / 序列化(§54–§68)
 *   provider     Provider 归一契约(provider-adapter §6/§8.1/§12/§17.1)
 *   chat         chats / messages / chat_branches 运行态(database-schema §17/§19/§21)
 *   compiler     PromptContribution / CompileMode / CompileTrace(compiler-spec §88/§72/§101)
 *
 * 纪律:本包零 IO、零工作区依赖(依赖方向最底层,ESLint no-restricted-imports
 * 锁定);其余包允许 → contracts,模块间只经 contracts 通信,禁止任何包自造
 * 同义核心类型(C4)或反向依赖 database / provider / runtime。
 */
export * from './core'
export * from './placement'
export * from './instruction'
export * from './ir'
export * from './diagnostics'
export * from './snapshot'
export * from './provider'
export * from './chat'
export * from './compiler'
