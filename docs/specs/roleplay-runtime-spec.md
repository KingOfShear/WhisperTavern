# WhisperTavern V2 — Roleplay Runtime Specification

> 版本：V1.1（2026-09-05 升级：并入细化版后按折中 5 表持久化 + `roleplay.*` 事件域对齐收编）
> 状态：Draft（与总设计、agent-runtime-spec、prompt-compiler-spec、database-schema、api-spec 对齐，待 P4 实施验证）
> 文档层级：[technical-design.md](../technical-design.md) 之下的 **Roleplay Runtime 模块详细规格**（第五份模块规格，§38 决策 28）
> 依赖：`agent-runtime-spec.md`（执行四层 C5）、`prompt-compiler-spec.md`（PromptContribution / zone / CachePlan / C6）、`database-schema.md`（Roleplay 五表，§29.1–29.5）、`api-spec.md`、`dialogue-director-spec.md`（Director 子规格）、`roleplay-quality-spec.md`（Quality 子规格）、`technical-design.md`（§5.4 事件权威清单、§25 Memory、§26 群聊、§23.2 快速路径）
>
> **收编时六处裁决（R1–R6，已同步回总设计 §38 决策 28）**
> - **R1 默认单调用**：Fast RP 为默认档，**禁止引入额外模型调用**（延续裁决 C1）。Fast 下 Behavior Directive 由**运行时启发式规则**推导并折叠进单次 Prompt；LLM Behavior Director 与 Quality Critic 仅在 Balanced/Deep（Deep 默认不启用）出现。
> - **R2 命名**：本文"Behavior Director（Dialogue Director，行为指向）"≠ agent-runtime-spec §23/§80 的**群聊/工作流 Director**（编排选人），不得混用。
> - **R3 Memory 集成**：角色记忆不另起一套记忆系统，在既有四层记忆上扩展；只向 Memory Runtime 查询，不内置完整存储。
> - **R4 缓存兼容**：RP 动态内容一律落 `freshWB/injection/tail`，**永不进稳定前缀**（延续 C2）；`tail` 白名单段逐字未变按 C6/决策 24 复用 snapshotId。
> - **R5 两层裁剪**：RP 语义优先级选内容，总设计 §15 缓存成本序管物理裁剪。
> - **R6 持久化粒度（本升版补充）**：数据库采用**折中 5 表**——`roleplay_states`（存活状态）、`story_threads`（剧情线）、`roleplay_snapshots`（每次 Run 快照 + decision trace + state_hash）、`relationship_states`（关系边表，群聊关系图）、`character_state_events`（状态变更事件溯源）；Directive / Quality Report 存 `artifacts`（type='roleplay_directive' / type='roleplay_quality'）并绑定 attempt/step_run。

---

# 1. 文档目的

Roleplay Runtime 是 WhisperTavern V2 中负责"角色作为一个持续存在的人物进行行动"的核心运行时。

**它不负责**：最终 Prompt 拼接、模型调用、Token Budget 分配、Provider 调用、世界书激活本身、最终回复生成。

**它负责**：角色状态、情绪连续性、关系状态、当前意图、潜台词、行为倾向、主动性、剧情推进压力、对话节奏、新颖性、表达重复控制、角色知识边界、用户 Agency、生成前 Directive、生成后 Quality Analysis。

核心原则：

> **Roleplay Runtime 决定"角色此刻是什么状态、倾向于怎么行动"；模型决定"具体怎么写出来"。**

---

# 2. 核心问题

普通 LLM：`User Message → Semantic Understanding → Answer`。

Roleplay：

```text
User Event → Perception → State Transition → Intent → Behavior Selection
→ Expression Strategy → Generation → State Commit
```

因此 Roleplay Runtime 的核心不是 `Prompt Enhancement`，而是 `Character Simulation`。

---

# 3. 与 Agent Runtime / Prompt Compiler 的关系

- **Agent Runtime** = How to Execute（决定"何时执行、执行什么步骤"）。
- **Roleplay Runtime** = How the Character Behaves（决定"角色在这个工作中如何行动"）。
- **Prompt Compiler** = What the Model Sees（唯一最终编译入口）。

Roleplay Runtime 参与 Agent Run 的步骤：`roleplay_state / dialogue_director / quality_gate / commit`；它**不允许反向调用 Prompt Compiler 重新编译自身状态**。依赖关系：

```text
Agent Runtime → Roleplay Runtime ─↕─ Memory Runtime / Worldbook Runtime / Character Asset
                              ↓
                        Dialogue Director → Prompt Compiler → Provider
```

---

# 4. 设计原则

