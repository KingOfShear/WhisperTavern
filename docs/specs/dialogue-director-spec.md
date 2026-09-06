# WhisperTavern V2 — Dialogue Director Specification

> 版本：V1.0（2026-09-05，Roleplay Runtime 子规格一）
> 状态：Draft（与 roleplay-runtime-spec / agent-runtime-spec / prompt-compiler-spec / api-spec 对齐，待 P4 实施）
> 文档层级：`roleplay-runtime-spec.md` 之下的 **子模块规格**，与 `roleplay-quality-spec.md` 并列
> 依赖：`roleplay-runtime-spec.md`（角色状态/意图/线程/表达历史/主动性）、`agent-runtime-spec.md`（执行四层 C5）、`prompt-compiler-spec.md`（PromptContribution）、`technical-design.md`（§5.4 事件、§38 决策 28）
> 命名：本文 **Dialogue Director（Behavior Director，行为指向器）** ≠ agent-runtime-spec §23/§80 的**群聊/工作流 Director**（R2），不得混用。
> 裁决前提：沿用 roleplay-runtime-spec R1（**Fast 默认单调用**）——MVP/Rule Engine 不新增模型调用；大模型 Director 仅 Deep 可选。

---

# 1. 文档目的

Dialogue Director 回答一个核心问题：

> **这一轮角色应该"怎么回应"，而不是"应该说什么"。**

它不生成最终文本，只根据角色状态、用户事件、关系、情绪、目标、剧情线程、表达历史、节奏、主动性/新颖性预算、世界状态、知识边界、用户 Agency，决定本轮的：

```text
情绪方向 / 行为倾向 / 互动目标 / 对话策略 / 信息披露程度 / 潜台词 / 主动性
/ 节奏 / 新颖性 / 应避免的重复模式 / 是否推进/转移/提问 / 是否留下未完成信息
```

输出 **Behavioral Directive（行为指令）**，不是台词。

---

# 2. 核心设计原则

- **2.1 Director ≠ 第二个 Prompt**：不得输出"她轻轻叹了口气，目光移向窗外……"（Prompt→LLM→Prompt→LLM 双重 AI 味、锁死模型）。只给方向。
- **2.2 Direction Over Script**：给"隐瞒真实原因、保持交流开放"，不给"下一句说 X、然后低头"。
- **2.3 局部决策器**：Director 只作本轮倾向决策，不是剧情编剧/Planner（Planner 管未来几轮，Model 管具体表达）。
- **2.4 保留模型创作自由**。
- **2.5 Soft Constraint**：倾向/概率/权重/冷却，而非"必须/禁止某词"。
- **2.6 Fast 默认不新增模型调用**（R1）：MVP 用 Rule Engine + 轻量状态计算 + 表达历史分析；大模型 Director 按需（Deep），非每轮。

架构位置：

```text
Agent Runtime → Roleplay Runtime → Dialogue Director → Behavioral Directive
                                                                  ↓
                                            Prompt Compiler → Prompt IR → Model → Candidate → Quality Gate → Commit
```

---

# 3. 输入

```ts
interface DialogueDirectorInput {
  character: CharacterProfile
  runtimeState: CharacterRuntimeState
  dialogueEvent: DialogueEvent
  relationship?: RelationshipState
  activeThreads: StoryThread[]
  recentEvents: DialogueEvent[]
  expressionHistory: ExpressionHistory
  noveltyState: NoveltyState
  dialogueState: DialogueState
  initiativeState: InitiativeState
  knowledgeBoundary: KnowledgeBoundary
  worldState?: WorldState
  memoryContext?: DirectorMemoryContext
  policies: DirectorPolicies
  runtimeContext: DirectorRuntimeContext
}
```

---

# 4. 事件归一与 Semantic Signal

Director 不把用户消息当字符串，先归一为 `DialogueEvent`：

```ts
interface DialogueEvent {
  id: string
  actor: 'user' | 'character' | 'system' | 'world'
  type: 'speech'|'action'|'question'|'emotion'|'revelation'|'request'|'threat'
       |'compliment'|'insult'|'gift'|'departure'|'arrival'
       |'environment_change'|'time_advance'|'other'
  content: string
  semanticSignals: SemanticSignal[]
  timestamp: string
  messageId?: string
}

interface SemanticSignal {
  type: SemanticSignalType   // question|request|compliment|insult|affection|hostility
                             // |suspicion|fear|concern|curiosity|humor|relationship_probe
                             // |boundary_probe|revelation|deception|farewell|invitation
                             // |conflict|vulnerability|topic_change|silence|other
  confidence: number
  intensity?: number
  target?: string
  source: 'parser' | 'runtime' | 'model' | 'rule'
}
```

例：用户"你是不是在躲着我？" → `type=question` + signals `{relationship_probe,0.91} {suspicion,0.72} {emotional_pressure,0.61}`。

