# WhisperTavern V2 — Shared Contracts Specification

> 版本：V2.0（2026-09-05：**P0 收编落地**——§2 包结构按 WP0.2 实际平铺模块修订，新增 §2.1 P0 模块清单 / §2.2 Schema 同源机制 / §2.3 开放形状 / §2.4 C1–C4 自查；§9 补落地证据。V1.0 骨架，2026-09-05）
> 状态：**Active（P0 范围真相源）**——packages/contracts 已按本规格落地并过门禁；P1+ 随 WP 渐次充实
> 文档层级：**跨模块共享契约**（非新运行时模块；用于收编固化各模块的核心类型为单一真相源）
> 依赖：`agent-runtime-spec.md`、`database-schema.md`、`api-spec.md`（DTO 投影）、`roleplay-runtime-spec.md` 及子规格。
> 收编对点（4 处对齐，已并入技术总设计 §38 决策 29）：
> - **C1 事件命名**：本规格**不再定义 `RUN_CREATED`/`RUN_STARTED` 等大写枚举**；Runtime 事件一律取技术总设计 §5.4 权威域（`agent.run.*`、`roleplay.*` 点分小写），本规格只提供 `RuntimeEvent` 形状 + 引用 §5.4。
> - **C2 包结构**：`packages/contracts` 为**核心类型 + Zod/Schema 的单一真相源**（超集）；既有的 `packages/api-types`（决策 27）改作其**线格式投影/反导出**，不再各自维护第二套形状。
> - **C3 命名映射**：本规格的 `Session/Conversation/Turn` 分别对应项目 `users/chats/Turn`（AgentTurn 的子集），语义先做**映射表**，不引入平行概念；`MessageRole.character ≠ assistant` 与 database-schema `author_type` 对齐。
> - **C4 去重**：本规格**不重造** Run/Attempt/StepRun/Emotion/Relationship 等已有点，只"收编/引用" agent-runtime 与 database-schema 的权威定义；本规格专注**跨模块形状（ID/Timestamp/Versioned/Result/Correlation/StatePatch/Ownership）**。

---

# 1. 文档目的

WhisperTavern 含多个 Runtime（Agent / Roleplay / Dialogue Director / Prompt Compiler / Evaluation / Memory / Database / Inspector），它们必须共享统一数据模型。本规格定义 **Shared Contracts** 作为唯一真相源：

```text
One Concept → One Canonical Contract → Many Consumers
```

禁止各模块：自行定义同义核心类型、复制 Runtime State、重定义 Run/Attempt、用匿名 object 传核心数据。全部改为 `Import Shared Contract`。

依赖方向：`contracts → runtime/application → infrastructure`；**禁止 contracts → database / provider / runtime 反向**。各模块允许 `→ contracts`；模块间经 `→ contracts` 通信（如 Evaluation Engine → contracts，而非 → Roleplay Runtime）。

---

# 2. 包结构与基础形状

**P0 落地（WP0.2 起渐次）**：`packages/contracts/src/` 按域**平铺**为九个模块（§2.1 清单；WP0.4 增 `compiler.ts`）。下方长期目录树是 P3+ 全域形态——后续阶段将对应模块**归位入目录**（归位 = 移文件 + 改 index 出口，不动类型语义）：

```text
packages/contracts/src/{ core/ runtime/ conversation/ character/ world/ memory/
                          directive/ prompt/ evaluation/ trace/ snapshot/ index.ts }
```

基础类型：`Brand<T,B>` 所有业务 ID 为 branded；`Timestamp = string`（ISO-8601 UTC，禁 `Date` 跨边界）；`Versioned{ version }`；`EntityBase<TId>{ id, createdAt, updatedAt }`；`ImmutableRecord<TId>{ id, createdAt }`（Message/Run/Attempt/StepRun/Evaluation/Snapshot 创建后不可改）；`Correlated{ traceId, runId?, attemptId?, stepRunId? }` 贯穿所有 Runtime Operation。

