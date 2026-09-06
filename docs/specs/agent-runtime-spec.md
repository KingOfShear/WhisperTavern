# DesireGrimoire V2 — Agent Runtime Specification

> 版本：V2.1（2026-09-05 参照 DeepSeek Harness 补强执行语义）
> 状态：Draft（已与总设计对齐，待 P3 实施验证）
> 文档层级：[technical-design.md](../technical-design.md) 之下的 **Agent Runtime 模块详细规格**，与 `prompt-compiler-spec.md`、`database-schema.md` 同级
> 依赖：`database-schema.md`、`prompt-compiler-spec.md`
> 参考实现：`https://github.com/deepseek-ai/deepseek-harness`（编码 agent harness；仅借鉴其 agent-loop 脊柱机械结构，不借鉴其编码领域能力，取舍记录见 §176）
>
> **收编时的五处裁决**（本文与总设计冲突处的最终口径，已同步回总设计 §38 决策 13–18）
> - **C1 单聊路径**（§78）：Single Chat = 退化为单节点的 Workflow——统一抽象成立，但**快速路径禁止引入额外模型调用、Director 不参与**。
> - **C2 冻结产物**（§72）：`frozen = true` **不提升缓存分区**，一律 injection / tail（另见 prompt-compiler-spec §84.1）。
> - **C3 Retry**（§12 与 §47 原文自相矛盾，以本条为准）：Provider / Tool 瞬时错误 = 同 Run 内新 Attempt；用户触发的重试 = 新建 Run + `origin_run_id`。Run 本体永不从终态改回 running。
> - **C4 事件命名**：§59 / §117 / §118 中的 `user.message.created`、`chat.message.created`、`tool.completed` 等自造名作废，以总设计 §5.4 权威清单为准。
> - **C5 统一执行层级**（新增，收编 AI 建议，§4.1–4.6）：Agent Runtime 全部运行行为收敛为 **Run / Attempt / Step Run / Operation** 四层；Retry 一律创建新记录，设施级 HTTP 重试归 Operation。**用户重试语义维持 C3（新建 Run + `origin_run_id`），不随建议改为同 Run 新 Attempt**。Phase 纪律：Operation 与 agent 级 `step_runs`、`attempts` 独立表仅 **P3** 引入，P0–P2 保留 `runs.attempt` 列（database-schema §34.1–34.3）。

---

# 1. 文档目标

Agent Runtime 是 DesireGrimoire V2 的执行核心。

它负责：

```text
Agent Definition
        ↓
Runtime Instance
        ↓
Context Resolution
        ↓
Prompt Compilation
        ↓
Provider Execution
        ↓
Tool / Skill Execution
        ↓
State Update
        ↓
Resume / Retry / Continue
```

Agent Runtime 不负责直接构造最终 Prompt。

最终 Prompt 始终由：

```text
Prompt Compiler
```

负责。

Agent Runtime 的职责是：

> 决定“谁在什么时候做什么，以及它可以访问什么”。

Prompt Compiler 的职责是：

> 决定“这一轮具体给模型看什么”。

---

# 2. 核心设计原则

## 2.1 Agent ≠ Prompt

Agent 是一个 Runtime Entity：

```text
Agent
├── Instructions
├── Context Policy
├── Memory Policy
├── Tool Policy
├── Model Policy
├── Runtime State
└── Execution History
```

Prompt 只是 Agent 某一次执行的输入。

---

# 2.2 Agent ≠ Model

一个 Agent 可以：

```text
Agent
 ↓
Model Router
 ↓
GPT
```

也可以：

```text
Agent
 ↓
Model Router
 ├── Primary Model
 ├── Fallback Model
 └── Cheap Model
```

Agent 不应该把 Provider API 细节写死。

---

# 2.3 Workflow ≠ Agent

Workflow：

```text
编排多个执行步骤
```

Agent：

```text
执行一个具有目标、上下文和能力边界的智能实体
```

因此：

```text
Workflow
 ├── Agent Step
 ├── Tool Step
 ├── Condition Step
 ├── Transform Step
 ├── Human Approval Step
 └── Parallel Step
```

---

# 2.4 Agent Runtime ≠ Workflow Engine

Workflow Engine 负责：

```text
DAG
Dependencies
Conditions
Parallelism
Retry
```

Agent Runtime 负责：

```text
Agent Context
Prompt
Model Call
Tool Use
Memory
Agent State
```

两者协作：

```text
Workflow Runtime
        │
        ▼
Agent Runtime
        │
        ▼
Prompt Compiler
        │
        ▼
Provider
```

---

# 3. 总体架构

```text
                     Application Runtime
                            │
                            ▼
                    ┌───────────────┐
                    │ Agent Runtime │
                    └───────┬───────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
   Context Manager     State Manager     Permission Manager
          │                 │                 │
          └────────────┬────┴────────────┬────┘
                       ▼                 ▼
                Prompt Compiler      Tool Runtime
                       │                 │
                       ▼                 ▼
                 Provider Runtime    Skill Runtime
                       │
                       ▼
                     Model
```

Workflow：

```text
Workflow Runtime
       │
       ├── Agent Runtime
       ├── Tool Runtime
       ├── Condition Runtime
       └── Human Runtime
```

---

# 4. Runtime 对象层级

```text
Agent Definition
       │
       ▼
Agent Version
       │
       ▼
Agent Instance
       │
       ▼
Agent Run
       │
       ├── Prompt Snapshot
       ├── Generation
       ├── Tool Calls
       ├── Artifacts
       └── Events
```

其中：

```text
Agent Definition
```

是持久化资产。

```text
Agent Instance
```

是某个 Chat 中实际运行的 Agent。

```text
Agent Run
```

是一次执行。

---

# 4.1 统一执行层级：Run / Attempt / Step Run / Operation

【2026-09 收编·裁决 C5】Agent Runtime 的全部运行行为统一收敛为四层执行层级，作为 Inspector / Replay / Cost / Resume / Workflow / Group Chat / Tool Calling 的共享骨架。此模型是后续所有章节（§5–§175）的**执行核心规范**：不再各自定义互不兼容的 execution / session / task / job 模型。

```text
Run                                        “做什么”       —— 一次完整执行意图，稳定身份
  └── Attempt                               “这次怎么做”   —— 一次实际执行尝试，持有执行环境
        └── Step Run                        “哪一步实际做了一次” —— Step 的一次执行记录
              └── Operation                 “底层调用发生了什么” —— 设施级 IO / Provider / Tool 重试
```

一句话定规：

> **Run 定义“做什么”，Attempt 定义“这次怎么做”，Step Run 定义“哪个步骤实际做了一次”，Operation 定义“底层实际调用发生了什么”。Retry 不创建新 Run，而是创建新 Attempt；Step Retry 也不覆盖原 Step Run，而是创建新 Step Run；设施级 HTTP 重试归 Operation。**

| 层级 | 含义 | 是否可 Retry |
|---|---|---|
| **Run** | 一次完整执行意图 | ❌ Retry 创建 Attempt |
| **Attempt** | 一次实际执行尝试 | ❌ 历史保留 |
| **Step Run** | 一个 Step 的一次实际执行 | ❌ Retry 创建新的 Step Run |
| **Operation** | 底层 IO / Provider / Tool 操作 | 可内部 Retry |

对应实现物（`database-schema.md` §34.1–34.3）：P0–P2 仅以 `runs.attempt` 列承载 attemptNo；**P3 起升为独立 `attempts` / `step_runs` / `execution_operations` 表**。完整执行树（Inspector 的基础数据结构）：

```text
Run
└── Attempt #1
    ├── StepRun: resolve_context
    ├── StepRun: retrieve_memory
    ├── StepRun: compile_prompt
    ├── StepRun: model_call
    │     ├── Operation #1   (provider_request)
    │     └── Operation #2   (provider_request, retry)
    └── StepRun: tool_call
          └── Operation #1   (tool_request)
```

### 4.1.1 持久化不变量（覆盖三层）

与 §12 / §40 同构，扩展覆盖 Attempt 与 Step Run：

- `StepRun.attemptId` 必须指向存在的 Attempt；`Attempt.runId` 必须指向存在的 Run。
- Step Run 一旦进入终态（`succeeded / failed / cancelled / timed_out / skipped`）不可原地改写。
- Retry 一律创建新记录，禁止 `UPDATE step_runs SET status='succeeded'` 覆盖历史失败执行。
- 历史 Attempt 不可变，仅允许追加 `metadata / events / diagnostics`，不得改动其核心执行语义。

### 4.1.2 ID 与 Sequence

所有执行实体使用全局唯一 ID（`run_xxx / attempt_xxx / step_run_xxx / operation_xxx / event_xxx`，SQLite 落地为 UUIDv7），业务身份不依赖数据库自增整数；局部提供 `attemptNo / runNo / sequence` 作为同一范围内的可读序列。

---

# 4.2 各层职责与 Retry 归位（与裁决 C3 调和）

- **Provider / Tool 瞬时错误**（`NETWORK_ERROR / RATE_LIMIT / TEMPORARY / TIMEOUT`）= 同 Run 内新 Attempt（§47 左半，C3）。
- **用户点「重试」/ 从失败阶段重跑 = 新建 Run + `origin_run_id`**（§12 + C3）。这是唯一例外：**用户重试新建 Run，不新建 Attempt**，旧 Run 保持 `failed`。
- **Step 内部重试**：只新建该 Step 的 Step Run（`StepRun B#1 → failed`，`StepRun B#2 → succeeded`），不新增 Attempt。真正需要新建 Attempt 的情形仅在 §10.1–10.5（Provider / Model / Runtime Snapshot 改变、从 checkpoint 分支）。
- **设施级 HTTP / SDK 内部重试**：Runtime 不可见的归 Operation（§4.5），既不是 Agent Step Retry，也不是 Attempt Retry，三者不可相互污染。

---

# 4.3 统一 ExecutionStatus

Run / Attempt / Step Run **统一使用一套生命周期语义为基底**，再按对象定义允许子集，避免三种对象各持有完全不同的状态集合（§9 `AgentStatus` 与 §98 `InternalRunStatus` 归约到它之下）：

```ts
type ExecutionStatus =
  | 'created' | 'queued' | 'running' | 'waiting'
  | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
  | 'paused' | 'resuming' | 'skipped'
```

- **Run**：`created → queued → running → succeeded (failed / cancelled / timed_out)`，`running` 可经 `waiting / paused` 与 `resuming` 往返，但**永不从终态回到 running**（§12）。
- **Attempt / Step Run**：同一状态基底；`waiting` 表示等待 tool / child / approval / 外部事件（§116）。
- `AgentStatus`（§9）保留为 Agent Instance 的**聚合状态**（由当前 Run / Attempt 归约），与 ExecutionStatus 不合并。

---

# 4.4 Step Identity、Step Run Identity 与 Step Revision