- **4.1 Runtime First**：能由程序明确维护的状态，不依赖模型每轮自行推断。
- **4.2 Direction Over Script**：Runtime 给方向/倾向/约束，不给"下一句话/下一个动作/完整剧情"。
- **4.3 State Over Prompt**：角色连续性来自 State，不来自越来越长的 Prompt。
- **4.4 Soft Constraint Over Hard Constraint**：优先倾向/概率/权重/冷却/预算/优先级，而非"必须/绝对/禁止某词/固定 N 次"。
- **4.5 Preserve Model Creativity**：Runtime 不把模型降级成模板执行器。

---

# 5. 生命周期与执行四层（C5）

一次普通 Roleplay Turn（落在既有 Run/Attempt/StepRun 上）：

```text
User Message
  ↓ Create Run → Create Attempt
  ↓ resolve_roleplay_context
  ↓ apply_dialogue_event   （含 Emotion Transition + Attention）
  ↓ retrieve_roleplay_memory
  ↓ create_dialogue_directive
  ↓ compile_prompt
  ↓ model_call（禁止重新 Compile）
  ↓ roleplay_quality_check → accept / regenerate
  ↓ commit_roleplay_state
  ↓ Return Response
```

Retry 语义按 C5：完整 Retry = 新 Attempt；Step Retry = 新 StepRun；同 Attempt 内模型调用网络重试 = 同 StepRun + 新 Operation。见 §5 生命周期与 agent-runtime-spec C5（§4.1–4.6）。

---

# 6. Dialogue Event 与 Semantic Signal

用户输入首先归一为统一事件：

```ts
interface DialogueEvent {
  id: string; chatId: string; messageId?: string
  actorId: string; actorType: 'user' | 'character' | 'system' | 'external'
  content: string; timestamp: string
  semanticSignals?: SemanticSignal[]
  explicitActions?: Action[]
  referencedEntities?: EntityRef[]
}
```

```ts
interface SemanticSignal {
  type: 'question'|'praise'|'insult'|'request'|'threat'|'confession'|'rejection'
         |'gift'|'touch'|'departure'|'arrival'|'revelation'|'topic_change'
  confidence: number; target?: string; evidence?: string
}
```

Signal 可由轻量模型/规则/主模型产生；**Signal 是辅助，不是事实**。

---

# 7. Character Runtime State

```ts
interface CharacterRuntimeState {
  characterId: string; agentId: string; version: number
  emotionalState: EmotionalState
  relationshipStates: RelationshipState[]        // 关系边（见 §9）
  currentGoal?: Goal; currentFocus?: Focus
  activeIntent?: CharacterIntent
  unresolvedThreads: StoryThread[]
  recentEvents: RecentEvent[]
  behavioralTendencies: CharacterTendency[]
  dialogueState: DialogueState
  initiativeState: InitiativeState
  noveltyState: NoveltyState
  attentionState: AttentionState
  knowledgeBoundary: KnowledgeBoundary
  expressionHistory: ExpressionHistory
  createdAt: string; updatedAt: string
}
```

**State ≠ Character Card**：Card 是静态人格（"骄傲、嘴硬"）；Runtime State 是当前人格状态（"此刻尴尬 0.62、对用户信任 0.71、正在隐藏开心"）。两者不混淆。

State Mutation 原则：Roleplay Runtime 有状态（Read → Calculate Transition → Commit），**Prompt Compiler 必须是纯函数，不允许 Compiler 改 State**。

---

# 8. Emotion Runtime

```ts
interface EmotionalState {
  primary: Emotion; secondary?: Emotion
  intensity: number; valence: number; arousal: number
  inertia: number; confidence: number
  sourceEvents: string[]; updatedAt: string
}
```

Transition（有惯性，不是每轮重置）：

```ts
interface EmotionalTransition {
  previous: EmotionalState; triggerEventId: string; target: EmotionalState
  delta: EmotionDelta; transitionSpeed: number; reason: string
}
```

`newEmotion = previousEmotion + eventImpact × transitionSpeed`，而不是 `newEmotion = eventEmotion`。

**Inertia**：0=极易变，1=极稳定，默认 0.5–0.8，特殊角色可由 Character Definition 覆盖。

**Emotion ≠ 文字**：`emotion='embarrassed'` 不能直接编成"她脸颊泛红"；须经 `Personality → Tendency → ExpressionPolicy` 产生"可能的表现"。

---

# 9. Relationship State（关系边模型）

关系不是单一数字，且是**边**而非角色自带属性（群聊中 A↔B、A↔User、B↔C 各一条边）：

```ts
interface RelationshipState {
  sourceCharacterId: string; targetActorId: string
  familiarity: number; trust: number; affection: number; dependence: number
  tension: number; respect: number; intimacy: number; resentment: number
  relationshipLabels: string[]
  recentChanges: RelationshipChange[]
  version: number; updatedAt: string
}
```

```ts
interface RelationshipChange {
  dimension: 'familiarity'|'trust'|'affection'|'dependence'|'tension'
            |'respect'|'intimacy'|'resentment'
  delta: number; causeEventId: string; confidence: number
}
```

