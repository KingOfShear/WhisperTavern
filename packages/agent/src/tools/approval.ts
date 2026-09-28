/**
 * 审批(agent-runtime-spec §115 / §115.1 / §116 / §117)。
 *
 * 核心语义 = **fail-closed 四值**:调用方只在 allowed_once 时放行;
 * 没有回答者 / 跨 chat / 抛异常 / 返回枚举外 → 一律 `unavailable`;
 * per-chat 策略 `never` 在**派发之前**生效(后注册的回答者无法绕过);
 * 审计落库失败 → 直接拒绝(不允许返回一个没记进日志的决定)。
 * `approval.requested` / `approval.decided` 由 approvalId 关联、成对落库(durable),
 * **log-only:不进模型转录**。
 */
import type { EventBus } from '@whispertavern/runtime'
import type { Timestamp } from '@whispertavern/contracts'
import { uuidv7 } from '@whispertavern/runtime'
import { APPROVAL_OUTCOMES, type ApprovalOutcome, type ApprovalPolicy, type ApprovalRequest, type ApprovalResponder } from './types'

export class ApprovalAuditError extends Error {
  constructor(message: string) {
    super(`approval 审计落库失败: ${message}`)
    this.name = 'ApprovalAuditError'
  }
}

export class ApprovalManager {
  /** per-chat 策略(§115.1;变更须落事件日志供 Replay 还原) */
  private readonly policies = new Map<string, ApprovalPolicy>()
  private readonly responders = new Map<string, ApprovalResponder>()

  setPolicy(chatId: string, policy: ApprovalPolicy): void {
    this.policies.set(chatId, policy)
  }

  policyOf(chatId: string): ApprovalPolicy {
    return this.policies.get(chatId) ?? 'ask'
  }

  /** 回答者必须属于该 chat(§115.1:跨 chat 回答者 → unavailable) */
  registerResponder(chatId: string, responder: ApprovalResponder): void {
    this.responders.set(chatId, responder)
  }

  /**
   * 解析一次性授权。返回四值之一;**除 allowed_once 外一律拒绝执行**。
   * 审计事件成对落库;审计失败抛 ApprovalAuditError(调用方按拒绝处理)。
   */
  async resolve(
    deps: { bus: EventBus; persistAudit: (row: ApprovalAuditRow) => void },
    input: { chatId: string; policy?: ApprovalPolicy; request: Omit<ApprovalRequest, 'id'>; now: Timestamp },
  ): Promise<ApprovalOutcome> {
    const policy = input.policy ?? this.policyOf(input.chatId)
    const request: ApprovalRequest = { id: uuidv7(), ...input.request }
    const requestedAt = input.now

    // —— 审计先行:requested 落库失败 = 连"问过"都不存在 → 直接拒(§115.1)——
    deps.persistAudit({
      id: request.id,
      runId: request.runId,
      toolCallId: request.toolCallId,
      action: request.action,
      description: request.description,
      risk: request.risk,
      requestedPermissions: [...request.requestedPermissions],
      reason: request.reason,
      policyAtRequest: policy,
      status: 'pending',
      createdAt: input.now,
    })
    this.publish(deps.bus, 'approval.requested', request.runId, request.id, {
      approvalId: request.id,
      runId: request.runId,
      action: request.action,
      risk: request.risk,
      toolCallId: request.toolCallId,
      policy,
    }, input.now)

    // —— §115.1:never 在派发之前生效 ——
    if (policy === 'never') {
      return this.decide(deps, request, 'rejected', input.now, 'policy=never(无人值守,确定性拒绝)', policy, input.now)
    }

    // —— 派发回答者链:无 / 跨 chat / 抛异常 / 枚举外 → unavailable ——
    const responder = this.responders.get(input.chatId)
    if (responder === undefined) {
      return this.decide(deps, request, 'unavailable', input.now, '无已注册回答者(headless / 后台 / 无 UI)', policy, input.now)
    }
    let raw: ApprovalOutcome | string
    try {
      raw = await responder(request)
    } catch {
      return this.decide(deps, request, 'unavailable', input.now, '回答者抛异常', policy, input.now)
    }
    if (!(APPROVAL_OUTCOMES as readonly string[]).includes(raw)) {
      return this.decide(deps, request, 'unavailable', input.now, `回答者返回枚举外值: ${String(raw)}`, policy, requestedAt)
    }
    return this.decide(deps, request, raw as ApprovalOutcome, input.now, undefined, policy, requestedAt)
  }

  /** decided 侧:审计行 + 成对事件(同一 approvalId);任何失败都向上抛 → 调用方拒绝 */
  private decide(
    deps: { bus: EventBus; persistAudit: (row: ApprovalAuditRow) => void },
    request: ApprovalRequest,
    outcome: ApprovalOutcome,
    now: Timestamp,
    note?: string,
    policy: ApprovalPolicy = 'ask',
    requestedAt?: Timestamp,
  ): ApprovalOutcome {
    try {
      deps.persistAudit({
        id: request.id,
        runId: request.runId,
        toolCallId: request.toolCallId,
        action: request.action,
        description: request.description,
        risk: request.risk,
        requestedPermissions: [...request.requestedPermissions],
        reason: request.reason,
        status: 'decided',
        outcome,
        decidedAt: now,
        policyAtRequest: policy,
        createdAt: requestedAt ?? now,
        note,
      })
    } catch (error) {
      throw new ApprovalAuditError(String(error))
    }
    this.publish(deps.bus, 'approval.decided', request.runId, request.id, {
      approvalId: request.id,
      runId: request.runId,
      outcome,
      toolCallId: request.toolCallId,
      ...(note === undefined ? {} : { note }),
    }, now)
    return outcome
  }

  private publish(bus: EventBus, type: 'approval.requested' | 'approval.decided', runId: string, aggregateId: string, payload: Record<string, unknown>, now: Timestamp): void {
    bus.publish({
      type,
      runId,
      aggregateType: 'approval',
      aggregateId,
      timestamp: now,
      payload,
    })
  }
}

export interface ApprovalAuditRow {
  id: string
  runId: string
  toolCallId?: string
  action: string
  description?: string
  risk: 'low' | 'medium' | 'high'
  requestedPermissions: string[]
  reason?: string
  policyAtRequest: ApprovalPolicy
  status: 'pending' | 'decided'
  outcome?: ApprovalOutcome
  decidedAt?: Timestamp
  createdAt: Timestamp
  note?: string
}