严格区分三物，数据库 Key 只能是 `stepRunId`，**绝不能 `PRIMARY KEY(stepId)`**：

```text
stepId      = “我要执行什么”（如 model.generate）
stepRunId   = “这次实际执行记录是什么”（终态后不可变）
stepRevision= “这次执行用的是第几版 Step 定义”
```

同一 `stepId` 可产生 `succeeded failed` 等多次 `stepRun`（`sr_001 failed`、`sr_002 succeeded`）。Workflow / Agent 定义修改后，历史 Step Run 必须保留当时的 `stepRevision`（与 §163–165 版本钉住哲学一致），否则 Replay 失效：

```text
Workflow v3  Step(id=model.generate, revision=7)
历史执行      StepRun(stepId=model.generate, stepRevision=6)   ← 不得跟随其变成 7
```

---

# 4.5 Operation 层

Operation 是**基础设施级别**的执行记录，它显式把各类“重试”归位，避免把 HTTP Retry 误判为 Agent Step Retry：

```ts
interface ExecutionOperation {
  id: string
  stepRunId: string
  type: 'provider_request' | 'tool_request' | 'network_request' | 'storage' | 'plugin_call'
  attemptNo: number
  status: ExecutionStatus
  startedAt: string
  completedAt?: string
  latencyMs?: number
  error?: RuntimeError
}
```

定位约束：

- **默认不记录**，仅在 Debug / simulation / replay（§58 / §125）与排障场景开启——它记录“这台 Provider / 工具这一跳实际发生了什么”。
- 与现有两表的关系：`generations`（§51，Provider 一次**语义生成**）与 `tool_calls`（§35，一次**工具调用**）是上层事实；`execution_operations` 是它们**内部 / 底层的重试明细**，不重复记录它们本身。

---

# 4.6 Runtime Snapshot 与 Prompt Snapshot

沿用 §166 `RuntimeDependencyManifest`（compiler / agent / workflow / tool 版本 + provider / model）作为“**为什么 Runtime 这样执行**”的判据；`prompt_snapshot`（§27 / §39）是“**模型最终看到了什么**”。二者边界不变，不可合并：

- Runtime Snapshot = 一次 Attempt 固定下来的执行环境判据（Attempt 上独立持有 provider / model / randomSeed / clock / policy 版本）。
- Prompt Snapshot = 一次 Provider Request 实际发送的编译快照。
- Resume 前比对 `state_hash` 与 `dependency_manifest` 版本，不一致 → `RESUME_INCOMPATIBLE`（§55）。

---

# 5. Agent Definition

```ts
interface AgentDefinition {
  id: string
  version: number

  name: string
  description?: string

  type: AgentType

  instructions: string

  contextPolicy: ContextPolicy
  memoryPolicy: MemoryPolicy
  toolPolicy: ToolPolicy

  modelPolicy: ModelPolicy

  runtimePolicy: RuntimePolicy

  metadata?: Record<string, unknown>
}
```

---

# 6. Agent Type

```ts
type AgentType =
  | 'character'
  | 'director'
  | 'writer'
  | 'checker'
  | 'editor'
  | 'tool-agent'
  | 'custom'
```

这些只是预定义角色。

Runtime 不应针对每一种 Agent 写独立执行器。

统一：

```text
AgentDefinition
+
AgentContext
+
AgentRuntime
```

---

# 7. Agent Instance

同一个 Agent Definition 可以同时存在于多个 Chat。

```ts
interface AgentInstance {
  id: string

  agentId: string
  agentVersion: number

  chatId: string

  state: AgentState

  status: AgentStatus

  currentRunId?: string

  createdAt: string
  updatedAt: string
}
```

例如：

```text
Character Agent
    ↓
Chat A

Character Agent
    ↓
Chat B
```

它们共享 Definition：

```text
Agent v3
```

但 Runtime State 完全独立。

---

# 8. Agent State

Agent State 是 Agent 在 Chat 中积累的运行状态。

```ts
interface AgentState {
  variables: Record<string, unknown>

  goals?: GoalState[]

  workingMemory?: WorkingMemory[]

  counters?: Record<string, number>

  metadata?: Record<string, unknown>
}
```

注意：

> Agent State 不是 Prompt。

Prompt Compiler 只读取其中允许暴露给 Context 的部分。

---

# 9. Agent Status

```ts
type AgentStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

状态转换必须受 State Machine 约束。

---

# 10. Agent State Machine

```text
                    ┌─────────────┐
                    │    idle     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   queued    │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
              ┌────►│   running   │─────┐
              │     └──────┬──────┘     │
              │            │            │
              │            ▼            ▼
              │       ┌─────────┐   ┌─────────┐
              │       │ waiting │   │ failed  │
              │       └────┬────┘   └────┬────┘
              │            │             │
              │            ▼             │
              │         running          │
              │                          │
              │            retry         │
              └──────────────────────────┘

running → paused
running → completed
running → cancelled

paused → running
paused → cancelled

waiting → running
waiting → cancelled
```

---

# 11. 非法状态转换

例如：

```text
completed → running
cancelled → running
failed → completed
```

默认禁止。

如果需要重新执行：

```text
创建新的 Run
```

而不是修改旧 Run。

---

# 12. Run 是不可变执行记录

一次执行：

```text
Run #101
```

如果失败：

```text
Run #101 = failed
```

Retry：

```text
Run #102 = running
```

而不是：

```text
Run #101
failed → running
```

这样可以保持完整执行历史。

【**裁决 C3 补充**】本节描述的是**用户触发的重试**（新建 Run #102）——这是正确的一半。另一半见 §47：Provider / Tool 瞬时错误在同 Run 内以新 Attempt 重试（`runs.attempt + 1`）。两者层级不同，不矛盾。

---

# 13. Run Context

每次 Agent Run 都有自己的 Runtime Context。

```ts
interface AgentRunContext {
  runId: string

  chatId: string
  agentId: string
  agentVersion: number

  triggerMessageId?: string

  variables: RuntimeVariables

  branchId?: string

  budget: RunBudget

  cancellation: CancellationToken

  permissions: PermissionSet

  parentRunId?: string
}
```

---

# 14. Parent Run

Agent 可以由另一个 Agent 调用。

例如：

```text
Director Run #1
      │
      ├── Writer Run #2
      │
      └── Checker Run #3
```

使用：

```ts
parentRunId
```

建立执行树。

---

# 15. Run Tree

```text
Workflow Run
│
├── Director Run
│
├── Writer Run
│   ├── Tool Call
│   └── Generation
│
└── Checker Run
    └── Generation
```

这对于：

```text
Inspector
Debug
Replay
Cost Accounting
```

非常重要。

---

# 16. Agent Execution Lifecycle

一次普通 Agent Run：

```text
Trigger
  ↓
Create Run
  ↓
Resolve Agent Version
  ↓
Resolve Runtime State
  ↓
Resolve Context
  ↓
Build Agent Context
  ↓
Compile Prompt
  ↓
Create Prompt Snapshot
  ↓
Provider Request
  ↓
Model Response
  ↓
Parse Response
  ↓
Tool Decision
  ↓
Tool Execution
  ↓
State Update
  ↓
Commit Result
  ↓
Complete Run
```

---

# 17. Context Manager

Context Manager 负责：

```text
Agent
+
Chat
+
Character
+
Persona
+
Worldbook
+
Memory
+
Workflow
+
Artifacts
+
Tool Results
```

最终生成：

```ts
interface AgentContext {
  systemInstructions?: string

  selectedMemory?: MemoryRef[]

  selectedWorldbook?: string[]

  visibleMessages?: string[]

  artifacts?: ArtifactRef[]

  toolResults?: ToolResultRef[]
}
```

这个对象交给 Prompt Compiler。

---

# 18. Context Policy

Agent 不应该默认看到所有数据。

```ts
interface ContextPolicy {
  history: HistoryPolicy

  worldbook: WorldbookPolicy

  memory: MemoryContextPolicy

  summary: SummaryPolicy

  artifacts: ArtifactPolicy

  toolResults: ToolResultPolicy

  otherAgents: AgentVisibilityPolicy
}
```

---

# 19. History Policy

```ts
interface HistoryPolicy {
  enabled: boolean

  maxMessages?: number

  maxTokens?: number

  includeUser: boolean
  includeAssistant: boolean
  includeTools: boolean

  pinnedMessages?: string[]

  branchMode: 'active' | 'root' | 'custom'
}
```

Agent Runtime 负责决定：

> 哪些历史允许进入 Context。

Prompt Compiler 负责决定：

> 这些历史最终如何序列化。

---

# 20. Memory Policy

```ts
interface MemoryPolicy {
  enabled: boolean

  maxItems?: number

  maxTokens?: number

  minImportance?: number

  minConfidence?: number

  retrievalStrategy:
    | 'recent'
    | 'importance'
    | 'semantic'
    | 'hybrid'
}
```

Memory Runtime 执行检索。

Agent Runtime 接收结果。

Prompt Compiler 只负责最终布局。

---

# 21. Worldbook Policy

```ts
interface WorldbookPolicy {
  enabled: boolean

  worldbookIds: string[]

  scanDepth?: number

  allowRecursive: boolean

  maxEntries?: number

  maxTokens?: number
}
```

Worldbook Activation 由 Worldbook Runtime 执行。

---

# 22. Artifact Policy

```ts
interface ArtifactPolicy {
  enabled: boolean

  allowedTypes?: string[]

  maxItems?: number

  maxTokens?: number

  promoteFrozenArtifacts: boolean
}
```

---

# 23. Other Agent Visibility

Agent 可以看到其他 Agent 的输出，但默认不能看到其内部 Prompt 或隐藏状态。

```ts
interface AgentVisibilityPolicy {
  allowedAgents: string[]

  allowOutputs: boolean

  allowArtifacts: boolean

  allowState: boolean

  allowPromptSnapshot: boolean
}
```

默认：

```text
Agent A
  ↓
Output
  ↓
Agent B
```

而不是：

```text
Agent A
  ↓
完整内部 Context
  ↓
Agent B
```

---

# 24. Agent Context Isolation

默认情况下：

```text
Agent A
```

不能读取：

```text
Agent B
├── hidden state
├── private tool arguments
├── private Prompt
└── internal reasoning
```

除非 Permission Policy 明确允许。

---

# 25. 不保存 / 不暴露内部推理

Agent Runtime 不应要求模型提供隐藏 Chain-of-Thought。

允许保存：

```text
final answer
tool calls
tool results
structured rationale
decision metadata
```

但不依赖模型内部隐藏推理作为 Runtime 状态。

---

# 26. Prompt Compiler 调用

Agent Runtime：

```ts
const compileInput: CompileInput = {
  chat,
  character,
  persona,
  preset,
  worldbook,
  memory,
  agent: agentContext,
  workflow,
  variables,
  provider,
  budget,
  options
}
```

调用：

```ts
const result = await promptCompiler.compile(compileInput)
```

得到：

```ts
CompileResult
```

---

# 27. Prompt Snapshot 强制要求

每次真正 Provider Request：

```text
必须存在 PromptSnapshot
```

流程：

```text
Compile
 ↓
