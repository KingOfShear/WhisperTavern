/**
 * Context Resolution(agent-runtime-spec §152 管线 / §153 不负责 Layout / §154 provenance / §155 来源)。
 *
 * 三件事必须说清,否则这一层会变成"又一个什么都管"的 Context Manager:
 *
 * 1. **只回答"有哪些内容"(§153)**。`ContextItem`(§154)的形状里**没有** zone / placement
 *    字段——所以"解析阶段决定 Layout"在这层是**结构上不可能**,不是靠自觉。
 *    排序 / 分区仍由 `compile()` 决定(compiler-spec §23–§29)。
 *
 * 2. **provenance 必须可追(§154)**。每条 item 带 `source`,取自 §155 的 ContextSource。
 *
 * 3. **§155 只列了五种来源**(message / memory / worldbook / artifact / agent),而实际
 *    贡献集合有 12 种 `SegmentSource`(contracts `ir.ts`)。本层**不发明 union 变体**
 *    (纪律 2:不能因为不够用就自造),而是把无法表达的来源原样列进 `unmapped` 并给出
 *    原因——让缺口可见、可断言,而不是悄悄丢掉。是否扩展 §155 归 **S26 Context Policy**。
 *
 * 副作用边界:**本层是纯函数**,不读 DB、不写库、不发事件。世界书激活等有副作用的步骤
 * 在 runtime 的生成编排里已经做过一次,调用方必须复用其结果(`StartedRun.contributions`),
 * 不得为取 provenance 再解析一次。
 */
import type { PromptContribution } from '@whispertavern/contracts'
import {
  CONTEXT_RESOLUTION_STAGES,
  type AgentContext,
  type ContextItem,
  type ContextResolutionStage,
  type ContextSource,
} from './types'

/** §155 未覆盖的来源:原样上报,不静默丢弃 */
export interface UnmappedContextOrigin {
  contributionId: string
  origin: string
  reason: string
}

export interface AgentContextResolution extends AgentContext {
  unmapped: readonly UnmappedContextOrigin[]
}

export interface ResolveAgentContextInput {
  /** 解析出的贡献集合——唯一输入,来自 runtime 生成编排(已含世界书激活等副作用结果) */
  contributions: readonly PromptContribution[]
}

/** 贡献来源 → §152 管线阶段(仅用于 `stages` 审计面) */
const ORIGIN_TO_STAGE: Record<string, ContextResolutionStage> = {
  agent: 'agent-definition',
  runtime: 'chat-state',
  character: 'character-version',
  persona: 'persona-version',
  preset: 'preset-version',
  worldbook: 'worldbook-activation',
  memory: 'memory-retrieval',
  summary: 'summary',
  message: 'history',
  artifacts: 'artifacts',
  toolResult: 'tool-results',
}

/** §155 的 ContextSource 与 `SegmentSource` 的交集——只有这五种能直接投影 */
function toContextSource(source: PromptContribution['source']): ContextSource | undefined {
  switch (source.type) {
    case 'message':
      return { type: 'message', messageId: source.messageId }
    case 'memory':
      return { type: 'memory', memoryId: source.memoryId }
    case 'worldbook':
      return { type: 'worldbook', entryId: source.entryId }
    case 'artifact':
      return { type: 'artifact', artifactId: source.artifactId }
    case 'agent':
      return { type: 'agent', agentId: source.agentId }
    default:
      return undefined
  }
}

/**
 * §152 管线:把已解析的贡献集合投影为带 provenance 的 Context Item。
 * 纯函数——同样的输入永远得到同样的输出,且**不改动输入**(§153 的 Layout 归别人)。
 */
export function resolveAgentContext(input: ResolveAgentContextInput): AgentContextResolution {
  const items: ContextItem[] = []
  const unmapped: UnmappedContextOrigin[] = []
  const stages = new Set<ContextResolutionStage>()

  for (const contribution of input.contributions) {
    const origin = contribution.source.type
    const stage = ORIGIN_TO_STAGE[origin]
    if (stage !== undefined) stages.add(stage)

    const source = toContextSource(contribution.source)
    if (source === undefined) {
      unmapped.push({
        contributionId: contribution.id,
        origin,
        reason: '§155 ContextSource 未覆盖该来源;是否扩展归 S26 Context Policy',
      })
      continue
    }
    items.push({
      id: contribution.id,
      type: origin,
      content: contribution.segment.content,
      source,
      ...(contribution.priority === 0 ? {} : { priority: contribution.priority }),
    })
  }

  return {
    items,
    // 只报"实际产出了内容"的阶段:把没跑的阶段也列上会变成谎报(§152 是全量清单,不是进度表)
    stages: CONTEXT_RESOLUTION_STAGES.filter((s) => stages.has(s)),
    unmapped,
  }
}
