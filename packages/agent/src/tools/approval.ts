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
import { APPROVAL_ABSTAIN, APPROVAL_OUTCOMES, type ApprovalOutcome, type ApprovalPolicy, type ApprovalRequest, type ApprovalResponder } from './types'

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
  /** §115.1 回答者链末级(S32):无 per-chat 回答者时的兜底;缺省 = 无 → unavailable */
  private defaultResponder: ApprovalResponder | undefined

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
   * §115.1 回答者链末级(S32):headless/后台场景下的**默认回答者**。
   *
   * 安全边界必须说清——默认回答者**不是**"没人审批就放行"的开关:
   * 1. 它只在 per-chat 回答者缺位或被跳过时参与(链序 = per-chat → default → unavailable);
   * 2. 它返回 `unavailable`/枚举外值/抛异常,结果与"完全没有回答者"一致,仍是拒绝;
   * 3. `policy='never'` 在链之前生效,默认回答者**无法**越过它(§115.1 硬约束)。
   * 因此默认回答者的实现(如 `createAutoApprover`)必须自己保证只放行白名单内的
   * 低风险只读工具,其余一律弃权——放行面写死在策略里,不由调用方临时决定。
   */
  setDefaultResponder(responder: ApprovalResponder | undefined): void {
    this.defaultResponder = responder
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

    // —— §115.1 派发回答者链:per-chat → default → unavailable ——
    // 弃权(APPROVAL_ABSTAIN)继续下探下一级;**抛异常 / 枚举外值当场 fail-closed**,
    // 不再下探——"回答者坏了"绝不能被下一级回答者的放行掩盖(S32 补链序)。
    const chain: { name: string; responder: ApprovalResponder | undefined }[] = [
      { name: 'per-chat 回答者', responder: this.responders.get(input.chatId) },
      { name: '默认回答者', responder: this.defaultResponder },
    ]
    for (const { name, responder } of chain) {
      if (responder === undefined) continue
      let raw: ApprovalOutcome | string
      try {
        raw = await responder(request)
      } catch {
        return this.decide(deps, request, 'unavailable', input.now, `${name}抛异常`, policy, requestedAt)
      }
      if (raw === APPROVAL_ABSTAIN) continue // 该级声明"此事不归我批" → 下探
      if (!(APPROVAL_OUTCOMES as readonly string[]).includes(raw)) {
        return this.decide(deps, request, 'unavailable', input.now, `${name}返回枚举外值: ${String(raw)}`, policy, requestedAt)
      }
      return this.decide(deps, request, raw as ApprovalOutcome, input.now, undefined, policy, requestedAt)
    }
    return this.decide(deps, request, 'unavailable', input.now, '无已注册回答者(headless / 后台 / 无 UI)', policy, requestedAt)
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

/**
 * 可被自动批准的**只读**权限集合(§33 权限目录的只读子集)。
 *
 * 刻意逐项列举而非"取反":新增权限时默认落在"不可自动批准"一侧(fail-closed)。
 */
const READ_ONLY_TOOL_PERMISSIONS = new Set([
  'network.request',
  'filesystem.read',
  'chat.read',
  'worldbook.read',
  'memory.read',
])

/**
 * §115.1 自动批准回答者工厂(S32/WP4.3)——低风险只读工具的"无人值守默认放行"。
 *
 * **它不是"关掉审批"**:每次调用照旧经 `resolve` 走完整管线——审计行先写、
 * `approval.requested`/`approval.decided` 成对落库、`policy='never'` 在它之前生效。
 * 它改变的只是**谁回答**这一个环节(p4-plan §7 任务 4 的"不绕过")。
 *
 * 放行面**写死在白名单里**,调用方无法在运行时扩大:
 * - 只放行 allowlist 中显式列出的工具(如只读外网类 `web.search`);
 * - 白名单外的工具一律 **abstain** → 继续下探 → 无人应答时 `unavailable` → 拒绝;
 * - 白名单里若混进带写权限的工具也不会被静默放行:`requestedPermissions` 含写类/
 *   提权类权限时同样弃权。
 *
 * 最后这条冗余校验的理由:白名单是人工维护的,而权限是工具自己声明的——用后者约束前者,
 * 才能保证"有人往白名单里加错工具"的后果只是拒绝,而不是越权。
 *
 * 注意判据**不含 `risk`**:§36.1 派发审批时 risk 由流水线统一给出(当前恒为 'medium'),
 * 按 risk 放行等于无条件放行;真正的判据必须是"这个工具是谁 + 它要什么权限"。
 */
export function createAutoApprover(allowlist: readonly string[]): ApprovalResponder {
  const allowed = new Set(allowlist)
  return async (request: ApprovalRequest): Promise<ApprovalOutcome | typeof APPROVAL_ABSTAIN> => {
    if (!allowed.has(request.action)) return APPROVAL_ABSTAIN
    if (request.requestedPermissions.some((p) => !READ_ONLY_TOOL_PERMISSIONS.has(p))) return APPROVAL_ABSTAIN
    return 'allowed_once'
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
