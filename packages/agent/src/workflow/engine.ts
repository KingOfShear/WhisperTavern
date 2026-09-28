/**
 * Workflow Runtime 引擎(agent-runtime-spec §62–§70 / §110–§113)。
 *
 * 调度模型 = **波次**(wave):每一波把"所有入边都已满足"的节点**并发**执行
 * (§68 fan-out 天然产生并行),汇入同一节点的分支在该节点处 join(等全部完成)。
 * §69 并行失败策略作用于同一波内的失败传播;§110/§111 用**节点账本**支持 Resume
 * (已完成的默认不重执行,失败的重试);§112/§113:环必须显式 LoopPolicy 且受
 * maxIterations 封顶,无政策的环在校验期直接拒绝。
 *
 * Agent 间通信只有 variables / artifacts / outputs(§70:不碰彼此内部状态)。
 * 条件一律走受限 DSL(§66/§67,condition.ts),禁止任意 JS。
 * 事件:workflow.started / stage_started / stage_completed / completed(§5.4 durable)。
 * R-P3-7:引擎仅内部 + 测试可驱动;HTTP 面(§155)归 P4。
 */
import type { EventBus } from '@whispertavern/runtime'
import type { Timestamp } from '@whispertavern/contracts'
import { evaluateCondition, evaluateExpression, ConditionSyntaxError } from './condition'
import { extractJson, validateDirectorDecision } from './director'
import type { AgentNode, ParallelFailurePolicy, ToolNode, WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeLedger } from './types'

/** 结构化输出校验(§81):JSON 可提取 + Director 决策 schema 通过 */
function structuredErrors(raw: string): string[] {
  const value = extractJson(raw)
  if (value === null) return ['输出中未找到 JSON 对象']
  if (validateDirectorDecision(value) === null) return ['JSON 未通过 schema 校验(缺 nextAgent 非空字符串)']
  return []
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(`WORKFLOW_INVALID: ${message}`)
    this.name = 'WorkflowValidationError'
  }
}

export class WorkflowLoopExceeded extends Error {
  constructor(message: string) {
    super(`WORKFLOW_LOOP_EXCEEDED: ${message}`)
    this.name = 'WorkflowLoopExceeded'
  }
}

/** 节点执行器(§64/§65 的落地委托;S25 由调用方注入,§172 测试接真实 runAgent) */
export interface WorkflowNodeExecutors {
  agent: (node: AgentNode, input: unknown, ctx: WorkflowRunContext) => Promise<unknown>
  tool: (node: ToolNode, input: unknown, ctx: WorkflowRunContext) => Promise<unknown>
}

/** §70 运行期上下文:variables 是数据总线,artifacts 是 Agent 间产物通道 */
export interface WorkflowRunContext {
  workflowId: string
  variables: Record<string, unknown>
  artifacts: Record<string, import('./types').WorkflowArtifact>
  now: Timestamp
}

export interface WorkflowRunResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  variables: Record<string, unknown>
  outputs: Record<string, unknown>
  ledger: WorkflowNodeLedger
  error?: string
}

export interface WorkflowEngineDeps {
  bus: EventBus
  executors: WorkflowNodeExecutors
  /** §110 账本持久化回调(缺省内存;S27 接 runtime_checkpoints 表) */
  persistLedger?: (workflowId: string, ledger: WorkflowNodeLedger) => void
  clock?: () => Timestamp
}

export class WorkflowEngine {
  /** 当前 run 的回边键集(§112;readyNodes 排除回边作为前置) */
  private backEdgeKeys = new Set<string>()

  constructor(private readonly deps: WorkflowEngineDeps) {}

