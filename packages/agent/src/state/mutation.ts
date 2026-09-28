/**
 * Agent State Mutation(agent-runtime-spec §107/§108/§109,S26/WP3.4)。
 *
 * §107 铁律:**Agent State 更新必须是显式事务** Validate → Commit;**禁止**
 * 模型输出直接覆盖 `agent_runtime_states.state`。本模块是唯一合法写入面:
 * 每笔变更 = StatePatch 列表 + expectedVersion,事务内「验版本 → 逐条校验 →
 * 应用 → 版本 +1 → 落库」一次完成。
 *
 * §108 StatePatch:五操作(set/delete/increment/append/remove),path 用点分
 * (`counters.chapter`);value 形状由操作校验(increment 要数字、append 要字符串
 * 或数组、remove 要数组)。
 *
 * §109 并发冲突:乐观并发——`expectedVersion` 不匹配即返回 `VERSION_CONFLICT`,
 * **不覆盖**;reload/merge/retry 归调用方(spec 明文三步)。版本号嵌在 state JSON
 * 的 `__version` 键(agent_runtime_states 表无 version 列;加列属表结构变更,
 * 等 P4 有真实多 Agent 状态查询需求再议——与 definition.ts 的 config JSON 同款权衡)。
 */
import { and, eq } from 'drizzle-orm'
import type { Timestamp } from '@whispertavern/contracts'
import { agentRuntimeStates, uuidv7, type WhisperTavernDb } from '@whispertavern/runtime'

/** §108 StatePatch(spec 形状逐字收编) */
export interface StatePatch {
  path: string
  operation: 'set' | 'delete' | 'increment' | 'append' | 'remove'
  value?: unknown
}

/** 版本嵌入键;读面把它从业务状态里剥掉 */
const VERSION_KEY = '__version'

export interface AgentStateView {
  state: Record<string, unknown>
  version: number
}

export class StateMutationError extends Error {
  constructor(message: string) {
    super(`STATE_MUTATION_ERROR: ${message}`)
    this.name = 'StateMutationError'
  }
}

/** 读取当前状态(行不存在 = 空状态 version 0,不自动建行——建行随首次写入) */
export function readAgentState(store: WhisperTavernDb, chatId: string, agentId: string): AgentStateView {
  const row = store.db
    .select()
    .from(agentRuntimeStates)
    .where(and(eq(agentRuntimeStates.chatId, chatId), eq(agentRuntimeStates.agentId, agentId)))
    .get()
  if (row === undefined) return { state: {}, version: 0 }
  const parsed = JSON.parse(row.state) as Record<string, unknown>
  const version = typeof parsed[VERSION_KEY] === 'number' ? parsed[VERSION_KEY] : 0
  const { [VERSION_KEY]: _v, ...business } = parsed
  return { state: business, version }
}

export type ApplyStatePatchesResult =
  | { ok: true; version: number; state: Record<string, unknown> }
  | { ok: false; code: 'VERSION_CONFLICT'; currentVersion: number; state: Record<string, unknown> }
  | { ok: false; code: 'VALIDATION_FAILED'; reason: string }

