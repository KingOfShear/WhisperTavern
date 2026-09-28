/**
 * Deterministic Replay(agent-runtime-spec §143–§146,S27/WP3.5)。
 *
 * §143:**外部 Provider 输出本身不确定** → Replay 靠"回放录制响应"实现完全确定性。
 * 三个构件:
 * 1. **ReplayAdapter(§144 Replay Provider 的 adapter 面)**——按序回放源 Run 的
 *    generations 录制(text / reasoning / finishReason / tool_calls),不调真实 Provider;
 * 2. **replayToolResults(§145 Tool Replay)**——工具不真实执行,结果从 tool_calls 表
 *    录制读取(按 工具名 + 同名第 N 次出现 对齐),避免副作用;
 * 3. **§146 Replay Safety**——Replay 模式下工具执行被结构性禁用(见 runAgent 的
 *    replay 分流):network / filesystem.write / 外部副作用无触发路径,无需运行时开关。
 *
 * 冻结面(§56):time(录制即冻结)/ runtime variables / worldbook state / agent /
 * compiler 版本都来自源 Run 的快照与 manifest;Replay 不重新激活世界书——复用录制轮
 * 的贡献等价物 = 直接从源 Run 快照编译。X14 验收 = 同源重放两次 serialized 逐字节一致。
 */
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderChatRequest,
  ProviderStreamEvent,
  RunId,
} from '@whispertavern/contracts'
import type { ToolResult } from '../tools/types'
import {
  toolCalls as toolCallsTable,
  type DispatchToolCall,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import { eq } from 'drizzle-orm'

interface RecordedGeneration {
  id: string
  createdAt: string
  finishReason: string | null
  response: { text?: string; reasoning?: string }
}

function loadRecordedGenerations(store: WhisperTavernDb, sourceRunId: RunId): RecordedGeneration[] {
  // rowid = 落库序(固定时钟下 createdAt 全等,时间排序失效——S27 真坑);
  // generation 行在 dispatch 完成时插入,顺序即轮次顺序
  const rows = store.sqlite
    .prepare(`SELECT rowid AS rid, id, created_at, finish_reason, response FROM generations WHERE run_id = ? ORDER BY rid`)
    .all(sourceRunId) as { rid: number; id: string; created_at: string; finish_reason: string | null; response: string | null }[]
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    finishReason: r.finish_reason,
    response: r.response === null ? {} : (JSON.parse(r.response) as { text?: string; reasoning?: string }),
  }))
}

/** 某轮 tool_use 的调用 = 行序落在该轮 generation 行之后、下一轮之前(rowid 序) */
function groupToolCallsByRound(
  store: WhisperTavernDb,
  sourceRunId: RunId,
): Map<number, { id: string; toolName: string; arguments: string }[]> {
  const rows = store.sqlite
    .prepare(`SELECT rowid AS rid, id, tool_name, arguments FROM tool_calls WHERE run_id = ? ORDER BY rid`)
    .all(sourceRunId) as { rid: number; id: string; tool_name: string; arguments: string }[]
  const genRids = store.sqlite
    .prepare(`SELECT rowid AS rid FROM generations WHERE run_id = ? ORDER BY rid`)
    .all(sourceRunId) as { rid: number }[]
  const groups = new Map<number, { id: string; toolName: string; arguments: string }[]>()
  for (const r of rows) {
    // 工具行在其归属轮 generation 行之后插入 → 前缀计数 - 1 = 轮序
    let round = genRids.filter((g) => g.rid < r.rid).length - 1
    if (round < 0) round = 0
    const list = groups.get(round) ?? []
    list.push({ id: r.id, toolName: r.tool_name, arguments: r.arguments })
    groups.set(round, list)
  }
  return groups
}
export class ReplayAdapter implements ProviderAdapter {
  readonly providerId = 'replay'
  private cursor = 0
  private readonly gens: RecordedGeneration[]
  private readonly toolRounds: Map<number, { id: string; toolName: string; arguments: string }[]>

  constructor(
    store: WhisperTavernDb,
    sourceRunId: RunId,
  ) {
    this.gens = loadRecordedGenerations(store, sourceRunId)
    this.toolRounds = groupToolCallsByRound(store, sourceRunId)
  }

  get recordedRounds(): number {
    return this.gens.length
  }

  capabilities(_model: string): ProviderCapabilities {
    return {
      systemRole: true,
      tools: true,
      vision: false,
      reasoning: true,
      streaming: true,
      promptCaching: false,
      cacheType: 'none',
      maxContextTokens: 131_072,
      maxOutputTokens: 4096,
      structuredOutput: 'none',
      parallelToolCalls: true,
      toolChoice: false,
    }
  }

  async *stream(_req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    const gen = this.gens[this.cursor]
    this.cursor += 1
    if (gen === undefined) throw new Error(`Replay 录制耗尽(§144):源 Run 只有 ${this.gens.length} 轮录制`)
    yield { type: 'message_start' }
    if (gen.response.reasoning !== undefined && gen.response.reasoning !== '') {
      yield { type: 'reasoning_delta', text: gen.response.reasoning }
    }
    if (gen.finishReason === 'tool_use' || gen.finishReason === 'tool_call') {
      for (const [index, call] of (this.toolRounds.get(this.cursor - 1) ?? []).entries()) {
        yield { type: 'tool_call_delta', index, id: call.id, name: call.toolName, argsFragment: call.arguments }
      }
      yield { type: 'finish', reason: 'tool_use' }
      return
    }
    if (gen.response.text !== undefined && gen.response.text !== '') {
      yield { type: 'text_delta', text: gen.response.text }
    }
    const reason = (gen.finishReason ?? 'stop') as 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error'
    yield { type: 'finish', reason }
  }
}

/**
 * §145 Tool Replay:录制结果替代真实执行。
 * 对齐键 = 工具名 + 同名第 N 次出现(录制调用 id 与重放请求 id 无关联——wire 占位 id
 * 在 S24 已定为按序合成,真相源 = tool_calls 表)。
 */
export function replayToolResults(
  store: WhisperTavernDb,
  sourceRunId: RunId,
  calls: readonly DispatchToolCall[],
): ToolResult[] {
  const rows = store.db.select().from(toolCallsTable).where(eq(toolCallsTable.runId, sourceRunId)).all()
  const byName = new Map<string, string[]>()
  for (const r of rows) {
    const list = byName.get(r.toolName) ?? []
    list.push(r.result ?? 'null')
    byName.set(r.toolName, list)
  }
  const seen = new Map<string, number>()
  return calls.map((call) => {
    const occurrence = seen.get(call.name) ?? 0
    seen.set(call.name, occurrence + 1)
    const recorded = byName.get(call.name)?.[occurrence]
    if (recorded === undefined) {
      return { toolCallId: call.id, status: 'error' as const, error: { code: 'REPLAY_RECORDING_MISSING', message: `录制缺失: ${call.name} 第 ${occurrence + 1} 次` } }
    }
    return { toolCallId: call.id, status: 'success' as const, output: JSON.parse(recorded) }
  })
}