Snapshot
 ↓
Provider Request
```

禁止：

```text
Compile
 ↓
Provider
```

直接跳过 Snapshot。

原因：

```text
Debug
Replay
Cache
Billing
Regression
```

都需要 Snapshot。

---

# 28. Provider Runtime

Provider Runtime 接收：

```ts
interface ProviderRequest {
  snapshotId: string

  providerId: string
  modelId: string

  serializedPrompt: SerializedPrompt

  generationConfig: GenerationConfig

  cancellationToken: CancellationToken
}
```

Provider Runtime 不重新编译 Prompt。

---

# 29. Model Response

```ts
interface ModelResponse {
  text?: string

  toolCalls?: ToolCallRequest[]

  finishReason: FinishReason

  usage?: TokenUsage

  raw?: unknown
}
```

---

# 30. Finish Reason

```ts
type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_call'
  | 'content_filter'
  | 'error'
  | 'cancelled'
  | 'unknown'
```

---

# 31. Tool Runtime

Tool 是 Agent 能力。

```ts
interface ToolDefinition {
  id: string
  name: string

  description: string

  inputSchema: JSONSchema

  outputSchema?: JSONSchema

  permissions: Permission[]

  execute(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolResult>
}
```

---

# 32. Tool Execution Context

```ts
interface ToolExecutionContext {
  runId: string
  agentId: string
  chatId: string

  permissions: PermissionSet

  cancellationToken: CancellationToken

  budget: ToolBudget
}
```

---

# 33. Tool Permission

Tool 不能默认拥有所有权限。

例如：

```text
network.request
filesystem.read
filesystem.write
chat.read
chat.write
worldbook.read
worldbook.write
memory.read
memory.write
provider.call
```

---

# 34. Permission Check

执行 Tool 前：

```text
Tool Request
     ↓
Permission Check
     ↓
Allowed?
 ┌───┴────┐
Yes       No
 │         │
 ▼         ▼
Execute   Deny
```

拒绝必须生成：

```text
TOOL_PERMISSION_DENIED
```

而不是静默失败。

---

# 35. Tool Result

```ts
interface ToolResult {
  toolCallId: string

  status:
    | 'success'
    | 'error'
    | 'denied'
    | 'cancelled'
    | 'timeout'

  output?: unknown

  error?: ToolError

  durationMs?: number

  /**
   * 【2026-09 补，工程纪律 D1】正交结果信号。
   * 三个字段含义互不重叠，必须各自独立上报，
   * 不得把其中一个嵌套在另一个的分支里。
   */
  outcome?: ToolOutcomeSignals
}
```

```ts
interface ToolOutcomeSignals {
  /** 是否触发超时。与 exitCode 正交。 */
  timedOut: boolean

  /** 终止信号（若有）。与 timedOut 正交。 */
  signal?: string

  /**
   * 底层退出码（若有）。
   * 「超时」与「退出码 0」是可以同时成立的合法组合
   * （进程捕获信号后正常退出），
   * 因此禁止从 exitCode === 0 反推「未超时」。
   */
  exitCode?: number | null
}
```

> **为什么单列**：`status: 'timeout'` 只有一个槽位，读结果的人会把「超时但已干净退出」误读为「干净成功」。这类缺陷在生命周期/并发代码里反复出现，故把正交事实拆成独立字段，让调用方无法误判。

---

# 36. Tool Loop

Agent 可以：

```text
Model
 ↓
Tool Call
 ↓
Tool Result
 ↓
Model
 ↓
Tool Call
 ↓
Tool Result
 ↓
Final
```

因此 Agent Run 内部不是一定“一次 Model Call”。

---

# 36.1 工具执行流水线（五段）

【2026-09 补，参照 DeepSeek Harness `docs/tool-execution-pipeline.md`】

§31–§36 原文只描述「权限检查 → 执行 → 返回结果」三步。三步模型在「模型请求」与「工具结果」之间**没有任何钩子点**，后果是：产物冻结（§72，裁决 C2）、大结果裁剪、预算预扣、结果改写这些需求将来只能硬编码进 Runtime。补齐为五段：

```text
Model 输出 tool_call
     ↓
tool.call.started                 ← 执行前先落账（durable）
     ↓
① pre-execute     策略 / 预算预扣 / 参数改写 / 沙箱包装 → allow | deny | ask
     ↓
② approval        一次性授权解析（§115.1），必须在 guards 之前
     ↓
③ guards          单调守卫：只 deny 或 abstain，永不放行
     ↓
④ execute         around-dispatch：timeout / retry / metrics 包在 dispatch 外层
     ↓
⑤ post-execute    accept | block | replace | add_context
     ↓
归一化             任意环节 throw → 收敛为 status='error'（§36.2）
     ↓
finalizeContent   最后一道「只允许改内容」的不变量
     ↓
tool.call.completed               ← 冻结的权威结果（durable）
```

| 段 | 允许做什么 | 明确禁止 | 我们的既有需求挂在哪里 |
|---|---|---|---|
| ① pre-execute | 改写入参、预扣预算、包装沙箱、拒绝 | 不得修改 `toolCallId` | 预算预留（§42） |
| ② approval | 解析 one-shot 授权 | 不得改写被批准的调用体 | 人工批准（§114–115） |
| ③ guards | deny / abstain | **永不放行**；身份受保护，后续钩子不得改写 | 权限检查（§33–34）、Capability scope |
| ④ execute | 包 timeout / retry / metrics | 不得吞掉 cancellation | 超时（§46）、Tool 重试（§47–48） |
| ⑤ post-execute | accept / block / replace / add_context | 不得改 `status` 语义 | **产物冻结（§72 / 裁决 C2）**、大结果裁剪 |
| 归一化 | 快照 + 收敛为 `isError` | 不得升格为 Run 失败 | §36.2 |
| finalizeContent | 只改 `output` 内容 | 不得改 `status` / `error` | — |

> **顺序为什么重要**：approval 必须排在 guards **之前**。否则用户刚批准的那个调用，会立刻被同一个守卫再次拦下——授权等于无效。

---

# 36.2 抛错归一化（工程纪律 D2）

流水线内任意环节（pre / approval / guard / execute / post）抛出的异常，由 Tool Registry **无损快照**后收敛为：

```text
ToolResult.status = 'error'
ToolResult.error  = { code: 'TOOL_PIPELINE_ERROR', ... }
```

不得：

- 冒泡成 Run 级失败 —— Run 继续，模型看到 error 结果后可自行恢复
- 静默吞掉 —— 必须落 `tool.call.failed`

三类区分：

| 来源 | 落库结果 | 说明 |
|---|---|---|
| Tool 自身业务错误 | `status='error'` | 正常回灌给模型 |
| 流水线基础设施错误 | `status='error'`，`error.infrastructure=true` | 语义同上，额外标记便于观测 |
| Cancellation | `status='cancelled'` | **不视为失败**（§45） |

> 同理适用于 Provider 层：`ProviderRuntime` 内部可以抛异常，也可以返回错误帧，但对外只暴露一种归一化形式（`generation.failed`）。中间件与消费方自身的缺陷才允许抛。这样调用方不必猜「这个异常是 provider 的、包装层的、还是我自己的」。

---

# 36.3 并行工具的结果回灌顺序

Parallel Step（§2.3）与单 Turn 内多工具调用：

- **并发执行**：允许。按 `ToolDefinition.executionMode` 分类，使用有界滚动池。
- **结果回灌**：**必须按模型请求顺序（model order），不得按完成顺序。**

理由：

1. 完成顺序不确定 → 每次重放组装出的 prompt 不同 → 缓存前缀必然失效（§105–106）
2. §174 必测场景「确定性 Replay」要求同输入同输出

实现：并发执行，但按 model order 排队进入 post-execute 并落 `tool.call.completed`。前一个结果未就绪时，后续结果在 barrier 处等待。

```ts
type ToolExecutionMode =
  | 'sync'       // 串行，独占
  | 'parallel'   // 可与其他 parallel 工具并发
  | 'exclusive'  // 执行期间不允许任何其他工具运行（barrier）
```

每次启动前**重新分类** `executionMode`：工具可以因上下文变化而在同一 Turn 内从 `parallel` 变为 `exclusive`。

---

# 37. Agent Turn

定义：

```ts
interface AgentTurn {
  index: number

  promptSnapshotId: string

  generationId: string

  toolCalls: string[]

  result?: string
}
```

一次 Run 可以包含多个 Turn。

---

# 37.1 Turn 开合规则与空 Turn 记账

【2026-09 补，参照 DeepSeek Harness `docs/agent-lifecycle.md`】

原文只给了 Turn 的数据结构，没给开合规则。补三条：

**一、开合判据**

```text
Turn 开启：在它的第一份输入被认领（claim）之前开启
Turn 关闭：不再欠任何东西时关闭
           —— 没有待执行的工具调用
           —— 没有待回灌的工具结果
           —— 没有待认领的 next-step 输入
```

**二、空 Turn 必须记账**

被拒绝的、或首份输入被改写为空的 Turn，**仍然要开一条 Turn 记录并正常关闭**，只是 `toolCalls` 为空、不消耗任何 Step。

理由：否则「用户发了消息但 Agent 拒绝执行 / 输入被过滤掉」这一类事件在审计上完全消失。长 RP 里这类痕迹往往正是要追查的东西（例如 worldbook 屏蔽、权限拦截、注入过滤）。

```ts
interface AgentTurn {
  // ... 原有字段

  /** 【2026-09 补】本次 Turn 实际消耗的 Step 数，空 Turn 为 0 */
  stepCount: number

  /** 【2026-09 补】Turn 关闭原因 */
  endReason:
    | 'completed'     // 正常产出
    | 'rejected'      // pre-step 拒绝
    | 'empty_input'    // 首份输入被改写为空
    | 'cancelled'
    | 'budget_exceeded'
    | 'context_overflow'   // 见 §49.1
}
```

**三、Turn 与 Attempt 的关系**

- 一个 Turn 内部可以有多次 Attempt（网络抖动重试、§49.1 的溢出降级重试）。
- 一次 Attempt 失败**不关闭** Turn；Turn 在「不再欠任何东西」时才关闭。
- 因此「Turn 数」不等于「模型调用数」，`maxTurns`（§38）限制的是 Turn，不是 Step。

---

# 38. Tool Loop Limit

必须限制：

```ts
interface RuntimePolicy {
  maxTurns: number
  maxToolCalls: number
  maxExecutionTimeMs: number
}
```

例如：

```text
maxTurns = 8
maxToolCalls = 20
```

超过限制：

```text
RUN_BUDGET_EXCEEDED
```

---

# 39. Budget System

Agent Runtime 必须有自己的 Budget。

```ts
interface RunBudget {
  maxTurns: number

