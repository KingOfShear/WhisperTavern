# WhisperTavern V2 API Specification

> **Version:** 2.1（2026-09 收编修订版。5 处修正与既有文档对齐：①事件名以总设计 §5.4 权威事件表为准——agent.* 平铺命名并入 agent.run.*/agent.turn.*/tool.call.*，generation.usage 并入 usage.recorded，provider/import/export/memory/artifact 五个域反哺进权威表；②事件持久化按 durability 三档（§141），不是"generation.* 全持久化"；③里程碑 M2–M5 重映射 P2–P5；④对象形状以模块规格为准，本 spec 的 DTO 是线格式投影（§1.2）；⑤PromptSnapshot hashes / SegmentSnapshot stability / CacheCheckpoint / AgentBudget 字段对齐模块 spec）  
> **Status:** Implementation Specification  
> **文档层级：** [technical-design.md](../technical-design.md) 之下的 **HTTP/SSE API 模块详细规格**  
> **Protocol:** HTTP/1.1 + SSE  
> **Data Format:** JSON  
> **Validation:** Zod  
> **Primary Runtime:** Node.js + Hono  
> **Architecture:** Local-first / Single-user / Agent-native

---

# 1. API Design Principles

WhisperTavern V2 API 遵循以下原则：

## 1.1 API 是 Runtime Contract

API 不应该暴露内部实现。

例如：

```text
Prompt Compiler
Worldbook Engine
Cache Planner
Agent Scheduler
```

这些是内部 Runtime。

API 暴露的是：

```text
Compile
Generate
Run
Cancel
Inspect
Replay
Search
Import
Export
```

## 1.2 文档优先级

对象形状（Prompt IR / Segment / Run / 状态机 / 表结构）与运行语义以**模块规格**为准：[prompt-compiler-spec.md](./prompt-compiler-spec.md)、[agent-runtime-spec.md](./agent-runtime-spec.md)、[database-schema.md](./database-schema.md)。本规格的 DTO 是它们的**线格式投影**——字段裁剪与命名映射可以发生，语义不得漂移；冲突时改本规格，不改模块规格。事件名与持久化分档以总设计 §5.4 权威事件表为准。架构口径以 [technical-design.md](../technical-design.md) 为准。

---

# 2. Transport

## 2.1 HTTP

普通 CRUD 与控制操作：

```text
HTTP/1.1
Content-Type: application/json
```

---

## 2.2 SSE

所有长时间运行任务使用 SSE：

```text
GET /api/v2/runs/{runId}/events
```

适用于：

- LLM Streaming
- Agent
- Workflow
- Tool Call
- Memory Job
- Import Job
- Export Job

不建议为每一种 Runtime 单独创造 WebSocket 协议。

---

# 3. API Versioning

所有 API：

```text
/api/v2/*
```

例如：

```text
/api/v2/chats
/api/v2/providers
/api/v2/runs
/api/v2/agents
```

未来破坏性修改：

```text
/api/v3/*
```

---

# 4. Common Headers

客户端请求建议：

```http
Content-Type: application/json
X-Request-ID: <uuid>
```

对于可能重复提交的操作：

```http
Idempotency-Key: <uuid>
```

例如生成：

```http
POST /api/v2/chats/{chatId}/generate
Idempotency-Key: 3b241101-e2bb-4255-8caf-4136c566a962
```

---

# 5. Request ID

服务器为每个请求分配：

```ts
type RequestId = string
```

所有日志、Event、Generation、Provider Request 都应记录：

```text
requestId
```

这样可以从：

```text
UI
 ↓
HTTP
 ↓
Generation
 ↓
Prompt Snapshot
 ↓
Provider Request
 ↓
Agent
```

一路追踪。

---

# 6. Common Response Envelope

普通成功响应：

```ts
type ApiResponse<T> = {
  data: T
  requestId: string
}
```

例如：

```json
{
  "data": {
    "id": "chat_123",
    "name": "测试角色"
  },
  "requestId": "req_abc"
}
```

---

# 7. Error Response

统一：

```ts
type ApiError = {
  error: {
    code: string
    message: string

    details?: unknown

    retryable: boolean

    requestId: string
  }
}
```

例如：

```json
{
  "error": {
    "code": "PROMPT_COMPILE_FAILED",
    "message": "Worldbook budget exceeded",
    "retryable": false,
    "requestId": "req_123"
  }
}
```

---

# 8. Error Codes

核心错误：

```text
BAD_REQUEST
VALIDATION_ERROR
NOT_FOUND
CONFLICT
FORBIDDEN

PROMPT_COMPILE_FAILED
PROMPT_BUDGET_EXCEEDED
PROMPT_SERIALIZE_FAILED

PROVIDER_NOT_FOUND
PROVIDER_UNAVAILABLE
PROVIDER_AUTH_FAILED
PROVIDER_RATE_LIMITED
PROVIDER_TIMEOUT
PROVIDER_BAD_RESPONSE

GENERATION_NOT_FOUND
GENERATION_CANCELLED
GENERATION_TIMEOUT

AGENT_NOT_FOUND
AGENT_PERMISSION_DENIED
AGENT_BUDGET_EXCEEDED
AGENT_TIMEOUT
AGENT_FAILED

TOOL_NOT_FOUND
TOOL_PERMISSION_DENIED
TOOL_INVALID_ARGUMENTS
TOOL_FAILED

WORKFLOW_NOT_FOUND
WORKFLOW_FAILED

IMPORT_FAILED
EXPORT_FAILED

IDEMPOTENCY_CONFLICT
VERSION_CONFLICT
```

---

# 9. Resource Model

核心资源：

```text
Character
Persona
Worldbook
Preset
Chat
Message
Generation
PromptSnapshot
Provider
Model
Agent
AgentRun
Tool
Skill
Workflow
Artifact
Memory
TimelineEvent
UsageRecord
Plugin
Event
```

---

# 10. Resource IDs

所有 Runtime Resource 使用字符串 ID：

```text
char_xxx
persona_xxx
world_xxx
preset_xxx
chat_xxx
msg_xxx
gen_xxx
snap_xxx
agent_xxx
run_xxx
tool_xxx
skill_xxx
workflow_xxx
artifact_xxx
memory_xxx
```

推荐使用：

```text
UUIDv7
```

或者等价的时间有序 ID。

---

# 11. Chat API

## 11.1 Create Chat

```http
POST /api/v2/chats
```

Request：

```ts
type CreateChatRequest = {
  name?: string

  characterId?: string

  characterIds?: string[]

  personaId?: string

  presetId?: string

  worldbookIds?: string[]
}
```

Response：

```ts
type Chat = {
  id: string
  name: string

  characterIds: string[]

  personaId?: string
  presetId?: string
  worldbookIds: string[]

  activeMessageId?: string

  createdAt: string
  updatedAt: string
}
```

---

# 12. List Chats

```http
GET /api/v2/chats
```

Query：

```text
limit
cursor
search
sort
```

例如：

```http
GET /api/v2/chats?limit=50&search=Seraphina
```

---

# 13. Get Chat

```http
GET /api/v2/chats/{chatId}
```

返回：

```text
Chat
+
active branch metadata
+
character metadata
+
preset metadata
```