ID：`UserId/SessionId/ConversationId/MessageId/TurnId/CharacterId/WorldId/MemoryId/ThreadId/RunId/AttemptId/StepRunId/PromptId/CandidateId/EvaluationId/SnapshotId/TraceId/DirectiveId`（均为 opaque 全局唯一、非语义，`user_123/char_001` 只作 slug/displayName）。

**Normalized Scale**：默认 `Score 0.0–1.0`，禁止模块各自 0–100 / −10–10（除非显式声明）。**Serialization Boundary**：契约必须 JSON-serializable（禁 Date/Map/Set/Function/ClassInstance/BigInt 跨模块）。**Unknown Boundary**：禁 `any`，允许 `unknown` 由具体模块 validation+narrowing。

**Result/校验/生成**：Application Boundary 用 `Result<T,E>{ ok:true,value } | { ok:false,error }`，**禁 `throw` 作普通控制流**；`ApplicationError{ code, message, retryable, details? }`。外部输入（API/DB JSON/LLM Output/Plugin/Provider）一律过运行时 Schema 校验（Zod/Valibot/ArkType），**Schema → z.infer 得类型**（不是手写类型再手写 schema），保持同步。

## 2.1 P0 模块清单（落地事实，WP0.2）

| 模块 | 内容 | 规格出处（收编点） |
|---|---|---|
| `core.ts` | Brand（zod `$brand` 投影）/ Timestamp / Versioned / EntityBase / ImmutableRecord / Correlated / Result / ApplicationError / NormalizedScore；P0 业务 ID 九枚（User/Chat/Message/ChatBranch/Snapshot/Run/Character/Persona/Preset） | 本节基础形状；database-schema §3（UUIDv7）/ §4 |
| `placement.ts` | SemanticPlacement（5 变体，worldbook position 保留 ST 拼写 anTop/emTop…）/ CachePlacement（7 区）/ StabilityClass（5 级）/ PromptZoneName | compiler-spec §12–§18 |
| `instruction.ts` | InstructionAuthority（12 档）+ AUTHORITY_ORDER 全序 / Trust（3）/ Scope（5）/ InstructionMetadata | instruction-security-spec §6–§9 |
| `ir.ts` | PromptRole / SegmentSource（13 变体）/ PromptSegment（含 §17 stabilityOverride 与 instruction 扩展位）/ PromptZone / PromptIR | compiler-spec §7–§11；instruction-security §9 |
| `diagnostics.ts` | Diagnostic / P0 码表 7 码（开放联合，新码须先进 compiler-spec §71 注册表） | compiler-spec §70–§71；p0-plan R-P0-1/R-P0-3 |
| `snapshot.ts` | CacheCheckpoint / CacheBreakReason（14 变体）/ CachePlan / SerializedPart / SerializedPrompt（含 §52 `tokenCountMode`）/ PromptHashes（八区）/ PromptSnapshot（含 instruction-security §19.1 `authorityFingerprint`） | compiler-spec §54–§59、§62–§68 |
| `provider.ts` | ProviderErrorCode（14）/ ProviderError / ProviderMessage / ProviderUsage / ProviderStreamEvent（7 类）/ ProviderChatRequest / **ProviderCapabilities（§18.2 全形定稿 + instructionLayers 登记点，WP0.5）** / ProviderAdapter | provider-adapter-spec §6/§7/§8.1/§12/§15/§17.1 |
| `chat.ts` | MessageRole（6 值）/ Chat / Message / ChatBranch（含血缘位） | database-schema §17/§19/§21/§22；本规格 §3（C3 映射） |
| `compiler.ts` | PromptContribution（§88 + instruction 扩展位）/ CompileMode（§72 全集注册）/ CompileTrace（§101） | compiler-spec §88/§72/§101；instruction-security §9 |

## 2.2 Schema 同源机制（WP0.2 定案）