变化通常渐进（trust 0.60→0.62，而非 0.60→1.00）。群聊形成**角色关系图**：每个节点 `CharacterRuntimeState`，每条边 `RelationshipState`。

---

# 10. Character Intent

```ts
interface CharacterIntent {
  explicitGoal?: string; hiddenIntent?: string; emotionalSubtext?: string
  withheldInformation?: string; desiredReaction?: string
  avoidanceTarget?: string; confidence: number
}
```

Intent 是"这一轮角色想做什么"，**不是永久人格**。潜台词作潜变量，默认不入正文。

---

# 11. Character Tendency 与加权选择

```ts
interface CharacterTendency {
  id: string; trigger: Condition
  behavior: 'deflect'|'tease'|'avoid'|'confront'|'lie'|'change_topic'
           |'seek_reassurance'|'show_off'|'withdraw'|'probe'|'joke'
           |'counter_attack'|'comply'
  strength: number; cooldownTurns?: number; lastUsedAt?: string
}
```

**不要** `if trigger: behavior=tendency`。**应该**加权选择：

```text
Score = BaseStrength × TriggerMatch × EmotionalFit × RelationshipFit × ContextFit × CooldownFactor
```

CooldownFactor：最近用过 → 概率下降。例：`deflect` 两次、1 轮前用过 → Factor≈0.35；`tease` 未用过 → 1.0。

---

# 12. 选择性注意与角色知识边界

**Attention**（不平均对待用户消息每条信息）：

```ts
interface AttentionState {
  focusTargets: AttentionTarget[]; curiosityTargets: AttentionTarget[]
  emotionalTriggers: AttentionTarget[]; ignoredSignals: AttentionTarget[]
}
interface AttentionTarget {
  target: string; salience: number; emotionalRelevance: number
  narrativeRelevance: number; curiosity: number
}
```

例如"我昨天去了公司，路上遇到老朋友，不过今天主要是来找你的"——角色只抓住"主要是来找你的"。

**Knowledge Boundary**：

```ts
interface KnowledgeBoundary {
  knownFacts: Fact[]; inferredFacts: Fact[]
  unknownTopics: string[]; forbiddenKnowledge: string[]
}
```

模型不自动拥有：用户没说过的、角色不可能知道的、未来剧情信息、开发者内部信息。

---

# 13. Initiative

```ts
interface InitiativeState {
  level: number; recentInitiativeCount: number; unansweredQuestions: number
  activePlans: number; allowedNewTopics: boolean; allowedNewEvents: boolean
}
interface InitiativePolicy {
  level: number; allowNewTopics: boolean; allowQuestions: boolean
  allowActions: boolean; allowEvents: boolean
  maxNewThreadsPerTurn: number; maxUnpromptedActionsPerTurn: number
}
```

`Initiative ≠ 更多字数`；主动性是行为广度集合（提问/提议/换话题/发行为/提计划/引入信息/触发事件/主动表达）。

---

# 14. Story Thread 与 Thread Scheduler

```ts
interface StoryThread {
  id: string; topic: string; originMessageId: string
  importance: number; emotionalWeight: number; narrativeWeight: number
  status: 'open' | 'dormant' | 'resolved'
  lastMentionedAt?: string; revisitProbability: number; participants: string[]
}
```

Thread Scheduler 每轮按 `Relevance → Emotional Weight → Narrative Weight → Recency → Revisit Probability` 计算，输出 `{ activeThreads, dormantThreads, ignoredThreads }`。进 Context 只取相关子集。

---

# 15. Story Momentum 与 Event Budget

```ts
interface StoryMomentum {
  pressure: number; desiredProgress: number
  eventBudget: EventBudget; unresolvedThreadPriority: number
  interruptionAllowance: number
}
interface EventBudget {
  minimum?: number; preferred: number; maximum: number; importanceThreshold: number
}
```

默认 `minimum=0 / preferred=1 / maximum=2`；紧张剧情 pressure 0.75、高潮 0.9。**不固定每轮 N 个事件**（去 Kemini 强制计数）。

---

# 16. Life Texture

```ts
interface LifeTexturePolicy {
  mundaneActions: number; incidentalTopics: number; environmentalInteraction: number
  casualQuestions: number; routineEvents: number; unfinishedSmallTalk: number
}
```

目标：让角色"像正在生活"，而非专门等待用户输入。属 Dynamic，落 tail/request；Deep 或角色偏好时启用。

---

# 17. User Agency

```ts
interface AgencyPolicy {
  mayDescribeUser: boolean; mayInferUserEmotion: boolean
  mayChooseUserAction: boolean; mayWriteUserDialogue: boolean
  mayResolveUserDecision: boolean
}
```