默认不返回整个聊天历史。

---

# 14. Update Chat

```http
PATCH /api/v2/chats/{chatId}
```

支持：

```ts
{
  name?: string
  characterIds?: string[]
  personaId?: string
  presetId?: string
  worldbookIds?: string[]
}
```

---

# 15. Delete Chat

```http
DELETE /api/v2/chats/{chatId}
```

默认：

```text
soft delete
```

彻底删除使用：

```http
DELETE /api/v2/chats/{chatId}?purge=true
```

---

# 16. Message Tree API

## Get Messages

```http
GET /api/v2/chats/{chatId}/messages
```

Query：

```text
branch=active
limit=100
before=<messageId>
after=<messageId>
```

---

# 17. Get Message

```http
GET /api/v2/messages/{messageId}
```

返回：

```ts
type Message = {
  id: string

  chatId: string

  parentId: string | null

  variantOf: string | null

  role: 'system' | 'user' | 'assistant' | 'tool'

  name?: string

  content: string

  model?: string

  usage?: Usage

  createdAt: string
}
```

【2026-09 修订】`variantOf` 是线格式投影；DB 权威模型是 messages 的 `variant_group_id + variant_index`（[database-schema.md](./database-schema.md) §19，无 is_active 列），由 API 层投影为兄弟链。`usage` / `model` 同理是 generations 表的投影（Message ≠ Generation）。

---

# 18. Create User Message

```http
POST /api/v2/chats/{chatId}/messages
```

Request：

```ts
type CreateMessageRequest = {
  parentId?: string

  role: 'user'

  content: string

  metadata?: Record<string, unknown>
}
```

Response：

```ts
{
  message: Message
  activeLeaf: string
}
```

---

# 19. Edit Message

不要原地覆盖历史。

```http
POST /api/v2/messages/{messageId}/edit
```

Request：

```ts
{
  content: string
}
```

服务器创建新的 Variant：

```text
old message
      │
      ├── old version
      │
      └── edited version
```

---

# 20. Swipe

```http
POST /api/v2/messages/{messageId}/swipe
```

如果该消息是：

```text
assistant
```

服务器创建新的 sibling：

```text
User
 ├── Assistant A
 └── Assistant B
```

Request：

```ts
{
  provider?: ProviderRef
  model?: string

  sampling?: SamplingParams
}
```

返回：

```ts
{
  runId: string
  messageId: string
}
```

---

# 21. Branch

```http
POST /api/v2/chats/{chatId}/branch
```

Request：

```ts
{
  fromMessageId: string
}
```

Response：

```ts
{
  branchId: string
  activeLeafId: string
}
```

Branch 不复制整个聊天。

只改变：

```text
active leaf
```

---

# 22. Activate Message Branch

```http
POST /api/v2/chats/{chatId}/active-leaf
```

Request：

```json
{
  "messageId": "msg_123"
}
```

---

# 23. Generation API

Generation 是：

> 一次完整的模型生成 Runtime。

---

# 24. Start Generation

```http
POST /api/v2/chats/{chatId}/generate
```

Request：

```ts
type GenerateRequest = {
  parentMessageId?: string

  mode?: 'normal' | 'swipe' | 'regenerate'

  provider?: ProviderRef

  model?: string

  presetId?: string

  sampling?: SamplingParams

  tools?: string[]

  agent?: string

  workflow?: string

  context?: ContextOverride
}
```

Response：

```ts
{
  runId: string
  generationId: string
  messageId: string
}
```

---

# 25. Generation State

```ts
type GenerationState =
  | 'queued'
  | 'compiling'
  | 'waiting_provider'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

---

# 26. Generation Event Stream

```http
GET /api/v2/runs/{runId}/events
Accept: text/event-stream
```

---

# 27. SSE Event Envelope

```ts
type RuntimeEvent = {
  id: string

  type: string

  runId: string

  timestamp: string

  sequence: number

  data: unknown
}
```

`sequence` 必须单调递增。

客户端可以检测：

```text
1
2
3
5
```

从而发现：

```text
event 4 missing
```

---

# 28. Generation SSE Events

最小事件（【2026-09 修订】命名以总设计 §5.4 权威事件表为准：编译阶段事件归 prompt.* 域，用量事件归 usage.* 域，工具调用归 tool.call.* 域）：

```text
generation.started
prompt.compiling
prompt.compiled

generation.delta
tool.call.started

usage.recorded

generation.completed
generation.failed
generation.cancelled
```

---

# 29. generation.delta

```json
{
  "type": "generation.delta",
  "data": {
    "text": "她沉默了片刻……"
  }
}
```

不要每个 Token 都强制单独发送 HTTP Event。

Runtime 可以聚合成：

```text
10–50ms
```

一批发送。

---

# 30. Cancel Generation

```http
POST /api/v2/runs/{runId}/cancel
```

取消必须具有传播性：

```text
Generation
 ↓
Provider Request
 ↓
Tool Call
 ↓
