/**
 * Output Commit(agent-runtime-spec §73/§74/§75,S26/WP3.4)。
 *
 * §74 铁律:**Agent 输出不是自动变成 Chat Message**——必须经 Output Policy 裁决:
 *
 * ```text
 * Agent Output → Output Policy → Commit → Message(或 Artifact / 丢弃)
 * ```
 *
 * Checker Agent 输出落 Artifact、Character Agent 输出落 Assistant Message——
 * 这条分流就是 §74 的两个示例。四模式:
 * - `message`  → 落消息树(role 由 policy.role 决定);
 * - `artifact` → 落 artifacts 表(type='agent-output');
 * - `silent`   → 什么都不落(内部推理类 Agent;§25 不保存隐藏推理);
 * - `custom`   → 注册制;**未注册直接拒(fail-closed)**——与 §115 审批的
 *   "无回答者必拒"同一设计哲学:能力缺失时宁可拒绝,不许静默降级。
 *
 * 调和注(§75):spec `role` 枚举 = 'assistant'|'user'|'tool';本项目消息树里
 * `character` 是 RP 一等角色(contracts chat.ts §3,不与 assistant 合并——缓存语义/
 * author_type/UI 呈现都不同),故枚举**扩展** 'character'(Breaking:N,记 spec 修订)。
 */
import type { MessageRole, Timestamp } from '@whispertavern/contracts'
import type { EventBus, WhisperTavernDb } from '@whispertavern/runtime'
import type { MessageId } from '@whispertavern/contracts'
import { createMessage } from '@whispertavern/runtime'
import { createArtifact, type Artifact } from '../artifacts/store'

/** §73 Agent Output(spec 形状逐字收编) */
export interface AgentOutput {
  text?: string
  artifacts?: string[]
  toolResults?: string[]
  structured?: unknown
}

/** §75 Output Policy(spec 形状 + role 扩展 'character',见模块头调和注) */
export interface OutputPolicy {
  mode: 'message' | 'artifact' | 'silent' | 'custom'
  role?: 'assistant' | 'user' | 'tool' | 'character'
  authorId?: string
}

/** 缺省 = Character Agent 的经典路径:落 character 消息(S23 既有行为的策略化) */
export const DEFAULT_OUTPUT_POLICY: OutputPolicy = { mode: 'message', role: 'character' }

export type OutputCommitter = (
  output: AgentOutput,
  policy: OutputPolicy,
  ctx: { chatId: string; runId: string; now: Timestamp },
) => { messageId?: MessageId; artifactId?: string }

export class OutputCommitError extends Error {
  constructor(message: string) {
    super(`OUTPUT_COMMIT_ERROR: ${message}`)
    this.name = 'OutputCommitError'
  }
}

export interface CommitOutputResult {
  messageId: MessageId | null
  artifact: Artifact | null
}

/**
 * §74 Commit:Output Policy 裁决 → 落地。
 * `mode='message'` 且 text 为空 = 无可提交内容,静默返回(不报错——空输出不是错误)。
 */
export function commitOutput(
  store: WhisperTavernDb,
  bus: EventBus,
  input: {
    chatId: string
    runId: string
    output: AgentOutput
    policy: OutputPolicy
    now: Timestamp
    /** mode='custom' 的注册面;未注册抛 OutputCommitError(fail-closed) */
    customCommitters?: ReadonlyMap<string, OutputCommitter>
  },
): CommitOutputResult {
  const { policy, output } = input
  switch (policy.mode) {
    case 'silent':
      return { messageId: null, artifact: null }
    case 'artifact': {
      if (output.text === undefined && output.structured === undefined) return { messageId: null, artifact: null }
      const artifact = createArtifact(store, bus, {
        chatId: input.chatId,
        runId: input.runId,
        type: 'agent-output',
        name: `run-${input.runId}`,
        ...(output.text !== undefined ? { content: output.text } : {}),
        ...(output.structured !== undefined ? { data: output.structured } : {}),
        now: input.now,
      })
      return { messageId: null, artifact }
    }
    case 'message': {
      if (output.text === undefined || output.text === '') return { messageId: null, artifact: null }
      const role: MessageRole = policy.role ?? 'character'
      const created = createMessage(store, bus, {
        chatId: input.chatId as never,
        role,
        content: output.text,
        authorType: role,
        ...(policy.authorId !== undefined ? { authorId: policy.authorId } : {}),
        now: input.now,
      })
      if (!created.ok) throw new OutputCommitError(`消息落库失败: ${created.error.message}`)
      return { messageId: created.value.message.id, artifact: null }
    }
    case 'custom': {
      const committer = input.customCommitters?.get(policy.authorId ?? 'default')
      if (committer === undefined) {
        // fail-closed:未注册的 custom 面直接拒,不静默降级为 message/silent(§74/§115 同哲学)
        throw new OutputCommitError(`mode=custom 未注册 committer(${policy.authorId ?? 'default'})`)
      }
      const result = committer(output, policy, { chatId: input.chatId, runId: input.runId, now: input.now })
      return { messageId: result.messageId ?? null, artifact: null }
    }
  }
}