默认：描述用户缓慢 / 推断情绪 false / 替行动 false / 替说话 false / 替决定 false（`mayDescribeUser=cautious` 由 Prompt Policy 细化）。违反 → Quality 的 `AGENCY_VIOLATION` 阻断重试。继承 Kemini"防支配"。

---

# 18. Expression History 与五层重复检测

```ts
interface ExpressionHistory {
  phrases: PhraseRecord[]; actions: ActionRecord[]; metaphors: MetaphorRecord[]
  emotionExpressions: ExpressionRecord[]; openings: StructureRecord[]
  closings: StructureRecord[]; patterns: StructuralPattern[]
}
interface ExpressionRecord {
  normalizedForm: string; category: string; turnIndex: number
  similarityHash?: string; semanticEmbedding?: number[]; cooldownUntil?: number
}
```

只保留近期窗口 + 聚合，不存无限历史。五层检测：**Lexical → Syntactic → Semantic → Behavioral → Narrative**。

- Lexical：高频词/短语/固定动作/句尾/开头。
- Structural：`pause → gaze → silence` 结构重复（`StructuralPattern.{patternId, category, similarity, recentCount, cooldown}`）。
- Semantic：`手指收紧/指节泛白/攥紧` → `tension/gripping`（`SemanticExpressionCluster`，MVP 用 normalized+n-gram+fingerprint，embedding 可选）。
- Behavioral：连续"被调侃→脸红→瞪人→嘴硬"即使文字不同仍是行为模板（记录 `Stimulus→Behavior` 映射）。
- Cooldown：`ExpressionCooldown{expression, category, cooldownTurns, severity, reason}`——**冷却而非永久禁止**。

---

# 19. Novelty 与 Surprise

```ts
interface NoveltyState {
  linguisticNovelty: number; behavioralNovelty: number; narrativeNovelty: number
  associativeNovelty: number; recentNoveltyScore: number; noveltyDebt: number
}
```

`noveltyDebt ↑` → 下一轮提高行为变化/话题偏移/环境互动/主动性，**而非单纯 temperature↑**。

```ts
interface SurprisePolicy {
  enabled: boolean; probability: number; allowedDeviation: number
  characterConsistency: number; narrativeRisk: number
}
```

Surprise 必须过 `Character Fit + World Fit + Relationship Fit`；`随机 ≠ 有趣`。

---

# 20. Generation Strategy 与 Dialogue Rhythm

```ts
type GenerationStrategy =
  | 'direct_dialogue' | 'dialogue_with_subtext' | 'action_first'
  | 'environment_first' | 'character_initiative' | 'reflection'
  | 'event_trigger' | 'casual_exchange' | 'mixed'
```

策略**不是正文**。

```ts
interface DialogueRhythm {
  responseLength: Range; actionRatio: Range; dialogueRatio: Range
  pauseFrequency: Range; initiativeFrequency: Range; topicShiftFrequency: Range
  questionFrequency: Range; paragraphLengthVariance: number
}
```

（活泼/冷淡/温柔三型示例见细化稿 §20；此处不赘。）

---

# 21. Behavior / Dialogue Directive

Roleplay Runtime 输出给 Prompt Compiler 的核心结果（R2 命名：与群聊/工作流 Director 区分）：

```ts
interface DialogueDirective {
  emotionalDirection?: string; interactionGoal?: string
  initiative: InitiativeLevel; subtext?: string; characterIntent?: string
  behavioralDirection?: string; attentionTargets?: string[]
  pacing?: PacingDirective; generationStrategy?: GenerationStrategy
  novelty?: NoveltyDirective; expressionConstraints?: ExpressionConstraint[]
  agencyConstraints?: AgencyConstraint[]; avoid?: Constraint[]
}
```

示例（得意时的"装无事"）：

```json
{
  "emotionalDirection": "slightly warmer",
  "interactionGoal": "continue the interaction",
  "initiative": "medium",
  "subtext": "hide that she is pleased",
  "behavioralDirection": "deflect the compliment and probe why the user came",
  "pacing": "short_exchange",
  "generationStrategy": "dialogue_with_subtext",
  "novelty": {"level": 0.55},
  "avoid": ["direct confession", "summary", "moral explanation", "repeated pause gesture"]
}
```

**Token 预算**：Normal 50–150 / Complex 150–300 / Max 500，绝不允许 Director 无限膨胀。

**Direction Over Script**：给方向（`隐藏关心/避免直接回答/试探动机`），不给剧本（`下一句说 X / 她低头 / 她端起咖啡`）。

---

# 22. Directive 三种实现级别（R1 Fast 落点）

