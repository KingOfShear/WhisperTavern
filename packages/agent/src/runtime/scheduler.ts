/**
 * Runtime Scheduler(agent-runtime-spec §93)+ Agent Tree 递归护栏(S28/WP3.6 还账 #17)。
 *
 * §93 原文只给接口骨架(推荐建立 Scheduler);S28 落地其**唯一真正需要的判定**:
 * spawn 前的树护栏 `assertCanSpawn`。enqueue/cancel/pause/resume 已在别处有各自
 * 载体(runAgent 执行循环 / server registry,不重复造),故本模块只承载护栏判定——
 * delegate §71 / handoff §73 / 任何 spawn 类操作必须先过 `assertCanSpawn` 再建 Run。
 *
 * 口径(spec 骨架见 §39/§93):
 * - 判定依据 = Run Tree 现况 + RunBudget 四护栏字段(`maxDepth / maxChildren /
 *   maxTotalAgents / maxRuntimeMs`),不读 AgentDefinition(Definition 只给默认值,
 *   同 §39 收编注"以 RunBudget 为唯一执行判据")。
 * - depth = **新子代的深度**(= 沿 parent_run_id 链收集到的祖先数含 parent;
 *   根 = 0;A 直接子代 = 1),`depth > maxDepth` 即拒——maxDepth=1 允建 A 的子代、禁其孙代;
 * - children = parent 当前**直接**子 Run 数(§15 Run Tree;不计 origin_run_id 重试链);
 * - totalAgents = 自 root 起的整棵 Run Tree 累计 Run 数(每 Run = 一次 Agent 执行);
 * - runtimeMs = 自 root 的 `created_at` 到 now 的毫秒差(入参 now;测试可注入)。
 * - 任一超限 → 拒绝 spawn,返回 `AGENT_RECURSION_LIMIT`(§100;api-spec §8 → 409)。
 * - 无 parentRunId(根 Run)恒放行;四字段缺省 = 不限制(单聊无子树,§39 注)。
 *
 * 只读 runs 表统计,不写任何行;schema 经 runtime 统一导出(§38 决策 45,守卫 B4 焊死)。
 */
import { eq } from 'drizzle-orm'
import type { RunId, Timestamp } from '@whispertavern/contracts'
import type { WhisperTavernDb } from '@whispertavern/runtime'
import { runs } from '@whispertavern/runtime'

/** §39 RunBudget 的树护栏视角(全部可选;缺省 = 不限制) */
export interface TreeGuardLimits {
  maxDepth?: number
  maxChildren?: number
  maxTotalAgents?: number
  maxRuntimeMs?: number
}

export interface SpawnCheckInput {
  parentRunId?: RunId
  limits: TreeGuardLimits
  /** 判定时刻(缺省 wall-clock;X14 测试注入固定 now 保确定性) */
  now?: Timestamp
}

export interface SpawnCheckResult {
  allowed: boolean
  reason?: string
  /** 护栏逐项现况(观测面 §124 Agent Inspector 展示用) */
  stats: {
    depth: number
    children: number
    totalAgents: number
    rootStartedAt?: Timestamp
  }
}

/** §39/§93:超护栏拒绝 spawn —— api-spec §8 码 AGENT_RECURSION_LIMIT(服务面 409) */
export class TreeGuardViolation extends Error {
  constructor(readonly reason: string) {
    super(`AGENT_RECURSION_LIMIT: ${reason}`)
    this.name = 'TreeGuardViolation'
  }
}

interface RunRow {
  id: string
  parentRunId: string | null
  createdAt: string
}

function loadRunRow(store: WhisperTavernDb, id: string): RunRow | undefined {
  const row = store.db.select().from(runs).where(eq(runs.id, id)).get()
  return row === undefined
    ? undefined
    : { id: row.id, parentRunId: row.parentRunId, createdAt: row.createdAt }
}

