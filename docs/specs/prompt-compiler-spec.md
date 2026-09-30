# WhisperTavern V2 — Prompt Compiler Specification

> **文件：** `docs/specs/prompt-compiler-spec.md`  
> **版本：** V2.7（2026-09-29 S33a 修订：**§10 Segment Source 补 `character` 源的生产者与槽位填充语义**——该变体自 P0 起只有声明（`diff.ts` 已映射 `CHARACTER_CHANGED`）却**零生产者**、`characters.description/personality/scenario` 零消费者、10 个真实预设的 charDescription/charPersonality 全是 `content:""` 空壳标记，属悬空虚设，本轮补齐；确立"① 槽位填充（原地替换标记段内容，段的 id/placement/prompt_order 一概不动，依据 §81 顺序即语义序；段的 source 仍为 preset）/ ② 角色贡献（`character:<id>:<field>` 稳定 ID 的 header 独立贡献，供 SegmentDiff 精确归因）/ ③ 填充范围是正白名单（只含 charDescription/charPersonality；worldInfo*/chatHistory/personaDescription 各有其主，重复填充即双注入）"三分离；补零漂移不变量（未绑定/空卡 → 空槽位表 + 空贡献集 + `character_id` NULL → header 逐字节不变）与 per-(chat, character) 命名空间关系（键落 `prompt_snapshots.character_id`，migration v11）。先前 V2.6 修订内容：2026-09-28 S32 修订：§86 补落地注记——"Tool Result 默认进 tail"的精确口径 = **末尾连续输入段**（`role ∈ {user, tool}`），并说明为何不能"凡 tool 结果都注 tail"（zone-first 排序会打乱 tool 结果与其调用的配对）；tool 结果段经 `source.type='toolResult'` + `toolCallId` 溯源。先前 V2.5 修订内容：S19 修订：§54 providerStrategy 定稿——翻译指令落 contracts ProviderStrategySchema（breakpoints 投影 afterPartIndex/stableZoneTokens 不含 freshWB/prefixTooSmall 阈值数据），装配条件 checkpoints>0，providerCacheType 由 run.ts 注入；§71 注记 CACHE_UNSAFE_MACRO 等不动。先前 V2.4 修订内容：S18 Budget/CachePlan 落地口径：§46–§58 补落地注记——Budget Manager 缺省值、§49 裁剪序权威化落 contracts（BUDGET_TRIM_ORDER，tail→injection→freshWB→elasticHistory→summary→stableWB→header）、CachePlan 装配算法（version=1、automatic 断点三位置、enabled=false 段不参与序列化）、Elastic History 无状态整体推出范围、§71 登记 BUDGET_TRIM。先前 V2.3 修订内容：§16 stableWB/freshWB 区默认稳定性改 session（决策 A）、§29 注记 stale 转场 S17 不产出、§71 登记 WORLD_BOOK_RETIRED/WORLD_BOOK_DEACTIVATED。先前 V2.2 修订内容：§40 时间日期 UTC 格式与 {{random}} 确定性种子流、§41 evaluate 增 args、§43 稳定区枚举与触发判据/处置粒度/三档映射、§44 user 缺省 'User'、§45 MacroContext 增 rng/seed 注入位、§71 登记 CACHE_UNSAFE_MACRO/UNKNOWN_MACRO/EVAL_MACRO_REJECTED 并退役 MACRO_UNEXPANDED_P0。先前 V2.1 修订内容：①§30 stableWB 成员资格与当轮激活解耦；②§32/§111 summary 维持 history 之前、追加=显式失效事件；③§83 撤销"静态 Injection 进稳定区"；④§12/§58 补全 ST 槽位枚举与消息级失效原因）  
> **状态：** Implementation Specification  
> **所属系统：** WhisperTavern V2  
> **文档层级：** [technical-design.md](../technical-design.md) 之下的 **Prompt Compiler 模块详细规格**  
> **上游：** Application Runtime / Agent Runtime  
> **下游：** Provider Adapter  
>
> **核心职责：**
>
> ```text
> Runtime State
>      ↓
> Prompt Compiler
>      ↓
> Prompt IR
>      ↓
> CachePlan
>      ↓
> Prompt Snapshot
>      ↓
> Provider Request
> ```
>
> Prompt Compiler 是 WhisperTavern V2 中唯一允许生成最终模型 Prompt 的核心模块。

---

# 1. Overview

## 1.1 Purpose

Prompt Compiler 负责将当前 Runtime 状态编译为：

1. Provider 无关的 Prompt IR；
2. 可缓存的 Segment 结构；
3. 最终 Prompt 序列；
4. CachePlan；
5. Prompt Snapshot。

输入：

```text
Character
Persona
Preset
Worldbook
Chat
Memory
Agent Context
Workflow Context
Runtime Variables
Provider Capabilities
Context Budget
```

输出：

```text
PromptIR
CachePlan
SerializedPrompt
PromptSnapshot
```

---

# 2. Design Principles

## 2.1 Single Source of Truth

系统中只能存在一个 Prompt 编译入口：

```ts
compilePrompt()
```

禁止：

```text
Frontend 拼 Prompt
Agent 自己拼 Prompt
Worldbook 自己拼 Prompt
Provider Adapter 自己补 Prompt
Plugin 自己插 Prompt
```

正确结构：

```text
Plugin
Agent
Worldbook
Memory
        ↓
  Runtime Context
        ↓
  Prompt Compiler
        ↓
   Provider Adapter
```

---

# 3. Compiler Pipeline

完整 Pipeline：

```text
                    Runtime State
                         │
                         ▼
                ┌─────────────────┐
                │  Normalize      │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Resolve Context  │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Macro Analysis   │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Worldbook Match  │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Semantic Layout  │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Cache Placement  │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Budget Manager   │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Validation      │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Serialization   │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │ Prompt Snapshot │
                └─────────────────┘
```

---

# 4. Compiler API

核心 API：

```ts
export interface PromptCompiler {
  compile(
    input: CompileInput
  ): Promise<CompileResult>
}
```

输入：

```ts
export interface CompileInput {
  chat: ChatContext

  character: CharacterContext

  persona?: PersonaContext

  preset: PresetContext

  worldbook?: WorldbookContext

  memory?: MemoryContext

  agent?: AgentContext

  workflow?: WorkflowContext

  variables: RuntimeVariables

  provider: ProviderCapabilities

  budget: ContextBudget

  options?: CompileOptions
}
```

输出：

```ts
export interface CompileResult {
  ir: PromptIR

  cachePlan: CachePlan

  serialized: SerializedPrompt

  snapshot: PromptSnapshot

  diagnostics: Diagnostic[]
}
```

---

# 5. Determinism

对于相同输入：

```text
CompileInput A
```

必须得到：

```text
PromptIR A
CachePlan A
SerializedPrompt A
```

相同的内容哈希。

即：

```text
compile(A) === compile(A)
```

除非输入中存在：

```text
volatile macro
```

或者：

```text
explicit runtime nonce
```

---

# 6. Compiler Version

每个 Snapshot 必须记录：

```ts
compilerVersion: string
```

例如：

```text
2.0.0
```

Compiler 行为发生破坏性变化时：

```text
2.x → 3.x
```

必须产生新的 Golden Snapshot。

---

# 7. Prompt IR

Prompt IR 是 Compiler 的核心中间表示。

```ts
export interface PromptIR {
  schemaVersion: number

  segments: PromptSegment[]

  zones: PromptZone[]

  metadata: PromptMetadata
}
```

---

# 8. Prompt Segment

```ts
export interface PromptSegment {
  id: string

  source: SegmentSource

  role: PromptRole

  content: string

  semanticPlacement: SemanticPlacement

  cachePlacement: CachePlacement

  stability: StabilityClass

  order: number

  tokenCount: number

  dependencies: string[]

  enabled: boolean

  metadata?: Record<string, unknown>
}
```

---

# 9. Segment ID

Segment ID 必须稳定。

禁止：

```ts
id = randomUUID()
```

否则每次编译都会导致：

```text
IR Diff
Cache Diff
Snapshot Diff
```

---

## 9.1 ID 来源

优先：

```text
assetId + logicalPath
```

例如：

```text
character:abc:description
preset:default:system
worldbook:book1:entry:183
chat:123:message:982
summary:chat123:block:7
```

---

# 10. Segment Source