1. **Zod-first**：schema 是事实源，类型一律 `z.infer` 导出——手写类型仅限下述例外。
2. **品牌 ID**：`z.string().brand<'XxxId'>()` 产出；`Brand<T,B>` 类型助手 = `z.$brand` 的类型投影，全项目只有这一套品牌机制。
3. **手写类型的两个合法例外**：①`ProviderChatRequest.signal?`（AbortSignal，IO 注入字段，不可序列化——Serialization Boundary 的边界外注入）；②纯类型工具（`Brand/Result/EntityBase/Correlated` 等）本身无 schema 需求。
4. **运行时校验边界**：schema 校验发生在"外部输入进入处"（fixture 回放、DB 行读取、HTTP/SSE 入口）；内部构造点（如 Compiler 产段）由构造器保证,不强制重复 parse。

## 2.3 开放形状（catchall/custom 承载，形状随对应 WP 定稿）

| 形状 | 现状 | 定稿点 |
|---|---|---|
| `SerializedPart` | role/content 已知键 + catchall 未知键 | compiler-spec §63 实现（WP0.4） |
| `CachePlan.providerStrategy` | `unknown?`（P0 CachePlan 恒空,R-P0-4） | WP2.4 缓存标记翻译 |
| `PromptMetadata` | 开放记录；**确定性红线：禁 wall-clock/随机值进 IR**（参与哈希） | §102 编译结果示例落定（WP0.4+） |
| `InstructionMetadata.registeredBy` | `z.custom<SegmentSource>` passthrough（Compiler 内部构造,非外部输入） | 类型单一来源保持,不单独 schema 化 |

## 2.4 C1–C4 自查（WP0.2）

