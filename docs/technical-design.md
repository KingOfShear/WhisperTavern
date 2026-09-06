# WhisperTavern 技术总设计（V2）

> **版本**：V2.0 合并稿（2026-09-04）
> **来源**：以《WhisperTavern V2 技术总设计》草案为骨架，合并原 technical-plan.md / worldbook-cache-design.md 的实施结论，并修正三处设计问题（stableWB 排序漏洞、summary 区位置、默认工作流路径），修正依据见 §38 决策记录。
> **一句话定义**：以 Prompt Compiler 为核心、以 Prefix Cache 为成本引擎、以 Agent Runtime 为执行引擎、以 Memory Runtime 为长期上下文引擎，通过 Snapshot / Event / Inspector 实现完全可观测的 Local-first AI RP / 长上下文工作台。

## 0. 核心设计原则（铁律）

1. **Prompt Compiler 是唯一 Prompt 组装入口**；Frontend 不拼 Prompt。
2. **Agent Runtime 决定**谁做什么、何时做、能看到什么、能调用什么；它不拼 Prompt 字符串。
3. **Cache Lifecycle ≠ Physical Ordering**：毕业（graduation）只改缓存状态，永不改物理位置。
4. **稳定内容不能被动态内容压在前面**；凡进入稳定前缀的内容必须跨轮逐字节一致（byte-for-byte）。
5. **Summary 区只追加冻结块**；追加 = 显式 CacheBreak 事件，禁止无事件语义的摘要回写与重排。
6. **动态宏必须声明 volatility**；未声明稳定性的挥发内容一律进 tail。
7. **Worldbook Activation 与 Cache Placement 解耦**：触发逻辑决定"哪些条目进 prompt"，缓存分区决定"放在哪里"，互不污染。
8. **Agent 不直接拥有上下文与权限**：上下文经 Context Policy、权限经 Capability 获得。
9. **长任务必须可 Resume**；重要 Runtime 状态必须可 Snapshot。
10. **任何性能优化必须通过 Semantic Equivalence Test**：优化可以改变物理排列，不能改变定义好的语义结果。
11. 重要行为必须**可观察、可 Diff、可 Replay**；Event Bus 从第一版就存在。
12. 核心 Runtime 与 UI、插件、Provider 解耦。

---

## 1. 项目定位

WhisperTavern V2 不是 SillyTavern UI 重制版。目标是把"角色卡 + 世界书 + Prompt + 聊天记录 + 插件"组成的传统 AI Chat 客户端，升级为拥有 Prompt Compiler、缓存管理、长期记忆和多智能体运行时的本地 AI 工作台。

传统酒馆的核心模型：`资产 → 前端脚本 → 动态拼 Prompt → Provider → 模型`。其 Prompt 组装散落在浏览器端各处（胖前端架构，见 [st-reference-analysis.md](./st-reference-analysis.md)），扩展只能在浏览器里做字符串手术。V2 将组装收敛为服务端纯函数编译管线，这是架构层面的主动升级而非重构。

V2 的核心模型：

```text
                 ┌───────────────┐
                 │    Web UI     │
                 └───────┬───────┘
              ┌──────────▼──────────┐
              │ Application Runtime │
              └──────────┬──────────┘
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  Prompt Compiler    Agent Runtime     Event Bus
        └────────────────┼────────────────┘
              ┌──────────▼──────────┐
              │ Context / Memory /  │
              │ Worldbook / Tools   │
              └──────────┬──────────┘
                 ┌───────▼────────┐
                 │ Cache Planner   │
                 └───────┬────────┘
                 ┌───────▼────────┐
                 │ Provider Layer  │
                 └────────────────┘
```

## 2. 产品目标

### 2.1 第一目标：优秀的本地 AI RP 客户端

完整支持：角色卡、用户 Persona、世界书、Prompt Preset、聊天记录、Swipe/Reroll、消息编辑、消息分支、多模型、流式输出、群聊、长上下文、自定义 Provider；并最大程度兼容 SillyTavern 生态资产（§27）。

### 2.2 第二目标：真正有效的 Prompt Cache Pipeline

传统系统最大的问题不是"Prompt 太长"，而是**每一轮都在修改长 Prompt 的前缀**。目标是从数据结构层面建立：

```text
稳定内容 → 稳定物理位置 → 稳定字节序列 → 稳定 Token Prefix → Provider Cache
```

缓存设计从 Prompt Compiler 内部开始，不是 Provider 层临时打补丁。世界书内容哈希分区的方向已被参考实现"小猫之神"验证可行（见 [worldbook-cache-design.md](./worldbook-cache-design.md) §9）。

### 2.3 第三目标：Agent-native

单角色聊天、群聊、写作工作流、记忆 Agent、审核 Agent、搜索 Agent、导演 Agent 不是七套系统，统一抽象为 Agent Runtime：

```text
单聊   = 1 Agent（快速路径，见 §23.2）
群聊   = N Character Agents + Director
写作   = Writer + Checker + Editor
记忆   = Scribe Agent
搜索   = Search Tool / Search Agent
```

## 3. 非目标

V2 不负责：多人云端服务、云端账号体系、社交系统、内置图片/语音/视频生成、直接执行任意 SillyTavern JS 扩展、把第三方扩展 JS 原样搬进 Runtime。

第三方能力通过 **Plugin / Tool / Skill / Provider** 四个口扩展。

## 4. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         Web UI                              │
│ Chat / Characters / Worldbooks / Presets / Inspector        │
│ Workflow / Agent / Memory / Telemetry / Settings            │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼─────────────────────────────────┐
│                    Application Runtime                      │
│ ┌────────────────┐ ┌────────────────┐ ┌──────────────────┐  │
│ │ Prompt Compiler│ │ Agent Runtime  │ │    Event Bus     │  │
│ └───────┬────────┘ └───────┬────────┘ └────────┬─────────┘  │
│ ┌───────▼────────┐ ┌───────▼────────┐ ┌────────▼─────────┐  │
│ │ Worldbook      │ │ Workflow       │ │ Plugin Runtime   │  │
│ │ Macro Engine   │ │ Tool Runtime   │ │ Permission       │  │
│ │ Context Engine │ │ Skill Runtime  │ │ Scheduler        │  │
│ └───────┬────────┘ └───────┬────────┘ └──────────────────┘  │
│ ┌───────▼──────────────────▼─────────────────────────────┐  │
│ │                Memory / RAG / Artifacts                 │  │
│ └──────────────────────────┬─────────────────────────────┘  │
│                  ┌─────────▼─────────┐                      │
│                  │   Cache Planner   │                      │
│                  └─────────┬─────────┘                      │
└────────────────────────────┼────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Provider Adapter Layer                                     │
│  OpenAI Compatible / Anthropic / Gemini / Local / Custom    │
└─────────────────────────────────────────────────────────────┘
```

## 5. 四大核心基础设施

### 5.1 Prompt Compiler

编译管线（2026-09 修订：**Activation Engine 拆出为有状态前置阶段**，修正初稿"纯函数却内含有副作用的激活"的自相矛盾）：

```text
Runtime State ─→ Activation Engine（有状态：sticky/cooldown/delay/概率掷骰，读+更新）
                        │ 产出 ActivatedEntries
                        ▼
Asset → Macro Analysis → Context Resolution → Segment IR → Semantic Placement
      → Cache Placement → Budget → Validation → CachePlan → Serialization → Prompt Snapshot