```ts
export type SegmentSource =
  | {
      type: 'character'
      assetId: string
      field: string
    }
  | {
      type: 'persona'
      assetId: string
    }
  | {
      type: 'preset'
      presetId: string
      segmentId: string
    }
  | {
      type: 'worldbook'
      worldbookId: string
      entryId: string
    }
  | {
      type: 'summary'
      summaryId: string
    }
  | {
      type: 'message'
      messageId: string
    }
  | {
      type: 'memory'
      memoryId: string
    }
  | {
      type: 'agent'
      agentId: string
    }
  | {
      type: 'workflow'
      workflowId: string
      stageId: string
    }
  | {
      type: 'artifact'          // 补（2026-09）：Agent 产物，供 Inspector 溯源
      artifactId: string
      runId?: string
    }
  | {
      type: 'toolResult'        // 补（2026-09）：Tool 输出进 Context 后的溯源
      toolCallId: string
    }
  | {
      type: 'plugin'
      pluginId: string
      contributionId: string
    }
  | {
      type: 'runtime'
      key: string
    }
```

【2026-09-29 修订（S33a/WP4.4）】**`character` 源的生产者与槽位填充语义落地**（此前该变体自 P0 起只有声明、`core/serializer/diff.ts` 早已把它映射成 `CHARACTER_CHANGED`，但**零生产者**，属悬空虚设）。

（1）**两个职责分离，别混用**：

```text
① 槽位填充（slot fill）—— 让角色卡正文落进**作者排好的位置**
   ST 预设里的 charDescription / charPersonality 是"空壳标记"（只声明位置，content 为空）。
   编译时用角色卡对应字段**原地替换**该标记段的内容，段的 id / role / placement / prompt_order
   **一概不动** —— 依据 §81「顺序即语义序」：标记段的位置就是内容该落的位置，
   另发一条贡献会丢掉作者在 prompt_order 里排的序。
   段的 source 仍为 `preset`（它确实是预设声明的段）；角色卡自身的溯源由 ② 承载。

② 角色贡献（character contribution）—— 让"角色卡变了"可被精确归因
   `packages/runtime/src/generation/character.ts` 产 `{ type:'character', assetId, field }`
   的 header 区独立贡献，段 ID = `character:<characterId>:<field>`（§9 稳定 ID = assetId + logicalPath，
   禁 randomUUID）。换角色换 ID、换字段换 ID，于是 SegmentDiff 能把变更精确落到一条段。

③ 填充范围是**正白名单**，只含 ① 的两个槽：
   charDescription → characters.description
   charPersonality → characters.personality
   worldInfoBefore/After（世界书 builder 产）、chatHistory（消息链产）、
   personaDescription（persona builder 产）**各有其主**，在此重复填充即双注入。
```

（2）**零漂移不变量**：未绑定角色（`chats.character_id IS NULL`）、角色行已删、或字段为空白 → 槽位表为空、角色贡献为空集，且快照 `character_id` 写 NULL。此时 header 与引用 `character` 源之前**逐字节一致**（金样基线与 P2 百轮缓存门禁的前提）。

（3）**缓存纪律**：角色卡是会话内静态资产，进 header 区（§19 Header 允许 Character Description，要求 `stability >= session`）。生产者不声明 stability，按区默认推导。

（4）**与 per-(chat, character) 命名空间的关系**（worldbook-cache-design §6）：角色卡进 header 后，各角色的稳定前缀天然不同 → 同 chat 内不同角色是**两条独立链**。命名空间键落 `prompt_snapshots.character_id`（migration v11），§41 遥测与 §42 二分诊断均按它取前驱；否则群聊里"上一轮"会取到别的角色的快照，每轮都报一次无意义的 CacheBreak。群聊多成员（`chat_members`）归 S33b，届时只换 ② 的输入（单值绑定 → 成员集），段身份口径不变。

---

# 11. Role

```ts
export type PromptRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
```

Role 是语义属性。

不要通过字符串推断：

```text
[System]
```

---

# 12. Semantic Placement

Semantic Placement 表示：

> **这个 Segment 按兼容语义应该出现在哪里。**

```ts
export type SemanticPlacement =
  | {
      type: 'header'
      order: number
    }
  | {
      type: 'worldbook'
      position:
        | 'before'    // position 0
        | 'after'     // position 1
        | 'anTop'     // position 2
        | 'anBottom'  // position 3
        | 'depth'     // position 4（atDepth，配 depth）
        | 'emTop'     // position 5
        | 'emBottom'  // position 6
        | 'outlet'    // position 7（ST 1.18 出口注入点，配 outletName）
      depth?: number
      outletName?: string
      order: number
    }
  | {
      type: 'history'
      order: number
    }
  | {
      type: 'injection'
      depth: number
      order: number
    }
  | {
      type: 'tail'
      order: number
    }
```

---

# 13. Cache Placement

Cache Placement 与 Semantic Placement 必须完全分离。

```ts
export type CachePlacement =
  | {
      zone: 'header'
    }
  | {
      zone: 'stableWB'
    }
  | {
      zone: 'freshWB'
    }
  | {
      zone: 'summary'
    }
  | {
      zone: 'history'
    }
  | {
      zone: 'injection'
    }
  | {
      zone: 'tail'
    }
```

---

# 14. 为什么必须分离

例如一个酒馆 Worldbook Entry：

```text
Semantic:
worldInfoBefore
```

可以被编译为：

```text
SemanticPlacement:
worldbook/before
```

但 Cache Placement：

```text
stableWB
```

这两个概念不能合并。

否则为了缓存优化而改变酒馆语义。

---

# 15. Stability

```ts
export type StabilityClass =
  | 'static'
  | 'session'
  | 'request'
  | 'message'
  | 'volatile'
```

含义：

### static

整个资产生命周期稳定。

### session

当前 Session 内稳定。

### request

单次请求内稳定。

### message

跟随当前消息变化。

### volatile

每次编译都可能变化。

---

# 16. Stability Inference

Compiler 自动分析：

```text
content
+
macro dependencies
+
runtime dependencies
```

得到：

```text
stability
```

例如：

```text
{{char}}
```

默认：

```text
session
```

而：

```text
{{time}}
```

默认：

```text
volatile
```

**S17 修订（2026-09-22）**：stableWB / freshWB 段的区默认稳定性为 **session**（决策 A）——世界书条目几乎必含 `{{user}}` 等 session 级宏，若区默认为 static 则 Macro Cache Rule（§43）会把含 session 宏的条目判 CACHE_UNSAFE_MACRO 全量移 tail，稳定区恒空、分区空转。改为 session 后 session 宏不触发（与 §43 示例"header 段含 {{char}} 不触发"对齐）；`{{random}}`(volatile)/`{{roll}}`(request)/`{{lastMessage}}`(message) 仍触发 → 移 tail，正是 R-P2-4 要隔离的逐轮易变宏。

---

# 17. Manual Stability Override

允许：

```ts
stabilityOverride?: StabilityClass
```

但必须记录：

```text
diagnostic.warning
```

例如：

```text
User manually marked {{time}} as session-stable.
```

系统不能假装它真的稳定。

---

# 18. Zone Definition

```ts
export type PromptZoneName =
  | 'header'
  | 'stableWB'
  | 'freshWB'
  | 'summary'
  | 'history'
  | 'injection'
  | 'tail'
```

默认顺序：

```text
header
↓
stableWB
↓
freshWB
↓
summary
↓
history
↓
injection
↓
tail
```

但是：

> Zone 顺序是 Cache Serialization 默认策略，不代表 SillyTavern 原始语义槽位。

Compatibility Mode 可以使用 Provider-specific serialization。

---

# 19. Header

Header 允许：

```text
System Prompt
Character Description
Persona
Static Preset
Static Rules
```

要求：

```text
stability >= session
```

否则：

```text
diagnostic = CACHE_BREAK_RISK
```

---

# 20. Stable Worldbook

stableWB 只允许：

```text
cacheState = stable
```

的 Worldbook Entry。

并且：

```text
physicalOrder
```

固定。

---

# 21. Physical Order

每个 Worldbook Runtime Entry：

```ts
interface WorldbookRuntimeEntry {
  entryId: string

  physicalOrder: number

  cacheState:
    | 'unseen'
    | 'fresh'
    | 'stable'
    | 'stale'
    | 'retired'
}
```

---

# 22. Worldbook Graduation

错误实现：

```text
fresh:
A B C D

graduate D

sort:
A D B C
```

禁止。

正确实现：

```text
Round 1:
A B C

Round 2:
A B C D

Round 3:
A B C D
```

D：

```text
fresh → stable
```

但是：

```text
physicalOrder(D)
```

不改变。

---

# 23. Worldbook Activation Pipeline

Worldbook 必须分为两个阶段：

```text
Activation
    ↓
Placement
```

---

## 23.1 Activation

输入：

```text
Recent Messages
Character
Worldbook
Scan Depth
Runtime State
```

输出：

```ts
ActivatedWorldbookEntry[]
```

---

## 23.2 Placement

输入：

```text
Activated Entries
+
Semantic Placement
+
Cache State
```

输出：

```text
PromptSegment[]
```

