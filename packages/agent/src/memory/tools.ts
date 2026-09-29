/**
 * Scribe 记忆写入工具(memory-runtime-spec §4 —— Scribe 是唯一记忆写入主体)。
 *
 * 三个工具都经 ToolRegistry 五段流水线执行 → 每次调用落 `tool_calls` 行 +
 * `tool.call.*` durable 事件(S24 面复用)——这就是 p4-plan §6 验收
 * "Scribe 写入经 tool_calls / artifacts 落账"的机制保证。
 *
 * 写入语义逐条对齐 memory-runtime-spec §4.1:
 * - `memory.upsert_dossier`   → Dossier 版本化更新(§4.1 不变量 2);
 * - `memory.append_timeline`  → Timeline 只追加(§4.1 不变量 3);
 * - `memory.append_summary`   → Summary 冻结块追加(§4.1 不变量 5,§24 Checkpoint)。
 *
 * 边界:工具只写记忆表,**永不触碰原始聊天记录**(§4.1 不变量 1 —— Scribe 铁律)。
 * chatId 由调用方(Scribe 指令)显式传入,保证记忆落旨目标 chat。
 */
import type { EventBus, WhisperTavernDb } from '@whispertavern/runtime'
import { createMemoryRepository } from '@whispertavern/runtime'
import type { ProviderTool } from '@whispertavern/contracts'
import type { ToolDefinition, ToolExecutionContext } from '../tools/types'
import { ToolBusinessError } from '../tools/registry'

export type MemoryWriterToolDeps = { store: WhisperTavernDb; bus: EventBus }

/** 工具输入必读的 chatId 字段;缺失 = 调用不完整(INVALID_INPUT) */
function requireChatId(input: unknown, toolName: string): string {
  const chatId = (input as { chatId?: unknown }).chatId
  if (typeof chatId !== 'string' || chatId === '') {
    throw new ToolBusinessError('INVALID_INPUT', `${toolName} 必须携带 chatId(Scribe 写入目标会话;缺失拒绝)`)
  }
  return chatId
}

export const MEMORY_WRITE_PERMISSIONS: readonly 'memory.write'[] = ['memory.write']

/** 工具的声明式规格(name/description/inputSchema 单一真相源;定义与 wire 投影共用) */
interface MemoryToolSpec {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOL_SPECS: readonly MemoryToolSpec[] = [
  {
    id: 'tool_memory_upsert_dossier',
    name: 'memory.upsert_dossier',
    description: '更新 Dossier 档案(人物/地点/组织/物品/关系/状态的结构化事实卡)。同实体重复调用 = 版本化更新(旧值快照入 memory_versions,version+1)。',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: '记忆所属会话' },
        entity: { type: 'string', description: '实体名(必填;Dossier 实体维度)' },
        content: { type: 'string', description: '单条事实的自然语言陈述' },
        importance: { type: 'number', description: '重要度 0-1' },
        confidence: { type: 'number', description: '置信度 0-1' },
        sourceMessageIds: { type: 'array', items: { type: 'string' }, description: '来源消息 id(可回溯)' },
      },
      required: ['chatId', 'entity', 'content'],
    },
  },
  {
    id: 'tool_memory_append_timeline',
    name: 'memory.append_timeline',
    description: '追加 Timeline 事件(只追加;事件 = 谁、何时、何地、做了什么、什么后果)。',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: '记忆所属会话' },
        eventType: { type: 'string', description: '事件类型(如 discovery / battle / promise)' },
        summary: { type: 'string', description: '事件摘要(经 Scribe 压缩)' },
        participants: { type: 'array', items: { type: 'string' }, description: '参与实体名单' },
        location: { type: 'string' },
        consequences: { type: 'string' },
        sourceMessageId: { type: 'string' },
        importance: { type: 'number', description: '重要度 0-1' },
        emotionalWeight: { type: 'number', description: '情绪权重 0-1' },
      },
      required: ['chatId', 'eventType', 'summary'],
    },
  },
  {
    id: 'tool_memory_append_summary',
    name: 'memory.append_summary',
    description: '追加 Summary 冻结块(剧情压缩;冻结后不可回写 = 显式 Checkpoint/SUMMARY_CHECKPOINT CacheBreak)。',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: '记忆所属会话' },
        content: { type: 'string', description: '冻结块正文(剧情压缩)' },
        fromMessageId: { type: 'string', description: '覆盖消息区间的起点' },
        toMessageId: { type: 'string', description: '覆盖消息区间的终点' },
        tokenCount: { type: 'number', description: '约化 token 数(可选)' },
      },
      required: ['chatId', 'content', 'fromMessageId', 'toMessageId'],
    },
  },
]

export { TOOL_SPECS as MEMORY_TOOL_SPECS }

function specToDefinition(spec: MemoryToolSpec, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    permissions: MEMORY_WRITE_PERMISSIONS,
    execute,
  }
}