```

Compiler 本体必须是**纯函数、无副作用、确定性**（compile(A) === compile(A)）、Provider 无关：

- **纯度边界**：Worldbook Runtime = READ + STATE UPDATE，Memory = READ + WRITE，Agent = READ + ORCHESTRATE，Compiler = **NO SIDE EFFECT**（只消费激活结果；telemetry 事件异步可选且不得导致编译失败）；
- **Diagnostics**：不只 throw，而是产出 `Diagnostic[]`（info / warning / error + 机器可读 code）；`UNSUPPORTED_SEMANTIC` 禁止静默忽略——这是酒馆字段长尾兼容的编译期执法；
- **CompileMode 六种**：compatibility / performance / strict（CI 与金样，遇歧义直接失败）/ preview（只读，不更新任何 Runtime 状态）/ simulation / replay（冻结 time 与 random seed，确定性复现）；
- **排序规则**：zone → semantic order → physical order → stable ID 逐级裁决，严禁 random / timestamp / 对象迭代序参与最终排序；
- **增量编译**：新消息只重算 History / freshWB / injection / tail，Character / Preset / stableWB / 冻结 Summary 复用；Compiler 自缓存（内容哈希为键，ContextHash 快判是否需要重编译）——注意 Compiler Cache 与 Provider Prompt Cache 是两个层级；
- **Token 计数**：不假设 1 token = 4 chars；优先 Provider/Model tokenizer，不可用时 estimation 模式并记录 `tokenCountMode: 'exact' | 'estimated'`；
- **Prompt Contribution API**：Plugin / Agent 不直接改 Prompt，而是提交带 priority 与 semanticPlacement 的 Contribution；冲突产生 `PROMPT_CONTRIBUTION_CONFLICT` 诊断，按 priority / exclusive group / explicit order 解决。

完整模块规格（IR 字段定义、Diagnostics code 表、不变量清单、测试矩阵、Definition of Done）见 [specs/prompt-compiler-spec.md](./specs/prompt-compiler-spec.md)。

### 5.2 Agent Runtime

负责 Agent 生命周期：Spawn / Delegate / Tool Call / Handoff / Await / Resume / Cancel / Timeout / Retry / Budget / Permission / Context Policy / Artifact。不负责 Prompt 字符串拼接。

### 5.3 Cache Planner

输入 `Prompt IR + Provider Capabilities + Context Budget + Cache Policy`，输出 CachePlan（§17），由 Provider Adapter 翻译为各家缓存原语。

### 5.4 Event Bus

所有核心 Runtime 行为都产生事件。**事件名统一点分记法，`域.对象.动作`**；下表是**唯一权威清单**，插件 API、UI 订阅、Telemetry 一律以此为准（ui-design 早期稿中的冒号记法 `message:delta` 作废；agent-runtime-spec §59/§117 与 api-spec 的域名以本表为准；api-spec 收编时反哺 provider / import / export / memory / artifact 五个域，2026-09）。

**持久化分档**（2026-09 补，参照 DeepSeek Harness 的 `session/event` 与 `agent/*` 分域）。判据只有一条：**进程重启后，重建执行树或账目是否需要它**。

```text
── durable：必须落 events 表 ──────────────────────────────
chat.created / chat.updated
message.created / message.edited / message.swiped / message.deleted
generation.started / generation.completed / generation.failed
prompt.compiled / prompt.snapshot.created / prompt.invalidated
worldbook.activated / worldbook.changed
agent.created
agent.run.created / agent.run.started / agent.run.paused / agent.run.resumed
agent.run.completed / agent.run.failed / agent.run.cancelled / agent.run.interrupted
agent.turn.started / agent.turn.completed
tool.call.started / tool.call.completed / tool.call.failed / tool.call.denied
workflow.started / workflow.stage_started / workflow.stage_completed / workflow.completed
approval.requested / approval.decided
provider.fallback
import.started / import.completed / import.failed
export.started / export.completed / export.failed
roleplay.state.updated / roleplay.relationship.changed
roleplay.thread.created / roleplay.thread.resolved
roleplay.commit.completed

── deferred-durable：异步批量落库，允许延迟不允许丢 ──────
cache.hit / cache.miss / cache.invalidated
usage.recorded
memory.created / memory.updated
artifact.created / artifact.updated
roleplay.directive.created / roleplay.quality.completed
roleplay.emotion.changed / roleplay.regeneration.started
roleplay.pattern.detected / roleplay.drift.detected / roleplay.quality.warning

── live：内存内广播即可，丢了不影响重建 ──────────────────
generation.delta                    （每 token，落表会打爆 events）
prompt.compiling
import.progress                     （导入作业进度）
```

> `approval.granted` / `approval.rejected` 合并为 **`approval.decided`**，结果由 payload 的 `outcome` 字段承载（四值见 agent-runtime-spec §115.1）。成对审计要求 `approval.requested` 与 `approval.decided` 由同一 `approvalId` 关联，且这两个事件 **log-only，不进模型转录**。
>
> `worldbook.activated` 归 durable 是因为 Activation Engine **有状态**（sticky / cooldown / delay / 概率掷骰，见 §5.1）。Replay 要复现激活结果，就必须记录激活历史。

六条硬约束：

- **命名只允许上表内的域**：`agent.* / run 相关走 agent.run.* / turn 走 agent.turn.* / tool.* / prompt.* / generation.* / message.* / workflow.* / approval.* / cache.* / worldbook.* / chat.* / usage.* / provider.* / import.* / export.* / memory.* / artifact.* / roleplay.*`。禁止 `user.message.created`、`chat.message.created`、`tool.completed` 这类自造名（同一事实只允许一个事件名，否则插件与 UI 会各自订阅到一半）。
- **新增事件必须同时声明分档**：只加事件名不加 `durable / deferred-durable / live` 标记一律打回。分档错了会走向两个极端——全落表把 events 撑爆，全不落则重启后执行树断了。
- **`roleplay.*` 与状态溯源分工**：`roleplay.*` 事件挂在全局 `events` 表（面向订阅者/UI/Telemetry）；角色状态的可回放补丁走专用 `character_state_events` 表（`patch + prev/next version`，面向状态还原），两者并存，见 database-schema §29.5。
- **durable 事件必须持久化到 `events` 表并带幂等 `event_id`**：Agent 的 waiting（等批准 / 等工具 / 等外部事件）不能依赖内存 Promise，进程重启后要能靠事件唤醒（agent-runtime-spec §116–§119）。
- **Telemetry 不得成为同步硬依赖**：Event Bus 可以 in-memory 分发，重要事件异步落库。deferred-durable 批次允许合并写入。
- **派发器必须吃掉订阅者异常**（工程纪律 D5）：一个订阅者抛错，不得中断派发链、不得让后续订阅者收不到事件、不得把异常冒泡成 emitter 的失败。派发循环包 try/catch + log，单个坏订阅者只影响它自己。
- **待办**：事件清单应尽早做成**源码常量 + 从源码生成文档**，防止事件名再次分叉（现在这份表已经是第三次统一了）。可参照 DeepSeek Harness 的 `gen-cordis-catalog` 思路，但按我们的体量做轻量版即可。

Event Bus 在 P0 就存在；插件、UI、Telemetry、Agent Runtime 都建立在事件之上。

### 5.5 运行期不变量与工程纪律

**运行期不变量**——不是"建议"，是必须在代码里断言、会抛错的检查：

| 不变量 | 触发时机 | 违反后果 |
|---|---|---|
| **发模型请求前必挂 `snapshotId`**，且该 snapshot 必须存在 | Provider 调用前 | `INVARIANT_VIOLATION`，**不发请求** |
| **模型可见即已记录**：任何进入模型请求的内容，必须能从 snapshot 或事件日志重建 | Provider 调用前 | `INVARIANT_VIOLATION` |
| **元数据不进模型可见前缀**：遥测、调试信息、追踪 ID、插件清单一律走 header / 独立字段 / 事件流，不得进 `messages`、`system`、tool schemas | 编译期 + 序列化前 | `INVARIANT_VIOLATION` |
| **`waiting` 状态必须有对应的 durable 事件** | 状态落库前 | `INVARIANT_VIOLATION` |

第三条值得单独说。DeepSeek Harness 把自己的 API 扩展字段刻意留在 `messages` / system prompt / tool schemas **之外**，理由写得很直白——"它们不增加 model-input tokens，也不改变模型可见前缀"。这与本项目「缓存前缀稳定性压倒一切」的立场同源。我们没有服务端、不上报会话日志，但**同类的诱惑一样存在**：把调试标记或追踪 ID 塞进 prompt 是最省事的写法，代价是整个缓存前缀每次都变。一律走旁路。

**工程纪律 D1–D5**（参照 DeepSeek Harness `docs/defensive-patterns.md` 提炼，那边原话是"每一条都是真的踩过或差点踩过的坑"）：

- **D1 正交结果独立上报**。一个结果可以同时是好几件事——进程可以既超时又退出码 0（它捕获了信号）。`timedOut` / `signal` / `exitCode` 各自成字段，禁止把其中一个嵌进另一个的分支里，否则调用方会把被截断的运行读成干净成功。落地见 agent-runtime-spec §35。
- **D2 公共契约两边都守**。实现内部可以有多种失败表示（抛异常 / 返回错误帧 / 事件），但对外的公共 API 只暴露**一种**归一化形式。Provider 层：模型请求失败只以 `generation.failed` 出现，中间件与消费方自身的缺陷才允许抛。工具层：流水线内任意环节 throw 一律收敛为 `ToolResult.status='error'`（agent-runtime-spec §36.2）。这样调用方不必猜这个异常是谁的。
- **D3 异步状态不是同步状态**。`agent_runtime_states.status` 是**区间状态**，不是某一条消息的完成回执。多条排队消息、注入上下文、后台作业可能共享同一个 `running` 区间，取消或销毁还会丢弃没开始的项目。**禁止把 `status === 'idle'` 读成"我刚发的那条跑完了"**。真正需要归属关系的调用方必须显式定义自己的区间（从该消息的 durable 入账 receipt 起，到下一次整 agent `idle` 止），并把输出描述为"区间内"而非"由该消息产生"。反面同样要处理：如果所等的状态转换永远不会发生，等待会挂死——"没什么可等"这个分支必须显式处理。
- **D4 Dispose 必须到达静默态，而不只是发出请求**。取消 / 关会话 / 卸载插件时：先关监听与通知注册（这样迟到的完成事件不会说话），再 kill，然后 **await** 子任务真的退出。只发 kill 就返回会留下孤儿。
- **D5 派发器必须吃掉订阅者异常**。见 §5.4 硬约束第五条。这条是我们 Event Bus 之前完全没规定的，风险最高。

## 6. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| Language | TypeScript strict 全栈 | IR 类型前后端共享；酒馆生态是 JS，资产解析零摩擦 |
| Backend | Node.js 22 + Hono | 轻量、TS 原生、SSE 一流 |
| Frontend | React + Vite | 组件生态最厚，预设/世界书等复杂表单省力 |
| UI | Tailwind + shadcn/ui | 与 zone 色彩语义系统（§30）契合 |
| State | Zustand | 轻量 store |
| Database | SQLite + Drizzle + FTS5 | 单用户本地最优；消息树/全文搜索/用量都是关系型诉求 |
| Vector | sqlite-vec | 记忆检索（P4） |
| Validation | Zod | 资产导入校验 |
| Test | Vitest | 快照/前缀稳定性测试主战场 |
| Package | pnpm workspaces | core 纯函数包独立测试 |
| Desktop | Tauri v2（P5） | web 先行，桌面壳只是分发形态 |
| Transport | HTTP + SSE | 单连接事件流 |

存储原则：**SQLite = Runtime State；Files = Portable Assets**。角色卡、世界书、预设等可移植资产存磁盘，不锁死在数据库中。

## 7. 仓库结构

```text
WhisperTavern/
├─ apps/
│  ├─ server/            # Hono：HTTP 路由 + SSE 网关（纯传输层，无业务逻辑）
│  │  ├─ api/
│  │  └─ server.ts
│  └─ web/               # components / panels / stores / main.tsx
├─ packages/
│  ├─ contracts/          # 核心类型 + Zod Schema 单一真相源（specs/shared-contracts-spec.md，§38 决策 29）
│  ├─ api-types/          # 前后端共享线格式 DTO（HTTP/SSE 契约，specs/api-spec.md）——contracts 的线格式投影/反导出
│  ├─ core/              # 纯 TS 无 IO：ir/ compiler/ worldbook/ macros/ budget/ cache/ serializer/
│  ├─ runtime/           # events/ permissions/ scheduler/ snapshots/ context/
│  ├─ agent/             # runtime/ workflow/ tools/ skills/ memory/ artifacts/
│  ├─ adapters/          # openai/ anthropic/ gemini/ local/
│  └─ st-compat/         # character/ worldbook/ preset/ chat/
├─ data/                 # cards/ worldbooks/ presets/ backgrounds/ + chats.sqlite
└─ docs/
```

> 结构修正：V2 草案在 apps/server 下另有 runtime/events/plugins，与 packages/runtime 职责重叠。统一为 **apps/server 只做传输**，事件总线、权限、调度、快照全部在 packages/runtime；插件宿主的权限/调度面在 packages/runtime，工具/技能面在 packages/agent。

## 8. Prompt Intermediate Representation

Prompt Compiler 的核心对象不是字符串，而是段落 IR：

```ts
type Segment = {
  id: string                    // 稳定 ID：预设 identifier / 世界书 uid / 摘要块 id
  source: 'preset' | 'worldbook' | 'character' | 'persona' | 'summary'
        | 'history' | 'memory' | 'workflow' | 'system'

  role: 'system' | 'user' | 'assistant'
  content: string               // 宏展开后的最终文本

  semanticPlacement: SemanticPlacement   // 酒馆语义要求的出现位置
  cachePlacement: CachePlacement         // 缓存视角的物理组织（zone + physicalOrder）

  stability: 'frozen' | 'append' | 'perRound' | 'volatile'

  order: number                 // 语义序（酒馆 order/uid）
  physicalOrder?: number        // 稳定区条目：首次分配后永不改变（§11）
  tokens: number

  dependencies: string[]        // 宏/条目/消息依赖（失效传播与二分定位用）
  metadata?: Record<string, unknown>
}
```

`id` 稳定 ID 约定沿用原实施规格：预设条目 identifier / 世界书 uid / 摘要块 id。

## 9. Semantic Placement 与 Cache Placement 彻底分离

V2 最重要的架构原则之一。一个世界书条目同时拥有两个正交的 placement：

- **Semantic Placement** 回答：酒馆语义要求它出现在哪里？（如 `slot: charBefore`、`atDepth(4)`）
- **Cache Placement** 回答：为了缓存，它在物理 Prompt 中应如何组织？（如 `zone: stableWB, physicalOrder: 4`）

二者不能混为一谈。酒馆兼容语义由 Semantic Placement 层严格保证（§12、§27.2），缓存优化只发生在 Cache Placement 层。

## 10. Zone 模型

```text
header → stableWB → freshWB → summary → history → injection → tail
```

**Zone 是逻辑缓存分区，不对应酒馆原始 Prompt 槽位**；酒馆槽位语义由 Semantic Placement 表达，序列化时按 Provider 消息结构等价映射（如 Anthropic 的 system 块外置）。

| Zone | 内容 | 稳定性要求 |
|---|---|---|
| header | 系统提示、预设核心段、persona、角色卡描述、静态指令 | **逐字节稳定**；动态宏不得进入 |
| stableWB | 已进入稳定缓存链的世界书条目（**成员由 chatCache 决定，与当轮激活无关**；失活条目照常发送直到退休） | **append-only**：physicalOrder 首次分配后永不改变（§11） |
| freshWB | 本轮新触发条目 | 可变；变化只影响其后内容 |
| summary | 冻结摘要块 S1..Sk | 冻结追加；追加 = 显式 CacheBreak 事件 |
| history | 对话历史窗口 | 追加式 |
| injection | @D 深度注入、AN、阶段产物 | 贴近末端，失效窗口小 |
| tail | 挥发宏、RAG 结果、工作流指令、风格指令 | 每轮可变，位于历史后 → 零缓存伤害 |

### 10.1 决策记录：summary 位于 history 之前

V2 草案曾把 summary 移到 history 之后，理由是"新摘要块插入会使 history 整体位移"。经成本对比后**维持 summary → history 布局**：

- 旧布局：摘要链字节**每轮都处于缓存前缀内**（按约 1/10 价计费）；新增摘要块（每 40–80 楼一次）使历史重发一次，属显式失效事件。
- history 之后布局：history 每轮追加导致前缀匹配止于 history 末尾，**摘要链永远无法命中缓存**，每轮按全价重发全部摘要 token 且随链增长——长对话累计成本远高于前者。

若未来需要"摘要贴近末端"的注意力收益，应以一个**有大小上限的滚动 recap** 注入 tail 区实现，而不是移动 summary 区。摘要块结构（`SummaryBlock`：id/seq/content/coversMessageRange/frozenAt）与"冻结后不可原地修改，修改 = 创建新版本"语义见 [worldbook-cache-design.md](./worldbook-cache-design.md)。

## 11. Worldbook 缓存：生命周期与物理位置分离

### 11.1 初版方案的漏洞与修正

初版排序规则（两区各按 `(order, uid)` 排序、freshWB 整体在后）存在漏洞：当新条目 D 的静态排序键**小于**某个已毕业条目时，毕业会把 D 从 freshWB 重排进 stableWB 中部：

```text
Round N:   A B C | D    (D 首次出现，进 freshWB)
Round N+1: A D B C      (D 毕业 → stableWB 中部插入，B/C 之后字节全部位移，历史失效)
```

即**毕业动作本身可能触发第二次历史重发**——初版文档声称的"毕业 = 字节原位"只在 D 的排序键大于全部已毕业条目时成立。修正：

> **physicalOrder 在条目首次进入稳定区时分配，此后永不改变。graduation 只改 cacheState，不改物理位置。**

### 11.2 数据模型与物理布局

```ts
type WorldbookRuntimeEntry = {
  uid: number
  contentHash: string            // sha256(normalize(宏展开后文本))
  activationState: 'inactive' | 'active'
  cacheState: 'unseen' | 'fresh' | 'stable' | 'stale' | 'retired'
  physicalOrder: number          // 首次进入稳定区时分配，永不改变
  firstSeenMessageId?: string
}
```

```text
Round 1: A B C       (全新 → freshWB，存哈希)
Round 2: A B C D     (D 首次出现 → 追加，physicalOrder=4)
Round 3: A B C D     (D 毕业：fresh → stable，字节原位不动)
```

毕业 ≠ 重排。新条目只在首次出现时使其后历史重发一次。stableWB 的成员资格由 chatCache（内容哈希集合）决定，**与当轮激活无关**：失活条目照常发送，只有 retirement（显式失效事件）才移除——否则失活即从序列中部消失，等于未声明的前缀断裂（Compatibility Mode 按 ST 语义即时移除，但产生 WORLD_BOOK_DEACTIVATED 声明事件）。

### 11.3 语义偏离与双模式

append-only 使条目物理顺序由**首次激活顺序**决定，不再严格等于酒馆 `(order, uid)` 语义序。处理：

- **Performance Mode（默认）**：append-only + 全部缓存优化；必须通过 Semantic Equivalence Test（§27.2）。
- **Compatibility Mode**：回退酒馆语义序，放弃该优化，严格保持酒馆行为。
- 条目级 `zoning.pin` 可强制单条回到语义位置。

### 11.4 编辑与退休

- **编辑已注入条目** = 旧化身退役（移出稳定区）+ 新内容以新 physicalOrder 进 freshWB 尾部。失效窗口与原位重注入相同（都从旧位置起），但保持分区连续；旧哈希成为死键，可惰性清理。
- **Retirement**：stableWB 只增不减会膨胀。连续 N 轮未激活且 priority 低于阈值才允许 retire；退休属**显式 CacheBreak 事件**（一次性重发历史，之后恢复稳态），默认关闭、UI 提供开关。

## 12. Worldbook Activation（酒馆语义权威清单）

Worldbook Engine 首先严格执行 SillyTavern 语义，产出 `ActivatedEntries`，之后才进入 Cache Placement：

主关键词 / 次关键词、selectiveLogic（AND ANY / AND ALL / NOT ANY / NOT ALL）、recursive scan（含 excludeRecursion / preventRecursion / delayUntilRecursion）、scan depth、probability、constant（蓝灯）/ selective（绿灯）/ vectorized、sticky / cooldown / delay、character filter、match scope（六个 match\* 字段）、group / groupWeight / useGroupScoring、outlet（1.18 新增注入点）、world_info_budget（默认 25% + cap）。

语义对照权威源：SillyTavern 1.18 `world-info.js`（位置枚举、预算、定时效应、递归行为），逐项对拍清单见 [st-reference-analysis.md](./st-reference-analysis.md) §2；原生 .dgworld 格式与字段映射见 [technical-plan.md](./technical-plan.md) §5.3。

## 13. Macro Engine

宏是 Prompt Cache 最大的隐性杀手之一。V2 不允许宏被当作简单字符串替换——每个宏携带 **volatility** 属性：

| 级别 | 示例 | 处理 |
|---|---|---|
| STATIC | 静态文本 | 任意区 |
| SESSION | `{{char}}` `{{user}}` | 按聊天冻结后可进 header |
| REQUEST | `{{roll}}` | 本请求内冻结 |
| MESSAGE | `{{lastMessage}}` | 随消息冻结 |
| VOLATILE | `{{time}}` `{{date}}` `{{random}}` | 只允许进 tail，或冻结取值 |

**Placement Rule**：VOLATILE 宏出现在 header / stableWB 时，Inspector 必须警告 `⚠ Cache Killer`，并提供 **Freeze Value**（转为会话冻结值）或自动降级到 tail。酒馆预设里系统提示嵌 `{{date}}` 是隐性命中率杀手，预设编辑器在编辑时就检测标红（见 [ui-design.md](./ui-design.md) §4.4）。

## 14. 缓存契约与生命周期

### 14.1 Stable Prefix Contract

凡进入 stable prefix 的内容必须满足 `Round N == Round N+1`（byte-for-byte identical）；做不到的内容不能进入稳定前缀。该契约由测试（§34）和遥测（§33）双重保障。

### 14.2 Segment 缓存生命周期

```text
unseen（从未进入当前聊天）→ fresh（本轮首次进入）→ stable（已成为稳定物理序列一部分）
→ stale（源数据已变，旧缓存记录保留）→ retired（长期未用，移出稳定区）
```

stale 语义沿用狐神抚指纹失效机制：变更**只标记不删除**（保护用户手编内容，可回滚）；提供"固定态"（用户手动维护、永不自动失效）与"强制刷新"两个显式覆盖。详见 [worldbook-cache-design.md](./worldbook-cache-design.md) §10。

## 15. Budget Manager

Context Budget 不只是 maxContext，而是分区预算：

```text
total budget = header + worldbook + summary + history + injection + tail + safety margin
```

### 15.1 裁剪优先级（修正版）

```text
tail / RAG        ← 缓存零伤害（位于历史后，裁剪不位移任何前缀）
→ injection       ← 只位移 tail，零伤害
→ freshWB         ← 位移 history，代价中
→ elastic history ← 整段推进（§16）
→ summary         ← 位移 history，代价大
→ stableWB        ← 代价很大，最后手段
→ header          ← 几乎不动
```

> 修正说明：初版把 freshWB 排在 injection 之前是缓存成本倒置（裁 injection 免费、裁 freshWB 要位移整个 history）。上表是**纯缓存成本序**；若 tail 中有语义上必须保留的内容（如风格/越狱指令），可在 policy 中标记 protect 使其跳过裁剪——裁剪策略可配置，最终顺序以 CachePlan 的 reasons 记录。

## 16. Elastic History

参考狐神抚"弹性楼层窗口"机制（其实测有效，见 [hushenfu-v18-analysis.md](./hushenfu-v18-analysis.md) §3.2）：

```text
H1 H2 H3 H4 H5 H6   ← Pinned History（稳定锚点，钉死）
H7 H8 H9 H10        ← Elastic History（尾部弹性区）
```

弹性区撑满后**一次性整体推进锚点**，而不是每轮删除一条——减少前缀被连续破坏。锚定带每楼内容签名（`role:length:FNV`），编辑/删除自动失效重建。与 §15.1 的裁剪共同构成两级策略：先裁 volatile/新条目，再整段滑动历史。

## 17. CachePlan

```ts
type CachePlan = {
  prefixHash: string
  stableTokens: number
  freshTokens: number
  volatileTokens: number
  expectedInvalidationTokens: number
  checkpoints: CacheCheckpoint[]        // 适配器翻译为 provider 原语
  invalidationRisk: 'low' | 'medium' | 'high'
  reasons: CacheReason[]
}
```

示例：Stable Prefix 42,813 tok / Fresh 2,341 tok / Volatile 1,024 tok / Expected Cache Eligible 42,813 tok。

Provider 翻译：Anthropic = 显式 `cache_control` 断点（header+stableWB+freshWB 末尾、summary+history 末尾、injection 末尾）；OpenAI 兼容/DeepSeek = 自动前缀缓存（仅保证前缀稳定）；Gemini = 隐式为主、长稳态会话可选显式 cachedContent；本地 = 无动作。完整映射与最小前缀阈值（Anthropic/OpenAI 1024、Gemini 4096）见 [worldbook-cache-design.md](./worldbook-cache-design.md) §5。

## 18. Provider 层

### 18.1 Adapter

```ts
interface ProviderAdapter {
  capabilities(): ProviderCapabilities
  generate(request: ChatRequest): AsyncIterable<ChatEvent>
}
```

OpenAI Compatible 为主干（覆盖 OpenAI/DeepSeek/GLM/Qwen/Kimi/OpenRouter/中转站），Anthropic/Gemini 保留原生适配，本地（ollama/vLLM/llama.cpp/LM Studio）走兼容端点 + 模型自动发现。自定义插头（自定义请求头/URL 改写/模型名映射）、代理、密钥本地加密（DPAPI/Keychain）、usage 字段归一等实施细节见 [technical-plan.md](./technical-plan.md) §5.1。

> **补（2026-09，见 §41.1）**：Provider Runtime 支持**同 Provider 多 API Key 轮换容错**——`RATE_LIMIT` 时在 `provider.call` 内轮换该 Provider 其余 key（上限与轮换策略受 §21.6 `AgentBudget` 约束），作为 retry/fallback 决策链（agent-runtime-spec §128–129）最便宜的一档，不派生新 Prompt Snapshot。

### 18.2 Capabilities

```ts
type ProviderCapabilities = {
  systemRole: boolean
  tools: boolean
  vision: boolean
  reasoning: boolean
  streaming: boolean
  promptCaching: boolean
  cacheType: 'automatic-prefix' | 'explicit-breakpoint' | 'context-cache' | 'none'
  maxContextTokens: number
  maxOutputTokens: number

  // 补：Agent Runtime 依赖（agent-runtime-spec §80–§82）
  structuredOutput: 'none' | 'json_mode' | 'json_schema'
  parallelToolCalls: boolean
  toolChoice: boolean
}
```

> **补（2026-09，收编 agent-runtime-spec）**：Director 选人（§80）、Checker 结论、Workflow 条件分支都依赖结构化输出。能力不足时的降级链：`json_schema` → `json_mode`（只保证是合法 JSON，不保证 schema）→ 提示词约束 + Runtime 校验 + `repairAttempts` 内修复（agent-runtime-spec §82），修复仍失败则 `STRUCTURED_OUTPUT_INVALID`，不静默降级为自然语言解析。

Compiler 不写 Provider 特殊逻辑；差异（system 折叠、采样参数降级、缓存标记翻译）由 Adapter 消化。

### 18.3 Usage 归一

```ts
type Usage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  estimatedCost?: number
  providerRaw?: unknown
}
```

各家缓存字段（OpenAI `prompt_tokens_details.cached_tokens`、DeepSeek `prompt_cache_hit_tokens`、Anthropic `cache_read_input_tokens`、Gemini `cachedContentTokenCount`）归一入库。

## 19. Prompt Snapshot

### 19.1 核心数据对象

每次真正请求 Provider 前生成：

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
  hashes: { header: string; worldbook: string; summary: string; history: string; final: string }
  tokenUsage?: Usage
  createdAt: string
}
```

### 19.2 所见即所发

Inspector 展示的 `Prompt Snapshot #N` 必须就是实际发送给 Provider 的版本。**禁止前端自己拼一个 Prompt 给用户看、后端又发送另一个**。Inspector、Replay、Debug、Regression Test 全部以 Prompt Snapshot 为事实来源。（口径：快照是"当时发了什么"的证据；Asset + Runtime State + Compiler 才是"下一轮发什么"的来源，见 §31 数据真相层级。）

快照不变量：**Snapshot 不可变**——重新编译产生新 Snapshot 而非修改旧的；每次 Provider Request 必须关联 `snapshotId`（不可为空）；任何 Cache Break 必须存在 CacheBreakReason，**不允许 `cache miss: unknown`**。

### 19.3 保留策略

- segments 元数据 + cachePlan + 哈希链：全量保留（体积小）。
- serializedPrompt 全文与 provider 原始请求/响应体：滚动保留最近 N 轮（默认 50）+ 被消息引用的快照，可配置。
- 任何被 message.usage / Replay 引用的快照不清理。

## 20. Prompt Diff 与 Cache Simulator

**Diff**：任意两轮对比（`Compare Round 27 vs 28`），按 zone 显示 token 增减（HEADER unchanged / STABLE WB unchanged / FRESH WB +2,314 / SUMMARY unchanged / HISTORY +1,842 / INJECTION +531 / TAIL +921），并定位 Cache Break Reason（哪个条目/宏变了、影响多少后缀 token）。

**Cache Simulator**：不调用真实 API，用 fake provider 模拟 100–1000 轮对话，输出逐轮 Stable/Fresh/History/Cache Break 曲线、理论缓存率、预计输入成本、最常见 Cache Killer。与 §34 前缀稳定性测试共用同一套 fake provider 基础设施。

## 21. Agent Runtime

> **完整实施规格见 [specs/agent-runtime-spec.md](./specs/agent-runtime-spec.md)**（175 节：对象层级、状态机、Context Policy、Tool / Budget / 权限、Resume / Replay、Workflow DAG、事件与验收标准）。本节只保留架构口径与"进入 Core 的边界"，细节一律以模块规格为准。

### 21.1 Agent Definition

```ts
type AgentDefinition = {
  id: string
  version: number                 // 补：Definition 版本，Run 启动时钉住（§163 热重载）

  identity: AgentIdentity
  instructions: string

  modelPolicy: ModelPolicy        // 补：primary / fallback / cheap，取代单一 model（spec §2.2、§129）
  contextPolicy: ContextPolicy    // 结构化定义见 spec §18–§24
  memoryPolicy: MemoryPolicy
  toolPolicy: ToolPolicy
  skillPolicy: SkillPolicy        // 补：可用技能包 + maxReadCharsPerCall/PerRun（§22 上下文经济性）
  runtimePolicy: RuntimePolicy    // maxTurns / maxToolCalls / maxExecutionTimeMs（spec §38）

  budget: AgentBudget
  permissions: Capability[]
  outputPolicy: OutputPolicy      // 补：message | artifact | silent | custom（spec §75）

  canDelegate: boolean
  canHandoff: boolean
}
```

> **补（2026-09）**：`model: ModelRef` 升级为 `modelPolicy`。降级链（主模型失败切备选）在 technical-plan §5.1 已承诺，但此前没进 AgentDefinition——现在归属明确：Provider Fallback 由 Provider Runtime 分类错误，Agent Runtime 决策 retry / fallback / pause，且**换 Provider 必须派生新 Prompt Snapshot**（`derivedFromSnapshotId`），不许绕过快照直接发请求（spec §129 与 §19.2 的调和）。

### 21.2 Lifecycle 与状态机

```text
idle → queued → running ─┬─ waiting（等 tool / child / approval / 外部事件）
                         ├─ paused
                         ├─ completed
                         ├─ failed
                         └─ cancelled
        waiting / paused → running → …
        interrupted（崩溃或心跳超时）→ 由 recovery scan 决定 resume / retry / fail
```

四条硬约束：

- **Run 是不可变执行记录**（spec §12）：`completed → running`、`failed → running`、`cancelled → running` 一律禁止。重新执行 = 新建 Run。
- **Retry 双层口径（裁决 C3）**：Provider / Tool 瞬时错误 = 同 Run 内 `attempt + 1`；用户点"重试" = 新建 Run 并记 `origin_run_id`。不重试的错误：`PERMISSION_DENIED / INVALID_INPUT / UNSUPPORTED_PROVIDER / USER_CANCELLED`（spec §49）。
- **Zombie Run 禁止永久存在**：Run 带 `last_heartbeat_at`，超过 `recoveryTimeout` 标记 `interrupted`；应用重启后先做 recovery scan，不允许把崩溃时的 running 当作成功（spec §96–§97）。
- **取消 ≠ 失败**：用户主动停止 = `cancelled`，与 `failed` / `timeout` 严格区分（spec §45）。取消沿 Workflow → Agent Run → Provider / Tool 全链路传播。

### 21.3 持久化与 Resume

所有执行持久化到统一表系 `runs / tool_calls / artifacts / events`（workflow 另有 workflow_runs / workflow_step_runs，见 §31 与 [specs/database-schema.md](./specs/database-schema.md) §34）。应用崩溃重启后可 `Resume Run #N` 继续执行（阶段、步数、等待中的子 Agent、进度全部还原）。

补充（2026-09 收编 agent-runtime-spec）：

- **恢复点**：新增 `runtime_checkpoints`（`turn_index / state_hash / agent_state / variables / tool_state / context_state / prompt_snapshot_id`）——Resume 从最近安全 Checkpoint 续跑，不是重跑整个 Run（spec §51–§55）。
- **恢复前校验**：比对 Compiler / Agent / Workflow / Tool / Provider Model / Runtime State 版本，不兼容 → `RESUME_INCOMPATIBLE`，默认不强行恢复，由用户选 restart / migrate / force_resume。
- **执行树**：`runs.parent_run_id` 建立 Director → Writer / Checker 的父子关系，支撑 Inspector、Replay、成本归集（spec §14–§15）。
- **等待态持久化**：等批准 / 等工具 / 等外部事件一律落库（`approvals` 表 + 事件唤醒），禁止只靠内存 Promise（spec §116–§117）。
- **Provider 请求不占事务**：编译 + 快照一个短事务 → 事务外调 Provider → 事务 B 落盘（spec §139）。

### 21.4 Context Policy

Agent 必须明确知道自己能看到什么，不同 Agent 不得默认获得整个世界：

```yaml
context:
  history: recent-40
  summary: stable
  worldbook: activated
  persona: current
  memory: relevant
  rag: on-demand
  sibling_agents: findings-only
  reasoning: never
```

结构化定义为 `ContextPolicy { history, worldbook, memory, summary, artifacts, toolResults, otherAgents }`（agent-runtime-spec §18–§24），上表是其人类可读简写。三条补充：

- **默认最小可见**：Agent 不默认看到整个世界；`history` 支持 `maxMessages / maxTokens / branchMode / pinnedMessages`，`otherAgents` 默认 `allowOutputs: true, allowState: false, allowPromptSnapshot: false`——Agent A 只能看到 Agent B 的**输出**，看不到它的隐藏状态、私有工具参数与内部 Prompt（spec §23–§24）。
- **不保存 / 不暴露内部推理**：允许存 final answer、tool calls、tool results、structured rationale、decision metadata；不依赖模型隐藏 CoT 作为 Runtime 状态（spec §25）。
- **Context Resolution 只回答"有哪些内容"，不回答"放在 Prompt 哪里"**——布局永远归 Prompt Compiler（spec §153）。

### 21.5 Permission（Capability 模型）

**权威清单（2026-09 合并总设计与 agent-runtime-spec §86）**：

```text
chat.read      chat.write
message.read   message.write
worldbook.read worldbook.write
memory.read    memory.write
artifact.read  artifact.write        ← 原 workspace.* 的正名（Agent 产物读写）
summary.read   summary.trigger
tool.execute
network.search network.fetch
filesystem.read filesystem.write
provider.call
agent.invoke                          ← 统一入口，由 InvocationPolicy 区分 spawn / delegate / handoff
workflow.invoke
```

**权限 = 能力 + 作用域**（新增，采纳 spec §87）：

```json
{ "permission": "worldbook.read", "scope": { "worldbookIds": ["book-1"] } }
```

即 Agent 可读 Worldbook A、不可读 Worldbook B。作用域缺省 = 全量。

其余硬约束：

- **拒绝必须显式**：权限不足产生 `TOOL_PERMISSION_DENIED` 事件与错误码，禁止静默失败（spec §34）。
- **Secret 隔离**：模型与 Agent 永不接触 API Key / OAuth Token / 数据库凭据，由 Provider Runtime 与 Tool Runtime 注入（spec §88）。
- **不可信 Tool 进沙箱**，至少限制 filesystem / network / process / environment（spec §89）。
- 示例：Writer = `chat.read, worldbook.read, memory.read, artifact.write, agent.invoke`；Checker = `chat.read, worldbook.read, artifact.read`，禁止 `chat.write / message.write / agent.invoke`。

### 21.6 Budget

```ts
type AgentBudget = {
  maxInputTokens: number
  maxOutputTokens: number
  maxSteps: number
  maxRuntimeMs: number
  maxCost: number
  maxToolCalls: number
  maxChildAgents: number
  maxInvocationsPerRun: number
  maxConcurrentInvocations: number
  resultBudgetTokens: number
}
```

防止无限递归 Agent、无限 Tool Call、无限 Token 消耗。声明式模型（工具白名单 + 调用/并发/结果预算 + allowedCallers + artifact）已由狐神抚 Agent Profile 验证，V2 提升为正式 Runtime API（参照 [hushenfu-v18-analysis.md](./hushenfu-v18-analysis.md) §4）。

**两层 Budget（2026-09 补，spec §39–§42）**：

```text
Agent Runtime Budget（一次 Run：turns / toolCalls / tokens / cost / 时长）
        ↓
Prompt Compiler Budget（一次编译：各 zone 的 token 配额与裁剪优先级，§15）
        ↓
Provider Generation Budget（maxTokens / context window）
```

- 三者**不可互相替代**：Compiler 的上下文裁剪省的是"这一轮塞多少"，Runtime Budget 管的是"整个 Run 花多少"。
- **并发前先预留**：剩余预算不足时不许同时启动两个估算各 $0.04 的子 Agent（reserve → execute → settle），否则并发会击穿上限（spec §42）。
- 消耗落 `runs.budget_usage`（turns / toolCalls / inputTokens / outputTokens / cachedTokens / cost / executionTimeMs）；超限 → `RUN_BUDGET_EXCEEDED`，不可静默继续。

## 22. Tool 与 Skill Runtime

**Tool** 是 Agent 的能力单元：`{ id, description, inputSchema(Zod), permission(Capability), execute(input, ctx) }`。核心 Tool：`chat.search / chat.read / worldbook.read / memory.search / memory.read / workspace.read / workspace.write / workspace.patch / agent.delegate / agent.await / agent.handoff / dice.roll / network.search / network.fetch`。

**Skill** 是 Agent 按需读取的知识/操作规范包（`SKILL.md + references/ + examples/`）。禁止无脑预读——采用"判断需要 → 读取 → 执行"，配 maxReadCharsPerCall/PerRun 字符预算（上下文经济性，狐神抚已验证）。

## 23. Workflow Runtime 与 Director

### 23.1 通用 DAG

Workflow 不写死"大纲 → 正文 → 润色"，而是 `Workflow = DAG + Agent + Tool + Artifact`：

```text
             ┌→ Persona Checker ─┐
Draft ───────┼→ Banword Checker ─┼→ Review → Patch → Commit
             └→ Format Checker ──┘
```

### 23.2 三条请求路径（决策记录：快速路径恢复为默认）

V2 草案 §41 曾把多阶段流程画成默认 RP 路径——照字面理解每条消息要 3–5 次模型调用，延迟与成本对 RP 聊天不可接受。恢复原实施规格的 Director 三路径设计：

```text
1. 快速路径（默认）：单次调用，等价酒馆体验；缓存管线全量生效
2. 完整工作流：Draft → 并行 Checker → Review → Patch（按会话开启或手动触发）
3. 记忆密集路径：长对话/记忆缺口时追加检索与记忆更新步骤
```

Director（编排器）为每轮决策走哪条路径；群聊中另负责选人。

### 23.3 默认完整 RP Workflow

```text
User Input → Director → Context Resolve → Writer
→ optional parallel: Persona / Continuity / Style Checker
→ Review → Patch → Final → History
```

### 23.4 写作 Workflow

```text
Outline → Draft → Parallel Review（角色一致性 / 剧情一致性 / 文风 / AI 味检测）
→ Revision → Final
```

各阶段独立配置 Model / Temperature / Preset / Context Policy / Budget / Skills。实战守则沿用狐神抚 fox-writer 四轮模式：固定并发批次、await 不混进并发批次、等待期流水线化（先自查 patch 再 await）。

## 24. 多阶段缓存

工作流必须避免每个 Agent 都重新发送 50k header：

```text
[Shared Header] [Stable Worldbook] [Stable Memory] [Stage Instruction] [Stage Artifact]
```

阶段之间共享稳定 Prefix（只缓存一份），阶段指令与上游产物全部放 tail；只有终稿进入 history。跨工作流阶段省 ~68% 输入（实测估算）。

## 25. Memory System

四层记忆：

| 层 | 职责 |
|---|---|
| Summary | 剧情压缩；冻结块追加（§10.1） |
| Dossier | 人物/地点/组织/物品/关系/状态的结构化事实卡 |
| Timeline | Event / Timestamp / Participants / Location / Consequences |
| Data Bank / RAG | txt/md/pdf/epub → 分块 → **FTS5 全文（关键词兜底）+ Embedding → sqlite-vec** → 检索 → **tail 注入**（不进稳定前缀） |

**Scribe Agent** 负责记忆写入：读取新剧情 → 发现重要事实 → 更新 Dossier → 追加 Timeline。Scribe 不直接修改原始聊天记录（原始消息永久保留，可回溯重摘要）。这套档案化 + 按需检索 + tail 注入替代 MVU/表格插件"每轮整表挥发注入"的模式（既省 token 又护缓存）。

## 26. Group Chat 与群聊缓存

群聊统一为 Agent Runtime：`Director → Character Agent A/B/C`，Director 决定谁说话、为什么说、是否多人回应（ST 原生 NATURAL/LIST/MANUAL/POOLED 策略为其子集，见 [st-reference-analysis.md](./st-reference-analysis.md) §5）。

缓存命名空间：

- 世界书缓存 = **chat scope**（内容寻址，角色间天然共享）；
- Provider Prompt Cache = **(chat, character) scope**（每角色独立缓存链：差异在角色卡/Persona View/角色专属 Prompt，共享世界书与历史）。

已知代价：轮换发言使各角色链 TTL 易过期（Anthropic 5min）→ 群聊模式建议 1h TTL 或接受较低命中；UI 显示每角色的链温度。详见 [worldbook-cache-design.md](./worldbook-cache-design.md) §6。

## 27. SillyTavern 兼容

### 27.1 两个等级

**Level A 资产兼容**：Character Card V2/V3（PNG/JSON/charx）、Worldbook、Preset、Chat JSONL、Persona。

**Level B 语义兼容**：prompt_order / prompts / marker / injection_position / depth / worldbook activation（§12 全清单）/ recursive scan / sticky / cooldown / delay / swipe / branch / 群聊策略枚举。语义基准是 ST 的 OpenAI Prompt 组装、PromptManager 与 world-info.js——**作为语义对照源，不复制其内部实现**。

### 27.2 Compatibility Mode 与 Performance Mode

- **Compatibility Mode**：严格保持酒馆语义，不允许缓存优化改变语义位置。
- **Performance Mode（默认）**：允许 stableWB append-only、elastic history、cache-aware placement，但必须通过 **Semantic Equivalence Test**：对同一酒馆资产，`ST reference output vs DG Compatibility Mode output` 在 Activation / Placement / Order / Role / Depth / Content 上一致。

### 27.3 Import Compatibility Report

导入酒馆资产后不显示简单的 "Import Success"，而是逐项报告：什么被完整迁移、什么被替代、什么未迁移：

```text
Character Card ✓   Worldbook ✓   Prompt Preset ✓   Persona ✓   Chat History ✓
Regex Scripts      12 / 15 migrated
SPreset ChatSquash replaced by native cache
TavernHelper       not executed（机制已由原生能力替代）
TauriTavern Agent  mapped to Agent Definition
MVU Sheets         read-only migration（档案记忆替代 + 一次性迁移工具）
```

### 27.4 扩展命名空间处理

SPreset / tavern_helper / tauritavern / regex_scripts / MVU sheets 的逐项处理策略与"机制层单向映射"承诺见 [technical-plan.md](./technical-plan.md) §5.9；导入优先级按用户真实资产排序见 [st-reference-analysis.md](./st-reference-analysis.md) §6。

## 28. 原生资产格式

| 格式 | 内容 | 设计要点 |
|---|---|---|
| `.dgcard` | 角色卡定义 | 定义与运行态分离（运行态进 SQLite）；资产结构化清单；内嵌书外置双向引用 |
| `.dgworld` | 世界书 | 语义字段 + zoning 元数据 + compat 袋；未建模酒馆字段原样暂存、导出回写 |
| `.dgpreset` | 预设 | 回归**纯声明式 Prompt 配置**（segments + params + bindings）；不再承载 JS Runtime / 缓存引擎 / 记忆引擎 / Agent 引擎 |

三格式完整 JSON schema、酒馆字段映射（position 0-7 → slot 枚举、disable 极性反转等）、往返保证与导入导出规则见 [technical-plan.md](./technical-plan.md) §5.3 / §5.5 / §5.10。承诺：**提示词层双向无损；机制层单向映射**（酒馆机制 → 原生能力，导出不回走私代码）。

## 29. Plugin 与安全模型

**Plugin = Manifest + Permissions + Events + Commands + Tools + UI Extensions + Storage**；iframe 只是 UI Sandbox，不是 Plugin 本体。权限显式声明（`chat.read / ui.panel / storage.own / network.fetch / provider.call:deepseek / filesystem.read:data/cards` 等），按 Capability 授权。

安全模型：最小权限原则。禁止 Plugin = full application access、Agent = full filesystem、Tool = unrestricted network。自定义 CSS 允许但隔离注入。服务端钩子只开放白名单参数（如 `prompt:postBuild` 只允许改 tail 区），避免重蹈"扩展随便改 prompt 毁缓存"的覆辙。

## 30. UI 概要

### 30.1 信息架构

```text
┌──────────┬──────────────────────────────┬──────────────┐
│ Sidebar  │          Chat                │ Inspector    │
│ Cards    │          Messages            │ / Worldbook  │
│ Chats    │          Input               │ / Workflow   │
│          │                              │ / Telemetry  │
└──────────┴──────────────────────────────┴──────────────┘
```

聊天工作台常驻主界面、消息树直接可见、生成过程可介入、桌面优先（1280px+）。完整界面详设、面板清单与里程碑映射见 [ui-design.md](./ui-design.md)。

### 30.2 Prompt Inspector

展示 Prompt Snapshot 本体，提供 Overview / Segments / Tokens / Cache / Macros / Worldbook / History / Provider / Raw / Diff 十个视图；缓存二分工具定位第一个分歧字节并点名原因。

### 30.3 缓存可视化

统一 zone 视觉语义（颜色贯穿 Inspector / 世界书编辑器 / 遥测 / 工作流）：HEADER stable / STABLE WB stable / FRESH WB fresh / SUMMARY frozen / HISTORY append / INJECTION near-tail / TAIL volatile。色板见 [ui-design.md](./ui-design.md) §5。

### 30.4 Workflow Panel

每个阶段显示状态/耗时/token/成本/模型，可展开 Input/Output/Prompt Snapshot；失败可从该阶段重跑。

### 30.5 事件驱动

前端使用**单一 SSE 连接**接收 `message.delta / stage.update / agent.update / usage.recorded / cache.invalidated / prompt.compiled`；UI 不轮询 Agent 状态。编译在服务端、展示在前端，前端只消费编译快照。

## 31. 数据模型与保留策略

【2026-09 修订】收编 [specs/database-schema.md](./specs/database-schema.md) 后的表体系，按五层组织：

```text
用户与资产注册层
  users / characters(+versions) / personas(+versions) / presets(+versions)
  worldbooks / worldbook_entries(+versions)
  agents(+versions) / workflows / macros

Chat 状态层
  chats / messages / chat_branches / chat_members(P4) / summary_blocks / memories(+versions)

执行态层
  runs / tool_calls / artifacts
  workflow_runs / workflow_step_runs / agent_runtime_states
  roleplay_states / story_threads / roleplay_snapshots     ← Roleplay Runtime（P4，database-schema §29.1–29.3）
  relationship_states / character_state_events            ← 关系边表 + 状态溯源（P4，§29.4–29.5）
  worldbook_runtime_entries / worldbook_activations

Prompt 证据层
  prompt_snapshots / prompt_snapshot_dependencies / replay_sessions
  cache_runtime_states / cache_checkpoints / cache_invalidations

基础设施层
  providers / models / generations / events
  plugins / plugin_states / import_jobs / export_jobs
  schema_metadata / migrations
```

要点：

- **混合资产存储**（§38 决策 11）：.dgcard/.dgworld/.dgpreset 文件是资产事实源（可移植、可分享）；DB 只存注册索引 + 版本快照（Chat 绑定时拍摄，保障历史 Replay）+ 运行态。
- **运行态专用表取代 KV**：原 chat_state KV 由 worldbook_runtime_entries（cache_state / physical_order / sticky / cooldown / delay）与 cache_runtime_states 取代；physicalOrder 可由 worldbook_activations 的首次激活序确定性重建。
- **Message ≠ Generation**：流式部分输出进 generations（挂 snapshot_id），Runtime 接受后才创建 Message；每次生成 = 一条 run（P0 起 agent 字段留空）。Provider 请求不得长时间占用数据库事务（编译+快照一个短事务 → 事务外调 Provider → 事务 B 落盘）。
- **数据真相层级**：Asset → Version → Runtime State → Snapshot；快照是执行证据（§19.2 口径），不是下一轮 Prompt 的来源。
- **活跃指针唯一来源**：chats.active_branch_id → chat_branches.leaf_message_id；messages 不设 is_active。
- 消息为追加式消息树（parent_message_id + variant_group_id/variant_index）：Swipe = 同组 sibling variant，Branch = 切换 leaf，Edit = 新 version，均不覆盖旧消息；历史检索从 active leaf 走 parent 链，全局 sequence 不是历史。
- **分支血缘位**（§38 决策 25，2026-09 补）：Branch 额外记录 `parent_message_id` + `seed_length` + `is_seeded`（`is_seeded` = 该分支是否含从父分支继承的事件前缀）。**继承前缀视为可复用的缓存前缀**：fork 出去的分支可以直接命中父分支已缓存的前缀，不必从零重发。对长 RP 是实打实的省钱项——分支是 RP 的核心玩法，每次分叉都全量重发的成本不可接受。参照 DeepSeek Harness 的 fork 语义（`seed + parentSession + seedLength + isSeeded`）。
- 保留策略：见 §19.3（快照/原始体滚动清理）；worldbook_activations / events 审计表按 seq 滚动归档；运行态表可清理（可从资产 + 激活审计重建，最坏代价 = 缓存一次性重发）。

列级定义、索引、并发（乐观锁/stateVersion）、迁移与实现顺序（已映射到 P0–P5）见 [specs/database-schema.md](./specs/database-schema.md)。

## 32. Replay 与确定性调试

Replay 使用 Character / Persona / Preset / Worldbook State / Memory / Message Branch / Prompt Snapshot / Model / Sampling Params 重新生成；支持 **Replay with Model B** 做 A/B 对照，同时比较 Prompt Diff / Output Diff / Cost / Latency / Cache。这使 WhisperTavern 从"聊天客户端"升级为 **AI Runtime Debugging Environment**。

## 33. 遥测与缓存诊断

### 33.1 每轮记录

input tokens / cached tokens / fresh tokens / output tokens / estimated cost / latency / TTFT / generation duration / cache hit / cache miss / cache break reason。

### 33.2 四层缓存指标

必须同时展示，**不能把"理论稳定前缀"直接等价为"Provider Cache Hit"**：

```text
Theoretical Stable Prefix → Cache Eligible → Actual Cached → Fresh
示例：48,231 → 48,231 → 47,910 → 3,821（Actual Cache Ratio 92.6%）
```

### 33.3 CacheBreakEvent

每次 Cache Break 生成诊断事件：断裂位置（segment id）、原因（新条目 / 宏变化 / 消息编辑）、受影响 token 数、处置建议（acceptable / Freeze macro / move to tail）。部分 provider 不回传缓存 usage 时，降级为前缀稳定性间接指标（自家序列化哈希链）。

## 34. 测试策略

测试重点不是普通 CRUD，而是 **Prompt Semantics + Prefix Stability + Runtime Recovery**：

| 测试 | 内容 | 断言 |
|---|---|---|
| Prompt Golden Test | 真实资产（仓库内 `地点.json` / `简单预设_V2.0.json` 等）走 Import → Compile → Serialize 生成金样 | 任何语义变化必须显式审查 |
| Prefix Stability Test | fake provider 模拟 1000 轮（含 WB 激活/编辑、Swipe、Reroll、Branch、宏、Summary、Budget 溢出、群聊、Agent workflow） | stable prefix 不变，除非显式 invalidation event |
| Semantic Equivalence Test | ST reference vs DG Compatibility Mode | Activation/Placement/Order/Role/Depth/Content 一致 |
| Agent Runtime Test | Spawn/Delegate/Await/Timeout/Retry/Cancel/Failure/Resume/Nested/Budget exceeded/Permission denied + **崩溃重启恢复** | 全部可用；**必测场景以 [specs/agent-runtime-spec.md](./specs/agent-runtime-spec.md) §174 的 10 个场景为准**（普通聊天 / Tool Loop / Cancellation / Retry / Resume / Crash Recovery / 并行 Workflow / Permission / 每次 Provider Request 必有 Snapshot / 确定性 Replay） |
| Provider Contract Test | 每个 Adapter 用录制回放 fixture 测 Streaming/Usage/Error/Retry/Tool Call/Cache Metadata | 归一正确 |
| Property / Fuzz / Regression / Determinism | 随机生成世界书/消息/分支/宏跑 1000+ 轮；fuzz 宏语法 / CJK / emoji / 畸形 ST JSON；每个真实 Bug 固化为 regression fixture；同一输入三次编译哈希一致 | 无显式失效 → 稳定前缀不变；编译器不崩溃；确定性 |

CI 稳定性测试零 API 成本即可验证命中率 claim；真机遥测闭环（命中率曲线 + 二分工具）见 [technical-plan.md](./technical-plan.md) §8。

## 35. 性能、可靠性与错误模型

**压力基线**：10,000+ messages、100+ worldbook entries、1M token 逻辑上下文、10+ 并发 agents、100+ tool calls；要求 UI 不阻塞、Inspector 可用、查询可接受、Agent 状态实时更新。

**编译性能目标**（目标值，最终以实际 benchmark 为准）：小聊天 <20ms、中型 <100ms、大型 <500ms、10k 消息增量编译 <1s。大上下文（100k+ token）使用消息/段落引用与惰性内容，禁止全量 stringify Runtime State 作为 Compiler 输入。

**可靠性**：Atomic DB transaction / Crash recovery / Agent resume / Generation cancellation（Stop 点击沿 Parent Agent → Child Agent → Tool Call 明确传播）/ Partial artifact preservation / Provider retry / Idempotency。

**错误模型**：ProviderError / PromptCompileError / ToolError / AgentError / PermissionError / BudgetError / TimeoutError / CancelledError / CompatibilityError——每种必须可观察、可记录、可恢复或可重试（如适用）。

## 36. 路线图

开发顺序不是"功能越多越好"，而是先把 P0→P2 做成"真正优秀、可解释、可测量的 AI Chat Runtime"，再扩 Agent。**不要一开始同时实现酒馆兼容、缓存、群聊、RAG、Agent、插件、Tauri——否则每个模块都有一点，但没有一个模块真正完成。**

| 阶段 | 内容 | 规模（单人） | 验收标准 |
|---|---|---|---|
| **P0 Core Runtime** | monorepo、core IR、Prompt Compiler + Snapshot、3 类适配器、流式、token 计数、消息树、基础 Chat UI、SQLite、密钥/设置、Event Bus（最小版） | 2–3 周 | DeepSeek/OpenAI 兼容、Anthropic、Gemini 流式聊天，可保存可重启；usage 入库；Snapshot 可查 |
| **P1 ST Compatibility** | 卡 V2/V3/PNG/charx、世界书引擎完整触发语义、预设映射、Persona 库、编辑/swipe/分支、Prompt Inspector、金样测试 | 3–4 周 | 目录内真实资产导入跑通；金样测试绿；Import Compatibility Report |
| **P2 Cache Engine** | Macro Engine、stableWB/freshWB 分区 + per-chat 哈希缓存、physicalOrder append-only、CachePlan、Budget + Elastic History、各 provider 缓存标记、遥测面板、二分工具、Cache Simulator | 2–3 周（可与 P1 并行） | CI 100 轮稳定性测试绿；1000 轮模拟无未声明失效；真实 API 稳态命中率 ≥70%，对照传统装配输入成本削减 ≥60% |
| **P3 Agent Runtime** | Agent Definition/Lifecycle/持久化 Resume/Context Policy/Permission/Budget/Tool Runtime/Skill Runtime/Workflow DAG/Artifact/Event Bus 完整版 | 3–4 周 | 通过 [specs/agent-runtime-spec.md](./specs/agent-runtime-spec.md) §173 验收标准（Agent / Workflow / Tool / Context / Prompt / Replay / Recovery 七组）与 §174 全部 10 个必测场景；单/多 Agent、Delegate/Await/Cancel/Resume/崩溃恢复全部可用 |
| **P4 Memory + Workflow + 群聊 + Roleplay** | Summary/Dossier/Timeline/RAG/Scribe/网络搜索（结果注 tail / agent 工具）/Director 三路径/默认工作流/工作流 UI/群聊控制台/per-char 缓存 + 记忆检索双引擎（FTS5 关键词兜底 + sqlite-vec，§25 / §41.1）+ Roleplay Fast 档（角色连续性 / Behavior Director 规则 / Story Thread / Expression History，[specs/roleplay-runtime-spec.md](./specs/roleplay-runtime-spec.md)） | 4–6 周 | 300+ 楼长对话对照基线（P2 模式）质量与成本可测提升；3 角色群聊 50 轮缓存行为符合预期；RP Fast 档每轮恰 1 次调用且稳定前缀不变 |
| **P5 Plugin + Desktop + Roleplay Deep** | Plugin SDK、iframe UI Sandbox、Plugin Permissions、主题/背景/快速回复/备份/导入导出、Tauri、酒馆聊天记录导入、i18n + Skill 对齐 `agentskills.io` 标准（§22 / §41.1）+ Roleplay Deep 档（LLM Behavior Director / Critic / Quality Gate / Benchmark / Inspector，[specs/roleplay-runtime-spec.md](./specs/roleplay-runtime-spec.md)） | 持续 | alpha 发布 |

顺序说明：**P2 是本项目最大差异化价值，建议尽早并优先打磨**；P1 先落世界书"激活层"后 P2 即可并行开工。

## 37. 版本验收四问

任何新功能进入 Core 前必须回答：

1. **它会不会改变 Prompt？** 会 → 必须经过 Prompt Compiler。
2. **它会不会破坏 Cache？** 会 → 必须产生 CacheBreakReason。
3. **它会不会影响 Agent？** 会 → 必须经过 Agent Runtime。
4. **它有没有办法 Debug？** 没有 → 功能暂不接受进入 Core。

Prompt Compiler 模块另有验收"五问"（源自 [specs/prompt-compiler-spec.md](./specs/prompt-compiler-spec.md)）：**这一轮模型究竟看到了什么？为什么看到这些？哪些内容可以缓存？为什么缓存断了？换一个模型 / 重新运行，这个 Prompt 能否完全复现？**

## 38. 已定决策记录

原 technical-plan 开放决策点章节的决策已全部落定（现该章编号为 §11），合并稿新增三项：

1. 前端 React（而非 Svelte/Solid）——为组件生态妥协。
2. 消息与状态 SQLite（而非酒馆式纯文件）——为消息树与查询妥协；文件仅存可移植资产。
3. Prompt 组装在服务端（酒馆在前端）——为 Agent/插件/遥测共用同一管线。
4. 首轮世界书注入范围：**仅本轮激活条目**进缓存；小世界书可开 preloadAll 开关。
5. 桌面化放 P5；P0–P4 为本地 web 应用（localhost）。
6. **summary 区位于 history 之前**，摘要块追加 = 显式 CacheBreak 事件（成本推导见 §10.1 与 [worldbook-cache-design.md](./worldbook-cache-design.md) §3.4）。
7. **stableWB 默认 first-seen append-only 物理序**（Performance Mode）；Compatibility Mode 回退酒馆语义序（漏洞分析见 §11.1）。
8. **编辑已注入条目 = 旧化身退役 + 新化身进 freshWB 尾部**（失效窗口与原位重注入相同，且保持分区连续，见 §11.4）。
9. **Activation Engine 拆出为有状态前置阶段，Compiler 保持纯计算**（收编 prompt-compiler-spec 时修正总设计初稿的自相矛盾，见 §5.1）。
10. **stableWB 成员资格由 chatCache 决定、与当轮激活解耦**：失活条目照常发送直到显式退休；Compatibility Mode 按 ST 语义即时移除但产生 WORLD_BOOK_DEACTIVATED 声明事件（修正 worldbook-cache-design §2.1 初版公式的隐含断裂，该矛盾由 prompt-compiler-spec §30 评审暴露）。
11. **混合资产存储**：.dgcard/.dgworld/.dgpreset 文件为资产事实源（可移植、可分享）；DB 只存注册索引 + 版本快照（Chat 绑定时拍摄，供历史 Replay）+ 运行态——database-schema 初稿"资产全入库"按此修正（沿用决策 2）。
12. **SQLite 为 V2 唯一目标库**（确认决策 2；PostgreSQL 双支持移出交付，Repository/Adapter 仅作代码卫生）；执行态统一为 runs / tool_calls / artifacts / events 表系（取代初稿 agent_runs 系列命名）。

**收编 agent-runtime-spec 新增（2026-09）**：

13. **单聊快速路径 = 退化为单节点的 Workflow，Director 不参与**（裁决 C1）。统一抽象成立（Single Chat = 一个 Character Agent），但不许因此给每条消息引入额外模型调用——这正是 §23.2 恢复快速路径为默认的原因。Director 只在群聊与显式开启完整工作流时介入。
14. **冻结 Artifact 不进稳定前缀**（裁决 C2）。`frozen = true` 只表示内容不再变化、可安全引用与复用，**不改变缓存分区**：产物一律进 `injection` / `tail`。理由与 compiler-spec §83 一致——在前缀中部插入内容会破坏其后全部字节稳定性。
15. **Retry 双层口径**（裁决 C3）：Provider/Tool 瞬时错误 = 同 Run 内新 Attempt；用户点"重试" = 新建 Run + `origin_run_id`。Run 本体永不从终态改回 running。
16. **事件名以 §5.4 为唯一权威清单**，Capability 以 §21.5 为唯一权威清单（含资源级 scope）。此前 ui-design 的冒号记法与 agent-runtime-spec 中的自造域名一律作废，P0 前统一（插件 API 会依赖事件名，越晚改成本越高）。
17. **ModelPolicy 取代单一 ModelRef**（§21.1）：primary / fallback / cheap 三档；**换 Provider 必须派生新 Prompt Snapshot**（`derivedFromSnapshotId`，同 IR 重新序列化），不许绕过快照直接发请求——维护 §19.2"每次 Provider Request 必挂 snapshotId + Snapshot 不可变"的证据链。
18. **统一执行层级 Run / Attempt / Step Run / Operation**（2026-09，收编 AI 建议，裁决 C5）：Agent Runtime 全部运行行为收敛为四层——Run“做什么”、Attempt“这次怎么做”（持执行环境）、Step Run“哪一步实际做了一次”、Operation“底层调用发生了什么”。Retry 一律创建新记录；设施级 HTTP 重试归 Operation。**用户重试语义维持 C3（新建 Run + `origin_run_id`），不改为同 Run 新 Attempt**。Phase 纪律：Operation 与 agent 级 `step_runs`、`attempts` 独立表仅 **P3** 引入，P0–P2 保留 `runs.attempt` 列（agent-runtime-spec §4.1–4.6、database-schema §34.1–34.3）。

**参照 DeepSeek Harness 补强执行语义新增（2026-09-05）**：

19. **事件持久化分档**（§5.4）：`durable / deferred-durable / live` 三档，判据唯一——**进程重启后重建执行树或账目是否需要它**。新增事件必须同时声明分档，否则打回。`generation.delta` 归 live（每 token，落表会撑爆 events）；`cache.*` / `usage.*` 归 deferred-durable（异步批量，允许延迟不允许丢）。
20. **运行期不变量 + 工程纪律 D1–D5**（§5.5）：不变量是**必须在代码里断言并抛 `INVARIANT_VIOLATION`** 的检查，不是建议。四条不变量：请求必挂 snapshotId / 模型可见即已记录 / 元数据不进模型可见前缀 / waiting 必须有 durable 事件。五条纪律：D1 正交结果独立上报、D2 公共契约两边都守、D3 异步状态不是同步状态、D4 Dispose 必须到达静默态、D5 派发器必须吃掉订阅者异常。
21. **工具执行流水线五段**（agent-runtime-spec §36.1–36.3）：pre → approval → guards → execute → post，外加抛错归一化与 finalizeContent。approval 必须排在 guards **之前**（否则刚批准的调用会被同一个守卫再拦一次）。**并行工具结果按 model order 回灌，不得按完成顺序**——否则每次重放组装出的 prompt 不同，缓存前缀必然失效，§174 的确定性 Replay 必测场景直接挂掉。
22. **审批 fail-closed 四值**（agent-runtime-spec §115.1）：`allowed_once / rejected / cancelled / unavailable`，只有第一种放行。无回答者、回答者抛错、返回值不合规一律 `unavailable` = 拒绝。**后台 workflow / 定时任务 / 群聊跑批没有 UI 回答者，默认必须是拒绝**——放行等于危险操作自动通过，挂起等于 Run 永久卡死。`approval.requested` 与 `approval.decided` 成对落库且 log-only，不进模型转录。
23. **上下文溢出反循环**（agent-runtime-spec §49.1）：`PROMPT_CONTEXT_TOO_LARGE` 是可重试但有前提的错误。捕获后先降级（裁剪 → 摘要），**只有当重算的 replacement generation 确实前进了才允许重试一次**；生成号没前进说明裁剪无效果，原错误保持权威、不再重试。否则会对同一个注定失败的 prompt 死循环到预算耗尽。Cancellation 优先于以上一切。
24. **动态上下文逐字未变可复用快照**（裁决 C6，prompt-compiler-spec §84.2）：**仅限白名单内的动态上下文段**（时间、当前激活 worldbook 状态、角色状态等，且位置固定在 tail），内容逐字未变时复用上一次的 snapshotId，不重新物化，不产生 CacheBreakEvent。**阶段产物不在此列，仍按决策 14（C2）一律 injection / tail**——C2 禁的是"内容会变的东西"进前缀，C6 说的是"内容确实没变就别重新物化"，两者不冲突但白名单必须写死。
25. **Swipe / Branch 血缘位**（§31）：消息树分支记录 `parent_message_id` + `seed_length` + `is_seeded`。继承前缀视为**可复用的缓存前缀**——fork 出去的分支可以直接命中父分支的缓存前缀，对长 RP 是实打实的省钱项。
26. **AI 协作编码规范**（technical-plan §7，2026-09-05 新增、同日评审修订）：本项目代码由 AI 会话接力生成（**P0 起全部如此**）、每次会话无记忆，因此明确——①注释分层：导出 API/模块头用 TSDoc，**必注**触及 spec 铁律的 why 决策（指向 spec 节号并带节标题），**禁注** what 型逐行翻译，量化锚点"**行内**注释与代码行比 ≈ 1:10"（TSDoc 与模块头不计入）；②**spec 是真相源，不另产平行详设**——详设位置三岔：核心 Runtime 与 API 契约在 specs/、Provider 实务/st-compat/资产格式在 technical-plan §5、UI 在 ui-design；新核心模块先落 spec 骨架再写码；改代码触及 spec 语义必须同步修订 spec（含其头部版本行），冲突时能改代码就改代码、确属 spec 错误才改 spec 并在此记录；③会话收尾写 `.workbuddy/memory/YYYY-MM-DD.md`、开工先读 memory + §38。落地背景：注释与文档是跨会话传递上下文的唯一载体。
27. **API 规格收编**（specs/api-spec.md V2.1，2026-09-05）：HTTP/SSE 控制面契定为第四份模块规格——路由/信封/错误码/幂等/并发（version + If-Match）/SSE 协议（run 内 sequence 单调递增 + Last-Event-ID 断线续传）/长任务"立即返回 runId + SSE"原则/分阶段 API 范围（P0→P5）。同时确立**文档优先序：模块规格（对象形状/状态机）> API 规格（线格式投影）> 总设计（架构口径）**；事件名与持久化分档一律以 §5.4 权威表为准——API 初稿的 agent.* 平铺命名、generation.usage、workflow.node_*、message.branch_changed 作废并入既有事件，provider/import/export/memory/artifact 五个域反哺进权威表并带分档；DTO 口径：PromptSnapshot hashes 以 compiler-spec §67 八区为准、SegmentSnapshot stability 三值为五级投影、AgentBudget 补 maxInvocationsPerRun/resultBudgetTokens；§151 包结构修正并采纳 **packages/api-types** 进 §7；M2–M5 重映射 P2–P5。
28. **Roleplay Runtime 模块化收编**（specs/roleplay-runtime-spec.md V1.1，2026-09-05，裁决 R1–R6）：把"RP 智能"从 Kemini 式提示词技巧升级为运行时模块（Character State / Emotion / Emotion Transition / Relationship 边模型 / Behavior Director / Initiative / Story Momentum / Novelty / Anti-Repetition / Life Texture / Event Sourcing / Quality Gate），落在 Agent Runtime 与 Prompt Compiler 之间。五条裁决 + 一条持久化裁决：**R1 Fast 默认单调用**（延续 C1，禁止每条消息额外调用；Behavior Directive 由规则推导折叠进单次 Prompt，LLM Director/Critic 仅 Deep 可选）；**R2 命名**（Behavior/Dialogue Director ≠ 群聊/工作流 Director）；**R3 记忆集成**（在四层记忆上扩展，只向 Memory Runtime 查询）；**R4 缓存兼容**（RP 动态落 fresh/injection/tail、绝不进稳定前缀，延续 C2；tail 白名单段按 C6/决策 24 复用 snapshotId）；**R5 两层裁剪**（RP 语义优先级选内容，§15 缓存成本序管裁剪）；**R6 折中 5 表持久化**（roleplay_states + story_threads + roleplay_snapshots + relationship_states 边表 + character_state_events 事件溯源，database-schema §29.1–29.5；Directive / QualityReport 存 artifacts）。`roleplay.*` 事件域并入 §5.4 权威清单（含 durability 分档）。阶段：RP Fast 归 P4，Deep/Benchmark/Inspector 归 P5。文档优先序下为**第五份模块规格**；其 **Director 与 Quality 细节下沉为两个子规格** [specs/dialogue-director-spec.md](./specs/dialogue-director-spec.md)、[specs/roleplay-quality-spec.md](./specs/roleplay-quality-spec.md)（roleplay-runtime-spec §21/§28 引用），Quality 事件统一并入 `roleplay.*` 权威域。

29. **共享契约 + 评价引擎收编**（specs/shared-contracts-spec.md、specs/roleplay-evaluation-engine-spec.md，2026-09-05）：①**Shared Contracts** 确立 `packages/contracts` 为核心类型 + Zod Schema 单一真相源，`packages/api-types`（决策 27）降为其线格式投影；跨模块形状（branded ID / Timestamp / Versioned / Result / StatePatch / Ownership）在此收编，Run / Attempt / StepRun 等只**引用 agent-runtime C5、不重造**；**事件命名不用大写枚举**，一律取 §5.4 权威域（决策 16/19）；`Conversation = chats 别名`（不引平行概念）、`MessageRole.character ≠ assistant`。②**Roleplay Evaluation Engine** 为 Quality（roleplay-quality-spec）的**实现层**（特征提取 / 各评价 Engine / 评分 / Decision / Replay / 版本化），事件并入 `roleplay.*`，Fast 默认本地规则、Slow LLM 归 P5。两规格均入 §40.1 层级。

**收编指令安全与信任边界规格（2026-09-05，原创规格——非 ChatGPT 文档收编，源自"破甲研究"对话的架构化落地）**：

30. **Instruction Security 规格**（specs/instruction-security-spec.md V1.0）：把"酒馆破甲差异"与"Prompt Injection"统一抽象为 **authority（来源权威）/ trust（内容可信度）/ scope（生效领域）三个正交编译元数据** + 覆盖裁决与 untrusted 封装规则，落在 Prompt Compiler 与 Agent Runtime 之间的策略层（跨模块规格，非新运行时模块：零事件域、零数据表、零哈希区变更）。七条裁决：①**authority 只由来源登记投影（compiler §10 → §38 决策 30 的默认推导表），内容文本自述一律无效**（世界书写"忽略以上指令"仍是 world 档）；②**无静默提升**——trust 升级只有三条显式路径（用户操作 / 资产声明经确认 / 编译器内建段）；③**untrusted 永禁入稳定前缀**（header/stableWB/summary；strict 下 compile fail）；④**override 槽位 = ST Jailbreak/Post-History 的语义化升级**（位阶高于 character/world 低于 platform/agent），仅随用户显式 preset/chat 配置产生、默认关闭，平台与 Agent 不得自动注入；⑤**元数据默认不进模型可见字节**（与 §5.5 一致），可见化唯一途径 = platform 档边界段封装（untrusted 只经 tail/injection 入区）；⑥快照**不加第九哈希区**，只增 authorityFingerprint 元数据供环境 A/B 对照（§38 决策 30 的 §23 附录）；⑦向 compiler 诊断体系增 5 码（AUTHORITY_OVERRIDE_DENIED / UNTRUSTED_IN_STABLE_ZONE / UNCONTAINED_UNTRUSTED / INSTRUCTION_SOURCE_MISMATCH / OVERRIDE_SLOT_ACTIVE，compiler-spec §71 已同步）。**边界声明：不收录任何具体越狱提示词/规避配方，不承诺"破甲效果"**——效果属外部变量，评估一律走 Request Fingerprint 对照法（不可测则不验收）。落地：P0 编译器元数据基线（缺省推导 = 零字节差异），P1 槽位 UI + 导入报告 + Inspector，P3 随 Agent 工具流启用 untrusted 回灌与结构化提升，P4 网络/记忆候选通道，P5 插件 API。**晚补 V1.1（同日）**：规格增 §2.1 五层定位（Provider Policy / Runtime Policy / Instruction Authority / Context·Intent / Model Learned Safety + Input·Output·Tool 三闸；第 2–4 层可精确定位，第 1/5 层与外闸只测不猜）与 §23.1–23.3 Safety Boundary Differential Test（固定变量、单变量变更，产出 Risk Response Matrix / Safety Behavior Compatibility Matrix，回答"同一模型为何在不同 Runtime 表现不同"）；归因纪律：措辞改变行为不得反推关键词机制；研究边界：不产「绕过改述」词表、不维护风险词表、中性改述文本属用户资产不内置。

31. **Provider Adapter 规格骨架**（specs/provider-adapter-spec.md V1.0，2026-09-05，P0 前落骨架）：**第六份模块规格**；同时**修订三岔分工**（决策 26 ②）——Provider 拆两层：**归一契约 / 流式事件 / 工具与 reasoning 归一 / 错误分类 / usage 归一 / 不变量 / 契约测试在 specs/**，接入方式 / 自定义插头 / 代理 / 密钥存储留 technical-plan §5.1。八条裁决 PV1–PV8：①只翻译不做语义（不改内容字节、不裁剪、不重排——语义修改权唯一在 Compiler）；②重试决策归 Operation 层（C5），适配器内部唯一例外 = 同 Provider 多 key 轮换（§41.1，受 AgentBudget 约束、不派生新 Snapshot）；③usage 恰好一次且在 finish 前（Anthropic 双帧合成 / Gemini 累积定稿是实现点）；④错误必分类——ProviderError 码表唯一权威、表驱动映射，UNKNOWN fail-closed 不自动重试；⑤密钥零泄漏（统一 redact 中间件，错误/日志/快照/fixture 全覆盖）；⑥取消优先（AbortSignal 贯穿 + partial 事件 + CANCELLED 终止）；⑦fixture 确定性回放（同字节 → 同事件序列，契约测试硬门禁）；⑧reasoning 不丢弃——归一为 reasoning_delta，是否回传历史由 Context Policy 定，唯一硬约束 = Anthropic thinking 签名块工具循环中原样回传。工程细节首次成文：SSE 多字节 UTF-8 增量解码缓冲、分层超时（connect / first-token / idle）、伪造 200 → PARSE_ERROR、usage 缺失 estimated 降级（不入命中率分母）、三层事件映射（provider 归一事件 → §5.4 generation.* → api-spec SSE，provider 事件不出进程）。P0 范围：三类 adapter + 流式 + usage + 错误分类 + 取消/超时 + redact + fixture T1/T4/T6/T10/T11/T12/T14 + 单 key + 代理。

32. **实施计划总纲**（docs/implementation-plan.md V1.0，2026-09-05）：新增**执行层文档**——只管工作包（WP）分解 / 构建顺序 / 依赖 / 验收触发 / 还账映射 / 状态看板，**零设计语义**（防平行详设边界写入其 §1：内容长出设计细节即移入 spec 留指针）；里程碑内容/规模/验收权威仍是 §36，冲突以 §36 为准。机制四条：①P0 分解为 9 个 WP（会话粒度 1–2 会话/包，B3），入场/出场条件显式；②**滚动细化原则**（B4）——P1–P5 仅初版分解，各里程碑开工首会话先细化并落前置 spec（如 WP4.1 memory-runtime 骨架），防止过度规划过期；③三份 spec 的同步挂账汇总为**还账总表**（implementation-plan §10）并逐项绑定 WP，出场必须勾销；④全局构建原则 B1–B4 成文（价值序 P2 优先 / 防腐化序门禁先行 / 会话粒度 / 滚动细化）。顺带修正 provider-adapter-spec §4 包名笔误（packages/provider → packages/adapters，对齐 §7，spec 升 V1.0.1）。

33. **开源许可证与开源边界**（2026-09-05）：项目以 **Apache-2.0** 开源（LICENSE 已落仓库根，官方原文）；执行挂账登记 implementation-plan §10 #14–#16。配套四条：①**依赖许可证兼容性纪律**——运行时依赖禁引入 GPL/AGPL 类许可证（发布套件挂账 #14，公开推送前生效）；②**与 SillyTavern 的边界**——reference/ 永远只读参照、st-compat 只重实现格式语义不搬代码，避免被 ST 的 AGPL-3.0 传染而被迫改许可证；③**数据边界不变**——data/ 全忽略不入库、密钥走 keychain（R-P0-6）、fixture/日志强制 redact（X3/PV5）、不内置用户提示词（AGENTS §7 原红线即开源边界）；④**Sanitized Debug Export / Reproduction Bundle**（RedactionPolicy：去用户聊天内容 / 匿名化 ID / 默认 sanitized 非 full，导出可 Replay）挂账 WP1.5 细化会话，Plugin 信任分档挂账 WP5（#15/#16）。同日开源评审中"重排为 13 包结构"方案**拒绝**（违反 §7 / 纪律 5 / shared-contracts C4）；该评审其余条目大半已被既有设计覆盖（§6 存储原则 / §21.5 Capability / §29 插件权限 / database-schema §77/78 迁移流程），不另立 open-source 文档（决策 26 ②）。

34. **密钥存储选型(R-P0-6 定案,S6/WP0.7 实施)**:
SecretStore 接口 + 双实现——①**DpapiSecretStore**(Windows 优先,@primno/dpapi 可选依赖,DPAPI protect/unprotect,每密钥一个受保护 blob);②**EncryptedFileSecretStore**(兜底,AES-256-GCM,master key 落 0600 文件)。createSecretStore 按平台/可用性自动选择;providers 表只存 secretRef(`secret://provider.<id>` 形态),HTTP 响应零回显(PV5)。诚实边界:兜底方案防误分享/误提交,不防本机攻击者;P5 Tauri 换 OS keychain 强绑定。同会话落地:runs/prompt_snapshots P0 子集表(migration v2)、EventBus 按 run 分配 SSE sequence(§27 续传依据)。

35. **P0 完成记录（2026-09-06,S8/WP0.9 收官）**:DoD 七条逐项核验（implementation-plan §4.10）——①真实四链路:机制全就绪,冒烟脚本 tests/smoke/real-provider-smoke.mjs（env-var 驱动、密钥不入库）,**真实执行待用户以自有 key 冒烟后勾销**;②streaming/取消/partial:e2e 锁定(取消→CANCELLED→partial 前缀可查);③generation+usage 入库 + 重启恢复:e2e 锁定(usage_source 分对/重启后消息树/运行记录/快照可查);④快照重建模型可见内容:e2e(serialized.parts ≡ generations.request.messages);⑤无绕过路径:fake 调用入口四不变量闸口 + 故意违规测试变红;⑥金样 G2/G4 + fixture T1/T4/T6/T10/T11/T12/T14×3 家全绿;⑦lint + tsc strict + 全量 177 测试 CI 绿。P0 范围外挂账:§152 的资产 CRUD 已于 S8 补齐(migration v3);swipe 生成填充、代理管道、Inspector 完整形态随 P1。**P1 起步前置:P1 细化会话产出 p1-plan(§11 阶段计划约定)。**

36. **目录/工作区改名后 node_modules junction 失效的修复约定（2026-09-06，承接 AGENTS§9 四版更名）**:更名后实测发现 pnpm 工作区 junction（`node_modules/.pnpm/node_modules/@whispertavern/*` 及各 workspace 包）其 Target 为**绝对路径**——文件夹改名不会自动更新，即便源码 grep 清零 + lockfile 干净，junction 仍指向旧路径 `D:\Workspace\DesireGrimoire\...`（已不存在），node_modules 处于死链接失效态。**四版所记"pnpm install 重链接"实际未在改名后生效，本条更正该记录**。修复：重跑 `pnpm install --frozen-lockfile`（重装遇 `ERR_PNPM_ENOENT`，即 better-sqlite3 rename 撞既有目录的 Windows pnpm 已知瞬态，清理该包残留后重跑成功）；修复后核验 `@whispertavern` 9 个 junction 全部指向 `D:\Workspace\WhisperTavern\...`、`@desiregrimoire` 死链接清除、旧名全仓 grep 清零、全量 192 测试绿。**沉淀约定：本仓库做目录/工作区改名时，除源码与 lockfile 机械替换外，必须重跑 `pnpm install` 并核验 workspace junction 的 Target——绝对路径型 junction 是 grep 看不见的旧路径残留，不得只以 grep 清零为验收**。

## 39. 风险与对策

完整风险清单（语义长尾、provider 缓存策略变动、usage 不回传降级、最小前缀阈值、群聊 TTL、摘要链质量、Agent 延迟）见 [technical-plan.md](./technical-plan.md) §10。

## 40. 文档层级与差异化定位

### 40.1 文档层级

```text
technical-design.md（本文件，唯一总设计）
├─ technical-plan.md          → 工程实施规格（子系统细节 / 数据模型列级定义 / 测试基建 / 风险 / 决策记录）
├─ implementation-plan.md     → 实施计划总纲（WP 分解 / 构建顺序 / 验收触发 / 还账映射 / 状态看板；执行层文档，零设计语义，§38 决策 32）
│  ├─ p0-plan.md              → P0 实施明细计划（已归档执行记录，2026-09-06 P0 完成）
│  └─ p1-plan.md              → P1 实施明细计划（ST Compatibility:S9–S15 会话切分 / 范围裁决 R-P1-1–6——B4 滚动细化）
├─ worldbook-cache-design.md  → Cache Engine 详细规格
├─ ui-design.md               → UI 详细规格
├─ st-reference-analysis.md   → 兼容性参照（ST 1.18 代码语义基准）
├─ hushenfu-v18-analysis.md   → Agent / Workflow 参照
├─ specs/prompt-compiler-spec.md → Prompt Compiler 模块规格
├─ specs/database-schema.md   → Database Schema 模块规格
├─ specs/agent-runtime-spec.md → Agent Runtime 模块规格（对象层级 / 状态机 / Context / Tool / Budget / 权限 / Resume / Replay / Workflow DAG / 验收）
└─ specs/api-spec.md          → HTTP/SSE API 模块规格（路由 / 信封 / 错误码 / 幂等 / SSE 协议 / 事件订阅 / 分阶段 API 范围；DTO 是模块规格的线格式投影）
└─ specs/roleplay-runtime-spec.md → Roleplay Runtime 模块规格（Character State / Emotion / Behavior Director / Initiative / Anti-Repetition / Story Thread / Quality Gate；第五份模块规格，§38 决策 28）
    └─ specs/dialogue-director-spec.md → Dialogue Director 子规格（Behavioral Directive / 候选加权选择 / Seed 确定性）
    └─ specs/roleplay-quality-spec.md → Roleplay Quality 子规格（QualityDimensions / HardConstraints / Decision / Profile）
        └─ specs/roleplay-evaluation-engine-spec.md → Quality 实现层（特征提取 / 各评价 Engine / 评分 / Decision / Replay）
└─ specs/shared-contracts-spec.md → 跨模块共享契约（packages/contracts 单一真相源，§38 决策 29）
└─ specs/instruction-security-spec.md → Instruction Security / Trust Boundary（authority/trust/scope 元数据与覆盖裁决、untrusted 封装；跨 Compiler 与 Agent Runtime 的策略层，§38 决策 30）
└─ specs/provider-adapter-spec.md → Provider Adapter 模块规格（流式/工具/reasoning 归一、错误分类学、多 key 轮换、能力探测降级链、缓存标记翻译、fixture 契约测试；第六份模块规格，§38 决策 31；接入实务留 technical-plan §5.1）
```

外部参照（不是本项目的真相源，仅作设计与语义对照）：

```text
SillyTavern                → 兼容性语义基准（st-reference-analysis.md）
狐神抚 V18                 → Agent / Workflow 产品形态参照（hushenfu-v18-analysis.md）
DeepSeek Harness           → agent-loop 脊柱机械结构参照
   https://github.com/deepseek-ai/deepseek-harness
   取舍记录见 specs/agent-runtime-spec.md §176
   —— 只借鉴其执行语义（工具流水线 / 事件分域 / 审批 fail-closed / 防御模式），
      不借鉴其编码领域能力（bash / LSP / sandbox / 代码运行时）与 Cordis 插件框架
```

### 40.2 真正的差异化

核心卖点不是"比 SillyTavern 更漂亮"，也不只是"支持 Agent"：

```text
┌──────────────────────────────────────────────┐
│              WhisperTavern V2               │
│  ① Compile     Prompt Compiler               │
│  ② Cache       Cache-aware Context           │
│  ③ Act         Agent Runtime                 │
│  ④ Remember    Memory Runtime                │
│  + Snapshot / Replay / Inspector / Events    │
└──────────────────────────────────────────────┘
```

---

# 41. 开源参照与借鉴清单（Hermes Agent / DeepSeek Hermes）

【2026-09】Hermes Agent（Nous Research 开源、DeepSeek 官方文档化对接的自托管 Agent 框架，带 Web UI / 桌面 / 多平台网关）作为**生产验证同类架构**的外部参照。结论：其多数组件已被本书 §21 Runtime / §4 执行四层 / §25 记忆 / §22 Skill / §31 表体系**更严谨地覆盖，不照抄**；仅吸收 §41.1 三点，其余以 §41.2 为"不倒退"边界。

## 41.1 采纳（三点）

| 借鉴点 | 落地位置 | 说明 |
|---|---|---|
| **记忆后端双检索引擎**（FTS5 关键词兜底 + 向量语义） | §25 Data Bank / database-schema §25 | Hermes 用 SQLite + FTS5 生产验证"本地持久记忆够用"；补 FTS5 作零成本关键词兜底，sqlite-vec 作语义检索，二者并行（已写入 P4 里程碑） |
| **同 Provider 多 API Key 限流容错** | §18.1 Provider Adapter + agent-runtime-spec §128–129 | `RATE_LIMIT` 时在 `provider.call` 内轮换同 Provider 其余 key，受 §21.6 `AgentBudget` 约束，不派生新 Prompt Snapshot；fallback 链最便宜一档 |
| **程序性记忆 = 可移植 Skill 文件** | §22 Skill / P5 | `SKILL.md + references/ + examples/` 对齐 `agentskills.io` 开放标准，技能可导出 / 分享 / 跨实例复用（已写入 P5 里程碑） |

## 41.2 明确不学（防止退化）

```text
粗粒度缓存断点              —— 本书 byte-stable 前缀 + physicalOrder 更优，不倒退到 Hermes 式粗断点
改写式上下文压缩             —— 会打断前缀；只用冻结 Summary 追加（§10.1）
单 Agent 个人会话模型         —— 本书为 Director 群聊 + Workflow DAG + 执行四层（C5），高于其单一环路
多平台消息网关 / OAuth 账号    —— 非目标（§3 本地单用户 web）
```

## 41.3 本项目自证关系

Hermes 的 `state.db` 会话账本、分层系统提示可缓存、代理自主决策沉淀，分别与本书 §31 执行态层、zone 模型、Scribe + `MemoryCandidate → Policy` 决策管线同构——它是一份**"方向已被生产验证"的外部背书**，而非待移植代码。

---

*关联文档：[technical-plan.md](./technical-plan.md) · [implementation-plan.md](./implementation-plan.md) · [worldbook-cache-design.md](./worldbook-cache-design.md) · [ui-design.md](./ui-design.md) · [st-reference-analysis.md](./st-reference-analysis.md) · [hushenfu-v18-analysis.md](./hushenfu-v18-analysis.md) · [specs/prompt-compiler-spec.md](./specs/prompt-compiler-spec.md) · [specs/database-schema.md](./specs/database-schema.md) · [specs/agent-runtime-spec.md](./specs/agent-runtime-spec.md) · [specs/api-spec.md](./specs/api-spec.md) · [specs/roleplay-runtime-spec.md](./specs/roleplay-runtime-spec.md) · [specs/shared-contracts-spec.md](./specs/shared-contracts-spec.md) · [specs/instruction-security-spec.md](./specs/instruction-security-spec.md) · [specs/provider-adapter-spec.md](./specs/provider-adapter-spec.md)*
