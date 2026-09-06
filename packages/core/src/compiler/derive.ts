import {
  AUTHORITY_ORDER,
  type InstructionAuthority,
  type InstructionMetadata,
  type InstructionScope,
  type InstructionTrust,
  type PromptContribution,
  type PromptRole,
  type PromptZoneName,
  type SegmentSource,
} from '@desiregrimoire/contracts'

/**
 * 指令元数据默认推导 —— instruction-security-spec §10(source → authority/trust/scope)
 * 的 P0 收编(p0-plan S4 任务 4)。
 *
 * **I1(不变式,§5)**:authority 只由来源登记投影决定,内容文本自述一律无效——
 * 本表是全项目唯一的 authority 生产者(P0),编译器不存在"识别文本身份"的代码路径。
 * 违反 I1/I4 的实现级断言见 pipeline.ts assertInvariants。
 */

export interface DerivedInstruction {
  authority: InstructionAuthority
  trust: InstructionTrust
  scope: InstructionScope
}

/**
 * §10 推导表(对 SegmentSource 十三变体穷尽,无例外分支)。
 *
 * message 的"按作者映射"P0 具体化:author 按 role 投影(character/assistant/narrator
 * → character 档);当轮 user 输入 = tail 区消息 → scope 'request',其余历史 → 'none'
 * (§6 说明:历史消息不产生指令效力,记录性内容)。
 */
export function deriveInstruction(
  source: SegmentSource,
  role: PromptRole,
  zone: PromptZoneName,
): DerivedInstruction {
  switch (source.type) {
    case 'character':
      return { authority: 'character', trust: 'semi_trusted', scope: 'roleplay' }
    case 'persona':
      return { authority: 'user', trust: 'trusted', scope: 'request' }
    case 'preset':
      // preset 保留段白名单 → override 档(§12)由 pipeline 的 overrideSlot 配置处理,
      // 不在本表:I4 要求 override 只经显式配置产生,推导表对 preset 恒给 system。
      return { authority: 'system', trust: 'trusted', scope: 'assembly' }
    case 'worldbook':
      return { authority: 'world', trust: 'semi_trusted', scope: 'roleplay' }
    case 'summary':
      return { authority: 'summary', trust: 'semi_trusted', scope: 'roleplay' }
    case 'message':
      return deriveMessage(role, zone)
    case 'memory':
      return { authority: 'memory', trust: 'semi_trusted', scope: 'roleplay' }
    case 'agent':
    case 'workflow':
      return { authority: 'agent', trust: 'trusted', scope: 'assembly' }
    // §10"随声明":P0 无 artifact 源,占位 roleplay;实装随 WP3.4
    case 'artifact':
      return { authority: 'agent', trust: 'semi_trusted', scope: 'roleplay' }
    case 'toolResult':
      // 工具结果回灌 = 外部通道内容(I3 触发源之一;P0 管线可经直接 API 提交)
      return { authority: 'untrusted', trust: 'untrusted', scope: 'none' }
    case 'plugin':
      return { authority: 'system', trust: 'semi_trusted', scope: 'assembly' }
    case 'runtime':
      return { authority: 'platform', trust: 'trusted', scope: 'assembly' }
  }
}

function deriveMessage(role: PromptRole, zone: PromptZoneName): DerivedInstruction {
  switch (role) {
    case 'user':
      return zone === 'tail'
        ? { authority: 'user', trust: 'trusted', scope: 'request' } // 当轮输入
        : { authority: 'user', trust: 'trusted', scope: 'none' } // 历史,记录性
    case 'assistant':
      // 编译层 assistant = 角色发言,作者映射 character 档(历史,记录性)
      return { authority: 'character', trust: 'trusted', scope: 'none' }
    case 'system':
      return { authority: 'system', trust: 'trusted', scope: 'none' }
    case 'tool':
      return { authority: 'tool', trust: 'trusted', scope: 'none' }
  }
}

/**
 * R2/R3 越权判定(§11):显式声明的 authority 是否高于来源推导档。
 * developer 仅投影档不存在于输入面(§6),比较时同样参与全序以防伪造提升。
 */
export function outranks(a: InstructionAuthority, b: InstructionAuthority): boolean {
  return rankOf(a) < rankOf(b) // AUTHORITY_ORDER 由高到低,序号小 = 档位高
}

function rankOf(authority: InstructionAuthority): number {
  const index = AUTHORITY_ORDER.indexOf(authority)
  if (index < 0) throw new Error(`INVARIANT_VIOLATION: unknown authority ${authority}`)
  return index
}

/**
 * R2 处置:显式声明试图提升档位 → 拒绝该声明,段按推导档入位,报诊断。
 * 返回实际生效的元数据(instruction-security §21 AUTHORITY_OVERRIDE_DENIED 行)。
 */
export function resolveInstruction(
  contribution: PromptContribution,
  zone: PromptZoneName,
): { instruction: InstructionMetadata; overrideDenied: boolean } {
  const derived = deriveInstruction(contribution.source, contribution.segment.role, zone)
  const provided = contribution.instruction
  if (!provided) {
    return { instruction: { ...derived }, overrideDenied: false }
  }
  if (outranks(provided.authority, derived.authority)) {
    // 低档来源声明高档身份 → 整体拒绝该声明(I1/I2:非法路径),段按推导档入位
    return { instruction: { ...derived }, overrideDenied: true }
  }
  return { instruction: { ...provided }, overrideDenied: false }
}