---

# 24. Worldbook Activation Result

```ts
interface WorldbookActivation {
  entryId: string

  activated: boolean

  reason:
    | 'keyword'
    | 'sticky'
    | 'group'
    | 'recursive'
    | 'manual'
    | 'probability'

  matchedKeywords: string[]

  sourceMessageIds: string[]

  score?: number
}
```

---

# 25. Worldbook Compatibility

必须支持的语义：

```text
primary keywords
secondary keywords

AND ANY
AND ALL
NOT ANY
NOT ALL

case sensitivity
match whole words

scan depth
recursive
sticky
cooldown
delay

probability

group
group scoring

character filter
match scope
```

若某字段尚未实现：

```text
diagnostic:
UNSUPPORTED_SEMANTIC
```

不得静默忽略。

---

# 26. Worldbook Group

Group 的选择发生在 Activation 阶段。

例如：

```text
Group A
 ├─ Entry 1 score 10
 ├─ Entry 2 score 30
 └─ Entry 3 score 20
```

如果策略：

```text
maxScore
```

只激活：

```text
Entry 2
```

Cache Engine 不参与 Group 决策。

---

# 27. Worldbook Sticky

Sticky 状态属于：

```text
Worldbook Runtime State
```

而不是：

```text
Prompt Segment
```

例如：

```ts
stickyUntil: number
```

Compiler 只读取状态。

---

# 28. Worldbook Cooldown

同样：

```ts
cooldownUntil?: number
```

Compiler 不自行修改 cooldown。

Activation Engine 负责：

```text
update state
```

Compiler 负责：

```text
consume state
```

---

# 29. Worldbook Cache State

```text
unseen
 ↓
fresh
 ↓
stable
 ↓
stale
 ↓
retired
```

注意：

```text
activationState
```

和：

```text
cacheState
```

完全独立。

一个 Entry 可以：

```text
activated = false
cacheState = stable
```

这是合法状态。

**S17 注记（2026-09-22）**：`stale` 转场 S17 不产出（狐神抚"stale 标记而非删除"归 P4 评估，保留枚举无转场）。

---

# 30. Stable Entry 未激活怎么办

【2026-09 修订】按模式区分：

Performance Mode（默认）：

```text
stable but inactive
```

照常发送。

stableWB 成员资格由 chatCache（内容哈希集合）决定，与当轮激活无关。失活条目只有通过 retirement（显式 Cache Invalidation Event，§31）才移除——从序列中部静默移除等于未声明的前缀断裂，且 CacheBreakReason 里没有对应原因。

Compatibility Mode：

```text
按 SillyTavern 语义即时移除
```

移除产生 `WORLD_BOOK_DEACTIVATED` 失效事件（§58），不静默。

两种模式下：

```text
physicalOrder
```

不因此改变。

即：

```text
Cache state ≠ Activation state
```

---

# 31. Retirement

Entry 可以因为：

```text
inactiveRounds > threshold
```

进入：

```text
retired
```

退休意味着：

```text
explicit cache invalidation
```

必须产生：

```text
CacheBreakReason:
WORLD_BOOK_RETIREMENT
```

---

# 32. Summary

【2026-09 修订】summary 区位于 history **之前**（总设计 §10.1 决策）：

```text
header
stableWB
freshWB
summary
history
injection
tail
```

禁止的是"无失效语义的摘要写入"，而不是这个布局：

- 摘要块只能以冻结 checkpoint（§33）追加；禁止原地改写、禁止每轮重写摘要文本；
- 追加新摘要块 = 显式 `SUMMARY_CHECKPOINT` CacheBreak 事件，其后历史一次性重发（40–80 楼才发生一次），之后恢复稳态；
- 成本依据（为何不把 summary 移到 history 之后）：history 每轮追加会使前缀匹配止于 history 末尾，摘要链永远无法命中缓存、每轮全价重发且随链增长——累计成本远高于"追加时重发一次历史"。

---

# 33. Summary Checkpoint

```ts
interface SummaryBlock {
  id: string

  seq: number

  content: string

  covers: {
    fromMessageId: string
    toMessageId: string
  }

  frozen: boolean

  contentHash: string

  createdAt: string
}
```

Frozen Summary：

```text
不可原地修改
```

---

# 34. History

History 默认：

```text
append-only
```

```text
H1
H2
H3
H4
```

新增：

```text
H5
```

变成：

```text
H1
H2
H3
H4
H5
```

---

# 35. Message Branch

Branch 不修改原消息。

```text
H3
├── H4a
└── H4b
```

Compiler 只读取：

```text
activeLeaf
```

对应的 ancestor chain。

---

# 36. Swipe

Swipe：

```text
same parent
different variant
```

例如：

```text
H4a
H4b
H4c
```

Compiler 只选择当前 active variant。

---

# 37. Macro Engine

Macro Engine 是独立子模块：

```ts
interface MacroEngine {
  analyze(
    content: string,
    context: MacroContext
  ): MacroAnalysis

  expand(
    content: string,
    context: MacroContext
  ): ExpandedContent
}
```

---

# 38. Macro Analysis

```ts
interface MacroAnalysis {
  macros: MacroOccurrence[]

  stability: StabilityClass

  dependencies: string[]

  diagnostics: Diagnostic[]
}
```

---

# 39. Macro Occurrence

```ts
interface MacroOccurrence {
  name: string

  raw: string

  start: number
  end: number

  volatility: StabilityClass

  dependencies: string[]
}
```

---

# 40. Macro Categories

默认：

```text
{{user}}
SESSION

{{char}}
SESSION

{{persona}}
SESSION

{{lastMessage}}
MESSAGE

{{time}}
VOLATILE

{{date}}
VOLATILE

{{random}}
VOLATILE

{{roll:1d20}}
REQUEST
```

具体 Macro 表属于：

```text
macro-registry.ts
```

而不是 Compiler 硬编码。

**S16 落地口径（2026-09-22 修订）**：

```text
{{time}}    → UTC HH:MM（24 小时制，getUTCHours/getUTCMinutes 零填充）
{{date}}    → UTC YYYY-MM-DD（getUTCFullYear/getUTCMonth+1/getUTCDate 零填充）
{{random}}  → 整数 [1,100]（含）；确定性种子流
{{roll}}    → 骰子求和，支持 NdM / NdM±K（如 1d20 / 2d6 / 1d20+3）；
             无效参数保留原文，不报错
```

确定性口径：`{{random}}`/`{{roll}}` 使用引擎级**确定性种子流**（RNG 种子 = `sha256Hex(now|chatId)` → mulberry32）。同输入（同 now 同 chat）任意次编译逐字节一致、跨运行可复现（§5 Determinism）；同一轮内多个 `{{random}}` 取值不同（保留 ST 语义）。种子**不得**引入 snapshotId/messageId 等每轮新建标识——否则破坏确定性测试与金样。

---

# 41. Macro Registry

```ts
interface MacroDefinition {
  name: string

  volatility: StabilityClass

  evaluate(
    context: MacroContext,
    args?: string
  ): string

  dependencies?: string[]
}
```

**S16 修订（2026-09-22）**：`evaluate` 增可选 `args`——参数化宏（如 `{{roll:1d20}}`）以 `:` 后的部分作为 args 传入（`'1d20'`）；无参数宏（`{{user}}`）args 为 `undefined`。

---

# 42. Macro Security

Macro 不允许执行任意 JS。

禁止：

```text
{{eval:...}}
```

除非经过明确的：

```text
Plugin Tool
```

权限体系。

Prompt Compiler 本身：

```text
不执行任意代码
```

---

# 43. Macro Cache Rule

如果：

```text
stable zone
```

包含：

```text
volatile macro
```

Compiler 必须：

```text
diagnostic
```

例如：

```text
CACHE_UNSAFE_MACRO
```

然后根据策略：

```text
strict:
compile error

normal:
move to tail

compat:
preserve position + mark cache unsafe
```

**S16 落地口径（2026-09-22 修订）**：