Child Agent
```

---

# 31. Retry Generation

```http
POST /api/v2/runs/{runId}/retry
```

Request：

```ts
{
  strategy?: 'same' | 'fallback-provider' | 'new-model'
}
```

默认不覆盖原 Generation。

创建新的：

```text
generation
```

---

# 32. Prompt Compiler API

Prompt Compiler 是整个 API 的核心。

现有设计已经明确要求 Prompt Compiler 成为唯一 Prompt 组装入口，并输出 Segment IR、序列化结果和 CachePlan。

---

# 33. Compile Prompt

```http
POST /api/v2/chats/{chatId}/prompt/compile
```

Request：

```ts
type CompilePromptRequest = {
  parentMessageId?: string

  provider: string

  model: string

  presetId?: string

  mode?: 'compatibility' | 'performance'

  includeDebug?: boolean
}
```

---

# 34. Compile Result

```ts
type CompileResult = {
  snapshotId: string

  segments: SegmentSnapshot[]

  serializedPrompt: SerializedPrompt

  cachePlan: CachePlan

  usage: {
    estimatedTokens: number
  }

  warnings: PromptWarning[]
}
```

---

# 35. SegmentSnapshot

```ts
type SegmentSnapshot = {
  id: string

  source: {
    type:
      | 'preset'
      | 'character'
      | 'persona'
      | 'worldbook'
      | 'summary'
      | 'message'
      | 'memory'
      | 'injection'
      | 'macro'
      | 'workflow'

    sourceId?: string
  }

  role: 'system' | 'user' | 'assistant' | 'tool'

  zone:
    | 'header'
    | 'stableWB'
    | 'freshWB'
    | 'summary'
    | 'history'
    | 'injection'
    | 'tail'

  content: string

  contentHash: string

  tokens: number

  stability:
    | 'stable'
    | 'appended'
    | 'volatile'

  physicalOrder: number

  dependencies: string[]
}
```

【2026-09 修订】`stability` 三值是 UI 投影；模块层权威口径是 [prompt-compiler-spec.md](./prompt-compiler-spec.md) §15 的五级（static / session / request / message / volatile），映射：stable ← static/session、appended ← message、volatile ← request/volatile。

---

# 36. Get Prompt Snapshot

```http
GET /api/v2/prompt-snapshots/{snapshotId}
```

返回：

```text
完整 Prompt Snapshot
+
CachePlan
+
Segment Hash Chain
+
Compiler Version
```

---

# 37. Prompt Snapshot 必须记录

```ts
type PromptSnapshot = {
  id: string

  chatId: string

  runId?: string

  provider: string
  model: string

  compilerVersion: string

  segments: SegmentSnapshot[]

  serializedPrompt: SerializedPrompt

  cachePlan: CachePlan

  hashes: {
    header: string
    worldbook: string
    summary: string
    history: string
    final: string
  }

  createdAt: string
}
```

这保证 Inspector 所看到的内容就是实际 Provider Request 的来源。

【2026-09 修订】hashes 权威口径是 [prompt-compiler-spec.md](./prompt-compiler-spec.md) §67 的**八区哈希**（header / stableWB / freshWB / summary / history / injection / tail / final）；本节五区是早期简化，落地以八区为准（UI 可用 worldbook = stableWB + freshWB 的合并视图）。

---

# 38. Prompt Diff

```http
GET /api/v2/prompt-snapshots/{snapshotA}/diff/{snapshotB}
```

返回：

```ts
type PromptDiff = {
  segments: SegmentDiff[]

  firstDivergence?: {
    segmentId: string
    byteOffset?: number
  }

  tokenDelta: {
    input: number
    cached: number
    fresh: number
  }

  cacheBreak?: CacheBreakReason
}
```

---

# 39. CachePlan

```ts
type CachePlan = {
  prefixHash: string

  stableTokens: number
  freshTokens: number
  volatileTokens: number

  checkpoints: CacheCheckpoint[]

  invalidationRisk: 'low' | 'medium' | 'high'

  reasons: CacheReason[]
}
```

---

# 40. Cache Checkpoint

```ts
type CacheCheckpoint = {
  id: string

  segmentId: string

  tokenOffset: number

  strategy:
    | 'automatic-prefix'
    | 'explicit-breakpoint'
    | 'context-cache'
    | 'none'
}
```

【2026-09 修订】字段口径以 [prompt-compiler-spec.md](./prompt-compiler-spec.md) §55 为准：`afterSegmentId` / `prefixHash` / `tokenCount` / `reason: automatic | provider-required | manual`；本节的 `strategy` 是 Provider 侧翻译结果（对应 capabilities.cacheType），两者不是同一层。

---

# 41. Cache Telemetry

```http
GET /api/v2/chats/{chatId}/cache/telemetry
```

Query：

```text
from
to
```

返回：

```ts
type CacheTelemetry = {
  rounds: CacheRoundMetric[]

  aggregate: {
    stableTokens: number
    eligibleTokens: number
    cachedTokens: number
    freshTokens: number

    theoreticalHitRate: number
    actualHitRate?: number

    estimatedCost: number
  }
}
```

---

# 42. Cache Break Diagnosis

```http
GET /api/v2/runs/{runId}/cache-break
```

返回：

```ts
type CacheBreakDiagnosis = {
  broken: boolean

  firstDivergence?: {
    previousSnapshot: string
    currentSnapshot: string

    segmentId: string
    sourceId?: string

    reason: string
  }

  affectedTokens: number

  suggestions: string[]
}
```

---

# 43. Cache Simulation

这是 V2 的重要 Debug API。

```http
POST /api/v2/cache/simulate
```

Request：

```ts
type CacheSimulationRequest = {
  chatId: string

  rounds: number

  scenarios?: (
    | 'worldbook-activation'
    | 'worldbook-edit'
    | 'macro'
    | 'swipe'
    | 'branch'
    | 'summary'
    | 'budget'
    | 'group'
  )[]

  provider?: string
  model?: string
}
```

注意：

> 不调用真实 Provider。

---

# 44. Cache Simulation Result

```ts
type CacheSimulationResult = {
  rounds: {
    round: number

    stableTokens: number
    freshTokens: number
    volatileTokens: number

    prefixHash: string

    cacheBreak?: CacheBreakReason
  }[]

  aggregate: {
    expectedCacheRatio: number
    totalInvalidatedTokens: number
  }
}
```

---

# 45. Worldbook API

## List

```http
GET /api/v2/worldbooks
```

---

# 46. Get Worldbook

```http
GET /api/v2/worldbooks/{worldbookId}
```

---

# 47. Create Worldbook

```http
POST /api/v2/worldbooks
```

Request：

```ts
type CreateWorldbookRequest = {
  name: string

  entries?: WorldbookEntry[]
}
```

---

# 48. Worldbook Entry

```ts
type WorldbookEntry = {
  uid: number

  comment?: string

  content: string

  keys: string[]

  secondaryKeys?: string[]

  selective?: boolean

  selectiveLogic?:
    | 'AND_ANY'
    | 'AND_ALL'
    | 'NOT_ANY'
    | 'NOT_ALL'

  constant?: boolean

  position:
    | 'before'
    | 'after'
    | 'ANTop'
    | 'ANBottom'
    | 'atDepth'
    | 'EMTop'
    | 'EMBottom'
    | 'outlet'

  depth?: number

  order: number

  probability?: number

  sticky?: number

  cooldown?: number

  delay?: number
}
```

Worldbook API 必须保留这些语义字段，因为酒馆 1.18 的世界书不仅是关键词匹配，还包括 selective logic、recursive scan、scan depth、probability、sticky/cooldown/delay 等行为。

---

# 49. Worldbook Activation Preview

```http
POST /api/v2/worldbooks/{worldbookId}/preview
```

Request：

```ts
{
  text: string

  chatId?: string

  messageId?: string
}
```

Response：

```ts
{
  activated: {
    uid: number
    reason: string
  }[]

  rejected: {
    uid: number
    reason: string
  }[]
}
```

---

# 50. Worldbook Cache State

```http
GET /api/v2/chats/{chatId}/worldbook/cache
```

返回：

```ts
type WorldbookCacheState = {
  entries: {
    uid: number

    contentHash: string

    activationState:
      | 'inactive'
      | 'active'

    cacheState:
      | 'unseen'
      | 'fresh'
      | 'stable'
      | 'stale'
      | 'retired'

    physicalOrder: number

    firstSeenMessageId?: string
  }[]
}
```

---

# 51. Character API

```http
GET    /api/v2/characters
POST   /api/v2/characters
GET    /api/v2/characters/{id}
PATCH  /api/v2/characters/{id}
DELETE /api/v2/characters/{id}
```

---

# 52. Character Schema

```ts
type Character = {
  id: string

  name: string

  description?: string

  personality?: string

  scenario?: string

  firstMessage?: string

  alternateGreetings?: string[]

  exampleMessages?: string[]

  systemPrompt?: string

  postHistoryInstructions?: string

  tags?: string[]

  extensions?: Record<string, unknown>

  sourceFormat:
    | 'native'
    | 'st-v2'
    | 'st-v3'
}
```

---

# 53. Persona API

```http
GET    /api/v2/personas
POST   /api/v2/personas
GET    /api/v2/personas/{id}
PATCH  /api/v2/personas/{id}
DELETE /api/v2/personas/{id}
```

---

# 54. Preset API

```http
GET    /api/v2/presets
POST   /api/v2/presets
GET    /api/v2/presets/{id}
PATCH  /api/v2/presets/{id}
DELETE /api/v2/presets/{id}
```

Preset 在 V2 中应该保持声明式。酒馆的 `prompts[] + prompt_order[]` 映射为 V2 Segment，同时机制通过 workflow / skill / displayRules 等 binding 引用。

---

# 55. Preset Compile Preview

```http
POST /api/v2/presets/{presetId}/compile-preview
```

Request：

```ts
{
  characterId?: string
  personaId?: string
  worldbookIds?: string[]

  provider: string
  model: string
}
```

返回：

```text
Segment IR
+
warnings
+
cache analysis
```

---

# 56. Import API

统一异步 Import：

```http
POST /api/v2/import
```

支持：

```text
character png
character json
charx
worldbook json
preset json
chat jsonl
dg assets
```

---

# 57. Import Request

推荐使用：

```http
multipart/form-data
```

Request：

```text
file=<binary>
format=auto
```

Response：

```ts
{
  importId: string
}
```

---

# 58. Import Events

```text
import.started
import.detected
import.parsed
import.compatibility_report
import.warning
import.completed
import.failed
```

---

# 59. Compatibility Report

```ts
type CompatibilityReport = {
  format: string

  imported: string[]

  migrated: {
    source: string
    target: string
  }[]

  unsupported: {
    field: string
    reason: string
  }[]

  warnings: string[]
}
```

---

# 60. Export API

```http
POST /api/v2/export
```

Request：

```ts
{
  resourceType:
    | 'character'
    | 'worldbook'
    | 'preset'
    | 'chat'

  resourceId: string

  format:
    | 'native'
    | 'st-v2'
    | 'st-v3'
    | 'json'
    | 'jsonl'
    | 'charx'
}
```

Response：

```ts
{
  exportId: string
}
```

---

# 61. Agent API

Agent Runtime 是 V2 第二核心 API。

---

# 62. Agent Definition

```ts
type AgentDefinition = {
  id: string

  name: string

  identity: {
    description?: string
  }

  model: {
    provider?: string
    model?: string
    inheritFrom?: 'run'
  }

  systemPrompt: string

  tools: string[]

  skills: string[]

  context: ContextPolicy

  budget: AgentBudget

  permissions: Capability[]

  canDelegate: boolean

  canHandoff: boolean
}
```

现有参考方案已经采用声明式 Agent Profile、工具白名单、调用预算、`allowedCallers`、artifact 等机制；V2 API 将这些能力正式化。

---

# 63. Agent CRUD

```http
GET    /api/v2/agents
POST   /api/v2/agents
GET    /api/v2/agents/{id}
PATCH  /api/v2/agents/{id}
DELETE /api/v2/agents/{id}
```

---

# 64. Run Agent

```http
POST /api/v2/agents/{agentId}/runs
```

Request：

```ts
type AgentRunRequest = {
  input: string

  chatId?: string

  parentRunId?: string

  context?: ContextOverride

  budget?: Partial<AgentBudget>
}
```

Response：

```ts
{
  runId: string
}
```

---

# 65. Agent Run State

```ts
type AgentRunState =
  | 'created'
  | 'planning'
  | 'running'
  | 'waiting_tool'
  | 'waiting_child'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
}
```

---

# 66. Agent Run API

```http
GET  /api/v2/agent-runs/{runId}
POST /api/v2/agent-runs/{runId}/cancel
POST /api/v2/agent-runs/{runId}/pause
POST /api/v2/agent-runs/{runId}/resume
GET  /api/v2/agent-runs/{runId}/events
```

---

# 67. Agent Step

```ts
type AgentStep = {
  id: string

  runId: string

  sequence: number

  type:
    | 'model'
    | 'tool'
    | 'delegate'
    | 'handoff'
    | 'await'
    | 'artifact'

  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'

  startedAt?: string
  completedAt?: string

  input?: unknown
  output?: unknown

  error?: ApiError
}
```

---

# 68. Agent Context Policy

```ts
type ContextPolicy = {
  history:
    | 'none'
    | 'recent'
    | 'recent-20'
    | 'recent-40'
    | 'all'

  summary:
    | 'none'
    | 'stable'
    | 'all'

  worldbook:
    | 'none'
    | 'activated'
    | 'all'

  memory:
    | 'none'
    | 'relevant'
    | 'all'

  rag:
    enabled: boolean

  siblingAgents:
    | 'none'
    | 'findings-only'
    | 'full'

  reasoning:
    | 'never'
    | 'own-only'
}
```

---

# 69. Context Override

任何 Agent Run 都可以：

```ts
{
  context?: {
    history?: ...
    memory?: ...
    worldbook?: ...
  }
}
```

但：

> Agent 不能通过普通 API 自行扩大权限。

最终 Context 必须经过：

```text
Agent Definition
+
Run Override
+
Permission Policy
```

计算。

---

# 70. Agent Budget

```ts
type AgentBudget = {
  maxInputTokens: number

  maxOutputTokens: number

  maxSteps: number

  maxRuntimeMs: number

  maxCost: number

  maxToolCalls: number

  maxChildAgents: number

  maxConcurrentInvocations: number

  maxInvocationsPerRun: number   // 【2026-09 修订】补齐，对齐总设计 §21.6 / agent-runtime-spec
  resultBudgetTokens: number     // 子代理结果预算
}
```

---

# 71. Delegate Agent

```http
POST /api/v2/agent-runs/{runId}/delegate
```

Request：

```ts
{
  agentId: string

  task: string

  context?: ContextOverride

  budget?: Partial<AgentBudget>
}
```

Response：

```ts
{
  childRunId: string
}
```

---

# 72. Await Child Agent

```http
POST /api/v2/agent-runs/{runId}/await
```

Request：

```ts
{
  childRunId: string
}
```

服务器：

```text
Parent
 ↓
