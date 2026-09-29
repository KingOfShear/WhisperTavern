/**
 * Context Policy 族(agent-runtime-spec §18–§22,S26/WP3.4)。
 *
 * 分工铁律(§19 明文):
 * - **Agent Runtime 决定"哪些内容允许进入 Context"**——本模块就是这句话的落点,
 *   一个纯过滤层,输入贡献集合,输出(过滤后贡献 + dropped 审计);
 * - **Prompt Compiler 决定"这些内容最终如何序列化"**——本模块不碰 zone / placement /
 *   排序,结构上不可能越权(与 runtime/context.ts 的 §153 同款约束)。
 *
 * 调和注(spec 未定义形状,落最小面,扩展随触发源):
 * - §18 引用的 `SummaryPolicy` 与 `ToolResultPolicy` 在 spec 全文**只有名字没有形状**
 *   ——按"最小可审计"原则落字段;扩充需先修 spec,不得静默加列。
 * - §20 Memory Policy 只落接口形状 + 空实现(R-P3-9:Memory Runtime 归 P4)——
 *   `resolveMemoryItems` 恒返回空,策略字段仅供 Inspector 展示,不参与过滤。
 * - §155 Context Source 封闭五型:**S26 裁决维持不变**——13 种 SegmentSource 中
 *   无法映射进五型的(runtime/character/persona/preset/plugin/workflow/toolResult/
 *   summary)继续在 runtime/context.ts 走 `unmapped` 显式上报,缺口可见可断言;
 *   扩 §155 属跨模块语义变更,归 P4+ 随 Memory/Runtime 面一起修 spec。
 */
import type { PromptContribution } from '@whispertavern/contracts'

/**
 * §20 记忆命中最小投影(纯函数不依赖 runtime 类型;结构与 runtime MemoryHit 子集一致,
 * 调用方传入时天然兼容——C4 不造同义枚举,这里是"够用即止"的结构类型)
 */
export interface MemoryHitLike {
  memoryId: string
  content: string
  importance?: number
  confidence?: number
  /** 命中通道(仅双检索合并时存在;keywords | semantic | both)——memory-runtime-spec §3.3 */
  via?: 'keywords' | 'semantic' | 'both'
}

/** §19 History Policy:历史可见性(spec 形状逐字收编) */
export interface HistoryPolicy {
  enabled: boolean
  maxMessages?: number
  maxTokens?: number
  includeUser: boolean
  includeAssistant: boolean
  includeTools: boolean
  pinnedMessages?: string[]
  branchMode: 'active' | 'root' | 'custom'
}

/** §20 Memory Policy:只落形状(R-P3-9 空实现) */
export interface MemoryContextPolicy {
  enabled: boolean
  maxItems?: number
  maxTokens?: number
  minImportance?: number
  minConfidence?: number
  retrievalStrategy: 'recent' | 'importance' | 'semantic' | 'hybrid'
}

/** §21 Worldbook Policy(spec 形状逐字收编) */
export interface WorldbookPolicy {
  enabled: boolean
  worldbookIds: string[]
  scanDepth?: number
  allowRecursive: boolean
  maxEntries?: number
  maxTokens?: number
}

/** §22 Artifact Policy(spec 形状逐字收编) */
export interface ArtifactPolicy {
  enabled: boolean
  allowedTypes?: string[]
  maxItems?: number
  maxTokens?: number
  promoteFrozenArtifacts: boolean
}

/** §18 引用、spec 未定义形状 → 调和注最小面(见模块头) */
export interface SummaryPolicy {
  enabled: boolean
  maxTokens?: number
  /** 预留:冻结摘要复用策略;P3 无 Summary Runtime,恒 passthrough */
  strategy?: 'frozen' | 'live'
}

/** §18 引用、spec 未定义形状 → 调和注最小面(见模块头) */
export interface ToolResultPolicy {
  enabled: boolean
  maxTokens?: number
  /** 保留最近 N 条工具结果;缺省 = 全保留 */
  lastN?: number
  includeErrors: boolean
}

/** §23 Agent Visibility Policy(spec 形状逐字收编) */
export interface AgentVisibilityPolicy {
  allowedAgents: string[]
  allowOutputs: boolean
  allowArtifacts: boolean
  allowState: boolean
  allowPromptSnapshot: boolean
}

/** §18 Context Policy:七族总装(spec 形状逐字收编) */
export interface ContextPolicy {
  history: HistoryPolicy
  worldbook: WorldbookPolicy
  memory: MemoryContextPolicy
  summary: SummaryPolicy
  artifacts: ArtifactPolicy
  toolResults: ToolResultPolicy
  otherAgents: AgentVisibilityPolicy
}