```text
稳定区枚举（stable zone）: { header, stableWB, freshWB, summary }
  —— technical-plan §5.2 稳定性表格：这四区是 history 之前的缓存敏感前缀区；
     history/injection/tail 不在稳定区（历史追加式、注入贴近末端、tail 本就每轮可变）。

触发判据: 段 zone ∈ 稳定区 ∧ 存在 occurrence.volatility 低于段 effective stability。
  稳定性阶梯: static(0) < session(1) < request(2) < message(3) < volatile(4)
  例: header 段（effective session）含 {{time}}（volatile）→ 触发；
      header 段含 {{char}}（session == session）→ 不触发；
      history 段含 {{time}}（不在稳定区）→ 不触发；
      {{lastMessage}}（message < session）出现在 header → 触发。

处置粒度: 整段（不做段内 split）——R-P2-4 口径是"条目/段落标 volatile → 一律进 tail"；
  段内 split 需为碎片分配新稳定 ID（§9 ID=assetId+logicalPath），哈希键变化自伤缓存；
  混合场景（系统提示内嵌 {{date}}）由 Inspector 标红引导用户修预设源头。

三档 ↔ 编译模式映射（S16 以独立 macroCachePolicy 字段显式传入）:
  strict      ↔ CompileMode.strict        → error 级诊断 → compile failure（§75）
  normal      ↔ CompileMode.preview/performance → 整段 cachePlacement.zone 改 'tail'、
                stability 改 'volatile'（仅当非用户显式声明）+ warning 诊断
  compat      ↔ CompileMode.compatibility  → 段位置不动 + warning 诊断（preserved）

§13 双 Placement 分离: normal 档只改 cachePlacement.zone 与排序键，不改 semanticPlacement——
  语义上仍属原位置，物理上移入 tail 区，序列化/哈希按 cachePlacement 分区落位。
```

---

# 44. Runtime Variables

Runtime Variables：

```ts
interface RuntimeVariables {
  user: string
  char: string

  sessionId: string
  chatId: string

  messageId?: string

  time?: string
  date?: string

  custom: Record<string, unknown>
}
```

**S16 落地口径（2026-09-22 修订）**：

```text
user 缺省 'User'（chat 无 persona 绑定时的 ST 默认 persona 名）；
char 缺省 ''（无角色绑定）；
time/date 可预置（chat_state 按聊天冻结取值，R-P2-4 的另一隔离路径）——
  预置值优先于引擎按 MacroContext.now 推导；
custom.persona 承载 persona 描述/名（{{persona}} 取文对象）。
```

---

# 45. Macro Evaluation Context

```ts
interface MacroContext {
  variables: RuntimeVariables

  message?: MessageContext

  character?: CharacterContext

  chat?: ChatContext

  now: Date

  mode:
    | 'compile'
    | 'preview'
    | 'simulation'
    | 'replay'

  rng: Rng
  seed?: string
}
```

Replay 模式必须允许：

```text
freeze now
freeze random seed
```

从而实现确定性 Replay。

**S16 落地口径（2026-09-22 修订）**：

```text
rng: Rng —— 引擎注入的确定性种子流（sha256Hex(now|chatId) → mulberry32），
  调用方不构造；整次 expand 调用共享一条流（多个 {{random}} 自然不同值）。
seed?: string —— replay 冻结位：mode==='replay' 时 now 取 context.now 原值、
  RNG 种子取 context.seed（不派生），实现确定性 Replay（§45/§78）。
MessageContext = { id, role, content }（contracts Message 字段子集）；
CharacterContext = { name, description? } / ChatContext = { id, title? } 为最小占位，
  随对应宏落地扩展（S16 仅 {{lastMessage}} 消费 message）。
```

---

# 46. Budget Manager

Budget Manager 输入：

```text
PromptIR
ContextBudget
ProviderCapabilities
```

输出：

```text
BudgetResult
```

**S18 落地口径（2026-09-22）**：Budget Manager 落 `core/compiler/budget.ts` 纯函数层。裁剪 = 段标记 enabled=false（§91 Disabled Segment：不参与 Serialization 但 Snapshot 可记录）；两级裁剪——①世界书 percent+cap 配额（`worldbookQuota = min(available*percent/100, cap ?? available)`，ST `world_info_budget` 默认 percent=25、cap=null）；②全局按 §49 权威序。header 区段 protect 硬编码不可裁（防空 prompt）；裁到只剩 header 仍超限 → PROMPT_CONTEXT_TOO_LARGE（§71 修订口径"裁剪后仍放不进模型上下文窗口"）。裁剪原因以 info 诊断 BUDGET_TRIM 记录。Elastic History（§50）无状态整体推出（撑满后锚点前移的完整跨轮语义留 S20+）。

---

# 47. Context Budget

```ts
interface ContextBudget {
  maxContextTokens: number

  maxOutputTokens: number

  reservedOutputTokens: number

  safetyMarginTokens: number
}
```

实际可用：

```text
maxContext
-
output reservation
-
safety margin
```

---

# 48. Zone Budget

```ts
interface ZoneBudget {
  header: number
  stableWB: number
  freshWB: number
  summary: number
  history: number
  injection: number
  tail: number
}
```

---

# 49. Budget Priority

默认裁剪优先级：

```text
tail
↓
injection
↓
freshWB
↓
elastic history
↓
summary
↓
stableWB
↓
header
```

即：

> 越稳定、越核心的内容越晚被裁剪。

---

# 50. History Elastic Window

History 分为：

```text
Pinned
Elastic
```

例如：

```text
Pinned:
H1 ... H40

Elastic:
H41 ... H80
```

Elastic 超限：

```text
H41 ... H60
```

整体推出。

避免：

```text
每轮删除 H41
```

导致连续 Cache Break。

---

# 51. Budget Decision

```ts
interface BudgetDecision {
  included: string[]

  excluded: string[]

  truncated: string[]

  reason: BudgetReason[]

  totalTokens: number
}
```

---

# 52. Token Counting

Compiler 不假设：

```text
1 token = 4 chars
```

生产环境必须使用：

```text
Provider/Model tokenizer
```

如果不可用：

```text
estimation mode
```

必须记录：

```text
tokenCountMode:
'exact' | 'estimated'
```

---

# 53. Cache Planner

Cache Planner 接收：

```text
PromptIR
```

并计算：

```text
stablePrefix
cache eligible
fresh
volatile
invalidation
```

---

# 54. CachePlan

```ts
interface CachePlan {
  version: number

  stablePrefixSegments: string[]

  stablePrefixTokens: number

  freshSegments: string[]

  freshTokens: number

  volatileSegments: string[]

  volatileTokens: number

  checkpoints: CacheCheckpoint[]

  invalidationRisk: 'low' | 'medium' | 'high'

  breakReasons: CacheBreakReason[]

  providerStrategy?: ProviderStrategy
}
```

> **S19 落地注记（§54 providerStrategy 定稿）**：翻译指令形状落 contracts `ProviderStrategySchema`
> （version=1；`breakpoints` 为 checkpoints 的翻译投影——`{afterSegmentId, afterPartIndex, reason:'automatic'}`，
> afterPartIndex 为断点落 `serialized.parts` 的 0-based 下标，core 由 IR 序（enabled 过滤后 parts 1:1）算出，
> adapter 据此定位自家 wire 形状；`stableZoneTokens` = header+stableWB 合计，不含 freshWB（§5 注口径）；
> 可选 `prefixTooSmall` = `stableZoneTokens < MIN_PREFIX_TOKENS[providerCacheType]` 时的阈值数据）。
> 装配条件：`checkpoints.length > 0`（P0 空形状兼容，R-P0-4）；adapter 只翻译、不回写快照（provider-adapter-spec §16）。
> `providerCacheType` 由 run.ts 注入（`adapter.capabilities(model).cacheType`，§5 阈值判定输入）。

---

# 55. Cache Checkpoint

```ts
interface CacheCheckpoint {
  id: string

  afterSegmentId: string

  prefixHash: string

  tokenCount: number

  reason:
    | 'automatic'
    | 'provider-required'
    | 'manual'
}
```

---

# 56. Stable Prefix

稳定 Prefix：

```text
Segment[0]
Segment[1]
...
Segment[N]
```

要求：

```text
contentHash unchanged
ordering unchanged
serialization unchanged
```

---

# 57. Prefix Hash

使用：

```text
SHA-256
```

例如：

```ts
sha256(
  serializedSegment0 +
  serializedSegment1 +
  ...
)
```

注意：

> Hash 是验证手段，不是稳定性的来源。

真正保证稳定的是：

```text
data model
+
ordering rules
+
macro policy
```

---

# 58. Cache Break Reason

```ts
type CacheBreakReason =
  | {
      type: 'WORLD_BOOK_NEW_ENTRY'
      entryId: string
      tokenDelta: number
    }
  | {
      type: 'WORLD_BOOK_RETIREMENT'
      entryId: string
    }
  | {
      type: 'WORLD_BOOK_CONTENT_CHANGED'
      entryId: string
    }
  | {
      type: 'MACRO_VOLATILE'
      segmentId: string
      macro: string
    }
  | {
      type: 'SUMMARY_CHECKPOINT'
      summaryId: string
    }
  | {
      type: 'HISTORY_COMPACTION'
    }
  | {
      type: 'PRESET_CHANGED'
      presetId: string
    }
  | {
      type: 'CHARACTER_CHANGED'
      characterId: string
    }
  | {
      type: 'PERSONA_CHANGED'
      personaId: string
    }
  | {
      type: 'MESSAGE_EDITED'
      messageId: string
    }
  | {
      type: 'MESSAGE_VARIANT_SWITCHED'
      messageId: string
    }
  | {
      type: 'BRANCH_SWITCHED'
      fromMessageId: string
      toMessageId: string
    }
  | {
      type: 'WORLD_BOOK_DEACTIVATED'
      entryId: string
    }
  | {
      type: 'MANUAL_INVALIDATION'
      reason: string
    }
```