- **C1 事件命名**：contracts 不定义任何 §5.4 事件名。`CacheBreakReason` 的 SCREAMING type 值是 compiler-spec §58 的**诊断标签**（非事件名），按原文保留。
- **C2 包结构**：api-types 已建壳并声明 `workspace:*` 反向依赖（投影约定写入其入口 TSDoc：type-only、禁止手写第二套形状）；contracts 自身零 IO、零工作区依赖（ESLint `no-restricted-imports` 锁定 node:* 与 @whispertavern/*）。
- **C3 命名映射**：chat.ts 不引入 Session/Turn（P0 无此面）；`Conversation = chats` 别名以注释承记；`MessageRole.character ≠ assistant` 落 schema 并有测试锁定；messages 不设 is_active（活跃指针唯一来源 = chats.active_branch_id → chat_branches.leaf_message_id）。
- **C4 去重**：Run/Attempt/StepRun 等执行形状未在 contracts 重造（P0 无消费面，引用规则见 §4）；authority/trust/scope 全项目仅 instruction.ts 一处。

---

# 3. 会话 / 对话 / 消息（C3 命名映射）

- **Session**（= 项目 `users` 单一锚点的长期空间）：`{ userId, status: active|paused|archived|deleted, activeConversationId, activeWorldId }`。
- **Conversation** = **项目 `chats` 的别名**（不在 DB/UI 引入第二套行话；文档与 API 层可别名）：`{ sessionId, title?, status: active|completed|archived, lastTurnId? }`。群聊 = chat + `chat_members`（database-schema §17/§20）。
- **Turn**（逻辑交互周期，= agent-runtime 的 AgentTurn 规范化）：`{ conversationId, index, triggerMessageId, outputMessageIds[], runId?, status, completedAt? }`。
- **Message**（不可变事实）：`{ conversationId, turnId?, role, content:{type:'text',text}, metadata? }`；`MessageRole = user|character|assistant|system|tool|narrator`，**character ≠ assistant**（与 `messages.author_type` 对齐）；future content 可扩展 image/audio/structured/tool_result。

---

# 4. 执行形状（C4 去重，引用 agent-runtime C5）

本规格只保持**跨模块引用形状**，不重造语义：

- **Run**：`{ traceId, sessionId, conversationId, turnId, type: conversation_turn|retry|evaluation|repair|background, status, startedAt, completedAt?, inputSnapshotId?, outputSnapshotId? }`——语义、状态机、四层执行（Run/Attempt/StepRun/Operation）见 **agent-runtime-spec C5（§4.1–4.6）**与 §5.4；本处仅为 DTO 引用。
- **Attempt**：`{ runId, index, type: initial|retry|repair|fallback, status, startedAt, completedAt?, candidateId?, evaluationId? }`（Retry 语义 = 新 Attempt，C3）。
- **StepRun**：`{ runId, attemptId?, traceId, step: RuntimeStep, status, startedAt, completedAt?, input?, output?, error? }`；`RuntimeStep = load_context|load_memory|dialogue_director|prompt_compile|model_generate|candidate_parse|evaluation|decision|repair|retry|state_commit`；`StepError{ code, message, retryable, cause? }`。

---

# 5. 角色 / 关系 / 世界（引用 roleplay/database，C4）

- **Character**（静态）= 角色卡资产（database-schema §6/§27）；`CharacterDefinition{ identity, traits, speech, behavior, emotionalProfile, knowledgePolicy?, initialState? }`；`CharacterTrait{ id, name, level: hard_fact|core|strong|soft|observed, weight }`。
- **CharacterRuntimeState** = `roleplay_states`（database-schema §29.1）的契约形状：`{ characterId, conversationId, revision, emotion, energy?, attention, behavior, currentGoals[], activeThreads[], recentBehaviorIds[], updatedByTurnId? }`；**`Character.id ≠ CharacterRuntimeState.id`**（后者是独立 RTS id）。
  - `EmotionState{ primary, secondary?, valence, arousal, intensity, inertia, confidence }`（`EmotionType` 用 `Builtin | (string & {})` 开放扩展）。
  - `AttentionState{ focus: user|environment|self|other, focusTargetId?, strength }`；`BehaviorState{ posture?, location?, activity?, mode: passive|responsive|active }`；`CharacterGoal{ id, type: immediate|short_term|long_term, description, priority, status: active|paused|completed|abandoned }`。
- **RelationshipState** = `relationship_states`（§29.4）契约：`{ conversationId, sourceCharacterId, targetId, targetType: user|character, trust, affection, familiarity, tension, intimacy, dependency, hostility, revision }`；**有向 A→B，禁 A↔B 作唯一存储**，User→Character 与 Character→User 分别（evaluation-engine §5）。
- **WorldState**：`{ worldId, conversationId, revision, time?, location?, facts[], activeEvents[] }`；`WorldFact{ id, key, value, source: FactSource, confidence? }`。

---

# 6. 方向 / 提示 / 候选 / 评价契约

- **DialogueDirective**（= dialogue-director-spec §5 契约）：`{ id, runId, attemptId?, initiative, emotionalTarget?, behaviorConstraints[], narrativeDirective?, noveltyTarget?, pacing?, retryHints?, createdAt }`；`InitiativeLevel = none|low|medium|high`。
- **CompiledPrompt / PromptMessage / PromptSection**：`{ id, runId, attemptId, version, messages[], tokenEstimate?, createdAt }`；`PromptSection = system|character|state|world|memory|directive|history|user_input|retry`（与 prompt-compiler-spec IR/zone 映射）。
- **CandidateResponse**：`{ runId, attemptId, text, author: character|assistant|narrator, generation?: GenerationMetadata{ provider, model, temperature, topP, maxTokens, seed, latencyMs } }`。
- **RoleplayEvaluation**（= evaluation-engine 输出）：`{ runId, attemptId, candidateId, score: QualityScore, issues[], feedback, decision: EvaluationDecision, evidence[], analyzerVersions }`；`QualityScore`（13 维 0–1）、`QualityIssue{ code, severity: info|warning|error|critical, score?, confidence, message, evidence? }`、`EvaluationAction = accept|accept_with_warning|repair|retry|block`、`AdjustmentHint{ target, action, value?, reason }`——形状详见 roleplay-quality-spec / roleplay-evaluation-engine-spec。

---

# 7. 快照 / 追踪 / 状态 / 事件（C1 对齐）

- **RuntimeSnapshot**：`{ conversationId, turnId?, runId?, characterStates[], relationships[], worldState?, memoryContext?, versionMap }`。**原则**：Prompt Compilation / Evaluation / Retry / Replay 一律引用 Snapshot，不引用 Latest State，否则无法 Replay（与 prompt-snapshot / roleplay_snapshots / runtime_checkpoints 对应）。
- **Trace**：`{ rootRunId, sessionId, conversationId }`，层级 `Trace→Run→Attempt→(StepRun | Evaluation)`。
- **StatePatch**：`StatePatch<T>{ targetId, baseRevision, operations[], metadata? }`（Set/Increment/Append/Remove）；`revision` 参与 **Compare-And-Set**（expected revision → apply → success/conflict）。`StateCommit{ runId, snapshotId, patches[], committedAt }`。
- **RuntimeEvent**：本规格只定义形状 `RuntimeEvent<TPayload>{ id, type, traceId, runId?, attemptId?, timestamp, payload }`；`type` 取**技术总设计 §5.4 权威域**（`agent.run.* / roleplay.* / ...` 点分小写），**不在此定义大写枚举**（决策 16/19）。Command vs Event 分离：`GenerateResponseCommand{ runId, conversationId, turnId, inputMessageId, snapshotId }` / `EvaluateCandidateCommand{ runId, attemptId, candidateId, snapshotId, directiveId? }` 是命令，事件由 §5.4 命名。

---

# 8. 接口命名与所有权（纪律）

- 类型后缀只允许 `Entity/State/Context/Command/Event/Result/Policy/Config/Snapshot/Report/Decision`；禁止 `Data/Info/Object/Payload/Params` 作核心业务模型名。
- **Ownership（其余模块只 Read，勿直接 Mutate）**：

| Object | Owner |
|---|---|
| Run / Attempt / StepRun / RuntimeEvent / StateCommit | Agent Runtime |
| CharacterRuntimeState / RelationshipState | Roleplay Runtime |
| DialogueDirective | Dialogue Director |
| CompiledPrompt | Prompt Compiler |
| CandidateResponse | Model Generation |
| RoleplayEvaluation | Evaluation Engine |
| RuntimeSnapshot | Runtime |

- **Context vs State**：State 可持久化、有 revision、有生命周期；Context（如 EvaluationContext）是某次计算输入、不一定持久化、不是 DB Entity。
- 依赖图：`Contracts → Agent Runtime / Roleplay Runtime / Evaluation Engine → Prompt Compiler / Dialogue Director → Model Provider`。

---

# 9. 验收标准

- 所有跨模块核心类型来自 `packages/contracts`；无模块自造同义类型。
- 事件名全取 §5.4（大写枚举已废）；ID/Timestamp/Score 统一；`any` 禁、`unknown` 收。
- 契约 JSON-serializable；Schema→Infer 单源；Application Boundary 用 Result 不用 throw。
- State 更新走 StatePatch + CAS(revision)；Compile/Evaluate/Retry/Replay 引用 Snapshot。
- Ownership 表成立；模块间经 contracts 通信，无反向依赖。

## 9.1 P0 落地证据（WP0.2，2026-09-05 勾销还账 #1）

- **单测 30 条全绿**（contracts 8 文件）：Zod round-trip（IR/Snapshot/Provider/chat 全量）、
  branded ID 不可裸 string 互换（@ts-expect-error 编译期锁定）、枚举穷尽性
  （authority 12 档 / 错误码 14 / 流式事件 7 类 / CachePlacement 7 区 / MessageRole 6 值）。
- **依赖方向硬约束**：ESLint `no-restricted-imports` 使 contracts 引用 `node:*` 或
  任何 `@whispertavern/*` 直接 lint 红（§1 依赖方向的机械执行）。
- **收编闭环**：provider-adapter §6/§7 草案自 packages/adapters 临时占位收编入
  `provider.ts`,S1 占位文件已删除;fake adapter 改走 `@whispertavern/contracts`。

---

*关联文档：[agent-runtime-spec.md](./agent-runtime-spec.md) · [database-schema.md](./database-schema.md) · [api-spec.md](./api-spec.md) · [roleplay-runtime-spec.md](./roleplay-runtime-spec.md) · [roleplay-quality-spec.md](./roleplay-quality-spec.md) · [roleplay-evaluation-engine-spec.md](./roleplay-evaluation-engine-spec.md) · [dialogue-director-spec.md](./dialogue-director-spec.md) · [technical-design.md](../technical-design.md)*