| 级别 | 实现 | 说明 |
|---|---|---|
| Level 1 | Rule Based | 快/稳定/便宜/可解释；**Fast 默认用此**（见 §22 与 §30） |
| Level 2 | Small Model | State + History Summary → 小 LLM → Directive；适用复杂角色/关系/长剧情（Balanced/Deep） |
| Level 3 | Main Model Planning | 特殊情形允许主模型先生成内部 Directive；**不得把模型内部推理文本当 Runtime State**，只存结构化 Decision |

MVP：Rule Engine + Optional Small Model；**不要一开始让每轮都增加大模型调用**。

---

# 23. Roleplay Context

```ts
interface RoleplayContext {
  character: CharacterContext; state: CharacterRuntimeState
  relationship: RelationshipState[]; memories: MemoryRef[]; threads: StoryThread[]
  userEvent: DialogueEvent; directive?: DialogueDirective
  expressionConstraints?: ExpressionConstraint[]
  generationPolicy?: GenerationPolicy; agencyPolicy: AgencyPolicy
}
```

---

# 24. PromptContribution 与 Segments

Roleplay Runtime 不直接改 Prompt IR，输出 `PromptContribution{ source, id, priority, semanticPlacement, cachePlacement, stability, content, dependencies }`，`source ∈ roleplay_runtime | dialogue_director | relationship_runtime | expression_runtime`（prompt-compiler-spec §8 的 SegmentSource 扩展）。

推荐 Segment：`roleplay_runtime:state`、`roleplay_runtime:emotion`、`relationship_runtime:relationship`、`dialogue_director:intent/subtext/behavior`、`expression_runtime:constraints`。

**Stability 分层（默认）**：

```text
Character Core: static      Relationship: session/message      Emotion: request
Directive: request          Expression Constraints: message    User Message: message    Time: volatile
```

**缓存落位（R4）**：CHARACTER → STABLE WORLDBOOK → STABLE MEMORY → FROZEN SUMMARY → HISTORY → ROLEPLAY STATE → DIRECTIVE → USER MESSAGE → VOLATILE。动态内容绝不进稳定前缀，复用既有 CachePlan（C2/C6）。

### 24.1 Roleplay Context Policy（两层裁剪，R5）

RP 内部状态不能被全量塞进 Prompt，由 `RoleplayContextPolicy` 决定"选哪些进 Context"：

```ts
interface RoleplayContextPolicy {
  emotionalState: 'full' | 'compact' | 'omit'
  relationshipState: 'full' | 'compact' | 'omit'
  currentIntent: 'full' | 'compact' | 'omit'
  expressionHistory: 'summary' | 'patterns' | 'omit'
  storyThreads: 'relevant' | 'all' | 'omit'
  lifeTexture: 'relevant' | 'compact' | 'omit'
}
```

**两层分工（R5，不互相替代）**：
- **语义层（本文）**：选"哪些 RP 内容有价值进 Context"。默认选择序 `Character Core → User Event → Relationship → Relevant Memory → Intent → Recent History → Story Threads → Expression Control → Life Texture`（memory 内的优先级见 §25）。
- **物理层（总设计 §15）**：Context 超预算时按**缓存代价**裁剪 `tail > injection > freshWB > elastic history > summary > stableWB > header`。

语义层决定内容取舍、物理层决定裁剪代价，两者都在 Prompt Compiler 内分工完成。

---

# 25. Memory 集成（R3）

Roleplay Runtime 不实现完整 Memory Store，向 Memory Runtime 请求：

```ts
interface MemoryQuery {
  chatId: string; characterId?: string; query: string
  semanticFocus?: string[]; emotionalFocus?: string[]; relationshipFocus?: string[]
  maxResults: number; tokenBudget: number
}
```

默认优先级：`Relationship → Relevant Episodic → Character → Unresolved Threads → World → General History`（可由 Context Policy 调序）。

**Runtime State / Memory / Summary 三者关系**：Memory=可检索事实（"用户曾救过角色"）；State=当前动态状态（"因此更信任"）；Summary=过去发生了什么。三者不可互相替代。

---

# 26. State Commit（候选提交 + 原子 + 幂等）

**Critical Rule：生成期间不提交状态。** 错误：`Generate → 改 State → 失败 → Retry 用被污染状态`。正确：

```text
State Snapshot → Generate → Candidate State Patch → Quality Gate → Accept → Commit
```

使用状态补丁（不整存 State）：

```ts
interface RoleplayStatePatch {
  emotional?: Partial<EmotionalState>; initiative?: Partial<InitiativeState>
  attention?: Partial<AttentionState>; intent?: CharacterIntent | null; focus?: Focus | null
}
```

```ts
interface RoleplayCandidate {
  response: string; statePatch: RoleplayStatePatch
  relationshipChanges: RelationshipChange[]; newThreads: StoryThread[]
  expressionRecords: ExpressionRecord[]; qualityReport?: RoleplayQualityReport
}
interface RoleplayCommit {
  statePatch: RoleplayStatePatch; relationshipChanges: RelationshipChange[]
  newThreads: StoryThread[]; resolvedThreads: string[]
  memoryArtifacts: MemoryArtifact[]; expressionRecords: ExpressionRecord[]
}
```