waiting_child
 ↓
Child completed
 ↓
Parent resumes
```

---

# 73. Handoff

```http
POST /api/v2/agent-runs/{runId}/handoff
```

Request：

```ts
{
  targetAgentId: string

  reason: string

  findings?: string

  artifacts?: string[]
}
```

Handoff 不复制全部 Context。

只传：

```text
handoff payload
+
allowed context
```

---

# 74. Tool API

Tool 是 Agent 可以调用的最小能力单元。

---

# 75. List Tools

```http
GET /api/v2/tools
```

Query：

```text
agentId
capability
```

---

# 76. Tool Schema

```ts
type ToolDefinition = {
  id: string

  name: string

  description: string

  inputSchema: unknown

  permission: Capability

  source:
    | 'core'
    | 'plugin'
}
```

---

# 77. Execute Tool

原则：

> 普通 UI 不应该随意执行任意 Tool。

Agent Tool Call：

```http
POST /api/v2/agent-runs/{runId}/tool-calls
```

Request：

```ts
{
  toolId: string

  arguments: unknown
}
```

服务器检查：

```text
Agent Permission
+
Tool Permission
+
Run Budget
+
Argument Schema
```

---

# 78. Tool Result

```ts
type ToolResult = {
  success: boolean

  output?: unknown

  artifactIds?: string[]

  error?: {
    code: string
    message: string
  }
}
```

---

# 79. Skill API

```http
GET /api/v2/skills
GET /api/v2/skills/{skillId}
POST /api/v2/skills/{skillId}/read
```

Skill 默认按需读取。

不能在 Agent 初始化时自动把所有 Skill 全部塞入 Prompt。

---

# 80. Workflow API

Workflow 是：

```text
DAG
+
Agent
+
Tool
+
Artifact
```

而不是简单的：

```text
A → B → C
```

---

# 81. Workflow Schema

```ts
type WorkflowDefinition = {
  id: string

  name: string

  version: number

  nodes: WorkflowNode[]

  edges: WorkflowEdge[]
}
```

---

# 82. Workflow Node

```ts
type WorkflowNode = {
  id: string

  type:
    | 'agent'
    | 'tool'
    | 'condition'
    | 'parallel'
    | 'artifact'
    | 'human'

  agentId?: string

  toolId?: string

  config?: unknown
}
```

---

# 83. Workflow Edge

```ts
type WorkflowEdge = {
  from: string

  to: string

  condition?: string
}
```

---

# 84. Run Workflow

```http
POST /api/v2/workflows/{workflowId}/runs
```

Request：

```ts
{
  input: unknown

  chatId?: string

  variables?: Record<string, unknown>
}
```

Response：

```ts
{
  runId: string
}
```

---

# 85. Workflow Run

```http
GET /api/v2/workflow-runs/{runId}
GET /api/v2/workflow-runs/{runId}/events
POST /api/v2/workflow-runs/{runId}/cancel
POST /api/v2/workflow-runs/{runId}/resume
```

---

# 86. Artifact API

Agent 之间不要直接通过 Prompt 传递大量文本。

使用 Artifact。

```http
GET    /api/v2/artifacts/{artifactId}
POST   /api/v2/artifacts
DELETE /api/v2/artifacts/{artifactId}
```

---

# 87. Artifact Schema

```ts
type Artifact = {
  id: string

  runId: string

  path: string

  kind:
    | 'text'
    | 'markdown'
    | 'json'
    | 'code'
    | 'findings'

  contentHash: string

  size: number

  createdAt: string
}
```

例如：

```text
output/
 ├─ outline.md
 ├─ draft.md
 ├─ findings.json
 └─ final.md