**Signal 不是事实**：不直接改 `character.emotion`；最终状态变化必须经 Character Runtime 走一次状态机。

---

# 5. 核心输出：DialogueDirective

```ts
interface DialogueDirective {
  schemaVersion: number
  id: string
  emotionalDirection?: EmotionalDirection
  interactionGoal?: InteractionGoal
  behavioralDirection?: BehavioralDirection
  subtext?: SubtextDirective
  disclosure?: DisclosurePolicy
  initiative?: InitiativeLevel
  pacing?: DialoguePacing
  generationStrategy?: GenerationStrategy
  novelty?: NoveltyDirective
  topicStrategy?: TopicStrategy
  threadStrategy?: ThreadStrategy
  agency?: AgencyDirective
  knowledge?: KnowledgeDirective
  expressionConstraints?: ExpressionConstraints
  avoid?: AvoidPattern[]
  priority?: DirectivePriority
  confidence: number
  expiresAfter: 'turn' | 'response' | 'event'
  diagnostics?: Diagnostic[]
}
```

- **EmotionalDirection**：给**趋势**不给数值。`{ primary, secondary, direction: increase|decrease|shift|maintain|suppress|surface, intensity: subtle|low|medium|high, delta: tiny|small|moderate|large }`。
- **InteractionGoal**：`answer|ask|connect|comfort|persuade|deflect|probe|tease|challenge|reassure|hide_information|reveal_information|repair_relationship|escalate_conflict|deescalate|continue_topic|change_topic|end_exchange|create_opening`。
- **BehavioralDirection**：`{ primary, secondary?, strength: subtle|moderate|strong, forbidden? }`——允许高层自然语言（给模型理解），但不成剧情脚本。
- **SubtextDirective**：`{ intent?, emotionalSubtext?, withheld[], concealment, implication }`——潜台词与显性分离。
- **DisclosurePolicy**：`{ level: none|minimal|partial|open, reveal[], conceal[], allowAmbiguity }`。
- **InitiativeLevel**：`none|low|medium|high|very_high`（受 Initiative State 与 Budget 约束）。
- **TopicStrategy**：`{ action: stay|expand|probe|shift|return|close, targetTopic?, motivation? }`——不要 `nextTopic: "childhood"`（会脚本化）。
- **ThreadStrategy**：`{ action: ignore|maintain|hint|advance|resolve|revive, threadId? }`——渐进推进，不含"今天必须揭露真相"。
- **NoveltyDirective**：`{ level, linguistic, behavioral, associative, narrative, allowUnexpectedAction, allowTopicShift, allowNewAssociation }`。**优先级：行为创新 > 联想创新 > 叙事创新 > 纯语言创新**。
- **AgencyDirective**：`canDescribeUserEmotion/Thought/canDecideUserAction/canSpeakForUser/canChangeUserRelationship`，默认全 false。
- **KnowledgeDirective**：`{ allowedKnowledge, forbiddenKnowledge, uncertaintyAllowed, speculationLevel: none|low|medium|high }`——**系统知道≠角色知道**。

一个完整实例（用户质问"你昨天为什么突然走了"，角色骄傲嘴硬）：`emotionalDirection=surface+subtle+small; interactionGoal=deflect; behavioralDirection="avoid直说原因但保持交流开放"(strength=moderate); subtext.concealment=0.72; disclosure=max? level=minimal+allowAmbiguity; initiative=low; pacing=short_exchange; generationStrategy=dialogue_with_subtext; novelty.level=0.52; avoid=[direct confession, explicit emotional explanation, repeated pause gesture]; confidence=0.87`。**到这里就停止，不再写动作/台词**。

---

# 6. 决策流程与候选选择

完整流程（18 步从略，抽象为）：`Event→State→Signals→Emotion→Relationship→Goals→Threads→InitiativeBudget→ExpressionHistory→Novelty→选互动目标→选行为方向→选潜台词/披露→选话题策略→选生成策略→构造 Directive→校验→返回`。

**一次不做所有决定**：Director 不一次决定情绪+台词+动作+环境+剧情+下一回合+结局；只作局部决策。

**Rule 不是确定性脚本**：`IF compliment THEN say "谢谢"` 是错；`IF compliment AND pride高 AND embarrassment高 THEN 提升 deflect/tease/minimize/indirect 的概率` 才对。

**候选加权选择**：

```ts
interface BehaviorCandidate { behavior: string; weight: number; reasons: string[] }
score = personalityFit + emotionalFit + relationshipFit + contextFit + goalFit
      + noveltyBonus + threadRelevance
      - repetitionPenalty - cooldownPenalty - agencyRisk - knowledgeRisk
selectedBehavior = weightedRandom(candidates)   // 种子必须可 Replay
```

