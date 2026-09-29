/**
 * Memory Policy 真实实现(R-P3-9 兑现,S30/WP4.2a)。
 *
 * 本文件的职责 = §20 Memory Policy 的**检索编排**:
 * 1. 按 `MemoryContextPolicy.retrievalStrategy`(recent/importance/semantic/hybrid)选路;
 * 2. 调 runtime `MemoryRepository` 检索(双检索合并语义在 Repository 层,memory-runtime-spec §3);
 * 3. 命中交给 `resolveMemoryItems`(纯函数)做阈值过滤,并**一律投影 zone='tail'**——
 *    memory-runtime-spec §5:检索命中注 tail,绝不进稳定前缀(C2/R4)。
 *
 * 检索入参(database-schema §25.1/§25.5 口径):
 * - `query`:关键词兜底(FTS5 unicode61 + prefix 3 4);
 * - `embedding`:语义查询向量(Float32Array;`memories.embedding` BLOB 余弦)。
 * 二者皆缺(或与策略不匹配)时按策略退而求其次,如 semantic 无 embedding → 回退 recent
 * (S30 记录注:SQLite 库内无 embedding 编码器,查询向量由外部服务/调用方供给)。
 */
import type { PromptContribution } from '@whispertavern/contracts'
import type { MemoryRepository, MemoryReader } from '@whispertavern/runtime'
import { resolveMemoryItems, type MemoryContextPolicy, type MemoryHitLike } from '../context/policy'

export interface MemoryPolicyInput {
  policy: MemoryContextPolicy
  repository: MemoryRepository & MemoryReader
  chatId: string
  /** FTS5 关键词兜底查询(有的策略不用) */
  query?: string
  /** 语义查询向量(有的策略不用;缺则相关策略回退) */
  embedding?: Float32Array
  /** 本次检索上限;缺省按 policy.maxItems(未设则 8) */
  limit?: number
}

export interface MemoryPolicyResult {
  items: PromptContribution[]
  note: string
  hits: MemoryHitLike[]
}

export async function resolveMemoryPolicy(input: MemoryPolicyInput): Promise<MemoryPolicyResult> {
  if (!input.policy.enabled) {
    return { items: [], note: 'memory.enabled=false:记忆检索关闭', hits: [] }
  }
  const limit = input.limit ?? input.policy.maxItems ?? 8
  const { policy, repository, chatId, query, embedding } = input
  let hits: MemoryHitLike[]
  let retrievalNote = ''
  switch (policy.retrievalStrategy) {
    case 'recent':
      hits = await repository.listMemories({ chatId, limit })
      retrievalNote = 'recent:按最近更新取样'
      break
    case 'importance':
      hits = await repository.listMemories({ chatId, limit: Math.max(limit * 3, 24) })
      hits = hits.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, limit)
      retrievalNote = 'importance:按重要度取样'
      break
    case 'semantic':
      if (embedding !== undefined) {
        const rows = await repository.searchSemantic({ embedding, chatId, limit })
        hits = rows
        retrievalNote = 'semantic:embedding 余弦(± vec0 加速面)'
      } else {
        hits = await repository.listMemories({ chatId, limit })
        retrievalNote = 'semantic:无 embedding 查询向量 → 回退 recent(listMemories)'
      }
      break
    case 'hybrid':
      if (query !== undefined && query !== '' && embedding !== undefined) {
        hits = await repository.search(
          { query, chatId, limit },
          { embedding, chatId, limit },
        )
        retrievalNote = 'hybrid:FTS5 关键词 ∪ embedding 余弦(合并去重)'
      } else if (query !== undefined && query !== '') {
        const rows = await repository.searchKeywords({ query, chatId, limit })
        hits = rows
        retrievalNote = 'hybrid:无 embedding → 关键词单路(FTS5 兜底)'
      } else {
        hits = await repository.listMemories({ chatId, limit })
        retrievalNote = 'hybrid:无查询入参 → 回退 recent(listMemories)'
      }
      break
  }
  const { items, note: policyNote } = resolveMemoryItems(policy, hits)
  return { items, note: `${retrievalNote};${policyNote}`, hits }
}