```

---

# 88. Memory API

## Search Memory

```http
POST /api/v2/chats/{chatId}/memory/search
```

Request：

```ts
{
  query: string

  limit?: number

  kinds?: (
    | 'summary'
    | 'dossier'
    | 'timeline'
    | 'document'
  )[]
}
```

---

# 89. Memory Schema

```ts
type Memory = {
  id: string

  chatId: string

  kind:
    | 'summary'
    | 'dossier'
    | 'timeline'
    | 'document'

  entity?: string

  content: string

  importance?: number

  sourceMessageIds?: string[]

  embedding?: {
    model: string
  }

  createdAt: string

  updatedAt: string
}
```

---

# 90. Summary API

```http
GET  /api/v2/chats/{chatId}/summaries
POST /api/v2/chats/{chatId}/summaries
```

Summary Block：

```ts
type SummaryBlock = {
  id: string

  seq: number

  content: string

  coversMessageRange: {
    from: string
    to: string
  }

  frozenAt: string
}
```

Summary 一旦冻结，不原地修改。

新摘要：

```text
S1
S2
S3
```

作为新的 immutable block。

---

# 91. Dossier API

```http
GET  /api/v2/chats/{chatId}/dossier
POST /api/v2/chats/{chatId}/dossier/entities
PATCH /api/v2/dossier/entities/{id}
```

---

# 92. Timeline API

```http
GET  /api/v2/chats/{chatId}/timeline
POST /api/v2/chats/{chatId}/timeline
```

---

# 93. RAG API

```http
POST /api/v2/knowledge
GET  /api/v2/knowledge
POST /api/v2/knowledge/{id}/search
DELETE /api/v2/knowledge/{id}
```

文档：

```text
txt
md
pdf
epub
```

处理过程：

```text
Upload
 ↓
Parse
 ↓
Chunk
 ↓
Embed
 ↓
Index
```

---

# 94. Provider API

Provider 是 API 层与模型世界的边界。

---

# 95. Provider CRUD

```http
GET    /api/v2/providers
POST   /api/v2/providers
GET    /api/v2/providers/{id}
PATCH  /api/v2/providers/{id}
DELETE /api/v2/providers/{id}
```

---

# 96. Provider Schema

```ts
type Provider = {
  id: string

  name: string

  type:
    | 'openai-compatible'
    | 'anthropic'
    | 'gemini'
    | 'local'
    | 'custom'

  baseUrl: string

  auth: {
    type: 'api-key' | 'none' | 'custom-header'
  }

  models: ModelDefinition[]

  proxy?: ProxyConfig
}
```

---

# 97. API Key

API Key 永远不能出现在：

```text
GET /providers
```

返回值。

UI 只得到：

```json
{
  "configured": true
}
```

实际密钥存储：

```text
Windows → DPAPI
macOS → Keychain
Linux → OS Secret Service / encrypted store
```

原规划也明确要求密钥本地加密存储且不入库明文。

---

# 98. Model API

```http
GET /api/v2/providers/{providerId}/models
POST /api/v2/providers/{providerId}/models/refresh
```

---

# 99. Model Capabilities

```ts
type ModelCapabilities = {
  systemRole: boolean

  tools: boolean

  vision: boolean

  reasoning: boolean

  streaming: boolean

  promptCaching: boolean

  cacheType:
    | 'automatic-prefix'
    | 'explicit-breakpoint'
    | 'context-cache'
    | 'none'

  maxContextTokens: number

  maxOutputTokens: number
}
```

---

# 100. Provider Adapter Contract

内部 TypeScript API：

```ts
interface ProviderAdapter {
  capabilities(
    model: string
  ): Promise<ModelCapabilities>

