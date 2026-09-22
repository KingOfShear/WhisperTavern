/**
 * Budget 权威常量 —— compiler-spec §49(Budget Priority)+ technical-design §15.1(修正版)。
 *
 * 裁剪优先级 = 纯缓存成本序(越稳定、越核心越晚裁):tail/RAG(历史后,零伤害)→
 * injection(只位移 tail)→ freshWB(位移 history,代价中)→ elastic history(§50 整体推进)
 * → summary → stableWB(代价很大,最后手段)→ header(几乎不动)。
 *
 * §15.1 修正说明:初版把 freshWB 排在 injection 之前是缓存成本倒置——裁 freshWB 要
 * 位移整个 history,裁 injection 免费。
 *
 * elasticHistory 不是 Zone(是 history 区的子划分),用特殊标记表达;该档在预算阶段
 * 处理 history 的 elastic 子集(§50 整体推出,防连续 Cache Break)。
 */

/** §49 权威裁剪序;elasticHistory = history 区 elastic 子集的特殊标记 */
export const BUDGET_TRIM_ORDER = [
  'tail',
  'injection',
  'freshWB',
  'elasticHistory',
  'summary',
  'stableWB',
  'header',
] as const
export type BudgetTrimTarget = (typeof BUDGET_TRIM_ORDER)[number]