---

# 59. Cache Invalidation

Cache Invalidation 必须显式。

例如：

```ts
interface CacheInvalidation {
  scope:
    | 'segment'
    | 'zone'
    | 'prefix'
    | 'all'

  segmentIds: string[]

  reason: CacheBreakReason
}
```

---

# 60. Invalidation Propagation

如果：

```text
Segment B
```

发生变化：

```text
A B C D E
```

那么：

```text
A
```

仍可缓存。

而：

```text
B C D E
```

必须重新计算。

即：

```text
Invalidate from B
```

而不是：

```text
Invalidate everything
```

---

# 61. Prefix Invalidation

默认：

```text
first changed segment
```

决定 Prefix Break。

例如：

```text
A B C D E
```

C 改变：

```text
Stable:
A B

Fresh:
C D E
```

---

# 62. Physical Serialization

Serializer 必须接受：

```ts
PromptIR
```

而不是：

```text
Character
Worldbook
Chat
```

Serializer 不允许重新进行语义决策。

它只负责：

```text
IR
 ↓
Provider-specific representation
```

---

# 63. Provider Serialization

```ts
interface PromptSerializer {
  serialize(
    ir: PromptIR,
    capabilities: ProviderCapabilities
  ): SerializedPrompt
}
```

例如：

```text
OpenAI:
messages[]

Anthropic:
system + messages[]

Gemini:
contents[]
```

---

# 64. Provider Adapter Boundary

Provider Adapter 可以：

```text
转换 role
转换 message structure
插入 cache breakpoint
```

但禁止：

```text
新增 Worldbook
修改 History
执行 Macro
重新决定 Budget
```

---

# 65. Serialized Prompt

```ts
interface SerializedPrompt {
  format:
    | 'chat-messages'
    | 'responses'
    | 'contents'
    | 'custom'

  parts: SerializedPart[]

  raw?: unknown

  hash: string

  tokenCount: number
}
```

---

# 66. Prompt Snapshot

Snapshot 必须记录：

```ts
interface PromptSnapshot {
  id: string

  chatId: string

  runId?: string

  messageId?: string

  provider: string

  model: string

  compilerVersion: string

  ir: PromptIR

  cachePlan: CachePlan

  serialized: SerializedPrompt

  hashes: PromptHashes

  diagnostics: Diagnostic[]

  createdAt: string
}
```

---

# 67. Prompt Hashes

```ts
interface PromptHashes {
  header: string

  stableWB: string

  freshWB: string

  summary: string

  history: string

  injection: string

  tail: string

  final: string
}
```

---

# 68. Snapshot Immutability

Snapshot：

```text
immutable
```

禁止：

```text
UPDATE prompt_snapshots
```

如果重新编译：

```text
Snapshot #183
Snapshot #184
```

而不是：

```text
Snapshot #183 modified
```

---

# 69. Snapshot 用途

Snapshot 用于：

```text
Inspector
Replay
Prompt Diff
Cache Debug
Regression Test
Provider Debug
User Bug Report
```

---

# 70. Diagnostics

Compiler 不应该只：

```text
throw Error
```

而应该产生：

```ts
interface Diagnostic {
  level:
    | 'info'
    | 'warning'
    | 'error'

  code: string

  message: string

  segmentId?: string

  source?: SegmentSource

  details?: Record<string, unknown>
}
```

---

# 71. Diagnostic Examples

```text
CACHE_UNSAFE_MACRO

WORLD_BOOK_UNSUPPORTED_SEMANTIC

TOKEN_BUDGET_EXCEEDED

PROVIDER_ROLE_UNSUPPORTED

EMPTY_SEGMENT

INVALID_INJECTION_DEPTH

DUPLICATE_SEGMENT_ID

NON_DETERMINISTIC_MACRO

UNKNOWN_MACRO   // 补（2026-09-22）：未注册宏（{{place}} 等）→ 原样保留 + info

EVAL_MACRO_REJECTED   // 补（2026-09-22）：§42 {{eval:...}} 拒绝 + warning

WORLD_BOOK_RETIRED   // 补（2026-09-22）：§31 世界书条目退休（连续未激活超阈值 + 低优先级）

WORLD_BOOK_DEACTIVATED   // 补（2026-09-22）：§30 Compatibility 模式失活条目即时移除

BUDGET_TRIM   // 补（2026-09-22）：§49 预算裁剪原因（§46–§51 Budget Manager 落地）

PROMPT_CONTEXT_TOO_LARGE   // 补（2026-09）：裁剪后仍放不进模型上下文窗口

`PROMPT_CONTEXT_TOO_LARGE` 是**可降级但不可盲目重试**的诊断码。消费方（Agent Runtime）的处理口径见 agent-runtime-spec §49.1：降级后**只有当 replacement generation 确实前进**才允许重试一次，否则原错误保持权威。Compiler 侧只负责报码与提供裁剪建议，不参与重试决策。

退役（2026-09-22）：`MACRO_UNEXPANDED_P0`（R-P0-1 宏透传期结束，由 S16 宏引擎展开取代，全仓零产出方）。

---

# 72. Compilation Modes

V2 提供：

```ts
type CompileMode =
  | 'compatibility'
  | 'performance'
  | 'strict'
  | 'preview'
  | 'simulation'
  | 'replay'
```

---

# 73. Compatibility Mode

目标：

> 最大程度保持 SillyTavern 语义。

规则：

```text
不为了 Cache 修改语义位置
不自动冻结动态 Macro
不自动移动 Worldbook
不删除未知字段
```

---

# 74. Performance Mode

允许：

```text
Cache-aware placement
Stable WB
Elastic History
Macro freezing
```

但必须：

```text
Semantic Equivalence
```

通过。

---

# 75. Strict Mode

遇到：

```text
unsupported semantic
volatile macro in stable zone
budget ambiguity
provider capability mismatch
```

直接：

```text
compile failure
```

适用于：

```text
CI
Golden Test
开发调试
```

---

# 76. Preview Mode

Preview 不改变 Runtime State。

禁止：

```text
Worldbook sticky update
cooldown update
summary write
memory write
```

只生成：

```text
Prompt IR
Diagnostics
CachePlan
```

---

# 77. Simulation Mode

用于：

```text
Cache Simulator
```

允许：

```text
fake time
fake message
fake activation
fake provider
```

不调用真实模型。

---

# 78. Replay Mode

Replay 必须冻结：

```text
time
random seed
runtime variables
worldbook state
memory state
active message branch
```

确保：

```text
same input
→ same Prompt
```

---

# 79. Unknown Fields

兼容导入时：

```text
unknown field
```

不得直接丢弃。

保存：

```ts
compat: Record<string, unknown>
```

---

# 80. ST Prompt Mapping

SillyTavern：

```text
prompt_order
prompts
identifier
role
content
injection_position
injection_depth
```

转换为：

```text
PromptSegment
```

但原始字段必须保存在：

```text
source.compat
```

---

# 81. ST Prompt Order

导入：

```text
Prompt Order
```

首先建立：

```text
SemanticPlacement
```

然后：

```text
CachePlacement
```

不能直接：

```text
PromptOrder → stableWB
```

---

# 82. Injection

Injection：

```ts
{
  depth: number
  order: number
}
```

必须先按照：

```text
semantic depth
```

计算插入位置。

然后根据：

```text
cache policy
```

决定是否：

```text
injection
tail
```

---

# 83. Injection Cache Policy

【2026-09 修订】所有 @D / 深度 Injection 一律进入：

```text
injection zone
```

撤销初稿"静态 Injection 可进入稳定区"的规则：@D 的锚点是"历史末尾前 N 楼"，历史每轮增长使其绝对物理位置每轮移动——物理上不可能进入字节稳定前缀。真正静态的内容应建模为 header / stableWB 槽位，而不是 @D 注入。

Compatibility Mode 同样：

```text
保持原始语义位置
```

---

# 84. Agent Context

Agent Runtime 提供：

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

Prompt Compiler 只消费已经解析好的 Context。

Agent Runtime 不允许把自己的内部：

```text
chain of thought
```

注入 Prompt。

---

# 84.1 Artifact 与 Frozen Artifact 的放置（裁决 C2）

【2026-09 新增】对齐 agent-runtime-spec §71–§72 与总设计 §38 决策 14：

```text
working artifact（frozen = false）
        → injection / tail（默认）

