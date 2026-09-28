/**
 * Agent Definition 落库与版本快照(agent-runtime-spec §5 / §28 / §163)。
 *
 * 存储分工(database-schema §27/§28):
 * - `agents` 行 = Definition 当前版本(读面;改 Definition 递增 `version`);
 * - `agent_versions` 行 = 该版本的不可变快照 + contentHash(§163 热重载的钉住基准)。
 *
 * 列映射说明:表里没有 `model_policy` / `runtime_policy` 两列(spec §27 未列),
 * 故二者与 `metadata` 一并落在 `config` JSON 内;**不为了整齐去 ALTER 表**——
 * 加列属表结构变更(AGENTS §4b),等 S24 真正需要按列查询时再议。
 */
import { eq, isNull } from 'drizzle-orm'
import type { AgentId, Timestamp } from '@whispertavern/contracts'
import {
  agentVersions,
  agents,
  sha256Hex,
  uuidv7,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import type { AgentDefinition, AgentType, RuntimePolicy } from './types'

export class AgentDefinitionError extends Error {
  constructor(message: string) {
    super(`AGENT_DEFINITION_ERROR: ${message}`)
    this.name = 'AgentDefinitionError'
  }
}

export interface CreateAgentDefinitionInput {
  id?: AgentId
  ownerId?: string
  name: string
  description?: string
  type: AgentType
  instructions?: string
  contextPolicy?: Record<string, unknown>
  memoryPolicy?: Record<string, unknown>
  toolPolicy?: Record<string, unknown>
  modelPolicy?: Record<string, unknown>
  runtimePolicy?: RuntimePolicy
  metadata?: Record<string, unknown>
  now: Timestamp
}

/** §38 缺省工具循环上限;spec 示例给 maxTurns=8 / maxToolCalls=20 */
export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  maxTurns: 8,
  maxToolCalls: 20,
  maxExecutionTimeMs: 10 * 60_000,
}

type AgentRow = typeof agents.$inferSelect
type AgentConfigJson = {
  modelPolicy?: Record<string, unknown>
  runtimePolicy?: RuntimePolicy
  metadata?: Record<string, unknown>
}

/** 建 Definition:落 `agents` + 版本 1 快照(`agent_versions`) */
export function createAgentDefinition(
  store: WhisperTavernDb,
  input: CreateAgentDefinitionInput,
): AgentDefinition {
  const id = input.id ?? (uuidv7() as AgentId)
  const runtimePolicy = input.runtimePolicy ?? DEFAULT_RUNTIME_POLICY
  const definition: AgentDefinition = {
    id,
    version: 1,
    name: input.name,
    description: input.description,
    type: input.type,
    instructions: input.instructions ?? '',
    contextPolicy: input.contextPolicy ?? {},
    memoryPolicy: input.memoryPolicy ?? {},
    toolPolicy: input.toolPolicy ?? {},
    modelPolicy: input.modelPolicy ?? {},
    runtimePolicy,
    metadata: input.metadata,
  }
  store.db
    .insert(agents)
    .values({
      id,
      ownerId: input.ownerId ?? 'local',
      name: definition.name,
      description: definition.description,
      agentType: definition.type,
      instructions: definition.instructions,
      config: JSON.stringify(toConfig(definition)),
      toolPolicy: JSON.stringify(definition.toolPolicy),
      memoryPolicy: JSON.stringify(definition.memoryPolicy),
      contextPolicy: JSON.stringify(definition.contextPolicy),
      version: definition.version,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run()
  writeVersionSnapshot(store, definition, input.now)
  return definition
}

/** 读回 Definition(不含历史版本;需要钉旧版本时读 `agent_versions`) */
export function loadAgentDefinition(
  store: WhisperTavernDb,
  agentId: AgentId,
): AgentDefinition | undefined {
  const row = store.db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (row === undefined || row.deletedAt !== null) return undefined
  return fromRow(row)
}

/**
 * S28(WP3.6)api-spec §154 `GET /agents` 读面:未软删 Definition 全量
 * (按 createdAt 升序,limit 上限防无界响应面)。
 */
export function listAgentDefinitions(
  store: WhisperTavernDb,
  options: { limit?: number } = {},
): AgentDefinition[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  return store.db
    .select()
    .from(agents)
    .where(isNull(agents.deletedAt))
    .orderBy(agents.createdAt)
    .limit(limit)
    .all()
    .map(fromRow)
}

/** §163 热重载:Run 必须钉住它启动时的版本,而不是"每次都读最新" */
export function loadAgentVersionSnapshot(
  store: WhisperTavernDb,
  agentId: AgentId,
  version: number,
): AgentDefinition | undefined {
  const row = store.db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .all()
    .find((r) => r.version === version)
  if (row === undefined) return undefined
  return JSON.parse(row.snapshot) as AgentDefinition
}

function toConfig(definition: AgentDefinition): AgentConfigJson {
  return {
    modelPolicy: definition.modelPolicy,
    runtimePolicy: definition.runtimePolicy,
    metadata: definition.metadata,
  }
}

function fromRow(row: AgentRow): AgentDefinition {
  const config = safeParse<AgentConfigJson>(row.config)
  const definition: AgentDefinition = {
    id: row.id as AgentId,
    version: row.version,
    name: row.name,
    description: row.description ?? undefined,
    type: row.agentType as AgentType,
    instructions: row.instructions ?? '',
    contextPolicy: safeParse(row.contextPolicy),
    memoryPolicy: safeParse(row.memoryPolicy),
    toolPolicy: safeParse(row.toolPolicy),
    modelPolicy: config.modelPolicy ?? {},
    runtimePolicy: config.runtimePolicy ?? DEFAULT_RUNTIME_POLICY,
  }
  if (config.metadata !== undefined) definition.metadata = config.metadata
  return definition
}

function writeVersionSnapshot(store: WhisperTavernDb, definition: AgentDefinition, now: Timestamp): void {
  const snapshot = JSON.stringify(definition)
  store.db
    .insert(agentVersions)
    .values({
      id: uuidv7(),
      agentId: definition.id,
      version: definition.version,
      snapshot,
      contentHash: sha256Hex(snapshot),
      createdAt: now,
    })
    .run()
}

function safeParse<T = Record<string, unknown>>(raw: string | null): T {
  if (raw === null || raw === '') return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    // 坏 JSON 不静默吞成"空配置":那是把数据损坏伪装成"没配置"
    throw new AgentDefinitionError(`policy/config 列不是合法 JSON: ${raw.slice(0, 80)}`)
  }
}
