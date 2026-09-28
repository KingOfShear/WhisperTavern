/**
 * Workflow 对象形状(agent-runtime-spec §62–§67 / §68–§70 / §81 / §113)。
 *
 * 纪律:只转录 spec 已定义的形状;spec 列了名字但没给形状的
 * (TransformNode / ApprovalNode / ParallelNode / RetryPolicy / TimeoutPolicy /
 * WorkflowVariable / ConditionExpression)按最小实现收编并在字段上标注。
 * R-P3-7:Workflow 是**引擎**(内部 + 测试可驱动),用户面 CRUD/HTTP 归 P4(api-spec §155)。
 */
import type { Timestamp } from '@whispertavern/contracts'
import type { StructuredOutputPolicy } from './director'
import type { ApprovalOutcome } from '../tools/types'

/** §64 retryPolicy/timeoutPolicy 形状 spec 未定义 → 最小收编(S26/S27 随超时面细化) */
export interface RetryPolicy {
  maxAttempts: number
  backoffMs?: number
}
export interface TimeoutPolicy {
  nodeMs?: number
}

/** §62 Workflow Definition(variables 形状 spec 未定义 → 名+默认值最小收编) */
export interface WorkflowDefinition {
  id: string
  version: number
  nodes: readonly WorkflowNode[]
  edges: readonly WorkflowEdge[]
  variables?: readonly WorkflowVariable[]
  /** §113:环(回边)必须显式携带 LoopPolicy,否则校验拒绝(§112) */
  loopPolicy?: LoopPolicy
}

/** §113 Loop Policy(有界环;缺省无环 DAG 不需要) */
export interface LoopPolicy {
  maxIterations: number
  maxTotalRuns: number
  maxExecutionTimeMs: number
}

export interface WorkflowVariable {
  name: string
  default?: unknown
}

export type WorkflowNode = AgentNode | ToolNode | ConditionNode | TransformNode | ApprovalNode | ParallelNode

interface NodeBase {
  id: string
}

/** §64 Agent Node。S25 收编字段:structuredOutputPolicy(§81)+ dispatch(§80)——spec 的
 * AgentNode 未列,但 §80 的 Director 语义必须落在某个节点上;落调和注于 spec。 */
export interface AgentNode extends NodeBase {
  type: 'agent'
  agentId: string
  agentVersion?: number
  inputMapping?: Record<string, unknown>
  outputMapping?: Record<string, unknown>
  retryPolicy?: RetryPolicy
  timeoutPolicy?: TimeoutPolicy
  /** §81:结构化输出策略(声明后节点输出必须过 schema) */
  structuredOutputPolicy?: StructuredOutputPolicy
  /** §80:Director 语义——结构化输出的 `nextAgent` 字段决定下一个执行节点(不解析自然语言) */
  dispatch?: boolean
}

/** §65 Tool Node(执行委托 ToolRegistry 的五段流水线) */
export interface ToolNode extends NodeBase {
  type: 'tool'
  toolId: string
  inputMapping: Record<string, unknown>
  outputMapping?: Record<string, unknown>
}

/** §66 Condition Node:受限 DSL 分支路由,**禁止任意 JS**(spec 原文铁律) */
export interface ConditionNode extends NodeBase {
  type: 'condition'
  expression: ConditionExpression
  branches: readonly {
    condition: string
    nextNode: string
  }[]
}

/** Transform 形状 spec 未定义 → 最小收编:纯函数映射 variables→variables */
export interface TransformNode extends NodeBase {
  type: 'transform'
  /** 受限操作:set 常量 / copy 变量(不做任意计算) */
  sets: readonly { name: string; from?: string; value?: unknown }[]
}

/** §114 Approval 节点(复用 §115.1 四值;非 allowed_once → 节点失败) */
export interface ApprovalNode extends NodeBase {
  type: 'approval'
  action: string
  description?: string
  risk: 'low' | 'medium' | 'high'
}

/** ParallelNode 形状 spec 未定义 → S25 收编为**显式 join barrier 标记**:
 * 该节点等待所有入边完成(并行面由 fan-out 边天然产生,§68)。 */
export interface ParallelNode extends NodeBase {
  type: 'parallel'
  /** §69:汇入本节点的并行分支失败策略 */
  failurePolicy?: ParallelFailurePolicy
}

/** §68/§69 并行失败策略 */
export type ParallelFailurePolicy = 'fail_fast' | 'wait_all' | 'best_effort'

/** §67 Workflow Edge(condition 为受限 DSL 字符串,与 §66 同词法;禁止 JS) */
export interface WorkflowEdge {
  from: string
  to: string
  condition?: string
  priority?: number
}

/**
 * §66 受限条件表达式(§67 edge.condition 的对象形)。
 * 比较 + all/any/not 组合;**没有第三种自由形态**——字符串 DSL(§67)与对象形同词法。
 */
export type ConditionExpression =
  | { op: '==' | '!=' | '>' | '<' | '>=' | '<='; left: string; right: string | number | boolean }
  | { all: readonly ConditionExpression[] }
  | { any: readonly ConditionExpression[] }
  | { not: ConditionExpression }

/** §71 最小 Artifact 形状(§70:Agent 间只经 Artifact/Message/Event/Output 通信) */
export interface WorkflowArtifact {
  id: string
  type: string
  name?: string
  content?: string
  data?: unknown
  sourceRunId?: string
  createdAt: Timestamp
}

/** 节点执行账本(§110 Resume 的持久面;S25 内存账本 + 可选持久化回调,S27 接 checkpoint 表) */
export interface WorkflowNodeLedger {
  /** 已完成节点的输出(§110:已完成的默认不重执行) */
  completed: Record<string, unknown>
  /** 失败节点(§111:Resume 时 retry 这些,而不是从头跑) */
  failed: Record<string, { error: string; attempts: number }>
}

export type { ApprovalOutcome }