  maxToolCalls: number

  maxInputTokens?: number

  maxOutputTokens?: number

  maxTotalTokens?: number

  maxCost?: number

  maxExecutionTimeMs?: number
}
```

【2026-09 收编注】`RunBudget` 与 §38 的 `RuntimePolicy` 都定义了 `maxTurns / maxToolCalls`，二者关系为：**`RuntimePolicy` 是 AgentDefinition 上的默认值，`RunBudget` 是本次 Run 的生效值**（可由 `AgentRunInput.budget` 覆盖）。实现时以 RunBudget 为唯一执行判据，避免两处判定不一致。

Prompt Compiler 的 Context Budget 与 Agent Runtime Budget 不同。

---

# 40. 两层 Budget

```text
Agent Runtime Budget
        │
        ▼
Prompt Compiler Budget
        │
        ▼
Provider Generation Budget
```

例如：

```text
Run 总预算：$0.10

Prompt Context：100k tokens

Output：4k tokens

Tool Calls：10
```

---

# 41. Budget 消耗

每次执行更新：

```ts
interface BudgetUsage {
  turns: number

  toolCalls: number

  inputTokens: number

  outputTokens: number

  cachedTokens: number

  cost?: number

  executionTimeMs: number
}
```

---

# 42. Budget Reservation

并发执行前可以预留 Budget。

例如：

```text
remaining = $0.05
```

不能同时启动：

```text
Agent A estimated = $0.04
Agent B estimated = $0.04
```

导致最终超支。

因此：

```text
reserve
 ↓
execute
 ↓
settle
```

---

# 43. Cancellation

所有 Runtime 操作必须支持 CancellationToken。

```ts
interface CancellationToken {
  isCancelled(): boolean

  reason?: string

  onCancel(callback: () => void): void
}
```

---

# 44. Cancellation Propagation

```text
Workflow Run
     │
     ▼
Agent Run
     │
     ├── Provider Request
     │
     ├── Tool Call A
     │
     └── Tool Call B
```

取消 Workflow：

```text
Workflow
 ↓
Agent
 ↓
Provider
 ↓
Tool
```

全部收到 Cancellation。

---

# 45. Cancellation 不等于 Failure

必须区分：

```text
cancelled
failed
timeout
```

例如：

```text
用户主动停止
```

应该：

```text
status = cancelled
```

而不是：

```text
status = failed
```

---

# 46. Timeout

Runtime 至少支持：

```text
Run Timeout
Turn Timeout
Tool Timeout
Provider Timeout
```

例如：

```ts
interface TimeoutPolicy {
  runMs?: number
  turnMs?: number
  toolMs?: number
  providerMs?: number
}
```

---

# 47. Retry

Retry 必须建立新 Attempt。

```text
Run #10
Attempt 1 → failed

Run #10
Attempt 2 → running
```

数据库：

```text
workflow_step_runs.attempt      ← Workflow 步骤级重试
runs.attempt                    ← 补：Agent Run 级重试（2026-09，database-schema V2.2）
```

记录 Attempt。

【**裁决 C3**，2026-09 收编时补】本节与 §12 原文冲突（§12 说"Retry = 新建 Run #102"），最终口径为**双层**：

```text
Provider / Tool 瞬时错误（NETWORK_ERROR / RATE_LIMIT / TEMPORARY / TIMEOUT）
        → 同 Run 内 attempt + 1（Run 本体不变）

用户点「重试」/ 从失败阶段重跑
        → 新建 Run，origin_run_id 指向原 Run（旧 Run 保持 failed）
```

不重试的错误：`PERMISSION_DENIED / INVALID_INPUT / UNSUPPORTED_PROVIDER / USER_CANCELLED`（§49）。

---

# 47.1 Attempt 不进模型历史（强化裁决 C3）

【2026-09 补，参照 DeepSeek Harness `docs/agent-lifecycle.md`】

C3 定了「什么算一次 Retry」，本节定「Retry 的中间产物去哪」：

```text
assistant/message   成功落地的那次模型输出   → 进 derived model history
attempt 记录        failed / retried / cancelled / stream-error 的中间流
                                            → 留痕，但不进 derived model history
```

规则：

- Attempt 级重试产生的中间输出**必须留痕**（写入 `runs.attempt` 对应的执行记录 + 事件流），否则事后无法审计「为什么最终答案是这个」。
- 但这些中间输出**不得进入 History Policy（§19）推导出的模型历史**。否则一次网络抖动就会把半截内容永久灌进上下文，且缓存前缀直接断裂。
- 只有 `status` 达成终态 `completed` 的那次输出才是 `assistant/message`。

> 与 C3 的关系：C3 区分「Attempt 重试」与「新 Run」，本节进一步规定 Attempt 重试的可见性边界。两者互补，不冲突。

---

# 48. Retry Policy

```ts
interface RetryPolicy {
  maxAttempts: number

  strategy:
    | 'none'
    | 'immediate'
    | 'fixed'
    | 'exponential'

  baseDelayMs?: number

  maxDelayMs?: number

  retryableErrors: string[]
}
```

---

# 49. 不应 Retry 的错误

例如：

```text
PERMISSION_DENIED
INVALID_INPUT
UNSUPPORTED_PROVIDER
USER_CANCELLED
```

默认不 Retry。

可以 Retry：

```text
NETWORK_ERROR
RATE_LIMIT
TEMPORARY_PROVIDER_ERROR
TIMEOUT
```

具体由 Provider / Tool 定义。

---

# 49.1 上下文溢出的反循环规则

【2026-09 补，参照 DeepSeek Harness `docs/subsystems/compaction.md`】

`PROMPT_CONTEXT_TOO_LARGE`（compiler spec 诊断码）属于**可重试但有前提**的错误，不能简单归入上面任何一类。

问题：如果溢出后直接重试，而重发的输入与失败那次**逐字相同**，就会对同一个注定失败的 prompt 反复重试，直到预算耗尽。

规则：

```text
捕获 PROMPT_CONTEXT_TOO_LARGE
     ↓
执行降级：工具结果裁剪 → 摘要压缩 → 丢弃低优先级段
     ↓
重算待发内容的生成号（replacement generation）
     ↓
生成号是否前进？
 ┌───┴────┐
Yes        No
 │          │
 ▼          ▼
允许重试    原错误保持权威，不再重试
一次        直接以 RUN_CONTEXT_OVERFLOW 结束
```

- **生成号前进** = 裁剪或摘要确实改变了将要发出的内容（哪怕只改了一个 token）。这是允许重试的唯一依据。
- **生成号未前进** = 裁剪无效果（例如溢出的是一个不可分割的单段）。此时原错误保持权威，不再重试，避免死循环。
- 即使摘要生成过程在裁剪之后抛错，只要裁剪已经让生成号前进，重试仍然有效——判据只看生成号，不看后续步骤成败。
- **Cancellation 优先于以上一切**：用户取消时立即结束，不走降级。

> 对照 §47.1：本节的「重试」同样只能产出 attempt 级记录，不得把降级过程中的中间 prompt 灌进模型历史。

---

# 50. Idempotency

Tool Runtime 必须区分：

```text
read-only
idempotent
non-idempotent
```

例如：

```text
读取 Worldbook
```

可以安全 Retry。

而：

```text
发送外部请求
创建文件
```

可能不能自动 Retry。

Tool Definition 应声明：

```ts
type SideEffectLevel =
  | 'none'
  | 'idempotent'
  | 'non_idempotent'
```

---

# 51. Resume

Resume 是 V2 Agent Runtime 的一级能力。

如果：

```text
Run
 ↓
paused
```

之后可以：

```text
resume(runId)
```

继续。

---

# 52. Resume 的核心原则

不能简单：

```text
重新执行整个 Agent
```

必须从最近安全 Checkpoint 恢复。

例如：

```text
Turn 1 ✓
Turn 2 ✓
Tool A ✓
Turn 3 ✓
Tool B paused
```

Resume：

```text
Tool B
 ↓
继续
```

而不是重新：

```text
Turn 1
Turn 2
Tool A
Turn 3
```

---

# 53. Runtime Checkpoint

```ts
interface RuntimeCheckpoint {
  id: string

  runId: string

  turnIndex: number

  stateHash: string

  agentState: unknown

  variables: Record<string, unknown>

  toolState: unknown

  contextState: unknown

  promptSnapshotId?: string

  createdAt: string
}
```

---

# 54. Checkpoint 类型

```ts
type CheckpointReason =
  | 'before_provider'
  | 'after_provider'
  | 'before_tool'
  | 'after_tool'
  | 'before_pause'
  | 'manual'
  | 'automatic'
```

---

# 55. Resume 安全性

Resume 前检查：

```text
Compiler Version
Agent Version
Workflow Version
Tool Version
Provider Model
Runtime State
```

如果发生不兼容：

```text
RESUME_INCOMPATIBLE
```

默认不强行恢复。

用户可以选择：

```text
restart
migrate
force_resume
```

---

# 56. Deterministic Replay

Replay 和 Resume 不完全相同。

Resume：

```text
继续原来的执行
```

Replay：

```text
重新执行历史执行
```

Replay 必须冻结：

```text
time
random seed
runtime variables
worldbook state
memory state
branch state
agent version
workflow version
compiler version
```

---

# 57. Replay 模式

```ts
type RuntimeMode =
  | 'live'
  | 'simulation'
  | 'replay'
```

---

# 58. Simulation

Simulation：

```text
不调用真实 Provider
```

可以使用：

```text
Mock Provider
Recorded Generation
Synthetic Tool
Fake Time
Fake Random
```

用途：

```text
Workflow Debug
Prompt Debug
Cache Simulator
Regression Test
```

---

# 59. Event Bus

【**裁决 C4**】下列事件名中的自造域名已作废，一律以总设计 §5.4 的权威清单为准：`agent.run.created/started/...`、`agent.turn.started/completed`、`tool.call.started/completed/failed/denied`、`prompt.compiled` / `prompt.snapshot.created`、`generation.*`、`message.created`、`workflow.stage_started`、`approval.requested/granted/rejected`、`usage.recorded`。

Agent Runtime 所有关键状态变化都发布 Event。

例如：

```text
agent.run.created
agent.run.started
agent.run.paused
agent.run.resumed
agent.run.completed
agent.run.failed
agent.run.cancelled

agent.turn.started
agent.turn.completed

tool.call.started
tool.call.completed
tool.call.failed

prompt.compiled
prompt.snapshot.created

generation.started
generation.completed
generation.failed
```

---

# 60. Event Envelope

```ts
interface RuntimeEvent {
  id: string

  type: string

  timestamp: string

  runId?: string

  chatId?: string

  agentId?: string

  parentEventId?: string

