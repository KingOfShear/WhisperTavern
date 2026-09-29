/**
 * Scribe Agent(总设计 §25 + memory-runtime-spec §4/wp4.2b,S31)。
 *
 * 职责:**读新剧情 → 发现重要事实 → 更新 Dossier → 追加 Timeline**(按需冻结 Summary)。
 * 三条铁律项条对齐 memory-runtime-spec §4.1:
 * 1. **不直接修改原始聊天记录** —— Scribe 的整个对话(assistant/tool/final 消息)
 *    落在**影子会话**(`scribe:<targetChat>`),目标 chat 的消息树一行不碰;
 *    记忆写入只发生在工具内部,经 Repository 落 `memories/timeline_events/summary_blocks`,
 *    行的 chat_id = 工具入参显式给出的目标会话。
 * 2. 记忆写入是 Scribe 的**唯一**输出通道;最终也经 runAgent 的 commitOutput 落
 *    影子会话的消息/Artifact(§74),保证"经 tool_calls / artifacts 落账"可审计。
 * 3. 受 AgentBudget 约束(§39/§41/§42)——预算由调用方经 `budget` 传入,runAgent
 *    BudgetTracker 全路径生效。
 *
 * Scribe 不是第一类 Agent 类型(agent-runtime-spec §6 枚举不动,决策协议 b 不触碰
 * 公共契约);用 type='custom' + metadata.role='scribe' + 专用 instructions 表达。
 * 模型看到的工具清单 = memoryWriterWireTools() 三个记忆工具(wire 投影),
 * execution 经 deps.registry 按名派发(server 启动时必须注册)。
 */
import { eq } from 'drizzle-orm'
import type {
  AgentId,
  ChatId,
  ProviderAdapter,
  Result,
  RunId,
  Timestamp,
} from '@whispertavern/contracts'
import type { ApplicationError, Message } from '@whispertavern/contracts'
import {
  activeLeafId,
  chats as chatsTable,
  createChat,
  createMemoryRepository,
  createMessage,
  loadActiveChain,
  loadChat,
  uuidv7,
} from '@whispertavern/runtime'
import type { AgentRunDeps } from '../runtime/run-agent'
import { runAgent } from '../runtime/run-agent'
import { createAgentDefinition, loadAgentDefinition } from '../runtime/definition'
import { memoryWriterWireTools } from './tools'
import type { AgentDefinition } from '../runtime/types'

/** §4.2 影子会话标题:Scribe 的全部对话消息都落这里(原始 chat 一行不动)。 */
export function scribeChatTitle(targetChatId: string): string {
  return `scribe:${targetChatId}`
}

export interface RunScribeInput {
  /** 记忆归属的目标会话(工具入参 chatId 的唯一合法值) */
  chatId: ChatId
  /** 新剧情区间起点(缺省 = 最后一个 Summary 块 toMessageId 之后的消息;无摘要则链首) */
  fromMessageId?: string
  /** 新剧情区间终点(缺省 = 活跃叶) */
  toMessageId?: string
  adapter: ProviderAdapter
  providerId: string
  model: string
  /** §39 预算(缺省 maxTurns=1;Scribe 一轮读到新剧情即写,无需长循环) */
  budget?: { maxTurns?: number; maxToolCalls?: number; maxExecutionTimeMs?: number }
  signal?: AbortSignal
  /** §143 长任务:server 预生成 runId;缺省执行层内部生成 */
  runId?: string
  now: Timestamp
}

export interface RunScribeResult {
  runId: string
  /** 影子会话(全部 Scribe 对话落这里;目标 chat 未被触碰) */
  scribeChatId: ChatId
  scribeAgentId: AgentId
  status: 'succeeded' | 'failed' | 'cancelled' | 'skipped'
  /** 本次读入的新剧情消息数(0 = 无新剧情,跳过) */
  plotMessages: number
  /** 本次 run 写入记忆的行数(dossier / timeline / summary 三分) */
  writes: { dossier: number; timeline: number; summary: number }
}

const SCRIBE_AGENT_NAME = '__builtin_scribe'
export const SCRIBE_METADATA_ROLE = 'scribe'