- **Atomic Commit**：Response/State/Relationship/Memory/Thread 要么全部成功要么全回滚（避免"回复已生成但 Memory 写入失败"）。
- **Idempotency**：Commit 带 `CommitId{ runId, attemptId, candidateId }`，重复提交不重复改状态。
- **Cancellation**：Model Call 后、Commit 前用户取消 → discard candidate、不改 State。
- **Partial Failure**（Model 成功 / Quality 成功 / Memory 写失败）：保留 `Response Artifact + Pending Commit` 供恢复，避免"用户看到回复但丢失 Runtime State"。
- **State Version**：每次 Commit `version += 1`；Swipe/Variant 每个候选拥有自己的 Candidate State，只有被选中的才 Commit。
- **State Hash**：`canonical JSON → SHA-256`（字段/数组顺序、浮点格式必须确定），用于 Replay/Branch/Rollback 校验（对应 roleplay_snapshots.state_hash）。

---

# 27. 状态事件化（Event Sourcing）

推荐 `Snapshot + Event Log` 而非只存最终 JSON：

```text
State v100
  → Event: USER_PRAISE / EMOTION_CHANGE / DIRECTIVE_CREATED / RESPONSE_GENERATED / RELATIONSHIP_CHANGE
State v101
```

落库为 `character_state_events`（见 §29.4，database-schema V2.6），每条含 `patch + previous_version + next_version`，支撑 Audit / Replay / Rollback / Debug。

---

# 28. Quality Analysis 与 Quality Gate

```ts
interface RoleplayQualityReport {
  characterConsistency: number; emotionalContinuity: number; relationshipContinuity: number
  dialogueNaturalness: number; behavioralNovelty: number; linguisticNovelty: number
  initiativeQuality: number; narrativeMomentum: number; lifeTexture: number
  repetitionRisk: number; agencyViolationRisk: number; aiPatternRisk: number
  issues: QualityIssue[]
}
```

`QualityIssue` code：`CHARACTER_DRIFT / EMOTION_JUMP / RELATIONSHIP_JUMP / REPETITION / STRUCTURAL_REPETITION / BEHAVIORAL_REPETITION / AGENCY_VIOLATION / KNOWLEDGE_VIOLATION / LOW_NOVELTY / FORCED_PLOT / OOC_ACTION`。

**Quality Pipeline**：Parse → Agency Check → Knowledge Check → Character Check → Emotion Check → Repetition Check → Novelty Check → Narrative Check → Report。

默认只阻断：Agency / Knowledge Violation、Severe Drift、Severe OOC、严重重复。**不为 `novelty=0.45` 就重生成**（避免过度优化）。

---

# 29. Adaptive Retry 与预算

| 触发问题 | 调整 |
|---|---|
| REPETITION | generationStrategy + behavioralNovelty + expressionConstraints |
| CHARACTER_DRIFT | character tendency + character core reminder |
| AGENCY_VIOLATION | hard agency constraint |
| LOW_NOVELTY / initiative | noveltyDelta / initiativeDelta / directnessDelta |

```ts
interface RegenerationAdjustment {
  changeStrategy?: GenerationStrategy; noveltyDelta?: number; initiativeDelta?: number
  directnessDelta?: number; rhythmAdjustment?: string
  avoidPatterns?: string[]; strengthenConstraints?: string[]
}
```

最大 Retry：默认 0–1，Deep 0–2，不无限。Quality Loop 必须受预算约束：

```ts
interface RoleplayBudget {
  maxDirectorCalls: number; maxQualityCalls: number; maxRegenerations: number
  maxAdditionalInputTokens: number; maxAdditionalOutputTokens: number; maxAdditionalCost?: number
}
```

---

# 30. 三档（Fast / Balanced / Deep）与耗时目标

- **Fast**：State → Compile → Model（单调用，R1/C1）。
- **Balanced**：State → Memory → Director → Compile → Model → Light Quality。
- **Deep**：State → Memory → Director → Compile → Model → Quality → Optional Retry → Commit。

性能目标（不含模型调用）：Balanced 下 Roleplay Runtime CPU < 20ms；Rule Director < 10ms；Small Model Director 单独统计 latency。Runtime State 建议 < 32KB，不得全量注入 Prompt。长对话 `Raw Events → Recent Window → Aggregated State → Frozen Memory` 压缩。

---

# 31. Run 可观测（Observability）

每次 Run 至少记录：`state version / directive / memory selection / prompt snapshot / model response / quality report / commit result`，并产生事件（见 §33）。这才能定位"为什么这一轮突然 OOC？"。