/** 建三个 Scribe 记忆写入工具定义(注册用;execute 闭包携依赖,无模块级状态) */
export function createMemoryWriterToolDefinitions(deps: MemoryWriterToolDeps): ToolDefinition[] {
  const { store, bus } = deps

  const upsertDossier: ToolDefinition['execute'] = async (input, ctx) => {
    const chatId = requireChatId(input, 'memory.upsert_dossier')
    const entity = (input as { entity?: unknown }).entity
    const content = (input as { content?: unknown }).content
    if (typeof entity !== 'string' || entity === '' || typeof content !== 'string' || content === '') {
      throw new ToolBusinessError('INVALID_INPUT', 'memory.upsert_dossier 需要非空 entity 与 content')
    }
    const repo = createMemoryRepository(store.sqlite)
    // 版本化语义(§4.1 不变量 2):同实体既有事实 → 传 memoryId 走 version+1 更新
    const existing = await repo.listMemories({ chatId, type: 'fact', entity, limit: 1 })
    const memoryId = await repo.upsertMemory({
      ...(existing[0] !== undefined ? { memoryId: existing[0].memoryId } : {}),
      ownerId: 'scribe',
      chatId,
      type: 'fact',
      entity,
      content,
      importance: num((input as { importance?: unknown }).importance),
      confidence: num((input as { confidence?: unknown }).confidence),
      sourceMessageIds: strArray((input as { sourceMessageIds?: unknown }).sourceMessageIds),
    })
    bus.publish({
      type: existing[0] !== undefined ? 'memory.updated' : 'memory.created',
      aggregateType: 'memory',
      aggregateId: memoryId,
      runId: ctx?.runId,
      timestamp: new Date().toISOString(),
      payload: { memoryId, chatId, entity, writer: 'scribe', version: existing[0] !== undefined },
    })
    return { toolCallId: '', status: 'success', output: { memoryId, entity, updated: existing[0] !== undefined } }
  }

  const appendTimeline: ToolDefinition['execute'] = async (input, ctx) => {
    const chatId = requireChatId(input, 'memory.append_timeline')
    const eventType = (input as { eventType?: unknown }).eventType
    const summary = (input as { summary?: unknown }).summary
    if (typeof eventType !== 'string' || eventType === '' || typeof summary !== 'string' || summary === '') {
      throw new ToolBusinessError('INVALID_INPUT', 'memory.append_timeline 需要非空 eventType 与 summary')
    }
    const repo = createMemoryRepository(store.sqlite)
    const eventId = await repo.appendTimelineEvent({
      chatId,
      eventType,
      summary,
      participants: strArray((input as { participants?: unknown }).participants),
      location: optString((input as { location?: unknown }).location),
      consequences: optString((input as { consequences?: unknown }).consequences),
      sourceMessageId: optString((input as { sourceMessageId?: unknown }).sourceMessageId),
      importance: num((input as { importance?: unknown }).importance),
      emotionalWeight: num((input as { emotionalWeight?: unknown }).emotionalWeight),
    })
    bus.publish({
      type: 'memory.created',
      aggregateType: 'timeline-event',
      aggregateId: eventId,
      runId: ctx?.runId,
      timestamp: new Date().toISOString(),
      payload: { eventId, chatId, eventType, writer: 'scribe' },
    })
    return { toolCallId: '', status: 'success', output: { eventId, eventType } }
  }

  const appendSummary: ToolDefinition['execute'] = async (input, ctx) => {
    const chatId = requireChatId(input, 'memory.append_summary')
    const content = (input as { content?: unknown }).content
    const fromMessageId = (input as { fromMessageId?: unknown }).fromMessageId
    const toMessageId = (input as { toMessageId?: unknown }).toMessageId
    if (typeof content !== 'string' || content === '' || typeof fromMessageId !== 'string' || typeof toMessageId !== 'string') {
      throw new ToolBusinessError('INVALID_INPUT', 'memory.append_summary 需要非空 content/fromMessageId/toMessageId')
    }
    const repo = createMemoryRepository(store.sqlite)
    const block = await repo.appendSummaryBlock({
      chatId,
      content,
      fromMessageId,
      toMessageId,
      tokenCount: num((input as { tokenCount?: unknown }).tokenCount),
    })
    bus.publish({
      type: 'memory.created',
      aggregateType: 'summary-block',
      aggregateId: block.id,
      runId: ctx?.runId,
      timestamp: new Date().toISOString(),
      payload: { blockId: block.id, sequence: block.sequence, chatId, writer: 'scribe' },
    })
    return { toolCallId: '', status: 'success', output: { blockId: block.id, sequence: block.sequence, frozen: block.frozen } }
  }

  return [
    specToDefinition(TOOL_SPECS[0]!, upsertDossier),
    specToDefinition(TOOL_SPECS[1]!, appendTimeline),
    specToDefinition(TOOL_SPECS[2]!, appendSummary),
  ]
}

/** §31 wire 投影(模型看到的工具清单;execution 仍走注册表按名派发) */
export function memoryWriterWireTools(): ProviderTool[] {
  return TOOL_SPECS.map((s) => ({
    name: s.name,
    description: s.description,
    inputSchema: s.inputSchema,
  }))
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

export type { ToolExecutionContext }