function scribeInstructions(targetChatId: string): string {
  return [
    '你是 Scribe——记忆撰写者(memory-runtime-spec §4)。',
    '你的唯一职责:通读下方"新剧情",提炼重要事实与关键情节,调用记忆工具写入。',
    `目标会话(id 必须原样传入每个工具的 chatId 参数):${targetChatId}`,
    '规则:',
    '1. 只有值得长期记住的重要事实才写 Dossier(人物身份/关系/地点/物品/状态变化);琐碎寒暄不要写。',
    '2. Timeline 记录关键事件(谁、何时、何地、做了什么、什么后果);同一条事件只追加一次。',
    '3. 剧情到达小结点(重大转折/章节结束)时用 memory.append_summary 冻结一段摘要;否则跳过。',
    '4. sourceMessageIds 尽量回填来源消息 id(剧情原文里带)。',
    '5. 绝不修改任何聊天记录;你只通过记忆工具写入记忆表。',
    '完成后用一句话汇报写了什么;不要复述剧情。',
  ].join('\n')
}

/** 影子会话复用:找 `scribe:<target>` 标题已存在的会话;找不到返回 null(createChat 由调用方做) */
function findScribeChat(store: AgentRunDeps['store'], targetChatId: string): string | null {
  const rows = store.db
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(eq(chatsTable.title, scribeChatTitle(targetChatId)))
    .all()
  return rows[0]?.id ?? null
}

/** 只取 [from..to] 区间内的剧情消息(按链序;id 在区间外的不进 Scribe 视野) */
function slicePlot(chain: readonly Message[], fromMessageId?: string, toMessageId?: string): Message[] {
  let start = 0
  if (fromMessageId !== undefined) {
    const idx = chain.findIndex((m) => m.id === fromMessageId)
    start = idx >= 0 ? idx : 0
  }
  let end = chain.length - 1
  if (toMessageId !== undefined) {
    const idx = chain.findIndex((m) => m.id === toMessageId)
    end = idx >= 0 ? idx : chain.length - 1
  }
  if (start > end) return []
  return chain.slice(start, end + 1)
}

function serializePlot(messages: readonly Message[]): string {
  return messages
    .map((m) => `--- 消息 ${m.id} (${m.role}) ---\n${m.content}`)
    .join('\n\n')
}

/**
 * 执行一轮 Scribe。幂等性:同区间重复调用会重复追加 Timeline/Summary(工具本身
 * 只追加);调用方按"上次 Summary 块之后"推进区间即可避免(§4.2 节拍)。
 */
