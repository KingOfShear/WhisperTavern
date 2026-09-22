import {
  CachePlanSchema,
  PromptSnapshotSchema,
  type CachePlan,
  type ChatId,
  type Diagnostic,
  type MessageId,
  type PromptHashes,
  type PromptIR,
  type PromptSnapshot,
  type RunId,
  type SerializedPart,
  type SerializedPrompt,
  type SnapshotId,
  type Timestamp,
} from '@whispertavern/contracts'
import { deepFreeze, type DeepReadonly } from '../ir/segment'
import { buildZoneHashes } from './hash'
import type { TokenCountMode } from '../tokens/estimate'

/**
 * Snapshot 构建器 —— compiler-spec §66/§67/§68 (p0-plan S3 任务 2)。
 *
 * 确定性契约(§5):除输入字段外**零隐藏时钟、零随机**——createdAt 由调用方
 * 注入;同输入(含同 createdAt)任意次构建,产出逐字节一致(含全部哈希)。
 * 不可变契约(§68):返回值深冻结;重编译 = 新 Snapshot,不存在原地修改。
 */

export interface BuildPromptSnapshotInput {
  /** 调用方生成(UUIDv7,database-schema §3);builder 不产生随机 ID */
  id: SnapshotId
  chatId: ChatId
  runId?: RunId
  messageId?: MessageId
  provider: string
  model: string
  /** compiler-spec §6:破坏性 Compiler 行为变化必须升 major */
  compilerVersion: string
  ir: DeepReadonly<PromptIR>
  diagnostics?: readonly Diagnostic[]
  /** §52:记录 token 计数口径;缺省 'estimated'(native 钩子随 WP0.5) */
  tokenCountMode?: TokenCountMode
  /** 注入时钟:参与快照元数据,但**不参与任何哈希** */
  createdAt: Timestamp
  /** S18:真实 CachePlan(pipeline 装配);缺省 = P0 空形状(R-P0-4 兼容) */
  cachePlan?: DeepReadonly<CachePlan>
}

/**
 * 构建 Snapshot:
 * 1. 按 §18 区序把段分桶为规范字节流 → 八区 SHA-256(§67);
 * 2. serialized = 规范序列化(format 'custom';S4 的 Provider Serialization(§63)
 *    落 provider 格式后,由管线替换本字段的生成路径);
 * 3. cachePlan = 传入值或 P0 空形状(R-P0-4 兼容;S18 起由 Cache Planner 装配)。
 */
export function buildPromptSnapshot(input: BuildPromptSnapshotInput): DeepReadonly<PromptSnapshot> {
  const { hashes } = buildZoneHashes(input.ir)
  const serialized = buildCanonicalSerialized(input.ir, hashes, input.tokenCountMode ?? 'estimated')

  // S18:真实 CachePlan 由 pipeline 装配传入;缺省保持 P0 空形状(snapshot.test 兼容)
  const cachePlan = input.cachePlan ?? CachePlanSchema.parse({
    version: 0,
    stablePrefixSegments: [],
    stablePrefixTokens: 0,
    freshSegments: [],
    freshTokens: 0,
    volatileSegments: [],
    volatileTokens: 0,
    checkpoints: [],
    invalidationRisk: 'low',
    breakReasons: [],
  })

  return deepFreeze(
    PromptSnapshotSchema.parse({
      id: input.id,
      chatId: input.chatId,
      runId: input.runId,
      messageId: input.messageId,
      provider: input.provider,
      model: input.model,
      compilerVersion: input.compilerVersion,
      ir: input.ir,
      cachePlan,
      serialized,
      hashes,
      diagnostics: input.diagnostics ? [...input.diagnostics] : [],
      createdAt: input.createdAt,
    }),
  )
}

/** 规范序列化(§65 形状):IR 序展开为 parts;hash 取 final;tokenCount 汇总段计 */
function buildCanonicalSerialized(
  ir: DeepReadonly<PromptIR>,
  hashes: PromptHashes,
  tokenCountMode: TokenCountMode,
): SerializedPrompt {
  const parts: SerializedPart[] = []
  let tokenCount = 0
  for (const segment of ir.segments) {
    if (!segment.enabled) continue // §91 Disabled Segment:不参与 Serialization
    parts.push({ role: segment.role, content: segment.content })
    tokenCount += segment.tokenCount
  }
  return {
    format: 'custom',
    parts,
    hash: hashes.final,
    tokenCount,
    tokenCountMode,
  }
}