**Decision Trace**（不保存模型 CoT）：

```ts
interface RoleplayDecisionTrace {
  runId: string; attemptId: string
  eventSignals: SemanticSignal[]; emotionTransition?: EmotionalTransition
  relationshipChanges: RelationshipChange[]; selectedTendencies: SelectedTendency[]
  selectedThreads: string[]; attentionTargets: AttentionTarget[]
  directive: DialogueDirective; noveltyDecision?: NoveltyDecision; repetitionDecision?: RepetitionDecision
}
```

例：`{ "selectedTendencies": [{"id":"deflect_praise","score":0.81}], "emotionTransition":{"from":"neutral","to":"embarrassed"} }`。

---

# 32. 缓存与"为什么像 AI"

- **Cache Tests**：Roleplay State 更新不得导致 Character Core / Stable Worldbook / Frozen Memory 无意义失效（§24 稳定分层 + C6）。
- **Roleplay Inspector**：Emotion / Relationship / Intent / Behavior / Initiative / Memory / Repetition / Directive 分层视图，可跳转 PromptSnapshot（zone/stability/token/source）。
- **"为什么 AI 味重"诊断链**：`{ aiPatternRisk: 0.72; 原因: [最近4轮行为结构重复, 最近3轮均环境收尾, 缺主动行为, 情绪表达方式重复, Directive Novelty 偏低] }`——产品差异化功能。

---

# 33. Runtime 事件域（对齐总设计 §5.4）

统一并入 §5.4 权威清单，`roleplay.*` 域（决策 19 要求声明 durability）：

```text
roleplay.state.updated / roleplay.emotion.changed / roleplay.relationship.changed
roleplay.thread.created / roleplay.thread.resolved / roleplay.directive.created
roleplay.quality.completed / roleplay.regeneration.started / roleplay.commit.completed
roleplay.pattern.detected / roleplay.drift.detected / roleplay.quality.warning
```

durability 分档（见 technical-design §5.4）：`roleplay.state.updated / relationship.changed / thread.* / commit.completed` 归 **durable**（重建执行树/记账需要）；`roleplay.directive.created / quality.completed / regeneration.started / emotion.changed / pattern.detected / drift.detected / quality.warning` 归 **deferred-durable**（异步批量，允许延迟不允许丢）。

---

# 34. 持久化（database-schema §29.1–29.5，折中 5 表）

| 表 | 作用 | 说明 |
|---|---|---|
| `roleplay_states` | (chat,character) 存活状态 | = character_runtime_states；情绪/意图/initiative/novelty/rhythm/expression_history/attention/knowledge |
| `story_threads` | 未完成剧情线 | open/dormant/resolved |
| `roleplay_snapshots` | 每次 Run 快照 + decision_trace + state_hash | Replay/Branch/Undo/Swipe/Rollback |
| `relationship_states` | 关系边表 | (chat, source, target) 8 维；群聊关系图 |
| `character_state_events` | 状态变更事件溯源 | patch + prev/next version |

Directive / Quality Report 存 `artifacts`（`type='roleplay_directive'` / `type='roleplay_quality'`）并绑定 run/attempt/step_run。

---

# 35. Replay / Preview / Simulation

- **Replay**：`{ stateSnapshotId, eventIds, characterVersion, runtimeVersion, randomSeed, timestamp }`，**禁止真实状态写入**；保证 `F(State, Event, Seed) = same Decision`。
- **Preview**：读取 State → 生成 Directive → Compile；不 Commit、不写 Memory、不改 Relationship（用于 Inspector）。
- **Simulation**：Fake Time / Random / Model；用于 Cache Simulator、Benchmark、Regression。
- **World Event → Character Perception**：同一"警报响起"，角色 A 恐惧/B 兴奋/C 无所谓——`World Event → Character Perception → Character State`。

---

# 36. Group Chat（不新建 RP Runtime）

每个角色独立 `CharacterRuntimeState` + 关系图（A↔B、A↔User、B↔C 各一条边），不共享 Emotion。Turn Selection：

```ts
interface TurnSelection {
  characterId: string; score: number
  reason: 'directed'|'initiative'|'emotional_relevance'|'thread_relevance'|'rotation'|'randomized'
}
```

"谁下一轮说话"也是 Runtime 的一部分；仍由群聊 Director 决定谁去 + Roleplay 决定该角色怎么做（R2 分界）。

---

# 37. 测试策略与预算

- Unit / Golden / Property / Fuzz / Replay / Long-Context / Model-Comparison。
- **Emotion**：neutral→anger→sadness→neutral、高/低 inertia、多触发/冲突触发 → 断言 transition 确定。
- **Relationship**：正/负小事件、重复正事件、threshold、rollback → 不突然从陌生人变恋人。
- **Repetition**：20/50/100 轮检测 lexical/structural/behavioral/semantic。
- **Agency**：用户未说明下一步时，模型不得替用户做重大决定。
- **Replay/Property**：`Same State+Events+Seed+Runtime Version ⇒ Same Directive`。
- **Cache**：RP State 更新不使稳定前缀无意义失效。
- 属性不变量：输入 State/Event 不变，Roleplay Decision 必须确定。

