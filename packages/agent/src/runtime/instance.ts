/**
 * Agent Instance(agent-runtime-spec §7 / database-schema §29)。
 *
 * 同一 Agent Definition 可在多个 Chat 并存,各自持有一份**完全独立**的 Runtime State;
 * 靠 `agent_version` 实现 §163 热重载(改 Definition 不影响在跑的 Run)。
 *
 * 一行 = 一个 (chat, agent) 对(`UNIQUE(chat_id, agent_id)`),`id` 是 Instance 自身标识。
 * 状态推进一律走 `state-machine.ts` 的断言——非法转换在这里就断,不靠调用方自觉(§11)。
 */
import { eq } from 'drizzle-orm'
import type { AgentId, ChatId, RunId, Timestamp } from '@whispertavern/contracts'
import {
  agentRuntimeStates,
  uuidv7,
  type AgentStatus,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import { assertAgentTransition } from './state-machine'
import { EMPTY_AGENT_STATE, type AgentInstance, type AgentState } from './types'

type InstanceRow = typeof agentRuntimeStates.$inferSelect

/** §29 幂等入口:同一 (chat, agent) 只存在一份 Instance;已存在则复用其 `id` 与 state */
export function getOrCreateAgentInstance(
  store: WhisperTavernDb,
  input: { chatId: ChatId; agentId: AgentId; agentVersion: number; now: Timestamp },
): AgentInstance {
  const existing = loadAgentInstance(store, input.chatId, input.agentId)
  if (existing !== undefined) return existing
  const id = uuidv7()
  store.db
    .insert(agentRuntimeStates)
    .values({
      id,
      chatId: input.chatId,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      state: JSON.stringify(EMPTY_AGENT_STATE),
      status: 'idle',
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run()
  return {
    id,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    chatId: input.chatId,
    state: EMPTY_AGENT_STATE,
    status: 'idle',
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export function loadAgentInstance(
  store: WhisperTavernDb,
  chatId: ChatId,
  agentId: AgentId,
): AgentInstance | undefined {
  const row = store.db
    .select()
    .from(agentRuntimeStates)
    .where(eq(agentRuntimeStates.chatId, chatId))
    .all()
    .find((r) => r.agentId === agentId)
  return row === undefined ? undefined : fromRow(row)
}

/**
 * 推进 Instance 状态(§10)。`currentRunId` 随之更新——**清空要显式传 null**,
 * 不传表示"保持不动",避免收尾时不小心把归因丢掉。
 */
export function transitionAgentInstance(
  store: WhisperTavernDb,
  input: {
    chatId: ChatId
    agentId: AgentId
    to: AgentStatus
    now: Timestamp
    /** undefined = 不动;null = 清空(需要时显式表达) */
    currentRunId?: RunId | null
    state?: AgentState
  },
): AgentInstance {
  const current = loadAgentInstance(store, input.chatId, input.agentId)
  if (current === undefined) {
    throw new Error(`Agent Instance 不存在(${input.chatId} / ${input.agentId});先 getOrCreate`)
  }
  assertAgentTransition(current.status, input.to)
  store.db
    .update(agentRuntimeStates)
    .set({
      status: input.to,
      updatedAt: input.now,
      lastHeartbeatAt: input.now,
      ...(input.currentRunId === undefined
        ? {}
        : { currentRunId: input.currentRunId === null ? null : input.currentRunId }),
      ...(input.state === undefined ? {} : { state: JSON.stringify(input.state) }),
    })
    .where(eq(agentRuntimeStates.id, current.id))
    .run()
  return {
    ...current,
    status: input.to,
    updatedAt: input.now,
    ...(input.currentRunId === undefined
      ? {}
      : { currentRunId: input.currentRunId === null ? undefined : input.currentRunId }),
    ...(input.state === undefined ? {} : { state: input.state }),
  }
}

/** §97 同源:心跳。Zombie 判定读 `last_heartbeat_at`,不靠 wall-clock 猜 */
export function heartbeatAgentInstance(
  store: WhisperTavernDb,
  input: { chatId: ChatId; agentId: AgentId; now: Timestamp },
): void {
  const current = loadAgentInstance(store, input.chatId, input.agentId)
  if (current === undefined) return
  store.db
    .update(agentRuntimeStates)
    .set({ lastHeartbeatAt: input.now, updatedAt: input.now })
    .where(eq(agentRuntimeStates.id, current.id))
    .run()
}

/**
 * 聚合复位:把 Instance 拉回 `idle`(幂等)。
 *
 * 依据见 `state-machine.ts` 的调和注②——`completed` / `failed` / `cancelled` 是"刚结束那次
 * Run 的结果"的**瞬态**,不驻留;下一次触发必须能从 `idle` 重新走 `queued → running`。
 * 这也是唯一能让 §7(长期 Instance)+ §29(UNIQUE per chat/agent)+ §11(禁 completed → running)
 * 三条同时成立的解法。
 */
export function resetAgentInstanceToIdle(
  store: WhisperTavernDb,
  input: { chatId: ChatId; agentId: AgentId; now: Timestamp },
): AgentInstance | undefined {
  const current = loadAgentInstance(store, input.chatId, input.agentId)
  if (current === undefined || current.status === 'idle') return current
  return transitionAgentInstance(store, { ...input, to: 'idle', currentRunId: null })
}

function fromRow(row: InstanceRow): AgentInstance {
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    agentVersion: row.agentVersion ?? 0,
    chatId: row.chatId as ChatId,
    state: JSON.parse(row.state) as AgentState,
    status: row.status as AgentStatus,
    currentRunId: row.currentRunId === null ? undefined : (row.currentRunId as RunId),
    createdAt: row.createdAt as Timestamp,
    updatedAt: row.updatedAt as Timestamp,
  }
}