  generate(
    request: ProviderRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderEvent>
}
```

Provider Adapter 只负责：

```text
V2 IR
 ↓
Provider Protocol
```

不能负责：

```text
Worldbook
Prompt Assembly
Memory
Agent
```

---

# 101. Provider Request

```ts
type ProviderRequest = {
  model: string

  messages: ProviderMessage[]

  tools?: ProviderTool[]

  sampling: SamplingParams

  cache?: ProviderCachePlan

  metadata?: {
    requestId: string
    snapshotId: string
  }
}
```

---

# 102. Provider Cache Plan

```ts
type ProviderCachePlan = {
  checkpoints: {
    tokenOffset?: number

    segmentId: string

    strategy:
      | 'automatic-prefix'
      | 'explicit-breakpoint'
      | 'context-cache'
  }[]
}
```

Provider 层根据能力翻译 CachePlan；例如 Anthropic 使用 cache control，Gemini 使用 context caching，而 OpenAI/DeepSeek/本地模型主要依赖稳定前缀。

---

# 103. Usage API

```http
GET /api/v2/usage
GET /api/v2/chats/{chatId}/usage
GET /api/v2/runs/{runId}/usage
```

---

# 104. Usage Schema

```ts
type Usage = {
  inputTokens: number

  cachedInputTokens: number

  freshInputTokens: number

  outputTokens: number

  reasoningTokens?: number

  estimatedCost?: number

  providerRaw?: unknown
}
```

---

# 105. Replay API

Replay 是 V2 Debug 能力的重要组成部分。

```http
POST /api/v2/prompt-snapshots/{snapshotId}/replay
```

Request：

```ts
{
  provider?: string

  model?: string

  sampling?: SamplingParams

  saveAsBranch?: boolean
}
```

---

# 106. Replay 原则

Replay 默认使用：

```text
Character Snapshot
Persona Snapshot
Preset Snapshot
Worldbook State
Memory State
Message Branch
Prompt Snapshot
```

而不是重新读取当前最新配置。

这样才能真正复现历史请求。

---

# 107. Prompt Inspector API

```http
GET /api/v2/runs/{runId}/inspector
```

返回：

```ts
type InspectorData = {
  snapshot: PromptSnapshot

  cache: CachePlan

  provider: {
    id: string
    model: string
  }

  usage?: Usage

  warnings: PromptWarning[]

  events: RuntimeEvent[]
}
```

---

# 108. Runtime Event API

```http
GET /api/v2/events
```

Query：

```text
chatId
runId
agentRunId
types
afterSequence
```

用于 Debug / Plugin / UI。

---

# 109. Event Types

【2026-09 修订】完整事件清单以 [technical-design.md](../technical-design.md) §5.4 **权威事件表**为唯一事实源（`域.对象.动作` 记法 + durable / deferred-durable / live 三档），本节不复制清单，只声明 API 侧约定：

- 初稿命名的 `message.branch_changed` / `agent.started` / `agent.step` / `agent.tool_called` / `agent.waiting` / `agent.completed` / `agent.failed` / `workflow.node_started` / `workflow.node_completed` / `generation.usage` **作废**——分别并入权威表的 `agent.run.*` / `agent.turn.*` / `tool.call.*` / `workflow.stage_*` / `usage.recorded` 等既有事件；分支切换属 chat 状态变更，走 `chat.updated`。
- 本规格新增、已反哺进权威表的事件（含分档）：`provider.fallback`（durable，§125 降级链审计）、`import.started / import.completed / import.failed`（durable）与 `import.progress`（live）、`export.started / export.completed / export.failed`（durable）、`memory.created / memory.updated`（deferred-durable）、`artifact.created / artifact.updated`（deferred-durable，artifacts 表本身已持久化，事件供审计）。
- §130–134 流程图中的事件名为初稿简写，按本节映射对应到权威事件。

---

# 110. Event Subscription

Plugin 可以订阅：

```ts
{
  events: [
    'message.created',
    'generation.completed',
    'agent.completed'
  ]
}
```

但 Plugin 不能默认订阅：

```text
所有事件
```

避免性能和隐私问题。

---

# 111. Plugin API

Plugin Manifest：

```ts
type PluginManifest = {
  id: string

  name: string

  version: string

  apiVersion: string

  permissions: Capability[]

  events?: string[]

  tools?: string[]

  panels?: string[]

  commands?: string[]
}
```

---

# 112. Plugin Permissions

核心：

```text
chat.read
chat.write

message.read
message.write

worldbook.read
worldbook.write

memory.read
memory.write

agent.read
agent.run

workspace.read
workspace.write

network.search
network.fetch

filesystem.read
filesystem.write

ui.panel
ui.message_action

storage.own
```

---

# 113. Prompt Mutation Permission

默认：

```text
Plugin
= NO prompt mutation
```

如果允许：

```text
prompt.tail.append
```

才可以修改：

```text
tail
```

禁止：

```text
prompt.header.modify
prompt.stableWB.modify
```

这样避免插件破坏 Prefix Cache。

现有规划已经明确提出“服务端钩子只允许具名 hook + 白名单参数，例如 `prompt:postBuild` 只允许修改 tail 区”。

---

# 114. Search API

```http
GET /api/v2/search
```

Query：

```text
q
scope=chats|messages|memory|characters|worldbooks
limit
```

例如：

```http
GET /api/v2/search?q=Seraphina&scope=messages
```

---

# 115. Chat Search

```http
POST /api/v2/chats/{chatId}/search
```

Request：

```ts
{
  query: string

  limit?: number

  branch?: 'active' | 'all'
}
```

---

# 116. Settings API

```http
GET /api/v2/settings
PATCH /api/v2/settings
```

配置：

```text
UI
Default Provider
Default Model
Default Preset
Context
Cache
Telemetry
Agent
Storage
Proxy
```

---

# 117. Runtime Health

```http
GET /api/v2/health
```

返回：

```json
{
  "status": "ok",
  "version": "2.0.0",
  "database": "ok",
  "runtime": "ok"
}
```

---

# 118. Runtime Diagnostics

```http
GET /api/v2/diagnostics
```

返回：

```text
Database
Storage
Provider
Prompt Compiler
Agent Runtime
Event Bus
Cache
Vector Index
```

状态：

```text
healthy
warning
error
```

---

# 119. Database Backup

```http
POST /api/v2/backup
GET  /api/v2/backups
POST /api/v2/backups/{id}/restore
```

Restore 属于高风险操作。

必须要求：

```text
confirmation token
```

并默认创建当前数据库快照。

---

# 120. Concurrency

所有资源修改使用：

```text
version
```

例如：

```ts
{
  id: "preset_123",
  version: 17
}
```

PATCH：

```http
If-Match: 17
```

如果当前已经：

```text
18
```

返回：

```text
VERSION_CONFLICT
```

避免多个 UI Tab / Agent 同时覆盖数据。

---

# 121. Idempotency

以下 API 必须支持：

```text
POST generate
POST agent run
POST workflow run
POST import
POST export
```

使用：

```http
Idempotency-Key
```

重复请求必须返回原来的：

```text
runId
```

而不是重复调用模型。

---

# 122. Cancellation

所有长任务接受：

```ts
AbortSignal
```

内部传播：

```text
HTTP Cancel
 ↓
Runtime CancellationToken
 ↓
Agent
 ↓
Tool
 ↓
Provider
```

---

# 123. Timeout

所有 Runtime 都必须有默认 Timeout。

例如：

```text
Provider request: 5 min
Tool: 30 sec
Agent: 10 min
Workflow: 30 min
Import: 10 min
```

具体值由 Settings 覆盖。

---

# 124. Retry Policy

默认只自动重试：

```text
network failure
timeout
429
temporary 5xx
```

不自动重试：

```text
invalid request
authentication failure
permission denied
tool invalid arguments
prompt compile error
```

---

# 125. Provider Fallback

允许配置：

```ts
type FallbackChain = {
  primary: ProviderRef

  fallbacks: ProviderRef[]
}
```

例如：

```text
Claude
 ↓ failure
DeepSeek
 ↓ failure
Local
```

但必须产生：

```text
provider.fallback
```

事件。

并且新 Provider 必须重新生成自己的 Prompt Serialization。

不能假设：

```text
Provider A Prompt
==
Provider B Prompt
```

---

# 126. API 与 Prompt Cache 的边界

这是 V2 API 设计中非常重要的一条：

```text
Client
 ↓
/generate
 ↓
Runtime
 ↓
Prompt Compiler
 ↓
Cache Planner
 ↓
Provider Adapter
```

而不是：

```text
Client
 ↓
自己拼 Prompt
 ↓
/provider
```

---

# 127. API 与 Agent 的边界

同样：

```text
Client
 ↓
Agent Run
 ↓
Agent Runtime
 ↓
Prompt Compiler
 ↓
Provider
```

而不是：

```text
Client
 ↓
直接调用多个模型
```

否则 Agent 的：

```text
Budget
Permission
Context
Resume
Telemetry
```

都会失效。

---

# 128. API 与 Memory 的边界

Memory 不直接修改 Chat History。

例如：

```text
Scribe Agent
 ↓
Memory API
 ↓
Dossier
```

而不是：

```text
Scribe
 ↓
修改 message.content
```

原始聊天记录永远作为 Source of Truth。

---

# 129. API 与 Artifact 的边界

Agent 之间传递大量内容：

```text
禁止：
Prompt → 50k 字符 → Child Agent
```

优先：

```text
Artifact
 ↓
artifactId
 ↓
Child Agent Tool
 ↓
按需读取
```

这样减少 Context 和 Token 消耗。

---

# 130. Recommended API Flow — Normal Chat

完整一次普通对话：

```text
POST /chats/{id}/messages
        ↓
POST /chats/{id}/generate
        ↓
generation.started
        ↓
prompt.compiling
        ↓
prompt.compiled
        ↓
provider request
        ↓
generation.delta
        ↓
generation.usage
        ↓
generation.completed
        ↓
message.created
```

---

# 131. Recommended API Flow — Agent Chat

```text
POST /agents/director/runs
        ↓
agent.started
        ↓
context.resolve
        ↓
prompt.compiled
        ↓
agent.tool_called
        ↓
agent.delegate
        ↓
child agent
        ↓
child.completed
        ↓
parent.resume
        ↓
final generation
        ↓
artifact.created
        ↓
message.created
```

---

# 132. Recommended API Flow — Writing Workflow

```text
POST /workflows/writing/runs
        ↓
workflow.started

Outline
 ├─ Agent
 └─ Memory Search
        ↓
Draft
        ↓
Parallel:
 ├─ Persona Checker
 ├─ Continuity Checker
 └─ Style Checker
        ↓
Revision
        ↓
Final Artifact
        ↓
Commit Message
```

---

# 133. Recommended API Flow — Prompt Debug

```text
POST /chats/{id}/prompt/compile
        ↓
snapshotId
        ↓
GET /prompt-snapshots/{id}
        ↓
GET /prompt-snapshots/A/diff/B
        ↓
GET /runs/{id}/cache-break
```

最终 UI 能显示：

```text
Why did my cache break?

Worldbook #183
New activation

Affected:
31,204 tokens
```

---

# 134. Recommended API Flow — Replay

```text
Prompt Snapshot
      ↓
POST /replay
      ↓
New Generation
      ↓
New Snapshot
      ↓
Diff
```

因此 Replay 不修改历史。

---

# 135. API Security Boundary

虽然当前项目是 Local-first，但 API 仍然必须假定：

```text
Plugin ≠ Trusted
Agent ≠ Trusted
Imported Asset ≠ Trusted
Provider Response ≠ Trusted
Tool Input ≠ Trusted
```

所有：

```text
JSON
Plugin
Tool arguments
Imported files
Provider structured output
```

都必须经过 Schema Validation。

---

# 136. Zod Validation

所有 API：

```ts
const schema = z.object(...)
```

统一：

```text
parse
 ↓
normalize
 ↓
validate
 ↓
runtime
```

不要：

```text
req.body as SomeType
```

---

# 137. API Logging

默认记录：

```text
requestId
route
duration
status
resourceId
runId
```

禁止记录：

```text
API Key
Authorization
完整 Prompt
完整聊天内容
```

除非用户显式开启：

```text
Debug Prompt Logging
```

---

# 138. Sensitive Data

日志默认：

```text
Prompt → hash / metadata
Message → id
Provider key → never
```

Inspector 才显示实际 Prompt。

---

# 139. API Rate Limiting

Local-first 默认限制较宽松。

但 Agent / Plugin：

```text
max concurrent runs
max tool calls
max provider calls
```

必须强制。

---

# 140. Event Ordering Guarantee

同一个 Run 内：

```text
sequence
```

严格递增。

例如：

```text
1 generation.started
2 prompt.compiling
3 prompt.compiled
4 generation.delta
5 generation.delta
6 usage.recorded
7 generation.completed
```

不同 Run 之间不保证全局顺序。

---

# 141. Event Persistence

【2026-09 修订】持久化按总设计 §5.4 的 **durability 三档**执行（`events.durability` 列），不是"generation.* 全持久化"：

```text
durable            → 落 events 表（幂等 event_id）
deferred-durable   → 异步批量落库，允许延迟不允许丢
live               → 只走 SSE 内存广播（generation.delta / prompt.compiling / import.progress），不落表
```

初稿的"generation.* 持久化"作废——`generation.delta` 每 token 一条，落表会撑爆 events 表。新增事件类型必须显式声明分档。UI 临时事件可只保留内存。

---

# 142. SSE Reconnect

客户端断线后：

```http
GET /api/v2/runs/{runId}/events
Last-Event-ID: 37
```

服务器从：

```text
38
```

继续发送。

因此 Agent / Generation 不依赖 UI 长连接存活。

---

# 143. Long-running Run Principle

任何：

```text
Agent
Workflow
Import
Export
Embedding
RAG
```

都必须：

```text
create run
 ↓
return runId immediately
 ↓
SSE
```

不要让 HTTP Request 长时间保持到任务完成。

---

# 144. API Contract Testing

每一个 Provider / Runtime 都必须有 Contract Test。

例如：

```text
POST /generate
 ↓
Fake Provider
 ↓
SSE fixture
 ↓
assert:
  events
  usage
  snapshot
  message
```

---

# 145. Prompt Compiler Contract Test

输入：

```text
Character
Persona
Preset
Worldbook
Chat
Memory
```

输出必须：

```text
Segments
Serialized Prompt
CachePlan
Snapshot
```

且：

```text
same input
+
same compiler version
=
same snapshot
```

除非明确存在：

```text
volatile macro
```

---

# 146. Cache Contract Test

模拟：

```text
1000 rounds
```

验证：

```text
stable prefix
physicalOrder
worldbook graduation
summary append
history append
macro freezing
```

任何非显式变化导致：

```text
stable prefix changed
```

测试失败。

---

# 147. Agent Contract Test

必须覆盖：

```text
spawn
delegate
await
handoff
cancel
pause
resume
timeout
budget
permission
nested agent
```

---

# 148. API Compatibility Policy

V2 API：

```text
Minor version
=
向后兼容

Major version
=
允许破坏性变更
```

例如：

```text
2.0
2.1
2.2
```

保持：

```text
/api/v2
```

---

# 149. Internal API vs Public API

必须区分：

```text
Public API
```

和：

```text
Internal Runtime API
```

例如：

```ts
PromptCompiler.compile()
```

属于内部 API。

HTTP：

```http
POST /api/v2/chats/{id}/prompt/compile
```

属于 Public API。

未来可以让 Desktop / Plugin / CLI 直接使用 Runtime API，而不经过 HTTP。

---

# 150. Type Sharing

前后端共享：

```text
packages/core
packages/api-types
```

例如：

```text
GenerateRequest
GenerateResponse
RuntimeEvent
PromptSnapshot
CachePlan
AgentDefinition
```

统一定义。

禁止：

```text
Frontend Type
≠
Backend Type
```

---

# 151. Recommended Package Structure

【2026-09 修订】初稿漏了 packages/adapters 与 packages/st-compat；权威仓库结构以 [technical-design.md](../technical-design.md) §7 为准。本规格的新增贡献是 **packages/api-types**（已并入总设计 §7）：

```text
packages/
├─ api-types/       # 前后端共享线格式 DTO（chat / generation / prompt / cache / agent / workflow / memory / provider / events）
├─ core/            # 纯 TS 无 IO：ir / compiler / worldbook / macros / budget / cache / serializer
├─ runtime/         # events / permissions / scheduler / snapshots / context
├─ agent/           # runtime / workflow / tools / skills / memory / artifacts
├─ adapters/        # openai / anthropic / gemini / local
└─ st-compat/       # character / worldbook / preset / chat
```

---

# 152. MVP API Scope

【2026-09 修订】本节对应总设计路线图 **P0**；§153–156 的初稿 M 编号已重映射为 P 编号。第一阶段只实现：

```text
POST   /chats
GET    /chats
GET    /chats/:id

POST   /chats/:id/messages
GET    /chats/:id/messages

POST   /chats/:id/generate
GET    /runs/:id/events
POST   /runs/:id/cancel

POST   /chats/:id/prompt/compile
GET    /prompt-snapshots/:id

GET    /providers
POST   /providers
GET    /providers/:id/models

GET    /characters
POST   /characters

GET    /worldbooks
POST   /worldbooks

GET    /presets
POST   /presets
```

---

# 153. P2 Cache API

加入：

```text
GET  /chats/:id/cache/telemetry

POST /cache/simulate

GET  /runs/:id/cache-break

GET  /prompt-snapshots/:a/diff/:b
```

---

# 154. P3 Agent API

加入：

```text
GET  /agents
POST /agents

POST /agents/:id/runs
GET  /agent-runs/:id

POST /agent-runs/:id/cancel
POST /agent-runs/:id/pause
POST /agent-runs/:id/resume

POST /agent-runs/:id/delegate
POST /agent-runs/:id/handoff

GET /tools
GET /skills
```

---

# 155. P4 Workflow / Memory API

加入：

```text
GET  /workflows
POST /workflows

POST /workflows/:id/runs
GET  /workflow-runs/:id

POST /chats/:id/memory/search

GET  /chats/:id/summaries
POST /chats/:id/summaries

GET  /chats/:id/dossier
GET  /chats/:id/timeline

POST /knowledge
POST /knowledge/:id/search
```

---

# 156. P5 Plugin API

加入：

```text
GET  /plugins
POST /plugins
DELETE /plugins/:id

GET  /events

plugin:
  tools
  panels
  commands
  subscriptions
```

---

# 157. Final API Architecture

最终 API 可以归纳为：

```text
/api/v2
│
├─ /chats
│
├─ /messages
│
├─ /generations
├─ /runs
│
├─ /prompt-snapshots
├─ /cache
│
├─ /characters
├─ /personas
├─ /worldbooks
├─ /presets
│
├─ /agents
├─ /agent-runs
├─ /tools
├─ /skills
│
├─ /workflows
├─ /workflow-runs
├─ /artifacts
│
├─ /memory
├─ /knowledge
├─ /timeline
│
├─ /providers
├─ /models
│
├─ /plugins
├─ /events
│
├─ /import
├─ /export
├─ /replay
│
├─ /usage
├─ /settings
├─ /diagnostics
└─ /health
```

---

# 158. 最重要的 Runtime 链

WhisperTavern V2 最核心的一次请求应该永远遵循：

```text
                  USER
                   │
                   ▼
             POST /generate
                   │
                   ▼
          ┌─────────────────┐
          │  Runtime Run    │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ Context Resolve │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ Prompt Compiler │
          └────────┬────────┘
                   │
                   ├──────────────┐
                   ▼              ▼
              Prompt IR       CachePlan
                   │              │
                   └──────┬───────┘
                          ▼
                   Prompt Snapshot
                          │
                          ▼
                  Provider Adapter
                          │
                          ▼
                       MODEL
                          │
                          ▼
                   Runtime Events
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
            UI        Telemetry    Agent
              │
              ▼
           Message
```

---

# 159. 最重要的设计约束

### Constraint 1

```text
Client MUST NOT construct final Provider Prompt.
```

### Constraint 2

```text
Only Prompt Compiler MAY construct final Prompt.
```

### Constraint 3

```text
Provider Adapter MUST NOT modify semantic Prompt content.
```

### Constraint 4

```text
Agent MUST NOT bypass Permission / Budget.
```

### Constraint 5

```text
Tool MUST validate arguments independently.
```

### Constraint 6

```text
Runtime MUST persist long-running state.
```

### Constraint 7

```text
Every generation MUST have a Prompt Snapshot.
```

### Constraint 8

```text
Every cache invalidation SHOULD have a reason.
```

### Constraint 9

```text
Every long-running run MUST support cancellation.
```

### Constraint 10

```text
Every resumable run MUST survive application restart.
```

---

# 160. Final Design Principle

WhisperTavern V2 API 不应该被设计成：

> “给前端提供一堆 CRUD 接口。”

真正的 API 架构应该是：

```text
                ┌───────────────────┐
                │       Client      │
                └─────────┬─────────┘
                          │
                     Public API
                          │
                ┌─────────▼─────────┐
                │   Runtime Layer   │
                └─────────┬─────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
 Prompt Runtime      Agent Runtime      Event Runtime
       │                  │                  │
       ▼                  ▼                  ▼
 Cache Planner        Workflow          Telemetry
       │                  │                  │
       └──────────────────┼──────────────────┘
                          ▼
                  Provider Runtime
                          │
                          ▼
                         LLM
```

因此：

> **API 是 Runtime 的控制面，而不是业务逻辑的堆放区。**

Prompt Compiler、Cache Planner、Agent Runtime、Memory Runtime 都必须拥有自己的内部 Contract；HTTP API 只是把这些能力安全、可观察、可恢复地暴露给 Web UI、Desktop、CLI 和 Plugin。

最终形成：

```text
                    WhisperTavern V2
                           │
              ┌────────────┴────────────┐
              │                         │
          Control Plane             Runtime Plane
              │                         │
          HTTP / SSE             Compiler / Agent
              │                         │
              └────────────┬────────────┘
                           │
                    Prompt Snapshot
                           │
                     Provider Adapter
                           │
                          LLM
```

**这才是 V2 与传统酒馆 API 最大的架构差异：不是“API 更多”，而是 API 背后已经存在一个真正的 AI Runtime。**