/** 缺省策略 = 全放行(不改变既有 Run 行为;S23–S25 的贡献集合原样通过) */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  history: {
    enabled: true,
    includeUser: true,
    includeAssistant: true,
    includeTools: true,
    branchMode: 'active',
  },
  worldbook: { enabled: true, worldbookIds: [], allowRecursive: true },
  memory: { enabled: false, retrievalStrategy: 'recent' },
  summary: { enabled: true },
  artifacts: { enabled: true, promoteFrozenArtifacts: true },
  toolResults: { enabled: true, includeErrors: true },
  otherAgents: { allowedAgents: [], allowOutputs: true, allowArtifacts: true, allowState: false, allowPromptSnapshot: false },
}

/** dropped 审计:哪条贡献被哪条策略扔了,为什么(§19 裁决可追) */
export interface PolicyDrop {
  contributionId: string
  policy: 'history' | 'worldbook' | 'artifacts' | 'toolResults' | 'memory' | 'summary'
  reason: string
}

export interface PolicyFilterResult {
  contributions: PromptContribution[]
  dropped: PolicyDrop[]
}

const isMessage = (c: PromptContribution): boolean => c.source.type === 'message'
const isWorldbook = (c: PromptContribution): boolean => c.source.type === 'worldbook'
const isArtifact = (c: PromptContribution): boolean => c.source.type === 'artifact'
const isToolResult = (c: PromptContribution): boolean => c.source.type === 'toolResult'

/** message 贡献 → HistoryPolicy 的角色分类(§19 includeUser/Assistant/Tools) */
function historyRoleOf(c: PromptContribution): 'user' | 'assistant' | 'tools' | 'other' {
  if (c.segment.role === 'user') return 'user'
  if (c.segment.role === 'tool') return 'tools'
  if (c.segment.role === 'assistant') return 'assistant'
  return 'other'
}

/**
 * §18–§22 过滤层:按策略裁决每条贡献的去留。
 *
 * 顺序 = §18 字段序的语义优先级:history(消息)→ worldbook → artifacts → toolResults;
 * summary / memory 在 P3 无触发源,恒 passthrough(`resolveMemoryItems` 空实现 R-P3-9)。
 * 纯函数:不改输入,输出新数组。
 */
export function resolveContextByPolicy(
  policy: ContextPolicy,
  contributions: readonly PromptContribution[],
): PolicyFilterResult {
  const dropped: PolicyDrop[] = []
  let working = [...contributions]

  // —— §19 History Policy(消息贡献)——
  if (!policy.history.enabled) {
    const removed = working.filter(isMessage)
    working = working.filter((c) => !isMessage(c))
    for (const c of removed) dropped.push({ contributionId: c.id, policy: 'history', reason: 'history.enabled=false' })
  } else {
    const pinned = new Set(policy.history.pinnedMessages ?? [])
    const kept: PromptContribution[] = []
    const removed: PromptContribution[] = []
    for (const c of working) {
      if (!isMessage(c)) {
        kept.push(c)
        continue
      }
      const role = historyRoleOf(c)
      const messageId = c.source.type === 'message' ? c.source.messageId : ''
      if (pinned.has(messageId)) {
        kept.push(c) // 钉住的消息无视 include 开关与条数上限(§19 pinnedMessages 语义)
        continue
      }
      const allowed =
        (role === 'user' && policy.history.includeUser) ||
        (role === 'assistant' && policy.history.includeAssistant) ||
        (role === 'tools' && policy.history.includeTools) ||
        role === 'other'
      if (allowed) kept.push(c)
      else removed.push(c)
    }
    // maxMessages:按剩余条数从旧到新丢弃(保最新;钉住的不占不删)
    const messages = kept.filter(isMessage)
    if (policy.history.maxMessages !== undefined && messages.length > policy.history.maxMessages) {
      const over = messages.length - policy.history.maxMessages
      const dropIds = new Set(messages.filter((m) => !pinned.has(m.source.type === 'message' ? m.source.messageId : '')).slice(0, over).map((m) => m.id))
      for (const c of kept) {
        if (dropIds.has(c.id)) removed.push(c)
      }
    }
    if (removed.length > 0) {
      const removedIds = new Set(removed.map((c) => c.id))
      working = kept.filter((c) => !removedIds.has(c.id))
      for (const c of removed) dropped.push({ contributionId: c.id, policy: 'history', reason: `include 开关/maxMessages 裁决(${historyRoleOf(c)})` })
    }
  }

  // —— §21 Worldbook Policy ——
  if (!policy.worldbook.enabled) {
    const removed = working.filter(isWorldbook)
    working = working.filter((c) => !isWorldbook(c))
    for (const c of removed) dropped.push({ contributionId: c.id, policy: 'worldbook', reason: 'worldbook.enabled=false' })
  } else {
    if (policy.worldbook.worldbookIds.length > 0) {
      // 白名单非空 = 只留列出的书;空数组 = 不设限(全部书放行)
      const removed = working.filter((c) => isWorldbook(c) && c.source.type === 'worldbook' && !policy.worldbook.worldbookIds.includes(c.source.worldbookId))
      working = working.filter((c) => !(isWorldbook(c) && c.source.type === 'worldbook' && !policy.worldbook.worldbookIds.includes(c.source.worldbookId)))
      for (const c of removed) dropped.push({ contributionId: c.id, policy: 'worldbook', reason: `worldbookId 不在白名单(${c.source.type === 'worldbook' ? c.source.worldbookId : ''})` })
    }
    const entries = working.filter(isWorldbook)
    if (policy.worldbook.maxEntries !== undefined && entries.length > policy.worldbook.maxEntries) {
      const over = entries.length - policy.worldbook.maxEntries
      const dropIds = new Set(entries.slice(0, over).map((c) => c.id))
      working = working.filter((c) => !dropIds.has(c.id))
      for (const c of entries.slice(0, over)) dropped.push({ contributionId: c.id, policy: 'worldbook', reason: 'maxEntries 裁决' })
    }
  }

  // —— §22 Artifact Policy ——
  if (!policy.artifacts.enabled) {
    const removed = working.filter(isArtifact)
    working = working.filter((c) => !isArtifact(c))
    for (const c of removed) dropped.push({ contributionId: c.id, policy: 'artifacts', reason: 'artifacts.enabled=false' })
  } else {
    const allowed = policy.artifacts.allowedTypes
    const removed: PromptContribution[] = []
    if (allowed !== undefined) {
      // 类型白名单在贡献上不可见(贡献只带 artifactId)→ 由调用方在贡献构造时裁决;
      // 此处仅按 maxItems 裁决,allowedTypes 的执行点在 artifacts/store.ts artifactContributions
      void allowed
    }
    const arts = working.filter(isArtifact)
    if (policy.artifacts.maxItems !== undefined && arts.length > policy.artifacts.maxItems) {
      const over = arts.length - policy.artifacts.maxItems
      const dropIds = new Set(arts.slice(over).map((c) => c.id))
      working = working.filter((c) => !dropIds.has(c.id))
      for (const c of arts.slice(over)) removed.push(c)
    }
    for (const c of removed) dropped.push({ contributionId: c.id, policy: 'artifacts', reason: 'maxItems 裁决' })
  }

  // —— ToolResultPolicy(spec 未定义形状 → 调和注最小面)——
  if (!policy.toolResults.enabled) {
    const removed = working.filter(isToolResult)
    working = working.filter((c) => !isToolResult(c))
    for (const c of removed) dropped.push({ contributionId: c.id, policy: 'toolResults', reason: 'toolResults.enabled=false' })
  } else if (policy.toolResults.lastN !== undefined) {
    const trs = working.filter(isToolResult)
    if (trs.length > policy.toolResults.lastN) {
      const over = trs.length - policy.toolResults.lastN
      const dropIds = new Set(trs.slice(0, over).map((c) => c.id))
      working = working.filter((c) => !dropIds.has(c.id))
      for (const c of trs.slice(0, over)) dropped.push({ contributionId: c.id, policy: 'toolResults', reason: 'lastN 裁决' })
    }
  }

  return { contributions: working, dropped }
}