/** 点分 path 取值;中途非对象 = undefined */
function getPath(state: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = state
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/** 点分 path 写值(逐级建普通对象);返回新根(浅拷贝逐级) */
function setPath(state: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.')
  const root = { ...state }
  let cursor = root
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]!
    const next = cursor[key]
    cursor[key] = next !== null && typeof next === 'object' ? { ...(next as Record<string, unknown>) } : {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[keys[keys.length - 1]!] = value
  return root
}

/** 点分 path 删值(copy-on-write 逐级重建,不触碰原嵌套对象);目标不存在 = 幂等返回原样 */
function deletePath(state: Record<string, unknown>, path: string): Record<string, unknown> {
  const keys = path.split('.')
  const removeAt = (node: Record<string, unknown>, idx: number): Record<string, unknown> => {
    const key = keys[idx]!
    if (idx === keys.length - 1) {
      if (!(key in node)) return node
      const copy = { ...node }
      delete copy[key]
      return copy
    }
    const next = node[key]
    if (next === null || typeof next !== 'object') return node
    return { ...node, [key]: removeAt(next as Record<string, unknown>, idx + 1) }
  }
  return removeAt(state, 0)
}

/**
 * §107/§108/§109:显式事务应用 StatePatch 列表。
 * 校验失败 = VALIDATION_FAILED(逐条先验后改,§107 Validate 步);
 * 版本不匹配 = VERSION_CONFLICT(§109,不覆盖,归调用方 reload/merge/retry)。
 */
export function applyStatePatches(
  store: WhisperTavernDb,
  input: {
    chatId: string
    agentId: string
    agentVersion?: number
    expectedVersion: number
    patches: readonly StatePatch[]
    now: Timestamp
  },
): ApplyStatePatchesResult {
  const view = readAgentState(store, input.chatId, input.agentId)
  if (view.version !== input.expectedVersion) {
    // §109:第二写者检测到 VERSION_CONFLICT → reload / merge / retry(调用方),绝不覆盖
    return { ok: false, code: 'VERSION_CONFLICT', currentVersion: view.version, state: view.state }
  }

  // —— §107 Validate → Commit:序贯处理,任一 patch 校验失败 = 整笔拒绝(无部分提交)。
  // 校验基准 = 已应用前序 patch 的工作状态(同批 patch 允许链式依赖,如 append 建数组
  // 后同批 remove)。working 全程 copy-on-write,失败直接丢弃,原状态不受影响。
  let working = view.state
  for (const patch of input.patches) {
    if (patch.path === '' || patch.path === VERSION_KEY) {
      return { ok: false, code: 'VALIDATION_FAILED', reason: `非法 path: ${patch.path}` }
    }
    const current = getPath(working, patch.path)
    switch (patch.operation) {
      case 'set':
        if (patch.value === undefined) return { ok: false, code: 'VALIDATION_FAILED', reason: `set 需要值: ${patch.path}` }
        working = setPath(working, patch.path, patch.value)
        break
      case 'delete':
        working = deletePath(working, patch.path) // 目标不存在也合法(幂等)
        break
      case 'increment':
        if (typeof patch.value !== 'number') return { ok: false, code: 'VALIDATION_FAILED', reason: `increment 需要数字值: ${patch.path}` }
        if (current !== undefined && typeof current !== 'number') return { ok: false, code: 'VALIDATION_FAILED', reason: `increment 目标不是数字: ${patch.path}` }
        working = setPath(working, patch.path, (typeof current === 'number' ? current : 0) + patch.value)
        break
      case 'append':
        if (typeof patch.value !== 'string' && !Array.isArray(patch.value)) {
          return { ok: false, code: 'VALIDATION_FAILED', reason: `append 需要 string 或 array: ${patch.path}` }
        }
        if (current !== undefined && typeof current !== typeof patch.value) {
          return { ok: false, code: 'VALIDATION_FAILED', reason: `append 目标类型不匹配: ${patch.path}` }
        }
        if (Array.isArray(patch.value)) {
          working = setPath(working, patch.path, [...(Array.isArray(current) ? current : []), ...patch.value])
        } else {
          working = setPath(working, patch.path, (typeof current === 'string' ? current : '') + patch.value)
        }
        break
      case 'remove':
        if (!Array.isArray(current)) return { ok: false, code: 'VALIDATION_FAILED', reason: `remove 目标不是数组: ${patch.path}` }
        working = setPath(working, patch.path, current.filter((item) => item !== patch.value))
        break
    }
  }

  const newVersion = view.version + 1
  const row = store.db
    .select()
    .from(agentRuntimeStates)
    .where(and(eq(agentRuntimeStates.chatId, input.chatId), eq(agentRuntimeStates.agentId, input.agentId)))
    .get()
  const storedState = JSON.stringify({ ...working, [VERSION_KEY]: newVersion })
  store.db.transaction(() => {
    if (row === undefined) {
      store.db.insert(agentRuntimeStates).values({
        id: uuidv7(),
        chatId: input.chatId,
        agentId: input.agentId,
        ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
        state: storedState,
        status: 'idle',
        createdAt: input.now,
        updatedAt: input.now,
      }).run()
    } else {
      store.db
        .update(agentRuntimeStates)
        .set({ state: storedState, updatedAt: input.now })
        .where(and(eq(agentRuntimeStates.chatId, input.chatId), eq(agentRuntimeStates.agentId, input.agentId)))
        .run()
    }
  })
  return { ok: true, version: newVersion, state: working }
}