  /** 校验:节点/边引用、入边条件词法、§112 环必须显式 LoopPolicy */
  validate(def: WorkflowDefinition): void {
    const ids = new Set(def.nodes.map((n) => n.id))
    if (ids.size !== def.nodes.length) throw new WorkflowValidationError('节点 id 重复')
    for (const edge of def.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        throw new WorkflowValidationError(`边引用不存在的节点: ${edge.from} → ${edge.to}`)
      }
      if (edge.condition !== undefined) evaluateCondition(edge.condition, {}) // 词法校验
    }
    for (const node of def.nodes) {
      if (node.type === 'condition') {
        evaluateExpression(node.expression, {})
        for (const branch of node.branches) {
          if (!ids.has(branch.nextNode)) throw new WorkflowValidationError(`condition 分支指向不存在的节点: ${branch.nextNode}`)
          evaluateCondition(branch.condition, {})
        }
      }
    }
    // §112:回边(指向拓扑序更早的节点)= 环;必须显式 LoopPolicy
    const backEdges = findBackEdges(def)
    if (backEdges.length > 0 && def.loopPolicy === undefined) {
      throw new WorkflowValidationError(`检测到环(${backEdges.map((e) => `${e.from}→${e.to}`).join(', ')})但未声明 LoopPolicy(§112:只允许有界环)`)
    }
  }

  /** 执行;`resumeLedger` 提供时已完成节点跳过、失败节点重试(§110/§111) */
  async run(
    def: WorkflowDefinition,
    input: { variables?: Record<string, unknown>; now: Timestamp; resumeLedger?: WorkflowNodeLedger; parallelFailurePolicy?: ParallelFailurePolicy },
  ): Promise<WorkflowRunResult> {
    this.validate(def)
    const now = input.now
    const ledger: WorkflowNodeLedger = input.resumeLedger ?? { completed: {}, failed: {} }
    const variables: Record<string, unknown> = {}
    for (const v of def.variables ?? []) variables[v.name] = v.default
    Object.assign(variables, input.variables ?? {})
    const ctx: WorkflowRunContext = { workflowId: def.id, variables, artifacts: {}, now }

    const nodesById = new Map(def.nodes.map((n) => [n.id, n]))
    const totalRuns = (def.loopPolicy?.maxTotalRuns ?? Number.POSITIVE_INFINITY)
    let runCounter = 0
    const nodeExecCount = new Map<string, number>()
    const loopIterations = new Map<string, number>()
    const backEdgesCache = findBackEdges(def)
    this.backEdgeKeys = new Set(backEdgesCache.map((e) => `${e.from}>${e.to}`))
    const startedAt = Date.now()

    this.publish('workflow.started', def.id, { workflowId: def.id, version: def.version })

    // 波次循环:就绪 = 全部入边源已完成且边条件通过
    const executedFailures: string[] = []
    const routedAway = new Set<string>()
    const resuming = input.resumeLedger !== undefined
    let guard = 0
    while (true) {
      guard += 1
      if (guard > 10_000) throw new WorkflowLoopExceeded('波次调度超过安全上限(引擎 bug 或账本不一致)')
      if (def.loopPolicy !== undefined && Date.now() - startedAt > def.loopPolicy.maxExecutionTimeMs) {
        throw new WorkflowLoopExceeded(`执行时间超过 maxExecutionTimeMs=${def.loopPolicy.maxExecutionTimeMs}`)
      }
      const ready = this.readyNodes(def, ledger, variables, nodesById, input.parallelFailurePolicy ?? 'fail_fast', resuming, routedAway)
      if (ready.length === 0) break
      if (runCounter >= totalRuns) throw new WorkflowLoopExceeded(`总执行波次超过 maxTotalRuns=${totalRuns}`)

      // —— §68:整波并发;§69 波内失败按策略传播 ——
      const wave = ready.map(async (node) => {
        const count = (nodeExecCount.get(node.id) ?? 0) + 1
        nodeExecCount.set(node.id, count)
        if (def.loopPolicy !== undefined && count > def.loopPolicy.maxIterations) {
          throw new WorkflowLoopExceeded(`节点 ${node.id} 执行 ${count} 次超过 maxIterations=${def.loopPolicy.maxIterations}`)
        }
        this.publish('workflow.stage_started', node.id, { workflowId: def.id, nodeId: node.id, type: node.type, iteration: count })
        const input2 = this.resolveInput(node, ctx)
        let output: unknown
        if (ledger.completed[node.id] !== undefined) {
          // §110:已完成默认不重执行(理论上 readyNodes 已滤;双保险)
          output = ledger.completed[node.id]
        } else if (node.type === 'agent') {
          output = await this.deps.executors.agent(node, input2, ctx)
          output = await this.applyStructured(node, output, ctx)
        } else if (node.type === 'tool') {
          output = await this.deps.executors.tool(node, input2, ctx)
        } else if (node.type === 'condition') {
          output = this.executeCondition(node, variables)
        } else if (node.type === 'transform') {
          output = this.executeTransform(node, variables)
        } else if (node.type === 'approval') {
          throw new WorkflowValidationError(`approval 节点 ${node.id} 的执行面归 S26(Context Policy 族随审批接线);本会话校验其形状但不执行`)
        } else {
          // parallel:显式 join barrier 标记——输出 = 各入边源输出的汇聚
          output = this.incomingOutputs(def, node.id, ledger)
        }
        ledger.completed[node.id] = output
        if (ledger.failed[node.id] !== undefined) delete ledger.failed[node.id]
        this.applyOutputMapping(node, output, ctx)
        this.publish('workflow.stage_completed', node.id, { workflowId: def.id, nodeId: node.id, type: node.type })
        return output
      })

      const settled = await Promise.allSettled(wave)
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      if (rejected.length > 0) {
        const failurePolicy: ParallelFailurePolicy = input.parallelFailurePolicy ?? 'fail_fast'
        const messages = rejected.map((r) => String(r.reason instanceof Error ? r.reason.message : r.reason))
        // §111:失败节点记账(两种策略都记;Resume 依据)
        for (const [idx, s] of settled.entries()) {
          if (s.status === 'rejected') {
            const node = ready[idx]
            if (node !== undefined) ledger.failed[node.id] = { error: String(s.reason instanceof Error ? s.reason.message : s.reason), attempts: nodeExecCount.get(node.id) ?? 1 }
          }
        }
        if (failurePolicy === 'fail_fast' || failurePolicy === 'wait_all') {
          // 记账后判死(§111:已完成的保留,Resume 从失败处续)
          this.deps.persistLedger?.(def.id, ledger)
          this.publish('workflow.completed', def.id, { workflowId: def.id, status: 'failed', errors: messages })
          return { status: 'failed', variables, outputs: ledger.completed, ledger, error: messages.join('; ') }
        }
        // best_effort:失败已记账,继续(§69)
        for (const message of messages) executedFailures.push(message)
      }
      runCounter += 1

      // —— §112/§113 有界环:回边把**环体下游**完成态清掉(允许真迭代),次数受 maxIterations 封顶。
      // 回边源(edge.from)保留完成态——它是本轮迭代的起点依据,否则 W←K 互相等待形成死锁。
      if (def.loopPolicy !== undefined) {
        for (const edge of backEdgesCache) {
          if (ledger.completed[edge.from] === undefined) continue
          if (edge.condition !== undefined && !evaluateCondition(edge.condition, variables)) continue
          const loopKey = `${edge.from}->${edge.to}`
          const iterations = (loopIterations.get(loopKey) ?? 0) + 1
          if (iterations > def.loopPolicy.maxIterations) {
            throw new WorkflowLoopExceeded(`回边 ${loopKey} 迭代 ${iterations} 次超过 maxIterations=${def.loopPolicy.maxIterations}(§113)`)
          }
          loopIterations.set(loopKey, iterations)
          clearDownstreamExcept(def, edge.to, ledger, new Set([edge.from]))
        }
      }
      this.deps.persistLedger?.(def.id, ledger)
    }

    // 不可达 = 未完成、未失败、且不是被条件路由离开的节点(边条件为假是正常路由)
    const unreachable = def.nodes.filter(
      (n) => ledger.completed[n.id] === undefined && ledger.failed[n.id] === undefined && !routedAway.has(n.id),
    )
    if (unreachable.length > 0) {
      const error = `不可达节点: ${unreachable.map((n) => n.id).join(', ')}(边条件全假或图不连通)`
      this.publish('workflow.completed', def.id, { workflowId: def.id, status: 'failed', error })
      return { status: 'failed', variables, outputs: ledger.completed, ledger, error }
    }

    this.publish('workflow.completed', def.id, {
      workflowId: def.id,
      status: 'succeeded',
      ...(executedFailures.length > 0 ? { bestEffortFailures: executedFailures } : {}),
    })
    return { status: 'succeeded', variables, outputs: ledger.completed, ledger }
  }

  /** 就绪节点:入边源全部完成、边条件通过、自身未完成;condition 分支目标受门控。
   * best_effort 下,"失败已记账"的源视作已解决(带部分结果继续,§69);
   * Resume 时失败节点允许重试(§111),单次运行内失败则放弃(best_effort)或判死(fail_fast)。 */
  private readyNodes(
    def: WorkflowDefinition,
    ledger: WorkflowNodeLedger,
    variables: Readonly<Record<string, unknown>>,
    nodesById: Map<string, WorkflowNode>,
    failurePolicy: ParallelFailurePolicy,
    resuming: boolean,
    routedAway: Set<string>,
  ): WorkflowNode[] {
    const bestEffort = failurePolicy === 'best_effort'
    const done = (id: string): boolean => ledger.completed[id] !== undefined || (bestEffort && ledger.failed[id] !== undefined)
    return def.nodes.filter((node) => {
      if (done(node.id)) return false
      if (!resuming && ledger.failed[node.id] !== undefined) return false
      // —— condition 分支门控:引用本节点的 condition 未执行 → 等待;已执行但未选中本节点 → 永不就绪 ——
      for (const cond of def.nodes) {
        if (cond.type !== 'condition') continue
        if (!cond.branches.some((b) => b.nextNode === node.id)) continue
        if (!done(cond.id)) return false
        if (!this.conditionTargets(cond, variables).includes(node.id)) {
          routedAway.add(node.id)
          return false
        }
      }
      // 回边(§112 环闩)不是前置条件——它是"再次执行"的触发器;计入前置会让环失去入口(首波死锁)
      const incoming = def.edges.filter(
        (e) => e.to === node.id && nodesById.get(e.from)?.type !== 'condition' && !this.backEdgeKeys.has(`${e.from}>${e.to}`),
      )
      for (const edge of incoming) {
        if (!done(edge.from)) return false
        if (edge.condition !== undefined && !evaluateCondition(edge.condition, variables)) {
          routedAway.add(node.id)
          return false
        }
      }
      return true
    })
  }

  /** §66:condition 节点的分支求值(第一个为真的分支生效;全假 → 空数组) */
  private conditionTargets(node: Extract<WorkflowNode, { type: 'condition' }>, variables: Readonly<Record<string, unknown>>): string[] {
    const targets: string[] = []
    for (const branch of node.branches) {
      if (evaluateCondition(branch.condition, variables)) targets.push(branch.nextNode)
    }
    if (targets.length === 0 && node.branches.length > 0) {
      // fail-closed:全假不开任何分支(不可达节点判失败,见 run)
      return []
    }
    return targets
  }

  private executeCondition(node: Extract<WorkflowNode, { type: 'condition' }>, variables: Readonly<Record<string, unknown>>): unknown {
    const chosen = this.conditionTargets(node, variables)
    return { branches: chosen }
  }

  private executeTransform(node: Extract<WorkflowNode, { type: 'transform' }>, variables: Record<string, unknown>): unknown {
    for (const set of node.sets) {
      variables[set.name] = set.from !== undefined ? variables[set.from] : set.value
    }
    return { transformed: node.sets.map((s) => s.name) }
  }

  /** 输入解析:inputMapping 里 `"$var.name"` / `"$artifact.id"` / `"$out.nodeId"` 引用 */
  private resolveInput(node: WorkflowNode, ctx: WorkflowRunContext): unknown {
    const mapping = node.type === 'tool' ? node.inputMapping : node.type === 'agent' ? node.inputMapping : undefined
    if (mapping === undefined || Object.keys(mapping).length === 0) {
      return ctx.variables['input']
    }
    const resolved: Record<string, unknown> = {}
    for (const [key, ref] of Object.entries(mapping)) {
      resolved[key] = this.deref(ref, ctx)
    }
    return resolved
  }

  private deref(ref: unknown, ctx: WorkflowRunContext): unknown {
    if (typeof ref !== 'string' || !ref.startsWith('$')) return ref
    const path = ref.slice(1)
    if (path.startsWith('var.')) return ctx.variables[path.slice(4)]
    if (path.startsWith('artifact.')) return ctx.artifacts[path.slice(9)]
    return ref
  }

  private applyOutputMapping(node: WorkflowNode, output: unknown, ctx: WorkflowRunContext): void {
    if (node.type !== 'agent' && node.type !== 'tool') return
    const mapping = node.type === 'agent' ? node.outputMapping : node.outputMapping
    if (mapping === undefined) {
      // 缺省:输出整体挂到 `out.<nodeId>`
      ctx.variables[`out.${node.id}`] = output
      return
    }
    for (const [key, target] of Object.entries(mapping)) {
      if (typeof key !== 'string') continue
      const value = (output as Record<string, unknown> | null)?.[key]
      if (typeof target === 'string' && target.startsWith('$var.')) {
        ctx.variables[target.slice(5)] = value
      } else if (typeof target === 'string' && target.startsWith('$artifact.')) {
        ctx.artifacts[target.slice(10)] = {
          id: target.slice(10),
          type: node.type === 'agent' ? 'agent-output' : 'tool-output',
          data: value,
          sourceRunId: node.id,
          createdAt: ctx.now,
        }
      }
    }
  }

  /** §80/§81/§82:结构化输出 validate → repair(再调一次模型,受 repairAttempts 封顶)→ fail */
  private async applyStructured(node: AgentNode, output: unknown, ctx: WorkflowRunContext): Promise<unknown> {
    const policy = node.structuredOutputPolicy
    if (policy === undefined) return output
    let raw = typeof output === 'string' ? output : JSON.stringify(output ?? '')
    let errors = structuredErrors(raw)
    for (let attempt = 0; attempt <= policy.repairAttempts; attempt += 1) {
      if (errors.length === 0) {
        const decision = validateDirectorDecision(extractJson(raw) ?? {})
        if (decision === null) {
          throw new Error('Director 决策缺失(§80)')
        }
        ctx.variables[`decision.${node.id}`] = decision
        // 拍平到叶子键:条件边 `decision.<id>.nextAgent == 'x'` 直接读(§80 dispatch 路由)
        ctx.variables[`decision.${node.id}.nextAgent`] = decision.nextAgent
        if (decision.reason !== undefined) ctx.variables[`decision.${node.id}.reason`] = decision.reason
        if (node.dispatch === true) {
          // §80:Runtime 按 nextAgent 结构化字段 dispatch(路由经条件边读 decision 变量;
          // 不解析自然语言)。引擎把决策透出,调度器仍由 DAG 边驱动。
          return { ...decision, __dispatchTo: decision.nextAgent }
        }
        return decision
      }
      if (attempt === policy.repairAttempts) break
      // §82 Repair:带修复指令**再调一次模型**(预算 = policy.repairAttempts)
      raw = await this.deps.executors.agent(
        { ...node, inputMapping: undefined },
        { repair: true, previous: raw, errors },
        ctx,
      ) as unknown as string
      // 执行器约定返回 {text}(与 AgentNode 缺省输出同形);取正文作为新的待校验输出
      raw =
        typeof raw === 'string'
          ? raw
          : typeof (raw as { text?: unknown }).text === 'string'
            ? (raw as { text: string }).text
            : JSON.stringify(raw ?? '')
      errors = structuredErrors(raw)
    }
    throw new Error(`结构化输出校验失败(§81/§82,repairAttempts=${policy.repairAttempts}): ${errors.join('; ')}`)
  }

  private incomingOutputs(def: WorkflowDefinition, nodeId: string, ledger: WorkflowNodeLedger): unknown {
    const sources = def.edges.filter((e) => e.to === nodeId).map((e) => e.from)
    return sources.map((from) => ledger.completed[from])
  }

  private publish(type: 'workflow.started' | 'workflow.stage_started' | 'workflow.stage_completed' | 'workflow.completed', aggregateId: string, payload: Record<string, unknown>): void {
    this.deps.bus.publish({
      type,
      aggregateType: 'workflow',
      aggregateId,
      timestamp: this.deps.clock?.() ?? (new Date().toISOString() as Timestamp),
      payload,
    })
  }
}

