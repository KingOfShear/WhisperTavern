import type {
  DebugExportBundle,
  Diagnostic,
  PromptRole,
  PromptSnapshot,
  RedactionPolicy,
  SegmentProjection,
  SegmentSource,
} from '@whispertavern/contracts'
import { createRedact } from '@whispertavern/adapters'
import { projectSegment } from '@whispertavern/core'
import type { DeepReadonly } from '@whispertavern/core'

/**
 * Sanitized Debug Export(还账 #15,p1-plan §8 S14 任务 2)—— RedactionPolicy 与
 * 可回放 bundle 构建(server 层:需要 DB 行 + 密钥表;core 保持零 IO)。
 *
 * 政策口径(总设计 §19/§32;provider-adapter §17.2 PV5):
 * - 默认 mode = sanitized:stripUserContent / anonymizeIds / redactSecrets 全开;
 *   full 模式**必须**由请求方显式声明(用户内容原样出模块,是审计事件不是默认);
 * - stripUserContent:user/assistant(角色发言)正文替换为占位串——聊天内容不出模块;
 * - anonymizeIds:消息/资产 ID 映射为稳定匿名别名 redact-1, redact-2 …(同 ID 同别名,
 *   保留结构可比性);顺序 = 首次出现序,保证同输入同输出;
 * - redactSecrets:PV5 createRedact 兜底(Bearer/sk- 形态 + 已知密钥表)。
 *
 * 「可回放」= bundle.messages 与 runtime buildGenerationRequest 同一投影规则
 * (tool 跳过,其余 role/content 原样),可直接构造 FakeProviderAdapter 轮次回放。
 */

export const REDACTED_USER_CONTENT = '[user-content removed]'
export const BUNDLE_FORMAT = 'whispertavern-debug-bundle'
export const BUNDLE_VERSION = 1

export interface BuildDebugBundleInput {
  snapshot: DeepReadonly<PromptSnapshot>
  diagnostics?: readonly Diagnostic[]
  policy?: Partial<RedactionPolicy>
  /** 已知密钥表(secret store 内容;fake/测试为空,真实 provider 注入) */
  secrets?: readonly string[]
  exportedAt: string
}

/** 默认政策(还账 #15:默认 sanitized 非 full) */
export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  mode: 'sanitized',
  stripUserContent: true,
  anonymizeIds: true,
  redactSecrets: true,
}

export function resolvePolicy(requested?: Partial<RedactionPolicy>): RedactionPolicy {
  const merged = { ...DEFAULT_REDACTION_POLICY, ...requested }
  if (merged.mode === 'full') {
    // full = 保留原文:内容/ID 不脱敏,但密钥 redact 永不关闭(PV5 不可协商)
    return { mode: 'full', stripUserContent: false, anonymizeIds: false, redactSecrets: true }
  }
  return {
    mode: 'sanitized',
    stripUserContent: merged.stripUserContent,
    anonymizeIds: merged.anonymizeIds,
    redactSecrets: true,
  }
}

/** 匿名化器:首次出现序分配 redact-N;同一 ID 恒得同一别名 */
export class IdAnonymizer {
  private readonly map = new Map<string, string>()
  anonymize(id: string): string {
    const existing = this.map.get(id)
    if (existing !== undefined) return existing
    const alias = `redact-${this.map.size + 1}`
    this.map.set(id, alias)
    return alias
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map)
  }
}

export function buildDebugBundle(input: BuildDebugBundleInput): DebugExportBundle {
  const policy = resolvePolicy(input.policy)
  const redact =
    policy.redactSecrets && input.secrets !== undefined && input.secrets.length > 0
      ? createRedact(input.secrets)
      : createRedact([])

  const ids = new IdAnonymizer()
  const segments: (SegmentProjection & { content?: string })[] = []
  const messages: { role: PromptRole; content: string; segmentId?: string }[] = []

  for (const segment of input.snapshot.ir.segments) {
    // 匿名化登记顺序 = IR 序,保证确定性;source 内含的资产 ID 全部映射
    const source = anonymizeSource(segment.source, ids)
    const content =
      policy.stripUserContent && isUserFacing(segment.role) ? REDACTED_USER_CONTENT : segment.content
    segments.push({
      ...projectSegment(segment),
      source,
      content: redact(content),
    })
    messages.push({
      role: segment.role,
      content: redact(content),
      segmentId: segment.id,
    })
  }

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: input.exportedAt,
    policy,
    snapshot: {
      id: input.snapshot.id,
      chatId: policy.anonymizeIds ? ids.anonymize(input.snapshot.chatId) : input.snapshot.chatId,
      runId: input.snapshot.runId === undefined ? undefined : policy.anonymizeIds ? ids.anonymize(input.snapshot.runId) : input.snapshot.runId,
      provider: input.snapshot.provider,
      model: input.snapshot.model,
      compilerVersion: input.snapshot.compilerVersion,
      hashes: input.snapshot.hashes,
      tokenCount: input.snapshot.serialized.tokenCount,
      createdAt: input.snapshot.createdAt,
    },
    segments,
    messages,
    idMap: policy.anonymizeIds ? ids.snapshot() : {},
    diagnostics: [...(input.diagnostics ?? input.snapshot.diagnostics)],
  }
}

/** user/assistant 是"人话"层,tool 是机械层,system 是配置层——只脱前两类(§19) */
function isUserFacing(role: PromptRole): boolean {
  return role === 'user' || role === 'assistant'
}

function anonymizeSource(source: SegmentSource, ids: IdAnonymizer): SegmentSource {
  switch (source.type) {
    case 'character':
      return { ...source, assetId: ids.anonymize(source.assetId) }
    case 'persona':
      return { ...source, assetId: ids.anonymize(source.assetId) }
    case 'preset':
      return { ...source, presetId: ids.anonymize(source.presetId) }
    case 'worldbook':
      return { ...source, worldbookId: ids.anonymize(source.worldbookId), entryId: ids.anonymize(source.entryId) }
    case 'summary':
      return { ...source, summaryId: ids.anonymize(source.summaryId) }
    case 'message':
      return { ...source, messageId: ids.anonymize(source.messageId) }
    case 'memory':
      return { ...source, memoryId: ids.anonymize(source.memoryId) }
    case 'agent':
      return { ...source, agentId: ids.anonymize(source.agentId) }
    case 'workflow':
      return { ...source, workflowId: ids.anonymize(source.workflowId) }
    case 'artifact':
      return { ...source, artifactId: ids.anonymize(source.artifactId) }
    case 'toolResult':
      return { ...source, toolCallId: ids.anonymize(source.toolCallId) }
    case 'plugin':
      return { ...source, pluginId: ids.anonymize(source.pluginId) }
    case 'runtime':
      return source
  }
}