/** 沿 parent_run_id 链收集从 parent 到 root 的全部 Run 行(含 parent 自身;链序 = parent→root) */
function collectAncestors(store: WhisperTavernDb, runId: string): RunRow[] {
  const chain: RunRow[] = []
  let current: string | null = runId
  for (let i = 0; i < 10_000 && current !== null; i += 1) {
    const row = loadRunRow(store, current)
    if (row === undefined) break // 树不完整(父 Run 被清理):按当前可见链判定
    chain.push(row)
    current = row.parentRunId
  }
  return chain
}

/** 以 root 为根收集整棵子树 Run 数(direct children 计数同时返回) */
function collectSubtree(store: WhisperTavernDb, rootId: string): { total: number; children: number } {
  // 一次全表取 runs 的 (id, parentRunId) 轻量投影,内存建树(agent 包已依赖 runtime 表)
  const all = store.db.select().from(runs).all()
  const byParent = new Map<string, string[]>()
  for (const row of all) {
    if (row.parentRunId === null) continue
    const list = byParent.get(row.parentRunId) ?? []
    list.push(row.id)
    byParent.set(row.parentRunId, list)
  }
  let total = 0
  const stack = [rootId]
  while (stack.length > 0) {
    const node = stack.pop()!
    total += 1
    for (const child of byParent.get(node) ?? []) stack.push(child)
  }
  return { total, children: (byParent.get(rootId) ?? []).length }
}

/**
 * 判定能否以 parentRunId 为父 spawn 一个子 Run(§93·assertCanSpawn)。
 * 根 Run(parentRunId 缺失)恒放行;四栏字段全缺 = 不限制。
 */
export function assertCanSpawn(store: WhisperTavernDb, input: SpawnCheckInput): SpawnCheckResult {
  if (input.parentRunId === undefined) {
    return { allowed: true, stats: { depth: 0, children: 0, totalAgents: 0 } }
  }
  // 链 = [parent, ..., root],depth = 现有层数,子代位于 depth+1 ⇒ maxDepth=1 时禁二阶
  const chain = collectAncestors(store, input.parentRunId)
  const root = chain[chain.length - 1]
  if (root === undefined) {
    return {
      allowed: false,
      reason: `parent Run 不存在: ${input.parentRunId}`,
      stats: { depth: 0, children: 0, totalAgents: 0 },
    }
  }
  const depth = chain.length // 新子代的深度(根=0;A 的子代 = 1)
  const { total, children } = collectSubtree(store, root.id)
  let rootStartedAt: Timestamp | undefined
  let runtimeMs = 0
  if (input.limits.maxRuntimeMs !== undefined) {
    rootStartedAt = root.createdAt
    const at = input.now ?? new Date().toISOString()
    runtimeMs = Date.parse(at) - Date.parse(root.createdAt)
  }
  const stats = { depth, children, totalAgents: total, rootStartedAt }

  if (input.limits.maxDepth !== undefined && depth > input.limits.maxDepth) {
    return {
      allowed: false,
      reason: `Agent Tree 深度 ${depth} 超出 maxDepth=${input.limits.maxDepth}`,
      stats,
    }
  }
  if (input.limits.maxChildren !== undefined && children >= input.limits.maxChildren) {
    return {
      allowed: false,
      reason: `直接子代理 ${children} 已达 maxChildren=${input.limits.maxChildren}`,
      stats,
    }
  }
  if (input.limits.maxTotalAgents !== undefined && total >= input.limits.maxTotalAgents) {
    return {
      allowed: false,
      reason: `整树 Agent 数 ${total} 已达 maxTotalAgents=${input.limits.maxTotalAgents}`,
      stats,
    }
  }
  if (input.limits.maxRuntimeMs !== undefined && runtimeMs > input.limits.maxRuntimeMs) {
    return {
      allowed: false,
      reason: `整树累计耗时 ${Math.round(runtimeMs)}ms 已超 maxRuntimeMs=${input.limits.maxRuntimeMs}`,
      stats,
    }
  }
  return { allowed: true, stats }
}