  payload: Record<string, unknown>
}
```

---

# 61. Event 与数据库

Event Bus 本身可以是：

```text
in-memory
```

但重要 Event 应异步写入：

```text
events
```

数据库。

不要让：

```text
Telemetry
```

成为 Agent Runtime 的同步硬依赖。

---

# 62. Workflow Runtime

Workflow 定义：

```ts
interface WorkflowDefinition {
  id: string
  version: number

  nodes: WorkflowNode[]
  edges: WorkflowEdge[]

  variables?: WorkflowVariable[]
}
```

---

# 63. Workflow Node

```ts
type WorkflowNode =
  | AgentNode
  | ToolNode
  | ConditionNode
  | TransformNode
  | ApprovalNode
  | ParallelNode
```

---

# 64. Agent Node

```ts
interface AgentNode {
  id: string

  type: 'agent'

  agentId: string
  agentVersion?: number

  inputMapping?: Record<string, unknown>

  outputMapping?: Record<string, unknown>

  retryPolicy?: RetryPolicy

  timeoutPolicy?: TimeoutPolicy
}
```

---

# 65. Tool Node

```ts
interface ToolNode {
  id: string

  type: 'tool'

  toolId: string

  inputMapping: Record<string, unknown>

  outputMapping?: Record<string, unknown>
}
```

---

# 66. Condition Node

```ts
interface ConditionNode {
  id: string

  type: 'condition'

  expression: ConditionExpression

  branches: {
    condition: string
    nextNode: string
  }[]
}
```

禁止执行任意 JavaScript。

Expression 必须使用受限制的 DSL。

---

# 67. Workflow Edge

```ts
interface WorkflowEdge {
  from: string
  to: string

  condition?: string

  priority?: number
}
```

---

# 68. Parallel Execution

例如：

```text
        Director
           │
     ┌─────┴─────┐
     ▼           ▼
  Writer A    Writer B
     │           │
     └─────┬─────┘
           ▼
         Editor
```

A/B 可以并行。

Runtime 必须提供：

```text
join
timeout
partial result
failure policy
```

---

# 69. Parallel Failure Policy

```ts
type ParallelFailurePolicy =
  | 'fail_fast'
  | 'wait_all'
  | 'best_effort'
```

---

# 70. Agent-to-Agent Communication

Agent 不应该直接操作另一个 Agent 的内部状态。

通过：

```text
Artifact
Message
Event
Workflow Output
```

通信。

例如：

```text
Writer
 ↓
Artifact: draft
 ↓
Checker
 ↓
Artifact: review
 ↓
Editor
```

---

# 71. Artifact 是 Agent Runtime 的主要中间数据结构

Artifact：

```ts
interface Artifact {
  id: string

  type: string

  name?: string

  content?: string

  data?: unknown

  contentHash?: string

  sourceRunId?: string

  createdAt: string
}
```

Artifact 可以：

```text
引用
复制
冻结
传递
删除
```

---

# 72. Frozen Artifact

如果 Artifact 被标记：

```text
frozen = true
```

表示其内容不会继续变化。

【**裁决 C2**，2026-09 收编时修正原文】原文"Prompt Compiler 可以把它提升到更稳定的 Context Zone"**已否决**。冻结产物一律留在 `injection` / `tail`，理由与 prompt-compiler-spec §83（@D 不能进稳定前缀）同构：在稳定前缀中部或尾部插入内容会使其后全部字节位移，等于一次未声明的 Cache Break。

`frozen = true` 只带来两个效果：①Compiler 可以安全地以 `ArtifactRef` 引用而非复制全文；②Inspector 可标注"此产物可复用"。需要长期稳定的内容应建模为 header / stableWB 槽位，而不是把运行时产物提升进去。

否则：

```text
working artifact
```

默认进入：

```text
tail
```

---

# 73. Agent Output

Agent Run 最终输出：

```ts
interface AgentOutput {
  text?: string

  artifacts?: string[]

  toolResults?: string[]

  structured?: unknown
}
```

---

# 74. Output Commit

Agent 输出不是自动变成 Chat Message。

需要：

```text
Agent Output
     ↓
Output Policy
     ↓
Commit
     ↓
Message
```

例如 Checker Agent：

```text
Output
 ↓
Artifact
```

而 Character Agent：

```text
Output
 ↓
Assistant Message
```

---

# 75. Output Policy

```ts
interface OutputPolicy {
  mode:
    | 'message'
    | 'artifact'
    | 'silent'
    | 'custom'

  role?: 'assistant' | 'user' | 'tool'

  authorId?: string
}
```

---

# 76. Group Chat

Group Chat 不应该是特殊 Prompt Template。

推荐模型：

```text
Group Chat
│
├── Character Agent A
├── Character Agent B
├── Character Agent C
│
└── Director Agent
```

Director 决定：

```text
下一位 Agent
```

---

# 77. Group Chat Runtime

```text
User
 ↓
Director
 ↓
Select Character Agent
 ↓
Character Agent
 ↓
Message
 ↓
Director
 ↓
Select next Agent
```

因此 Group Chat 本质上是：

```text
Agent Runtime + Workflow Runtime
```

---

# 78. Single Chat

单角色聊天也统一成：

```text
Character Agent
```

而不是创建另一套 Chat Engine。

因此：

```text
Single Chat
=
Workflow with one Agent
```

【**裁决 C1**，2026-09 收编时补】统一抽象成立（单聊不再另建 Chat Engine），但**实现上这条等式不得引入额外模型调用**：快速路径下该 Workflow 只有一个 Agent 节点，Director 不参与、不做路径决策。Director 只在群聊与显式开启完整工作流时介入（总设计 §23.2 恢复快速路径为默认，正是为纠正"每条消息 3–5 次调用"的草案）。

---

# 79. Character Agent

Character Agent 通常：

```text
instructions
+
character
+
persona
+
worldbook
+
memory
+
history
```

最终：

```text
Prompt Compiler
```

---

# 80. Director Agent

Director 通常不直接生成最终用户可见内容。

它输出：

```json
{
  "nextAgent": "character_b",
  "reason": "..."
}
```

Runtime 根据结构化输出：

```text
validate
 ↓
permission
 ↓
dispatch
```

而不是解析自然语言：

```text
“我觉得接下来应该让B说话”
```

---

# 81. Structured Output

需要结构化输出的 Agent：

```ts
interface StructuredOutputPolicy {
  schema: JSONSchema

  strict: boolean

  repairAttempts: number
}
```

模型输出：

```text
JSON
```

Runtime：

```text
validate
 ↓
accept / repair / fail
```

---

# 82. Structured Output Repair

允许：

```text
Generation
 ↓
Schema Validation
 ↓
Invalid
 ↓
Repair Agent / Retry
```

但必须受：

```text
repairAttempts
budget
```

限制。

---

# 83. Agent Memory 写入

Agent 可以提出 Memory Candidate：

```ts
interface MemoryCandidate {
  content: string

  type: string

  importance: number

  confidence: number

  sourceMessageIds: string[]
}
```

但不能默认直接写入长期 Memory。

推荐：

```text
Agent
 ↓
Memory Candidate
 ↓
Memory Policy
 ↓
Validation
 ↓
Memory Store
```

---

# 84. Worldbook 写入

同样：

```text
Agent
 ↓
Worldbook Mutation Proposal
 ↓
Permission
 ↓
Validation
 ↓
Commit
```

不能允许模型直接：

```text
UPDATE worldbook_entries
```

---

# 85. Agent Mutation API

Runtime 提供受控接口：

```ts
interface AgentMutationAPI {
  proposeMemory(input: MemoryCandidate): Promise<MutationResult>

  proposeWorldbookChange(
    input: WorldbookMutation
  ): Promise<MutationResult>

  createArtifact(
    input: ArtifactInput
  ): Promise<Artifact>

  createMessage(
    input: MessageInput
  ): Promise<Message>
}
```

---

# 86. Permission Model

Permission 至少分：

```text
chat.read
chat.write

message.read
message.write

worldbook.read
worldbook.write

memory.read
memory.write

artifact.read
artifact.write

tool.execute

network.request

filesystem.read
filesystem.write

provider.call

agent.invoke
workflow.invoke
```

---

# 87. Permission Scope

权限不是只有：

```text
allowed / denied
```

还需要 Scope。

例如：

```json
{
  "permission": "worldbook.read",
  "scope": {
    "worldbookIds": ["book-1"]
  }
}
```

Agent A：

```text
可以读 Worldbook A
```

但不能：

```text
读 Worldbook B
```

---

# 88. Secret Isolation

Agent Runtime 不允许模型直接访问：

```text
API Keys
OAuth Tokens
Database Credentials
```

Provider Runtime / Tool Runtime 负责 Secret Injection。

---

# 89. Tool Sandboxing

不可信 Tool 应运行在：

```text
sandbox
```

中。

至少限制：

```text
filesystem
network
process
environment
```

---

# 90. Concurrency

多个 Agent 可以同时运行：

```text
Agent A
Agent B
Agent C
```

但同一个 Chat 默认需要：

```text
Chat Write Lock
```

避免：

```text
A 写 Message
B 同时写 Message
```

导致：

```text
sequence
branch
runtime state
```

冲突。

---

# 91. Read Parallelism

读取 Context 可以并行：

```text
Character
Worldbook
Memory
Summary
```

例如：

```text
          Context Resolver
          /      |      \
         /       |       \
 Character    Worldbook   Memory
         \       |       /
          \      |      /
             Merge
```

---

# 92. Write Serialization

状态写入需要串行：

```text
Worldbook State
Memory
Chat Message
Agent State
```

避免竞争条件。

---

# 93. Runtime Scheduler

推荐建立 Scheduler：

```ts
interface RuntimeScheduler {
  enqueue(run: RunRequest): Promise<string>

  cancel(runId: string): Promise<void>

  pause(runId: string): Promise<void>

  resume(runId: string): Promise<void>
}
```

---

# 94. Scheduler Queue

Queue 支持：

```text
priority
fairness
concurrency
cancellation
timeout
```

例如：

```ts
interface QueuePolicy {
  maxConcurrentRuns: number

  maxConcurrentPerChat: number