---

# 38. 与 Kemini 的对应与改造

| Kemini | WhisperTavern |
|---|---|
| 互动小说 | Roleplay Runtime |
| 白描 | Generation Style Policy |
| 对白生动化 | Dialogue Liveness + Director |
| 情绪优化 | Emotion Runtime |
| 推进剧情 | Story Momentum（去固定 N 事件） |
| 去八股 | Repetition/Novelty Runtime（去固定 consider/模板） |
| 摘要 | Memory Artifact（非正文固定输出） |
| 防支配 | Agency Policy |

保留：互动小说思维/不可预测性/剧情自发展/白描/作者隐身/可观察行动。改造：`consider` 模拟 → `Latent Candidate Generation`（Runtime 内部选策略，不要求模型输出标记、不强约束格式）。

---

# 39. MVP 范围与最小接口

第一版实现：CharacterRuntimeState / Emotion / Relationship / StoryThread / CharacterTendency / DialogueDirective / Initiative / ExpressionHistory / Basic Repetition / PromptContribution / State Snapshot + Patch Commit / Roleplay Inspector。暂缓：Small Model Director、Embedding 语义重复、自动 Narrative Critic、复杂 Surprise、高级群聊调度。

```ts
class RoleplayRuntime {
  resolveContext(input: RoleplayInput): Promise<RoleplayContext>
  applyEvent(context: RoleplayContext, event: DialogueEvent): Promise<RoleplayContext>
  createDirective(context: RoleplayContext): Promise<DialogueDirective>
  analyzeResponse(context: RoleplayContext, response: string): Promise<RoleplayQualityReport>
  createCandidate(context: RoleplayContext, response: string): Promise<RoleplayCandidate>
  commit(candidate: RoleplayCandidate): Promise<void>
}
```

推荐 Step：`resolve_roleplay_context → apply_dialogue_event → retrieve_roleplay_memory → create_dialogue_directive → compile_prompt → model_call → roleplay_quality_check → commit_roleplay_state`（步骤输入输出见细化稿 §130，此处从略）。底层依赖：`CharacterStateStore / RelationshipStore / ThreadStore / ExpressionStore / MemoryRuntime / WorldbookRuntime / DialogueDirector`。

---

# 40. 最终原则与产品定义

最终最重要的不是"让模型写更多/用更多文学技巧"，而是：

```text
让角色拥有持续状态 → 状态影响行为 → 行为影响关系 → 关系影响下一轮
+ 主动性 + 选择性注意 + 表达保持新鲜 + 保留模型最终创作自由
```

形成 **Character Loop**（User Event→Perception→State→Intent→Behavior→Expression→Response→State Change→Next Turn），而非 Prompt→Response Loop。

> **产品定义**：一个让 LLM 角色拥有持续心理状态、关系状态、行为倾向、记忆、主动性和表达新颖性的 Character Simulation Runtime。Agent Runtime = How to Execute；Roleplay Runtime = How the Character Behaves；Prompt Compiler = What the Model Sees。

---

# 41. 验收标准

- **单调用缺省**：默认 RP 路径每轮恰 1 次模型调用（Fast）；Balanced/Deep 仅按用户显式选择。
- **角色连续性**：20+ 轮同角色情绪无源漂移；关系渐进可 Replay。
- **反重复**：30+ 轮高频动作/句式不单调；cooldown 生效、不全局禁词。
- **干净缓存**：RP 动态全落 fresh/injection/tail，稳定前缀测试保持绿。
- **不越界**：默认 AgencyPolicy 下不替用户说话/决定；越界触发 `AGENCY_VIOLATION → retry`。
- **可观测**：每轮产生 `RoleplayStateSnapshot + DecisionTrace + PromptSnapshot + QualityReport`，Inspector 可答"为什么 AI 味重"。
- **Compiler 纯净**：无一 RP 模块直接拼最终 Prompt，全部经 PromptContribution。
- **原子一致**：Commit 原子、幂等（CommitId）、取消不落状态。

---

*关联文档：[agent-runtime-spec.md](./agent-runtime-spec.md) · [prompt-compiler-spec.md](./prompt-compiler-spec.md) · [database-schema.md](./database-schema.md) · [api-spec.md](./api-spec.md) · [dialogue-director-spec.md](./dialogue-director-spec.md) · [roleplay-quality-spec.md](./roleplay-quality-spec.md) · [technical-design.md](../technical-design.md) · [worldbook-cache-design.md](../worldbook-cache-design.md)*