/**
 * §20 Memory Policy —— R-P3-9 兑现(S30/WP4.2a)。
 *
 * 检索 IO(repository.search,async)由调用方(run-agent)执行,本函数是**纯转换层**:
 * 把已检出的 MemoryHit 按策略过滤(minImportance/minConfidence/maxItems/enabled)
 * 并投影为 PromptContribution——**一律 zone='tail'**(memory-runtime-spec §5:
 * 检索命中注 tail,绝不进稳定前缀;C2/R4)。若注入位置需要改变,先改 spec。
 */
export function resolveMemoryItems(
  policy: MemoryContextPolicy,
  hits: readonly MemoryHitLike[],
): { items: PromptContribution[]; note: string } {
  if (!policy.enabled) {
    return { items: [], note: 'memory.enabled=false:记忆检索关闭' }
  }
  const dropped: string[] = []
  const working = hits.filter((h) => {
    if (policy.minImportance !== undefined && h.importance !== undefined && h.importance < policy.minImportance) {
      dropped.push(`${h.memoryId}#importance`)
      return false
    }
    if (policy.minConfidence !== undefined && h.confidence !== undefined && h.confidence < policy.minConfidence) {
      dropped.push(`${h.memoryId}#confidence`)
      return false
    }
    return true
  })
  const capped = policy.maxItems !== undefined ? working.slice(0, policy.maxItems) : working
  if (policy.maxItems !== undefined && working.length > policy.maxItems) {
    for (const h of working.slice(policy.maxItems)) dropped.push(`${h.memoryId}#maxItems`)
  }
  const items: PromptContribution[] = capped.map((h, i) => ({
    id: `memory:${h.memoryId}`,
    source: { type: 'memory', memoryId: h.memoryId },
    segment: { role: 'system', content: `【记忆】${h.content}`, zone: 'tail' },
    priority: 0,
    semanticPlacement: { type: 'tail', order: i },
  }))
  return { items, note: dropped.length > 0 ? `记忆过滤:${dropped.join(', ')}` : '记忆检索全量注入(tail)' }
}