/** §112 环检测:DFS 找回边(返回**原始边对象**,保留 condition/priority——回边闩锁要读条件)。 */
function findBackEdges(def: WorkflowDefinition): WorkflowEdge[] {
  const adjacency = new Map<string, WorkflowEdge[]>()
  for (const e of def.edges) adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e])
  const state = new Map<string, 1 | 2>() // 1 = 在栈,2 = 完成
  const back: WorkflowEdge[] = []
  const visit = (id: string): void => {
    state.set(id, 1)
    for (const edge of adjacency.get(id) ?? []) {
      const s = state.get(edge.to)
      if (s === 1) back.push(edge)
      else if (s === undefined) visit(edge.to)
    }
    state.set(id, 2)
  }
  for (const node of def.nodes) {
    if (state.get(node.id) === undefined) visit(node.id)
  }
  return back
}

/** §112:清掉 `start` 及其全部下游的完成态(回边迭代 = 下游结果逻辑上过期);
 * `keep` 集合中的节点保留(回边源 = 本轮迭代起点依据)。 */
function clearDownstreamExcept(def: WorkflowDefinition, start: string, ledger: WorkflowNodeLedger, keep: ReadonlySet<string>): void {
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.pop()!
    if (keep.has(id)) continue
    delete ledger.completed[id]
    for (const edge of def.edges) {
      if (edge.from === id && ledger.completed[edge.to] !== undefined) queue.push(edge.to)
    }
  }
}

export { ConditionSyntaxError }