frozen artifact（frozen = true）
        → 仍然 injection / tail
```

**结论：`frozen` 不改变缓存分区。** 冻结只带来两个效果：①Compiler 可以安全地以 `ArtifactRef` 引用而非复制全文；②Inspector 可以标注"此产物可复用"。

理由与 §83 的 @D 论证完全同构：把冻结产物提升进 stableWB / summary 等于**在稳定前缀中部（或尾部）插入新内容**，其后所有字节随之位移，等于一次未声明的 Cache Break。真正需要长期稳定的内容应当建模为 header / stableWB 槽位，而不是把运行时产物塞进去。

Agent Runtime 侧对应规则：产物是否冻结由 Tool/Agent 显式声明（`createArtifact`），Runtime 不做自动推断。

---

# 84.2 动态上下文段与快照复用（裁决 C6）

【2026-09 新增】与 §84.1 配套，划清 C2 的边界。

## 问题

有一类内容既不是静态资产（Character / Preset），也不是运行时产物——它们是**每轮都要发、但通常不变**的上下文：

```text
当前时间
当前激活的 worldbook 状态
角色当前状态（好感度 / 位置 / 持有物）
当前 persona
审批策略等运行期开关
```

每轮重新物化这一段，缓存前缀就要跟着重算。虽然它在 tail，追加本身不破坏前面的字节，但**段内任何一处变化（例如时间从 10:30 变成 10:31）都会让它自己以及其后全部内容变成新字节**。

## 规则

**裁决 C6**：白名单内的动态上下文段，若本轮物化结果与上一轮**逐字相同**，则**复用上一次的 snapshotId**，不重新物化，不产生 `CacheBreakEvent`。

```text
dynamicContextSegment
     ↓
物化（render）
     ↓
与上一轮已落盘的该段内容逐字节比对
     ↓
相同？── Yes ──→ 复用上次 snapshotId，reused = true
  │
  No
  ↓
新 snapshot，reused = false，产生 CacheBreakEvent
```

比对是**逐字节**（或等价的内容哈希），不是"语义等价"。格式化差异也算变化。

## 白名单（写死，不在白名单内的一律不复用）

| 段 | 允许复用 | 说明 |
|---|---|---|
| 时间上下文 | ✅ | 通常按分钟/小时粒度渲染，跨轮常不变 |
| 当前激活 worldbook 状态 | ✅ | 未发生激活变化时不重发 |
| 角色状态快照 | ✅ | 无状态变更时不变 |
| 审批策略等运行期开关 | ✅ | 变更极少 |
| **阶段产物（Artifact）** | ❌ | **仍按 §84.1（C2）一律 injection / tail，永不复用、永不提升** |
| Summary / 摘要块 | ❌ | 追加即显式 CacheBreak（总设计 §38 决策 6） |
| History / freshWB | ❌ | 天然每轮变化 |

## 与 C2 的关系（一句话）

> **C2 禁的是"内容会变的东西"进稳定前缀；C6 说的是"内容确实没变，就别重新物化"。**

两者不冲突，但边界必须写死，否则实现时一定会把"冻结产物也可以复用"当成 C6 的推论——那等于推翻 C2。上表的白名单就是这个边界，改动需回总设计 §38。

## 参照

DeepSeek Harness 把 `PromptContext` 明确定义为 `PromptSection` 的 **cache-safe counterpart**，落盘时机是"仅在变化时或压缩移除后"——与本节的判据同构。

---

# 85. Memory Injection

Memory 默认：

```text
stable memory
→ stableWB / summary

retrieved memory
→ tail
```

原因：

```text
RAG retrieval
```

天然具有高波动性。

---

# 86. Tool Results

Tool Result 默认进入：

```text
tail
```

除非：

```text
explicitly promoted
```

例如：

```text
tool result
→ artifact
→ frozen context
```

才可以成为稳定内容。

> **【2026-09-28 补，S32/WP4.3 落地注记】"默认进 tail"的精确口径 = 末尾连续输入段。**
>
> 实现（`packages/runtime/src/generation/run.ts` `trailingInputStart`）把本节的"默认"落成：
> **链尾连续的一段 `role ∈ {user, tool}`（尚未被模型消费过的输入）注 tail，其余消息回落 history。**
> 直白说：`[u,a1,t1]` 的 tail 恰为 `[t1]`；而 `[u,a1,t1,a2,t2]` 中 `t1` 已不再是新鲜输入 → history，
> 只有 `t2` 进 tail。
>
> **为什么必须是"连续末尾"而不是"凡 tool 结果都进 tail"**：`§48`/pipeline 的排序是
> **先按 zone 再按语义序**（`ZONE_ORDER` → `placementOrder` → physical index）。把中间轮次的
> tool 结果也挪进 tail，会把 `[u,a1,t1,a2,t2]` 序列化成 `[u,a1,a2,t1,t2]`——tool 结果与其发起
> 调用错位，Provider 协议直接报错。末尾连续段天然保持区内字节序，故这条规则同时满足协议正确性与本节意图。
>
> **溯源（§10 来源登记表）**：tool 结果段携带 `source.type = 'toolResult'` + `toolCallId`，
> 该 id 由运行层写入消息元数据（`messages.metadata.toolCallId`）后在编译期升格。
> 缺元数据时退回 `message` 来源——存量数据与普通消息行为不变。
>
> **缓存语义**：`tail` 的 zone 默认稳定性是 `volatile`（`§16`），并位于 `§15.1` 裁剪序**首位**
> ——tool 结果既不可能进稳定前缀，也不会挤占稳定区预算。这正是 §86 想要的"不进稳定内容"。

---

# 87. Artifact Promotion

Agent 生成：

```text
Artifact
```

可以声明：

```ts
stability: 'session'
```

例如：

```text
当前任务规则
角色状态表
剧情大纲
```

然后进入：

```text
stable context
```

---

# 88. Prompt Contribution API

Plugin/Agent 不直接修改 Prompt。

而是提交：

```ts
interface PromptContribution {
  id: string

  source: SegmentSource

  segment: PromptContributionSegment

  priority: number

  semanticPlacement: SemanticPlacement
}
```

Compiler 统一处理。

---

# 89. Contribution Conflict

如果两个 Plugin：

```text
Plugin A
Plugin B
```

都修改同一个位置：

Compiler 不静默覆盖。

产生：

```text
PROMPT_CONTRIBUTION_CONFLICT
```

然后根据：

```text
priority
exclusive group
explicit order
```

解决。

---

# 90. Group / Exclusive Segment

Preset 可以定义：

```ts
group: {
  id: string
  exclusive: boolean
}
```

例如：

```text
Style A
Style B
Style C
```

如果：

```text
exclusive = true
```

只能激活一个。

---

# 91. Disabled Segment

disabled Segment：

```text
不参与 Serialization
```

但 Snapshot 可以记录：

```text
enabled = false
```

方便 Inspector。

---

# 92. Empty Segment

空 Segment：

```text
content = ''
```

默认：

```text
不发送
```

但保留：

```text
IR metadata
```

用于 Debug。

---

# 93. Ordering

排序优先级：

```text
zone
↓
semantic order
↓
physical order
↓
stable ID
```

严禁：

```text
random
timestamp
object iteration order
```

参与最终排序。

---

# 94. Stable Sorting

所有排序必须：

```text
deterministic
stable
```

如果两个 Segment：

```text
order 相同
```

使用：

```text
stable ID
```

作为 tie breaker。

---

# 95. Cache Stability Contract

Compiler 必须保证：

如果：

```text
inputStableState unchanged
```

那么：

```text
stablePrefixHash unchanged
```

形式化：

```text
S_t = stable state at round t

if S_t == S_t+1

then:

hash(prefix_t)
==
hash(prefix_t+1)
```

---

# 96. Cache Stability 不由 Hash 保证

禁止这种错误设计：

```text
hash 一样
→ stable
```

正确：

```text
stable data structure
→ deterministic serialization
→ hash verification
```

Hash 只是验证。

---

# 97. Compiler Context Hash

Compiler 可以计算：

```ts
interface ContextHash {
  character: string
  persona: string
  preset: string
  worldbookState: string
  memory: string
  history: string
  variables: string
}
```

用于快速判断：

```text
是否需要重新编译
```

---

# 98. Incremental Compilation

V2 支持：

```text
compile full
```

和：

```text
compile incremental
```

例如：

```text
new message
```

不需要重新计算：

```text
Character
Preset
Stable WB
Frozen Summary
```

只重新计算：

```text
History
Fresh WB
Injection
Tail
```

---

# 99. Compiler Cache

Compiler 自己可以缓存：

```text
Character IR
Preset IR
Worldbook Entry Parsed IR
Macro Analysis
Token Count
```

注意：

> Compiler Cache 与 Provider Prompt Cache 是两个不同层级。

---

# 100. Compiler Cache Key

例如：

```text
character:
sha256(character.content)