  priorityMode:
    | 'fifo'
    | 'priority'
}
```

---

# 95. Chat-level Serialization

默认：

```text
maxConcurrentPerChat = 1
```

这样可以保证：

```text
Message sequence
Branch
Worldbook runtime
Cache state
```

稳定。

未来可以针对只读 Agent 开放并发。

---

# 96. Run Recovery

应用崩溃时：

```text
Run = running
```

重启后不能直接认为成功。

Scheduler 执行：

```text
running
 ↓
recovery scan
 ↓
unknown / interrupted
```

然后根据 Provider / Tool 状态决定：

```text
resume
retry
fail
```

---

# 97. Zombie Run

禁止永久存在：

```text
running
```

需要：

```text
heartbeat
```

例如：

```ts
lastHeartbeatAt
```

超过：

```text
recoveryTimeout
```

标记：

```text
interrupted
```

---

# 98. Run Status 扩展

建议内部支持：

```ts
type InternalRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

---

# 99. Error Model

统一错误：

```ts
interface RuntimeError {
  code: string

  message: string

  retryable: boolean

  category:
    | 'runtime'
    | 'provider'
    | 'tool'
    | 'permission'
    | 'validation'
    | 'budget'
    | 'timeout'
    | 'cancelled'

  details?: Record<string, unknown>
}
```

---

# 100. 核心错误码

```text
AGENT_NOT_FOUND
AGENT_VERSION_NOT_FOUND

CONTEXT_RESOLUTION_FAILED

PROMPT_COMPILE_FAILED
PROMPT_SNAPSHOT_FAILED

PROVIDER_UNAVAILABLE
PROVIDER_TIMEOUT
PROVIDER_RATE_LIMIT

TOOL_NOT_FOUND
TOOL_INVALID_INPUT
TOOL_PERMISSION_DENIED
TOOL_TIMEOUT
TOOL_FAILED

RUN_BUDGET_EXCEEDED
RUN_TIMEOUT

RUN_CANCELLED
RUN_PAUSED

RESUME_INCOMPATIBLE
RUN_RECOVERY_FAILED

WORKFLOW_INVALID
WORKFLOW_CYCLE_DETECTED

STRUCTURED_OUTPUT_INVALID
```

---

# 101. Agent Runtime API

核心接口：

```ts
interface AgentRuntime {
  start(input: AgentRunInput): Promise<Run>

  pause(runId: string): Promise<void>

  resume(runId: string): Promise<Run>

  cancel(runId: string): Promise<void>

  retry(runId: string): Promise<Run>

  getRun(runId: string): Promise<Run>

  getRunTree(runId: string): Promise<RunTree>

  getState(agentId: string, chatId: string): Promise<AgentState>
}
```

---

# 102. AgentRunInput

```ts
interface AgentRunInput {
  agentId: string

  chatId: string

  triggerMessageId?: string

  parentRunId?: string

  workflowRunId?: string

  variables?: Record<string, unknown>

  mode?: RuntimeMode

  budget?: Partial<RunBudget>
}
```

---

# 103. Execution Loop

核心伪代码：

```ts
async function executeRun(run: Run) {
  createCheckpoint(run, 'automatic')

  while (!isFinished(run)) {
    assertNotCancelled(run)
    assertBudget(run)

    const context = await contextManager.resolve(run)

    const compiled = await promptCompiler.compile(context)

    const snapshot = await snapshotStore.create(compiled)

    const generation = await provider.generate(
      snapshot,
      run.cancellationToken
    )

    recordGeneration(generation)

    if (generation.toolCalls?.length) {
      for (const call of generation.toolCalls) {
        await executeTool(call, run)
      }

      createCheckpoint(run, 'after_tool')

      continue
    }

    const output = parseAgentOutput(generation)

    await commitOutput(output, run)

    createCheckpoint(run, 'after_provider')

    finishRun(run)
  }
}
```

实际实现必须加入：

```text
transaction
retry
timeout
permission
budget
event
recovery
```

---

# 104. Prompt Recompile After Tool

Tool 执行后：

```text
Tool Result
 ↓
Context Update
 ↓
Prompt Recompile
```

不能简单复用上一轮完整 Prompt。

但是可以通过：

```text
Incremental Compilation
```

复用：

```text
Character
Preset
Stable Worldbook
Frozen Summary
```

---

# 105. Cache Interaction

Agent Runtime 不直接决定 Cache Placement。

它只提供：

```text
context stability
runtime changes
```

Prompt Compiler 决定：

```text
stable prefix
fresh zone
volatile zone
```

---

# 106. Cache Break Event

如果 Tool 改变了 Worldbook：

```text
Tool
 ↓
Worldbook Mutation
 ↓
Runtime State Change
 ↓
Cache Invalidation Event
```

下一次 Compile：

```text
CachePlan
```

重新计算。

---

# 107. Agent State Mutation

Agent State 更新必须是显式事务：

```text
Run Output
 ↓
State Mutation
 ↓
Validate
 ↓
Commit
```

禁止：

```text
模型输出
 ↓
直接覆盖 agent_runtime_states.state
```

---

# 108. State Patch

推荐：

```ts
interface StatePatch {
  path: string

  operation:
    | 'set'
    | 'delete'
    | 'increment'
    | 'append'
    | 'remove'

  value?: unknown
}
```

例如：

```json
{
  "path": "counters.chapter",
  "operation": "increment",
  "value": 1
}
```

---

# 109. State Conflict

并发更新：

```text
State v10
```

Agent A：

```text
v10 → v11
```

Agent B：

```text
v10 → v11
```

第二个必须检测：

```text
VERSION_CONFLICT
```

然后：

```text
reload
merge
retry
```

而不是覆盖。

---

# 110. Workflow Resume

Workflow Resume：

```text
Workflow Run
 ↓
Find last completed node
 ↓
Restore variables
 ↓
Restore completed outputs
 ↓
Find next executable node
 ↓
Continue
```

已经完成的 Node 默认不重新执行。

---

# 111. Workflow Failure

例如：

```text
A ✓
B ✓
C ✗
D waiting
```

Resume：

```text
C retry
 ↓
D
```

而不是：

```text
A
B
C
D
```

重新全部执行。

---

# 112. Workflow Cycle

Workflow DAG 理论上不允许无限循环。

但是 Agent Workflow 有时需要：

```text
Writer
 ↓
Checker
 ↓
Editor
 ↓
Writer
```

因此系统需要显式允许：

```text
bounded loop
```

而不是允许任意无限循环。

---

# 113. Loop Policy

```ts
interface LoopPolicy {
  maxIterations: number

  maxTotalRuns: number

  maxExecutionTimeMs: number
}
```

例如：

```text
Writer → Checker → Editor → Writer
```

最多：

```text
3 iterations
```

---

# 114. Human Approval

某些 Tool / Workflow 节点需要用户批准。

```text
Agent
 ↓
Dangerous Action
 ↓
Approval Required
 ↓
waiting
 ↓
User Approves
 ↓
running
```

---

# 115. Approval Request

```ts
interface ApprovalRequest {
  id: string

  runId: string

  action: string

  description: string

  risk: 'low' | 'medium' | 'high'

  requestedPermissions: Permission[]

  expiresAt?: string

  /**
   * 【2026-09 补】发起方给出的「为什么问」的人类可读理由。
   * 刻意不携带工具入参 —— 入参已经随 tool.call.started 流式下发给 UI，
   * 在这里复制一份会产生两份可能漂移的副本。
   */
  reason?: string

  /** 【2026-09 补】关联到已呈现的那次工具调用，供 UI 挂卡片。 */
  toolCallId?: string
}
```

---

# 115.1 Approval Outcome（四值 + fail-closed）

【2026-09 补，参照 DeepSeek Harness `docs/subsystems/approval.md`】

批准结果是一个**封闭枚举**，且**默认拒绝**：

```ts
type ApprovalOutcome =
  | 'allowed_once'   // 一次性放行，且只放行被问到的那一个动作
  | 'rejected'       // 明确拒绝
  | 'cancelled'      // 请求被撤回（Run 取消 / 超时 / 发起方放弃）
  | 'unavailable'    // 没有可用回答者
```

调用方只在 `allowed_once` 时放行。其余三值一律拒绝。

`unavailable` 的触发条件（**fail-closed**）：

| 情况 | 结果 |
|---|---|
| 没有注册任何回答者（headless / 后台 workflow / 无 UI） | `unavailable` |
| 回答者不属于该 Run 所属的 chat | `unavailable` |
| 回答者抛异常 | `unavailable` |
| 回答者返回枚举外的值 | 归一化为 `unavailable` |
| 审计事件落库失败 | 直接拒绝 —— 不允许返回一个没记进日志的决定 |

> **为什么必须默认拒绝**：后台 workflow、定时任务、群聊自动跑批这些场景**根本没有 UI 回答者**。如果默认放行，等于所有危险操作在无人值守时自动通过；如果默认挂起，Run 会永久卡在 `waiting`。唯一安全的语义是拒绝并记一笔。

**per-chat 策略**：

```ts
type ApprovalPolicy =
  | 'ask'     // 默认值，派发给回答者链
  | 'never'   // 不派发任何回答者，所有请求确定性返回 'rejected'
```

- `never` 适用于 CI、无人值守跑批，以及「结果无需询问即可预知」的场景。
- `never` 必须在派发**之前**生效，后注册的回答者无法绕过它。
- 策略变更本身要写入事件日志，Replay 才能还原当时的有效策略。

**审计要求**：

- `approval.requested` 与 `approval.decided` **成对**落库（durable），由 `approvalId` 关联。
- 这一对事件是 **log-only**：**不进模型转录**。模型可见的只是调用方推导出的工具结果，以及当前的运行时上下文快照。
- 未配对的 `approval.requested`（有问无答）是异常，崩溃恢复时必须能被检测出来。

---

# 116. Waiting State

Agent Runtime 必须支持长期等待。

例如：

```text
waiting_for_user
waiting_for_tool
waiting_for_approval
waiting_for_external_event
```

因此：

```text
waiting
```

不能依赖内存中的 Promise。

必须持久化。

---

# 117. Wakeup Event

```text
waiting
 ↓
Event
 ↓
Scheduler
 ↓
resume
```

例如：

```text
approval.granted
tool.completed
user.message.created
external.event.received
```

---

# 118. Runtime Event Trigger

【**裁决 C4**（2026-09 扩充）】§117 / §118 示例中的自造名全部作废，正确名以总设计 §5.4 权威清单为准：

| 自造名 | 正确名 |
|---|---|
| `chat.message.created` / `user.message.created` | `message.created` |
| `tool.completed` | `tool.call.completed` |
| `approval.granted` / `approval.rejected` | `approval.decided`（结论由 payload 的 `outcome` 承载，四值见 §115.1） |
| `agent.completed` | `agent.run.completed` |
| `external.event.received` | 外部事件不走 Event Bus 域名；由 Runtime 内部转译为标准事件后再发布 |

Workflow 可以订阅：

```text
message.created
tool.call.completed
approval.decided
agent.run.completed
```

> 事件订阅要同时留意 §5.4 的**持久化分档**：`live` 档事件（`generation.delta`、`prompt.compiling`）只做内存广播、不落 `events` 表，**Workflow 不得依赖 live 事件做跨重启的触发**——进程重启后它们不存在。跨重启触发只能挂 `durable` 档。

但事件触发必须防止：

```text
无限递归触发
```

需要：

```text
event depth
run origin
deduplication key
```

---

# 119. Idempotent Event Handling

事件处理器需要：

```ts
eventId
```

去重。

如果：

```text
event #100
```

重复到达：

```text
第一次 → execute
第二次 → ignore
```

---

# 120. Observability

Runtime 至少提供：

```text
Run Timeline
Step Timeline
Prompt Timeline
Tool Timeline
Token Timeline
Cost Timeline
Cache Timeline
```

---

# 121. Run Timeline

例如：

```text
19:01:01 Run Started
19:01:02 Context Resolved
19:01:02 Prompt Compiled
19:01:02 Snapshot Created
19:01:03 Generation Started
19:01:08 Generation Completed
19:01:08 Tool Call Started
19:01:09 Tool Completed
19:01:09 Prompt Recompiled
19:01:15 Generation Completed
19:01:15 Run Completed
```

---

# 122. Cost Tracking

每个 Run 汇总：

```ts
interface RunCost {
  inputTokens: number
  outputTokens: number
  cachedTokens: number

  providerCost?: number

  toolCost?: number

  totalCost?: number
}
```

Workflow：

```text
Workflow Cost
    =
sum(Agent Cost)
+
sum(Tool Cost)
```

---

# 123. Prompt Inspector

Inspector 应从：

```text
Run
```

进入：

```text
Prompt Snapshot
```

然后展示：

```text
Segment
Source
Placement
Cache Zone
Token Count
Stability
Dependencies
```

---

# 124. Agent Inspector

Agent Inspector：

```text
Agent
├── Definition
├── Version
├── State
├── Current Run
├── Context
├── Prompt Snapshot
├── Tool Calls
├── Artifacts
├── Budget
└── Errors
```

---

# 125. Debug 模式

Runtime 支持：

```ts
interface DebugOptions {
  recordEvents: boolean

  recordSnapshots: boolean

  recordToolArguments: boolean

  recordRawProviderResponse: boolean

  deterministic: boolean
}
```

敏感信息仍必须遵守：

```text
Secret Redaction
```

---

# 126. Secret Redaction

日志中禁止出现：

```text
API Key
Authorization Header
OAuth Token
Database Password
```

Prompt Snapshot 如果包含用户明确要求隐藏的内容，也需要：

```text
redaction policy
```

---

# 127. Security Boundary

最终安全边界：

```text
Model
  ↓
Agent Runtime
  ↓
Permission Manager
  ↓
Tool Runtime
  ↓
Sandbox
```

绝不能：

```text
Model
 ↓
Operating System
```

直接执行。

---

# 128. Provider Failure

Provider 错误由 Provider Runtime 分类：

```text
retryable
non-retryable
```

Agent Runtime 决定：

```text
retry
fallback
pause
fail
```

---

# 129. Provider Fallback

例如：

```text
Primary Model
 ↓
Rate Limit
 ↓
Fallback Model
```

必须生成新的：

```text
Prompt Snapshot
```

还是复用？

默认：

```text
复用同一个 IR
重新序列化 / Provider-specific serialization
```

如果 Provider 能力不同导致 Prompt 需要变化：

```text
重新 Compile
```

并生成新的 Snapshot。

---

# 130. Model Switching

切换 Model：

```text
Model A
 ↓
Model B
```

可能影响：

```text
context window
role support
cache strategy
tokenizer
tool support
```

因此必须重新验证：

```text
ProviderCapabilities
```

---

# 131. Context Window Failure

如果：

```text
Prompt > Model Context Window
```

不能让 Provider 直接失败。

Prompt Compiler 应先：

```text
Budget Manager
 ↓
trim
 ↓
validate
```

如果仍无法满足：

```text
PROMPT_CONTEXT_TOO_LARGE
```

Run：

```text
failed
```

---

# 132. Agent Runtime 与 Prompt Cache

Runtime 不保存：

```text
最终 Cache Prefix 字符串
```

而保存：

```text
Prompt Snapshot
CachePlan
Cache Checkpoint
```

Provider Adapter 决定实际缓存 API。

---

# 133. Agent Runtime 与 Memory

Memory Runtime：

```text
retrieve
write
```

Agent Runtime：

```text
决定什么时候调用
```

Prompt Compiler：

```text
决定最终放在哪里
```

---

# 134. Agent Runtime 与 Worldbook

Worldbook Runtime：

```text
activation
sticky
cooldown
runtime lifecycle
```

Agent Runtime：

```text
决定使用哪个 Worldbook Context
```

Prompt Compiler：

```text
决定最终 Prompt Layout
```

三者不能混成一个模块。

---

# 135. Agent Runtime 与 Summary

Summary Runtime：

```text
决定什么时候生成 Summary
```

Agent Runtime：

```text
决定是否触发 Summary
```

Prompt Compiler：

```text
消费 Frozen Summary
```

---

# 136. Summary Trigger

例如：

```ts
interface SummaryTriggerPolicy {
  maxHistoryTokens?: number

  maxMessages?: number

  triggerMode:
    | 'automatic'
    | 'manual'
    | 'agent'
}
```

Summary 生成本身也可以是 Agent：

```text
Summary Agent
```

但生成的 Summary 必须：

```text
validate
freeze
persist
```

---

# 137. Agent Runtime 与 Summary Agent

推荐：

```text
Chat
 ↓
Summary Trigger
 ↓
Summary Agent
 ↓
Summary Block
 ↓
freeze
```

而不是：

```text
每次 Prompt 编译时
动态生成 Summary
```

否则会破坏：

```text
determinism
cache stability
replay
```

---

# 138. Prompt Compilation Failure

如果 Prompt Compiler 返回：

```text
error
```

Agent Runtime：

```text
不调用 Provider
```

并：

```text
Run = failed
```

保存：

```text
Diagnostic
```

---

# 139. Runtime Transaction

一次成功执行建议拆成：

```text
Transaction A
────────────────────
Create Run
Resolve Versions
Compile
Create Snapshot
Commit
────────────────────

Provider Call
────────────────────

Transaction B
────────────────────
Save Generation
Save Tool Results
Update Agent State
Create Message
Create Events
Update Run
Commit
────────────────────
```

Provider 网络请求不能长时间占据数据库 Transaction。

---

# 140. Exactly-once 不作为假设

外部 Provider / Tool 通常无法保证 Exactly Once。

因此 Runtime 设计为：

```text
At-least-once execution
+
Idempotency
+
Deduplication
```

尤其是 Tool。

---

# 141. Tool Idempotency Key

```ts
interface ToolCallRequest {
  toolCallId: string

  idempotencyKey: string

  toolName: string

  arguments: unknown
}
```

重复执行：

```text
same idempotencyKey
```

Tool Runtime 可以返回之前的结果。

---

# 142. Provider Request Idempotency

如果 Provider 支持：

```text
requestId
```

应传递：

```text
generationId
```

或：

```text
runId + turnIndex
```

作为稳定请求标识。

---

# 143. Runtime Determinism

Runtime 尽量保证：

```text
same state
+
same event order
+
same random seed
+
same compiler
=
same execution decisions
```

外部 Provider 输出本身可能不是确定性的。

因此 Replay 可以选择：

```text
replay recorded provider response
```

实现完全确定性。

---

# 144. Replay Provider

```ts
interface ReplayProvider {
  getRecordedGeneration(
    generationId: string
  ): Promise<ModelResponse>
}
```

Replay：

```text
Prompt Compiler
 ↓
Recorded Provider Response
 ↓
Tool Replay
 ↓
State Replay
```

---

# 145. Tool Replay

Tool 可以：

```text
recorded result
```

替代真实执行。

例如：

```text
Tool A
original result = X

Replay
Tool A → X
```

避免副作用。

---

# 146. Replay Safety

Replay 默认：

```text
network = disabled
filesystem.write = disabled
external side effects = disabled
```

除非用户明确允许。

---

# 147. Runtime Modes

最终定义：

```ts
type RuntimeMode =
  | 'live'
  | 'simulation'
  | 'replay'
  | 'debug'
```

---

# 148. Live Mode

正常生产运行：

```text
real Provider
real Tools
real Runtime State
```

---

# 149. Simulation Mode

```text
mock Provider
mock Tool
fake time
fake randomness
```

用于：

```text
test
debug
workflow preview
```

---

# 150. Replay Mode

```text
recorded input
recorded Provider result
recorded Tool result
frozen state
```

用于：

```text
exact reproduction
```

---

# 151. Debug Mode

```text
real execution
+
maximum observability
```

例如：

```text
every event
every snapshot
every context resolution
every tool decision
```

---

# 152. Context Resolution Pipeline

```text
Agent Definition
      ↓
Agent Runtime State
      ↓
Chat State
      ↓
Character Version
      ↓
Persona Version
      ↓
Preset Version
      ↓
Worldbook Activation
      ↓
Memory Retrieval
      ↓
Summary
      ↓
History
      ↓
Artifacts
      ↓
Tool Results
      ↓
Agent Context
```

然后：

```text
Agent Context
      ↓
Prompt Compiler
```

---

# 153. Context Resolution 不负责 Layout

Context Manager 只回答：

```text
有哪些内容？
```

不回答：

```text
放在 Prompt 哪里？
```

例如：

```text
Memory A
```

Context Manager：

```text
selected = true
```

Prompt Compiler：

```text
cacheZone = freshWB
```

---

# 154. Context Provenance

每个 Context Item 应带来源：

```ts
interface ContextItem {
  id: string

  type: string

  content: string

  source: ContextSource

  confidence?: number

  priority?: number
}
```

---

# 155. Context Source

```ts
type ContextSource =
  | {
      type: 'message'
      messageId: string
    }
  | {
      type: 'memory'
      memoryId: string
    }
  | {
      type: 'worldbook'
      entryId: string
    }
  | {
      type: 'artifact'
      artifactId: string
    }
  | {
      type: 'agent'
      agentId: string
    }
```

这样 Prompt Segment 可以追溯来源。

---

# 156. Agent Invocation

Agent 可以调用另一个 Agent：

```ts
interface AgentInvocation {
  agentId: string

  input: unknown

  mode:
    | 'sync'
    | 'async'

  permissions?: PermissionSet

  budget?: Partial<RunBudget>
}
```

---

# 157. Sync Invocation

```text
Agent A
 ↓
invoke Agent B
 ↓
wait
 ↓
Agent B complete
 ↓
Agent A continues
```

---

# 158. Async Invocation

```text
Agent A
 ↓
invoke Agent B
 ↓
continue
```

B 完成后：

```text
Event
 ↓
Agent A wakeup
```

---

# 159. Recursion Protection

Agent A：

```text
A → B → A → B
```

必须限制。

```ts
interface InvocationPolicy {
  maxDepth: number

  maxTotalInvocations: number
}
```

---

# 160. Agent Loop Detection

Runtime 记录：

```text
agent invocation stack
```

如果：

```text
A → B → A
```

超过允许深度：

```text
AGENT_RECURSION_LIMIT
```

---

# 161. Runtime Persistence

以下状态必须持久化：

```text
Run
Step Run
Agent Runtime State
Workflow Runtime State
Tool Call
Generation
Prompt Snapshot
Checkpoint
Approval
```

不能只存在：

```text
memory
```

中。

---

# 162. Runtime Cache

允许内存缓存：

```text
Character
Preset
Worldbook
Agent Definition
```

但数据库仍是 Source of Truth。

---

# 163. Hot Reload

修改 Agent Definition：

```text
Agent v3
```

不能影响：

```text
正在运行的 Run
```

Run 必须固定：

```text
agentVersion = 3
```

下一次 Run 才使用：

```text
v4
```

---

# 164. Workflow Version Pinning

Workflow Run 创建时固定：

```text
workflowVersion
```

即使用户之后修改 Workflow：

```text
Workflow v4
```

旧 Run：

```text
仍使用 v3
```

---

# 165. Tool Version Pinning

同样：

```text
Tool v5
```

Run 启动后固定。

Replay：

```text
Tool v5
```

而不是：

```text
当前 Tool v7
```

---

# 166. Dependency Manifest

Run 可以保存：

```ts
interface RuntimeDependencyManifest {
  compilerVersion: string

  agentVersion: string

  workflowVersion?: string

  toolVersions: Record<string, string>

  provider: string

  model: string
}
```

用于：

```text
Replay
Resume
Bug Report
```

---

# 167. Run Snapshot

除了 Prompt Snapshot，Runtime 可以保存：

```ts
interface RunSnapshot {
  runId: string

  dependencyManifest: RuntimeDependencyManifest

  agentState: unknown

  workflowState?: unknown

  contextState: unknown

  budgetState: BudgetUsage

  createdAt: string
}
```

---

# 168. Agent Runtime 的最终职责边界

Agent Runtime **负责**：

```text
Agent Lifecycle
Run Lifecycle
Workflow Execution
Context Resolution
Tool Invocation
Permission
Budget
Retry
Resume
Cancellation
Concurrency
State Mutation
Provider Invocation
Event Publishing
Replay
```

Agent Runtime **不负责**：

```text
最终 Prompt Layout
Worldbook Keyword Matching
Prompt Serialization
Provider-specific Prompt Formatting
UI Rendering
```

这些分别属于：

```text
Prompt Compiler
Worldbook Runtime
Provider Adapter
Frontend
```

---

# 169. 核心执行边界

最终：

```text
                 Agent Runtime
                       │
             "Who does what?"
                       │
                       ▼
                Context Manager
                       │
                "What can see?"
                       │
                       ▼
               Prompt Compiler
                       │
              "What sees exactly?"
                       │
                       ▼
               Provider Runtime
                       │
                "Which model?"
                       │
                       ▼
                    Model
```

---

# 170. 单 Agent 最终流程

```text
User Message
     │
     ▼
Create Agent Run
     │
     ▼
Resolve Context
     │
     ▼
Prompt Compiler
     │
     ▼
Prompt Snapshot
     │
     ▼
Provider
     │
     ▼
Model
     │
     ├─────────────┐
     ▼             ▼
Final Output    Tool Call
     │             │
     ▼             ▼
Message        Tool Runtime
                   │
                   ▼
              Tool Result
                   │
                   ▼
              Recompile
                   │
                   └──────→ Model
```

---

# 171. Group Chat 最终流程

```text
User
 │
 ▼
Director Agent
 │
 ▼
Agent Selection
 │
 ├───────────────┐
 ▼               ▼
Character A    Character B
 │               │
 └───────┬───────┘
         ▼
      Message
         │
         ▼
      Director
         │
         ▼
      Next Agent
```

---

# 172. Writer / Checker Workflow

```text
User
 │
 ▼
Writer Agent
 │
 ▼
Draft Artifact
 │
 ▼
Checker Agent
 │
 ├── pass ──→ Output
 │
 └── fail
       │
       ▼
   Editor Agent
       │
       ▼
   Revised Draft
       │
       └────────→ Checker
```

---

# 173. Acceptance Criteria

Agent Runtime 完成后必须满足：

## Agent

```text
创建 Agent
运行 Agent
暂停 Agent
恢复 Agent
取消 Agent
Retry Agent
```

## Workflow

```text
DAG
条件
并行
Join
Retry
Resume
Loop Limit
```

## Tool

```text
Permission
Timeout
Cancellation
Retry
Idempotency
Result Persistence
```

## Context

```text
History
Worldbook
Memory
Summary
Artifact
Tool Result
```

## Prompt

```text
所有 Provider Request 都有 Prompt Snapshot
```

## Replay

```text
能够使用历史状态重新执行
```

## Recovery

```text
进程崩溃后不会产生永久 Zombie Run
```

---

# 174. 必须测试的场景

### Test 1 — 普通聊天

```text
User
 ↓
Character Agent
 ↓
Prompt
 ↓
Model
 ↓
Message
```

---

### Test 2 — Tool Loop

```text
Agent
 ↓
Tool
 ↓
Agent
 ↓
Tool
 ↓
Agent
 ↓
Final
```

---

### Test 3 — Cancellation

```text
Agent
 ↓
Provider
 ↓
Cancel
```

必须最终：

```text
Run = cancelled
```

---

### Test 4 — Retry

```text
Attempt 1
 ↓
Network Error
 ↓
Attempt 2
 ↓
Success
```

---

### Test 5 — Resume

```text
Turn 1 ✓
Turn 2 ✓
Turn 3 paused
 ↓
Restart Application
 ↓
Resume
 ↓
Turn 3 continues
```

---

### Test 6 — Crash Recovery

```text
running
 ↓
process crash
 ↓
restart
 ↓
interrupted
 ↓
recover
```

---

### Test 7 — Parallel Workflow

```text
A
├── B
├── C
└── D
    ↓
    E
```

B/C/D 并行，E 等待全部完成。

---

### Test 8 — Permission

```text
Agent
 ↓
network.request
 ↓
Denied
```

必须：

```text
Tool not executed
Run continues / fails according to policy
```

---

### Test 9 — Prompt Snapshot

每次真实 Provider Request：

```text
generation.snapshotId != null
```

---

### Test 10 — Deterministic Replay

相同：

```text
Agent Version
Workflow Version
Compiler Version
Runtime State
Seed
Time
Provider Recorded Response
Tool Recorded Response
```

必须产生相同 Runtime Decision。

---

# 175. 最终架构原则

DesireGrimoire V2 的 Agent Runtime 最终应该遵循：

```text
Agent = Actor
Workflow = Orchestrator
Run = Execution
Context = Visibility
Prompt Compiler = Compiler
Provider = Execution Backend
Tool = Capability
Artifact = Intermediate Result
Snapshot = Evidence
Checkpoint = Recovery Point
Event = Runtime Signal
```

最终系统不是：

```text
Chat UI
 ↓
Prompt
 ↓
LLM
```

而是：

```text
                    User
                     │
                     ▼
               Application
                     │
                     ▼
               Agent Runtime
                     │
          ┌──────────┼──────────┐
          │          │          │
          ▼          ▼          ▼
       Context     Workflow    Tools
          │          │          │
          └──────────┼──────────┘
                     ▼
              Prompt Compiler
                     │
                     ▼
               Prompt Snapshot
                     │
                     ▼
               Provider Runtime
                     │
                     ▼
                   Model
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Message    Artifact    State
          │          │          │
          └──────────┼──────────┘
                     ▼
                 Event Bus
```

**最关键的一条规则：**

> Agent Runtime 决定“执行什么”；Prompt Compiler 决定“模型看到什么”；Provider Runtime 决定“由谁执行模型调用”。

三者必须保持严格边界。

这样后续 DesireGrimoire V2 才能在不推翻核心架构的情况下继续加入 **Multi-Agent、Group Chat、Workflow、Tool Calling、Memory、Worldbook、Prompt Cache、Replay、Human-in-the-loop 和插件系统**。

---

# 176. 参考实现取舍记录（DeepSeek Harness）

来源：`https://github.com/deepseek-ai/deepseek-harness`（DeepSeek AI 开源，MIT，developer preview）。

它是**编码 agent** 的 harness，本项目的领域是**长上下文叙事**。评估后按三档处理：

## 176.1 已借鉴（11 项）

| 项 | 本文位置 | 借鉴了什么 |
|---|---|---|
| 工具执行流水线 | §36.1 | 五段式 pre / approval / guards / execute / post + 归一化 + finalizeContent |
| 抛错归一化 | §36.2 | 流水线内 throw 收敛为 `isError`，不升格为 Run 失败 |
| 正交结果独立上报 | §35 | `timedOut` / `signal` / `exitCode` 各自成字段，不嵌套 |
| 并行结果按模型顺序回灌 | §36.3 | 保 Replay 确定性与缓存前缀 |
| Attempt 不进模型历史 | §47.1 | 失败/重试流留痕但不进 derived history |
| 上下文溢出反循环 | §49.1 | 生成号未前进则不许重试 |
| 审批四值 + fail-closed | §115.1 | `allowed_once / rejected / cancelled / unavailable` |
| Turn 开合 + 空 Turn 记账 | §37.1 | 「不再欠任何东西」判据，被拒的 Turn 也要记录 |
| 运行期不变量断言 | 总设计 §5.5 | 发请求前必挂 snapshotId（详见总设计） |
| 事件 durable / live 二分 | 总设计 §5.4 | 给「要不要落 events 表」一个判据 |
| 动态上下文逐字未变则复用快照 | compiler spec §84.2 | 白名单内的动态上下文段可复用 snapshot（与 C2 边界已划清） |

## 176.2 明确不借鉴

| 项 | 不借鉴的理由 |
|---|---|
| bash / terminal / PTY / LSP / sandbox / 代码运行时 / 文件系统 / 网页访问 | 编码 agent 专属能力，本项目无对应需求 |
| Cordis 全插件化 IOC（everything is a plugin + effect 可逆卸载） | 本项目是单体 web 应用 + SQLite，引入容器与生命周期语义成本远大于收益 |
| 会话日志上传 / 匿名 UUID / 插件清单上报 / 官方 API 线扩展字段 | 依赖其自有后端，本项目是本地优先、无服务端 |
| Agent Teams（花名册 / 任务板 / 信箱） | 与本文 §24 群聊、§23 Workflow DAG 职责重叠 |
| 文档从源码生成 + 漂移检查体系（`gen-cordis-catalog` / `verify-type-equiv` / `verify-package-invariants`） | 值得羡慕，但当前阶段建这套基建不划算。**待办**：事件清单应尽早做成源码常量 + 生成文档，防止事件名再次分叉（总设计 §5.4 已记录为待办）。 |

## 176.3 一条跨领域的设计直觉

它的官方 API 扩展字段刻意留在 `messages` / system prompt / tool schemas **之外**，理由写得非常直白：

> 它们不增加 model-input tokens，也不改变模型可见前缀。

这与本项目「缓存前缀稳定性压倒一切」的立场同源。任何新增的元数据、遥测、调试信息，都应当走**请求旁路**（header / 独立字段 / 事件流），**绝不许进入模型可见前缀**。这条已写入总设计 §5.5。