---

# 7. Director Seed 与确定性

每个 Attempt 携带 `DirectorSeed { seed, runId, attemptId, turnIndex }`；**禁止 `Math.random()` 裸用**，用 `runtime.randomSeed`。保证：`相同 Runtime Snapshot + 相同 DialogueEvent + 相同 Seed ⇒ 相同 Director Decision`。Replay 不一致报 `DIRECTOR_NON_DETERMINISTIC`。

`DirectorVersion { rulesVersion, scoringVersion, noveltyVersion, repetitionVersion }` 必须版本化，否则旧对话无法稳定 Replay。

---

# 8. Rule Engine 与升级路径

- **MVP（Fast）**：Rule Engine + 状态/表达历史分析（确定性、零模型调用，符合 R1）。
- **V2（Balanced/Deep 可选）**：Rule + Small Model——小模型只给 `{possibleIntent, possibleSubtext, candidateBehaviors, topicCandidates}`，不能把控权给模型，与 Rule 结果 merge。
- **V3（远期）**：按用户反馈自适应（`UserInteractionPreference`），但**用户偏好不能覆盖 Character Core / 世界事实 / 知识边界 / User Agency**。

大模型 Director **不每轮默认调用**（延迟/token/自产 AI 味/过度控制主模型）；仅 Rule 不确定时按需升级。

---

# 9. 冲突解决与优先级

- **DirectivePriority**：`low|normal|high|critical`；序 `Critical > Character Consistency > Agency/Knowledge > Interaction Goal > Emotional Direction > Story Thread > Novelty > Stylistic`。**"这轮更新颖"永远不能覆盖"不能控制用户行为"**。
- **冲突例**（角色隐藏秘密 vs 线程逼近揭露 vs 用户直问）：Director 不强制"必须撒谎"，输出 `interactionGoal=deflect + disclosure.minimal + subtext.concealment=0.85`，模型可从否认/模糊/反问/玩笑/转移/半真半假中选。

---

# 10. PromptContribution 与缓存

Director 输出 `PromptContribution{ id, source: dialogue_director|roleplay_runtime, stability, priority, content, metadata? }`，由 Prompt Compiler 转 IR；不直改 Prompt IR。

**Stability 分层**：Character Core=static、Tendency=session、Relationship Direction=session、Emotional/Dialogue Directive=request、Repetition Avoidance/Current Topic/User Event=message、Time=volatile。**Director 绝不能把"本轮她有点害羞"写进 static system prompt**。

**Directive Token Budget**：Normal 50–150、Complex 150–300、Hard max 500；超限压缩并按优先级保留 emotional/interaction goal/behavioral/agency/knowledge/critical avoidance。

---

# 11. Step 集成（C5）

```text
receive_user_event → update_perception → evaluate_character_state → dialogue_director
 → compile_prompt → model_call → response_quality_gate → commit_character_state
```

`dialogue_director` 产 `DialogueDirective`，`compile_prompt` 读取之。全部落在既有 Run/Attempt/StepRun 上（C5）。

---

# 12. 可观测

- **Inspector**：展示 InteractionGoal / Emotion / Subtext / Initiative / Topic / Thread / Novelty / RepetitionRisk / Behavior / Confidence，并提供 `Why?`（为何此行为/此情绪/此线程/提 novelty/压 pattern）。
- **Decision Trace**：`DirectorDecisionTrace { directiveId, eventId, candidates, selectedBehavior, scores, appliedRules, rejectedRules, repetitionPenalties, noveltyAdjustments, constraintViolations, seed }`——回答"为什么这轮突然反问"。
- Directive 落 `artifacts`（`type='roleplay_directive'`，绑 run/attempt/step_run），见 database-schema §29.3。

---

# 13. 验收标准

- **单调用缺省**：默认路径每轮恰 1 次模型调用（Director 规则零调用）。
- **方向非剧本**：Directive 无"下一句/动作/台词"，只含趋势/目标/方向（R2/Direction-over-Script）。
- **Replayable**：同 snapshot+event+seed ⇒ 同 Directive；不一致报 `DIRECTOR_NON_DETERMINISTIC`。
- **版本化**：规则/评分/novelty/repetition 版本可复现。
- **缓存干净**：Directive 全部 request/message 稳定性，不进静态前缀（&conflict R4）。
- **不越界**：默认 Agency 全禁；Priority 序保证硬约束不被 novelty 覆盖。

---

*关联文档：[roleplay-runtime-spec.md](./roleplay-runtime-spec.md) · [roleplay-quality-spec.md](./roleplay-quality-spec.md) · [agent-runtime-spec.md](./agent-runtime-spec.md) · [prompt-compiler-spec.md](./prompt-compiler-spec.md) · [database-schema.md](./database-schema.md) · [technical-design.md](../technical-design.md)*