preset:
sha256(preset.content)

worldbook entry:
sha256(entry.content + semantic fields)

macro:
sha256(rawMacro + registryVersion)
```

---

# 101. Compile Trace

每次 Compile 可以产生：

```ts
interface CompileTrace {
  startedAt: number

  stages: {
    name: string
    durationMs: number
  }[]

  cacheHits: number

  cacheMisses: number

  tokenCount: number
}
```

用于性能优化。

---

# 102. Compile Result Example

```ts
{
  ir: {
    segments: [
      {
        id: "preset:default:system",
        role: "system",
        content: "...",
        cachePlacement: {
          zone: "header"
        },
        stability: "session"
      },

      {
        id: "worldbook:main:183",
        role: "system",
        content: "...",
        cachePlacement: {
          zone: "stableWB"
        },
        stability: "session"
      },

      {
        id: "message:9281",
        role: "user",
        content: "...",
        cachePlacement: {
          zone: "history"
        },
        stability: "message"
      }
    ]
  },

  cachePlan: {
    stablePrefixTokens: 42183,
    freshTokens: 1820,
    volatileTokens: 923
  }
}
```

---

# 103. Compiler Error Handling

Compiler 错误分为：

```text
Recoverable
Warning
Fatal
```

---

## Recoverable

例如：

```text
provider 不支持某参数
```

可以：

```text
fallback
```

---

## Warning

例如：

```text
volatile macro
```

可以继续发送。

---

## Fatal

例如：

```text
invalid Prompt IR
unknown role
budget impossible
```

必须停止请求。

---

# 104. Provider Capability Validation

Compiler 在 Serialization 前检查：

```text
system role
tool role
vision
structured content
cache breakpoint
```

如果 Provider 不支持：

```text
fallback
```

或：

```text
diagnostic
```

---

# 105. Token Budget Failure

如果：

```text
requiredTokens > maxContextTokens
```

Compiler 首先执行：

```text
Budget Policy
```

如果仍然无法满足：

```text
TOKEN_BUDGET_EXCEEDED
```

禁止偷偷截断 Header。

---

# 106. Cache vs Budget

Cache 优化不能凌驾于 Context Budget。

优先：

```text
valid prompt
```

其次：

```text
semantic correctness
```

然后：

```text
cache efficiency
```

因此：

```text
Cache optimization
< Semantic correctness
< Valid request
```

---

# 107. Semantic Equivalence

Performance Mode 所有优化都必须满足：

```text
semantic output
=
compatibility output
```

至少保持：

```text
Activation
Role
Content
Relative semantic position
Depth
Order
```

一致。

---

# 108. Golden Test

每个 Compatibility Fixture：

```text
input/
  character.json
  worldbook.json
  preset.json
  chat.json
```

生成：

```text
expected/
  prompt.snapshot.json
```

测试：

```text
compile(input)
==
expected
```

---

# 109. Worldbook Tests

必须覆盖：

```text
keyword
secondary keyword
AND ANY
AND ALL
NOT ANY
NOT ALL

recursive
sticky
cooldown
delay
probability

group
group scoring

scan depth
```

---

# 110. Worldbook Cache Tests

关键测试：

```text
Round 1:
A B C

Round 2:
A B C D

Round 3:
A B C D
```

断言：

```text
physicalOrder(A)
physicalOrder(B)
physicalOrder(C)
```

全部不变。

D graduation：

```text
fresh → stable
```

但：

```text
prefix hash
```

不改变。

---

# 111. Summary Tests

测试：

```text
Summary S1
History H1 H2 H3
```

新增：

```text
Summary S2
```

断言（summary 位于 history 之前，见 §32 修订）：

```text
1. S2 追加必须产生显式 SUMMARY_CHECKPOINT 失效事件
   （禁止静默位移；不允许出现 cache miss: unknown）
2. 该轮之后，无新事件时前缀
   （header + stableWB + S1 S2 + H1 H2 H3）恢复稳定
3. H1 H2 H3 内容字节不变（位移仅发生一次且已声明）
```

---

# 112. Macro Tests

至少覆盖：

```text
static macro
session macro
message macro
request macro
volatile macro
unknown macro
nested macro
invalid macro
```

---

# 113. Macro Cache Tests

输入：

```text
Header:
"Current time: {{time}}"
```

默认结果：

```text
diagnostic:
CACHE_UNSAFE_MACRO
```

不得静默把它标记为：

```text
stable
```

---

# 114. Branch Tests

测试：

```text
H1
H2
 ├─ H3a
 └─ H3b
```

选择 H3a：

```text
compile(A)
```

选择 H3b：

```text
compile(B)
```

断言：

```text
common prefix
```

完全一致。

---

# 115. Determinism Test

执行：

```text
compile(input)
compile(input)
compile(input)
```

断言：

```text
IR hash
serialized hash
cachePlan hash
```

一致。

---

# 116. Property Test

随机生成：

```text
Worldbook
Messages
Branches
Macros
Summary
```

进行：

```text
1000+
```

轮测试。

核心 Property：

```text
No explicit invalidation
→ stable prefix must not change
```

---

# 117. Fuzz Test

Fuzz：

```text
macro syntax
worldbook keywords
injection depth
unicode
emoji
CJK
long content
empty content
malformed ST JSON
```

Compiler 不允许：

```text
crash process
```

---

# 118. Regression Test

每个真实 Bug 都必须变成：

```text
Regression Fixture
```

例如：

```text
regression/
  wb-graduation-reorder/
  summary-history-shift/
  volatile-time-header/
  duplicate-segment/
```

---

# 119. Inspector Requirements

Inspector 至少展示：

```text
Segment ID
Source
Role
Semantic Placement
Cache Placement
Stability
Tokens
Hash
Dependencies
```

Worldbook Entry 额外显示：

```text
Activation reason
Cache state
Physical order
Matched keywords
```

---

# 120. Cache Inspector

显示：

```text
Stable Prefix
Fresh
Volatile
```

以及：

```text
First Break
Break Reason
Affected Tokens
```

---

# 121. Compile Inspector

显示 Pipeline：

```text
Normalize              ✓
Macro Analysis         ✓
Worldbook Activation   ✓
Semantic Layout        ✓
Cache Placement        ✓
Budget                 ✓
Validation             ✓
Serialization          ✓
Snapshot               ✓
```

每阶段可查看：

```text
Input
Output
Duration
```

---

# 122. Cache Simulator API

```ts
interface CacheSimulator {
  simulate(
    input: SimulationInput
  ): Promise<SimulationResult>
}
```

---

# 123. Simulation Input

```ts
interface SimulationInput {
  initialState: RuntimeState

  rounds: SimulationRound[]

  provider: ProviderCapabilities

  budget: ContextBudget
}
```

---

# 124. Simulation Round

```ts
interface SimulationRound {
  message?: MessageInput

  worldbookChanges?: WorldbookChange[]

  macroVariables?: Record<string, unknown>

  summaryAction?: SummaryAction

  branchAction?: BranchAction
}
```

---

# 125. Simulation Result

```ts
interface SimulationResult {
  rounds: SimulationRoundResult[]

  aggregate: {
    totalTokens: number
    stableTokens: number
    freshTokens: number
    invalidations: number
    estimatedCost?: number
  }
}
```

---

# 126. Compile Performance Targets

目标：

### Small Chat

```text
< 20ms
```

### Medium Chat

```text
< 100ms
```

### Large Chat

```text
< 500ms
```

### 10k Messages

目标：

```text
incremental compile
< 1s
```

以上均为目标值，最终以实际 Benchmark 为准。

---

# 127. Memory Management

Compiler 不应该一次性复制：

```text
整个 1M token Chat
```

而应该：

```text
Message references
Segment references
lazy content
```

需要序列化时再读取。

---

# 128. Large Context

对于：

```text
100k+
1M+
```

Token Context：

必须避免：

```text
JSON stringify entire Runtime State
```

作为普通 Compiler 输入方式。

使用：

```text
references
iterators
incremental compilation
```

---

# 129. Immutability

Compiler 内部优先：

```text
immutable IR
```

禁止：

```text
Worldbook Engine
```

在 Compiler 完成后偷偷修改：

```text
PromptSegment
```

---

# 130. Runtime State Mutation Boundary

Compiler：

```text
READ
```

Worldbook Runtime：

```text
READ + STATE UPDATE
```

Memory Runtime：

```text
READ + WRITE
```

Agent Runtime：

```text
READ + ORCHESTRATE
```

Prompt Compiler：

```text
NO SIDE EFFECT
```

原则：

> Compiler 是纯计算层。

---

# 131. Compiler Side Effects

允许：

```text
Telemetry event
```

但必须异步、可选。

不能因为：

```text
telemetry failure
```

导致：

```text
Prompt compile failure
```

---

# 132. Serialization Invariant

同一个：

```text
PromptIR
+
ProviderCapabilities
```

必须得到：

```text
same SerializedPrompt
```

---

# 133. Cache Invariant

同一个：

```text
PromptIR
```

如果：

```text
stable segments unchanged
```

则：

```text
stablePrefixHash unchanged
```

---

# 134. Snapshot Invariant

每一次：

```text
Provider Request
```

必须存在：

```text
PromptSnapshot
```

并且：

```text
ProviderRequest.snapshotId
```

不能为空。

---

# 135. Debug Invariant

任何：

```text
Cache Break
```

必须存在：

```text
CacheBreakReason
```

不能出现：

```text
cache miss: unknown
```

---

# 136. Compatibility Invariant

任何：

```text
Unsupported ST Semantic
```

必须：

```text
diagnostic
```

禁止：

```text
silent drop
```

---

# 137. Module Boundaries

推荐：

```text
packages/core/compiler/
├── compiler.ts
├── normalize.ts
├── layout.ts
├── validation.ts
└── types.ts