export async function runScribe(
  deps: AgentRunDeps,
  input: RunScribeInput,
): Promise<Result<RunScribeResult, ApplicationError>> {
  const { store, bus, clock } = deps

  const chat = loadChat(store, input.chatId)
  if (!chat.ok) return chat

  // —— 1. 读取目标 chat 活跃链,切出 [from..to] 剧情 ——
  const leaf = activeLeafId(store, input.chatId)
  const chainResult = loadActiveChain(store, leaf)
  if (!chainResult.ok) return chainResult
  const chain = chainResult.value
  if (chain.length === 0) {
    return { ok: true, value: { runId: input.runId ?? uuidv7(), scribeChatId: input.chatId, scribeAgentId: '' as AgentId, status: 'skipped', plotMessages: 0, writes: { dossier: 0, timeline: 0, summary: 0 } } }
  }

  // 缺省区间起点:最后一个 Summary 块的 toMessageId 之后(memory-runtime-spec §4.2)
  const repo = createMemoryRepository(store.sqlite)
  const summaryChain = await repo.listSummaryChain(input.chatId)
  let fromMessageId = input.fromMessageId
  if (fromMessageId === undefined && summaryChain.length > 0) {
    fromMessageId = summaryChain[summaryChain.length - 1]!.toMessageId as string
  }
  const plot = slicePlot(chain, fromMessageId, input.toMessageId)
  if (plot.length === 0) {
    return { ok: true, value: { runId: input.runId ?? uuidv7(), scribeChatId: input.chatId, scribeAgentId: '' as AgentId, status: 'skipped', plotMessages: 0, writes: { dossier: 0, timeline: 0, summary: 0 } } }
  }

  // —— 2. 影子会话(Scribe 对话落这里;目标 chat 一行不动) ——
  let shadowChatId = findScribeChat(store, input.chatId)
  if (shadowChatId === null) {
    const created = createChat(store, bus, { title: scribeChatTitle(input.chatId), now: input.now })
    if (!created.ok) return created
    shadowChatId = created.value.id
  }

  // —— 3. Scribe Definition(缺省角色 type=custom;metadata.role='scribe') ——
  let scribeDef: AgentDefinition | undefined
  // 找既有 scribe:按固定 name 找(agent 表 name 非空,deleted_at 未删;首个为准)
  const found = store.sqlite
    .prepare(`SELECT id FROM agents WHERE name = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`)
    .get(SCRIBE_AGENT_NAME) as { id: string } | undefined
  if (found !== undefined) {
    const loaded = loadAgentDefinition(store, found.id as AgentId)
    if (loaded !== undefined) scribeDef = loaded
  }
  if (scribeDef === undefined) {
    scribeDef = createAgentDefinition(store, {
      id: uuidv7() as AgentId,
      name: SCRIBE_AGENT_NAME,
      description: '内置 Scribe:通读新剧情 → 更新 Dossier → 追加 Timeline → 按需冻结 Summary',
      type: 'custom',
      instructions: scribeInstructions(input.chatId),
      metadata: { role: SCRIBE_METADATA_ROLE },
      runtimePolicy: { maxTurns: 4, maxToolCalls: 12, maxExecutionTimeMs: 5 * 60_000 },
      now: input.now,
    })
  }

  // —— 4. 把剧情作为 user 消息投进影子会话(runAgent 从活跃链编译) ——
  const prompt = `【Scribe 任务】\n${scribeInstructions(input.chatId)}\n\n【新剧情】\n${serializePlot(plot)}`
  const seeded = createMessage(store, bus, {
    chatId: shadowChatId as ChatId,
    role: 'user',
    content: prompt,
    now: input.now,
  })
  if (!seeded.ok) return seeded

  // —— 5. 记写入前后行数(以增量 = 本次 run 写入条数) ——
  const before = await countWrites(repo, input.chatId)

  // —— 6. 确保记忆工具已注册(runAgent 的工具循环按名派发;缺 registry 现建) ——
  let registry = deps.registry
  if (registry === undefined) {
    // 与 server 缺省注册表同构;工具循环只在有工具时把清单交给模型
    const { ToolRegistry } = await import('../tools/registry')
    registry = new ToolRegistry({
      store,
      bus,
      persistApprovalAudit: () => undefined,
      ...(clock === undefined ? {} : { clock }),
    })
  }
  const writerTools = (await import('./tools')).createMemoryWriterToolDefinitions({ store, bus })
  for (const tool of writerTools) registry.register(tool)

  const runId = (input.runId ?? uuidv7()) as RunId
  const result = await runAgent(
    { ...deps, registry },
    {
      chatId: shadowChatId as ChatId,
      agentId: scribeDef.id,
      adapter: input.adapter,
      providerId: input.providerId,
      model: input.model,
      signal: input.signal,
      tools: memoryWriterWireTools(),
      permissions: new Set(['memory.read', 'memory.write']),
      budget: input.budget,
      runId,
      now: input.now,
    },
  )

  const after = await countWrites(repo, input.chatId)
  const writes = {
    dossier: after.dossier - before.dossier,
    timeline: after.timeline - before.timeline,
    summary: after.summary - before.summary,
  }

  if (!result.ok) {
    return {
      ok: true,
      value: { runId, scribeChatId: shadowChatId as ChatId, scribeAgentId: scribeDef.id, status: 'failed', plotMessages: plot.length, writes },
    }
  }
  const outcome = result.value
  const status =
    outcome.status === 'succeeded' ? 'succeeded' : outcome.status === 'cancelled' ? 'cancelled' : outcome.status === 'skipped' ? 'skipped' : 'failed'
  return {
    ok: true,
    value: { runId, scribeChatId: shadowChatId as ChatId, scribeAgentId: scribeDef.id, status, plotMessages: plot.length, writes },
  }
}

async function countWrites(
  repo: ReturnType<typeof createMemoryRepository>,
  chatId: string,
): Promise<{ dossier: number; timeline: number; summary: number }> {
  const [dossier, timeline, summary] = await Promise.all([
    repo.listMemories({ chatId, type: 'fact', limit: 1000 }),
    repo.listTimelineEvents({ chatId, limit: 1000 }),
    repo.listSummaryChain(chatId),
  ])
  return { dossier: dossier.length, timeline: timeline.length, summary: summary.length }
}

export type { ApplicationError }