packages/core/worldbook/
├── activation.ts
├── groups.ts
├── state.ts
└── types.ts

packages/core/macros/
├── engine.ts
├── registry.ts
├── parser.ts
└── types.ts

packages/core/budget/
├── manager.ts
├── history.ts
└── types.ts

packages/core/cache/
├── planner.ts
├── hash.ts
├── invalidation.ts
└── types.ts

packages/core/serializer/
├── generic.ts
└── types.ts

packages/runtime/snapshots/
├── snapshot.ts
└── repository.ts
```

---

# 138. Dependency Direction

必须：

```text
Worldbook
   ↓
Prompt IR

Macro
   ↓
Prompt IR

Budget
   ↓
Prompt IR

Cache
   ↓
Prompt IR

Serializer
   ↓
Prompt IR
```

不能：

```text
Prompt Compiler
 ↓
Provider Adapter
 ↓
Worldbook
```

形成反向依赖。

---

# 139. Forbidden Dependencies

Core Compiler 禁止直接依赖：

```text
React
Zustand
Browser DOM
SSE
HTTP
SQLite
Provider SDK
```

这样 Compiler 可以：

```text
Node
Browser
Worker
Test
CLI
```

独立运行。

---

# 140. API Summary

最终核心 API：

```ts
compilePrompt(input)

analyzeMacros(content, context)

activateWorldbook(context)

buildPromptIR(context)

planCache(ir, policy)

applyBudget(ir, budget)

serializePrompt(ir, provider)

createSnapshot(result)

simulateCache(input)
```

---

# 141. End-to-End Example

输入：

```text
Character:
Seraphina

Persona:
User

Worldbook:
Entry A
Entry B
Entry C

History:
H1
H2
H3

New message:
H4

Preset:
Default RP
```

Compiler：

```text
Normalize
 ↓
Character
Persona
Preset
 ↓
Worldbook Activation
 ↓
A B C
 ↓
Cache State
A B = stable
C = fresh
 ↓
History
H1 H2 H3 H4
 ↓
Budget
 ↓
CachePlan
 ↓
Serialization
 ↓
Snapshot
```

最终：

```text
header
stableWB(A B)
freshWB(C)
summary
history(H1 H2 H3 H4)
injection
tail
```

---

# 142. 下一轮

如果没有任何稳定内容改变：

```text
header
stableWB(A B)
freshWB(C)
summary
history(H1 H2 H3 H4 H5)
injection
tail
```

稳定 Prefix：

```text
header + A + B
```

完全不变。

---

# 143. Worldbook New Entry

新增：

```text
D
```

结果：

```text
header
stableWB(A B)
freshWB(C D)
summary
history(...)
```

下一轮 D graduation：

```text
header
stableWB(A B)
stableWB(C D)
summary
history(...)
```

但物理序列仍：

```text
A B C D
```

不是：

```text
A C D B
```

因此：

```text
graduation
≠
re-sort
```

---

# 144. Volatile Macro Example

Preset：

```text
System:
"You are {{char}}.
Current time: {{time}}"
```

Compiler：

```text
{{char}}
→ session

{{time}}
→ volatile
```

结果：

```text
diagnostic:
CACHE_UNSAFE_MACRO
```

Performance Mode：

```text
freeze time
```

或者：

```text
move time to tail
```

Compatibility Mode：

```text
保持原位置
cache marked unsafe
```

---

# 145. Final Compiler Contract

Prompt Compiler 必须保证：

```text
1. Deterministic
2. Side-effect free
3. Provider independent
4. Semantic explicit
5. Cache aware
6. Budget aware
7. Macro aware
8. Snapshot capable
9. Debuggable
10. Testable
```

---

# 146. 最终架构关系

```text
                   Runtime State
                         │
                         ▼
                ┌─────────────────┐
                │ Prompt Compiler │
                └────────┬────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
     Macro          Worldbook          Memory
     Engine          Engine            Engine
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                     Prompt IR
                         │
                         ▼
                  Semantic Layout
                         │
                         ▼
                   Cache Placement
                         │
                         ▼
                   Budget Manager
                         │
                         ▼
                    Validation
                         │
                         ▼
                    CachePlan
                         │
                         ▼
                    Serializer
                         │
                         ▼
                 Prompt Snapshot
                         │
                         ▼
                  Provider Adapter
                         │
                         ▼
                       Model
```

---

# 147. Definition of Done

Prompt Compiler V2 只有满足以下条件才能认为完成：

### Core

- [ ] Prompt IR 完成
- [ ] Deterministic Compile
- [ ] Segment Source
- [ ] Semantic Placement
- [ ] Cache Placement
- [ ] Provider Serialization

### Worldbook

- [ ] Activation
- [ ] Selective Logic
- [ ] Recursive
- [ ] Sticky
- [ ] Cooldown
- [ ] Delay
- [ ] Group
- [ ] Probability
- [ ] Stable/Fresh Cache
- [ ] Physical Order

### Macro

- [ ] Macro Registry
- [ ] Macro Parser
- [ ] Volatility Analysis
- [ ] Expansion
- [ ] Replay Freeze
- [ ] Cache Warning

### Budget

- [ ] Token Counter
- [ ] Zone Budget
- [ ] Elastic History
- [ ] Summary Checkpoint
- [ ] Overflow Diagnostics

### Cache

- [ ] CachePlan
- [ ] Prefix Hash
- [ ] Invalidation
- [ ] Break Reason
- [ ] Cache Simulator
- [ ] Prefix Stability Test

### Snapshot

- [ ] Prompt Snapshot
- [ ] Immutable
- [ ] Prompt Diff
- [ ] Replay
- [ ] Provider Request Link

### Compatibility

- [ ] Character Card
- [ ] Worldbook
- [ ] Preset
- [ ] Prompt Order
- [ ] Injection
- [ ] Persona
- [ ] Chat
- [ ] Unsupported Field Diagnostics

### Testing

- [ ] Unit Tests
- [ ] Golden Tests
- [ ] Property Tests
- [ ] Fuzz Tests
- [ ] Regression Tests
- [ ] Performance Benchmark

---

# 148. 最终原则

WhisperTavern V2 Prompt Compiler 最重要的不是“把 Prompt 拼出来”。

它真正解决的是：

```text
传统：

资产
 ↓
字符串拼接
 ↓
Prompt
 ↓
模型


WhisperTavern：

Runtime State
 ↓
Semantic Resolution
 ↓
Prompt IR
 ↓
Cache-aware Layout
 ↓
Budget
 ↓
CachePlan
 ↓
Snapshot
 ↓
Provider Serialization
 ↓
模型
```

因此 Prompt Compiler 本质上是：

> **一个确定性的、可观测的、缓存感知的 Prompt 编译器，而不是 Prompt Template Engine。**

它应该像编译器一样拥有：

```text
AST / IR
Semantic Analysis
Optimization
Budget / Resource Allocation
Code Generation
Snapshot
Diagnostics
Golden Tests
Regression Tests
```

而不是继续把所有逻辑塞进一个：

```text
buildPrompt()
```

函数。

**最终目标不是让 WhisperTavern “能生成 Prompt”，而是让系统能够回答：**

> **“这一轮模型究竟看到了什么？为什么看到这些？哪些内容可以缓存？为什么缓存断了？如果换一个模型/重新运行，这个 Prompt 能不能完全复现？”**

这五个问题，应该成为整个 Prompt Compiler 的验收标准。