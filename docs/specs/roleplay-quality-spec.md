# WhisperTavern V2 — Roleplay Quality Specification

> 版本：V1.0（2026-09-05，Roleplay Runtime 子规格二）
> 状态：Draft（与 roleplay-runtime-spec / dialogue-director-spec / agent-runtime-spec / prompt-compiler-spec 对齐，待 P4 实施）
> 文档层级：`roleplay-runtime-spec.md` 之下的 **子模块规格**，与 `dialogue-director-spec.md` 并列
> 依赖：`roleplay-runtime-spec.md`（角色状态/意图/线程/表达历史）、`dialogue-director-spec.md`（Directive）、`agent-runtime-spec.md`（C5 Retry）、`technical-design.md`（§5.4 事件权威域、§38 决策 28）
> 事件口径：**全部并入 `roleplay.*` 权威域**，不引入 `quality.*` 自造域（§14，决策 19 要求申报 durability）。

---

# 1. 文档目的

Quality Runtime 判断：

> **模型刚生成的回复，是否是一条合格的角色扮演回复。**

"合格"不是单轮文本质量，而是**长期对话稳定、自然、有变化、有角色感**。它综合判断：角色是否还是这个角色、情绪是否连续、关系是否合理、是否真正回应用户、是否侵犯用户控制权、是否知道不该知道的、是否模板化、是否重复近期行为、是否有足够变化、是否推动自然互动、是否抢用户剧情掌控、是否"像在生活"。

目标不是"让每句话完美"，而是"长期不崩、不僵、不重复、不失角色"。

---

# 2. 核心原则

- **不追求单轮完美**：单轮全高分但第 4–6 轮行为/情绪/模板开始重复，应被长期窗口捕获。因此 Quality 同时观察 `Current Response + Recent Window + Character/Relationship State + Director Directive + Story Threads`。
- **不重写正文**：`发现问题 → 生成 Quality Decision → Agent Runtime 决定 Retry`，不做"后处理强行改原文"（会产生修正后的 AI 味）。
- **Soft + Hard 并存**：分数不简单平均；**Hard Constraint 一票否决**。
- **不确定时不阻断创造力**：`confidence` 低 → warning；只有高 confidence 的硬问题才 retry。
- **Quality 不替代 Sampling**：Sampling 管 token 级多样性，Quality 管对话级多样性；AI 味不能用 `temperature↑` 硬解（会飘角色）。

---

# 3. 架构与决策

```text
Candidate Response → Response Analyzer → Consistency/Naturalness/Safety Analysis
   → Quality Aggregator → Decision Engine → Accept | Retry                  | Repair
                                                      └──────────→ State Commit
```

与其它模块边界：Character Runtime="角色现在是谁"；Dialogue Director="这轮想怎么互动"；Model="具体怎么写"；Quality Runtime="这次表现怎么样"；Prompt Compiler="模型看到什么"。

---

# 4. 核心数据结构（QualityReport）

```ts
interface RoleplayQualityReport {
  id: string; runId: string; attemptId: string; stepRunId: string
  messageId?: string; candidateId?: string
  overallScore: number
  dimensions: QualityDimensions
  issues: QualityIssue[]
  decision: QualityDecision
  analyzerVersion: string
  createdAt: string
}
```

**QualityDimensions（18 维，均 0–1）**：characterConsistency / emotionalContinuity / relationshipContinuity / contextualRelevance / dialogueNaturalness / behavioralNovelty / linguisticNovelty / associativeNovelty / initiativeQuality / narrativeMomentum / lifeTexture / repetitionRisk / templateRisk / aiPatternRisk / agencyRespect / knowledgeRespect / pacingQuality / responseCompleteness。

**QualityDecision**：`accept | accept_with_warning | repair | retry | block`。

---

# 5. Hard Constraints（一票否决）

```ts
interface HardConstraintResult { passed: boolean; violations: HardViolation[] }
```

违规码：`CHARACTER_HARD_CONTRADICTION / KNOWLEDGE_BOUNDARY_VIOLATION / USER_AGENCY_VIOLATION / WORLD_STATE_CONTRADICTION / SAFETY_VIOLATION / FORBIDDEN_OUTPUT / INVALID_FORMAT`。任何严重硬违反 → `Reject/Block`，**不能被高文学分抵消**（`overallScore = weightedDimensions × hardConstraintMultiplier`，agency<阈值时 multiplier=0）。

---

# 6. Issue 与 Issue Code

```ts
interface QualityIssue {
  id; code: QualityIssueCode; severity: 'info'|'warning'|'error'|'critical'
  confidence: number; evidence?: string[]; span?: {start,end}
  dimension?: keyof QualityDimensions
  suggestedAction?: 'ignore'|'repair'|'retry'|'block'
}
```

Issue Code（基础版，覆盖六类重复 + 反向缺陷 + 节奏/解释/元层）：

```ts
type QualityIssueCode =
  | 'CHARACTER_DRIFT' | 'CHARACTER_CONTRADICTION'
  | 'EMOTION_JUMP' | 'RELATIONSHIP_JUMP'
  | 'KNOWLEDGE_VIOLATION' | 'AGENCY_VIOLATION'
  | 'CONTEXT_MISS' | 'QUESTION_IGNORED'
  | 'REPETITION' | 'STRUCTURAL_REPETITION' | 'BEHAVIORAL_REPETITION' | 'EMOTIONAL_REPETITION'
  | 'TEMPLATE_LANGUAGE' | 'AI_PATTERN' | 'GENERIC_DESCRIPTION'
  | 'LOW_NOVELTY' | 'FORCED_NOVELTY'
  | 'LOW_INITIATIVE' | 'FORCED_INITIATIVE'
  | 'FORCED_PLOT' | 'THREAD_OVERLOAD'
  | 'PACE_TOO_FAST' | 'PACE_TOO_SLOW'
  | 'OVER_EXPLANATION' | 'AUTHORIAL_INTERPRETATION'
  | 'ROLEPLAY_BREAK' | 'FORMAT_ERROR'
```

---

# 7. 关键检查维度

- **Character Consistency**：对比 `Character Profile + Runtime State + Tendency + Relationship + Directive`，判断行为是否符合。
- **Drift ≠ 变化**：角色可以变化；问题在**无原因的突变**。判断 `Consistency of Transition`，不是 `Similarity to Initial Sheet`。
- **Contradiction**（更严重）：如"怕水"却"毫不犹豫跳进水"且无恐惧克服/紧急/成长 → `CHARACTER_CONTRADICTION`。
- **Emotional Continuity**：有惯性；`allowedDelta ≈ triggerStrength × characterSensitivity`（角色越稳定，小事件越不能引起巨变 → `EMOTION_JUMP`）。
- **Relationship Continuity**：渐进（陌生→熟悉→信任→亲密），不能"陌生下一轮深爱"除非强事件 → `RELATIONSHIP_JUMP`。
- **Context Relevance**：真正回应输入；"今天下雨了"却长篇讲童年创伤 → `CONTEXT_MISS`。**Question Response 检测 semantic response**（"你昨天为什么没来？"答"这个问题你最好别问"仍算有效回应），不是关键词匹配。
- **Agency / Knowledge**：`AGENCY_VIOLATION`（替用户说话/思考/行动/决定，分轻微→极严重四级，只严重以上默认 retry）、`KNOWLEDGE_BOUNDARY_VIOLATION`（角色知道不该知道的）。
- **六类重复**：Lexical（最低，warning 即可）/ Structural（pause→gaze→silence）/ **Behavioral**（被调侃→脸红→瞪人→嘴硬，表面文字不同仍是行为模板，最重要）/ Emotional / Narrative（对话→情绪波动→沉默→看窗外→环境→收尾，文字全变仍是模板）。
- **Template Risk / AI Pattern**：检测"最近生成行为是否收敛到同一种模式"，作为 `pattern family` 而非禁词；**不做黑名单**（禁"顿了顿"→ 变"眨眼"→ 再禁……模型无法自然描写）。
- **Novelty**：Linguistic/Behavioral/Associative/Narrative；**Language 权重最低**（语言变 ≠ 真创造）；Behavioral>Associative>Narrative>Linguistic。**Forced Novelty**：`novelty↑ + context relevance↓`（用户问吃啥、角色要去废弃研究所）→ 新颖性必须服从情境。
- **Initiative Quality**：`appropriateness + characterFit + contextFit + userAgency`；"沉默角色突然长篇人生哲学"即使 initiative 高，quality 仍低。
- **Life Texture**：非"每轮加动作"，而是"角色有独立于用户输入的内部生活"（记得未完成的事/自己的关注点/小动作/环境反应/自己的节奏）。
- **Dialogue Naturalness**：顺势回应、不过度完整、不每句像答题、不频繁总结、不过度解释 → `OVER_EXPLANATION`；`Show don't tell` 下直接解释内心 → `AUTHORIAL_INTERPRETATION`。
- **Pacing**：`PACE_TOO_FAST`（三句相识→表白→决裂）/ `PACE_TOO_SLOW`（连续"嗯/哦/这样啊"）。
- **Response Completeness**：`interactionGoalFulfilled`，非 tokenCount（沉默也可完整）。

---

# 8. 聚合与评分

分层聚合：`Layer1 HardConstraints → L2 Character Integrity → L3 Interaction Quality → L4 Naturalness → L5 Novelty → L6 Style`。

**初始权重（版本化，quality-policy-v1）**：Character 20 / Emotion 10 / Relationship 8 / Context 10 / Dialog 12 / Agency 10 / Knowledge 6 / BehaviorNovelty 7 / LingNovelty 2 / AssocNovelty 4 / Initiative 4 / LifeTexture 3 / NarrativeMomentum 4（这些非永久参数，必须版本化）。

---

# 9. Quality Decision 与 Retry

- **accept**：`overallScore ≥ 0.78 且 无 critical issue`。
- **accept_with_warning**：如 score 0.72 但 character/agency/knowledge 高、仅 linguisticNovelty 0.45 → 通过；**不要为"文笔非最优"反复调模型**。
- **repair**：仅局部问题（格式错/重复一段/轻微多余解释），轻量修复器；**Repair 默认不改变角色行为决策**。
- **retry**：Character Drift / Agency / Knowledge / 严重重复 / Forced Plot / Directive Failure → **same Run, new Attempt / new StepRun**（C5，绝不覆盖原记录）。
- **block**：安全 / 严重知识越界 / 严重用户掌控侵犯 / 系统协议破坏。

**Retry Budget**：`QualityRetryPolicy { maxRetriesPerResponse, retryOn, minImprovement, maxQualityTokens, fallbackStrategy }`；默认 0–1，严重 0–2，绝对上限 2–3，**绝不无限**。Best-Candidate：多候选不只选最高分，综合 `CharacterFit + DirectiveFit + Novelty + Naturalness`，并保证 **Candidate Diversity**（不同策略而非同句换词）；Quality 与 Sampling 各管一层，用 Behavioral/Associative/Initiative 从高层控创造性，而非提 temperature。

---

# 10. Director → Quality 反馈闭环

Quality 不只给分数，还给 `QualityFeedback { issues, adjustmentHints }`（如 `{target:behavior,action:avoid,value:repeated_pause_gesture}`、`{target:initiative,action:increase,value:0.1}`）。**Feedback 不直接进 Prompt**（禁止"不要有AI味"），而是 `Feedback → Director Adjustment → new Directive → Compiler`。对应：行为重复→BehavioralNovelty↑、解释过多→Directness↓、太被动→Initiative↑、情绪跳变→EmotionalDelta↓。形成 **Quality→Director 反馈闭环**（本文 §10；Feedback 不直进 Prompt，而改 Director 再编译）。

---

# 11. Pattern Memory / Recency Decay

维护 `PatternMemory { patternId, category, occurrences, frequency, recentFrequency, cooldownUntil }`，用 **Recency Decay**——不永久惩罚（"用过一次的行为永远禁用"会锁死角色）。用 `recentFrequency + weightedFrequency + semanticSimilarity`，而不是 `count("叹气")`；`叹气/轻轻呼气/吐出一口气/无声叹息` 可聚类为 `emotion_release_breath`。MVP 用行为分类器+规则+语义标签，不需向量模型；未来可用 Embedding 聚类。

---

# 12. Quality Profile / 长期趋势 / 基线

- **QualityProfile**：`stable | natural | creative | experimental | custom`；Creative 扩大行为选择空间（Agency/Knowledge/Character Core 仍硬限制），**不得改变角色人格**。
- **Per-Character Quality Policy**：`consistencyWeight / noveltyPreference / initiativePreference / emotionalExpressiveness / repetitionTolerance / lifeTexturePreference`。严肃角色 vs 活泼角色显著不同。
- **Turn / Session / Conversation 三级**：Turn=本轮明显错误；Session=近 20–50 轮是否模式化；Conversation=长期 OOC/关系是否合理/线程是否失控/剧情是否循环。`LongTermDriftReport { characterDrift, relationshipDrift, behavioralDrift, repetitionAccumulation, threadDrift, overallRisk }`。
- **Behavioral Identity / Baseline**：观察角色长期行为分布（拒绝 35%/调侃 25%/提问 15%…），判断当前是否偏离；**历史分布只能作软约束**（否则角色无法成长），`Identity + Evolution` 而非 immutable。Baseline 来源 = Character Definition + Chat Examples + Observed Accepted，soft constraint。
- **User Feedback**：👍👎 或"太像AI/OOC/太啰嗦/太被动/推太快" → `UserQualityFeedback{ rating, tags, text }` → **Quality Preference Update**（行为化调整，如 behavioralNoveltyPreference↑、repetitionTolerance↓），**不直接改 Prompt**；MVP 只支持显式反馈。

---

# 13. 状态提交 / 事务 / 失败

- **候选提交**：`CandidateState{ sourceResponseId, emotionDelta, relationshipDelta, threadUpdates, attentionUpdate, initiativeUpdate, expressionObservations }`，仅 Quality PASS 后提交；错误流程 `Model→改State→Quality失败` 会污染状态。
- **事务**：`BEGIN → 载入 Snapshot → 生成/分析/出报告 → 拒绝则 Retry/Discard，接受则 Commit Response+State → COMMIT`（原子）。
- **Partial Failure**：分析器失败默认不阻塞聊天 → `fail_open`；Safety 分析失败 → `fail_closed`。

---

# 14. 事件域（并入 roleplay.* 权威域）

Quality 各阶段事件**一律挂 `roleplay.*`**，不引入 `quality.*` 域（决策 19）。并入 technical-design §5.4：

```text
durable：             roleplay.state.updated / roleplay.relationship.changed
                     / roleplay.thread.created / roleplay.thread.resolved / roleplay.commit.completed
deferred-durable：    roleplay.directive.created / roleplay.quality.completed
                     / roleplay.emotion.changed / roleplay.regeneration.started
                     / roleplay.pattern.detected / roleplay.drift.detected / roleplay.quality.warning
```

`roleplay.quality.completed` 的 Report 落 `artifacts`（`type='roleplay_quality'`，绑 run/attempt/step_run）；`roleplay.pattern.detected / drift.detected / quality.warning` 为 deferred-durable（异步批量，允许延迟不允许丢）。

---

# 15. 性能 / 预算 / 可观测

- **Quality Modes**：`off | fast | balanced | strict | debug`；**off=只硬安全**（低延迟/本地/实验），fast=规则+重复+Agency+Knowledge+基础一致性（默认），balanced=默认 Fast+Medium+少量慢检查，strict=长剧情/重要节点（允许更多 Retry），debug=全维度+Decision Trace。
- **Escalation**：Fast Check → 问题明显 PASS，否则 Medium Check → 仍不确定才 Small Model（按需升级，非每轮）。
- **预算**：`QualityBudget { maxQualityChecks, maxQualityTokens, maxRetries, maxQualityLatencyMs, maxQualityCost }`；记录 `QualityUsage { localChecksMs, embeddingTokens?, smallModelTokens?, retryCount, estimatedCost }`（否则为去 AI 味成本可能翻 2–3 倍）。
- **性能标**：Fast <20ms、Medium <100ms、Slow（LLM）不默认启用。
- **指标**：`retry_rate` 等；**retry_rate >20% 通常表示 Quality Policy 太严而非模型不行**。
- **Inspector**：Overall + 各维度条 + Issues + Decision（ACCEPT）+ "Why" 面板（如 Behavioral repetition 展示 recent pattern / semantic cluster / frequency / penalty）+ Quality Timeline（Turn 35...39 显示 Character/Novelty 趋势，提示 "Behavioral diversity declining"）。

---

# 16. Quality 与记忆 / 长期抽取

Quality 产生的高价值持久事实可进 Memory Runtime（如"角色逐渐接受用户的玩笑方式"），但 **Quality Report 本身不进长期 Prompt**，只抽取 high-value durable facts；`Quality Score=0.82` 本身无长期记忆价值。Quality 从"你写得像 AI"类自然语言要求升级为可测量的评价系统，因为那些要求模糊/静态/不可测/不可 Replay/不可长期控制。

---

# 17. 测试策略

- **Semantic Regression**（非逐字相符）：断言 `agency≥0.95 / character≥0.85 / repetition≤0.35` 等。
- **Property Tests**：无新强事件→Emotion Delta 不无限增长；cooldown 内重复模式再次选择概率下降；用户没控制角色→无 Agency Violation；角色不知道→Knowledge Violation 不被接受。
- **AI Taste Regression Suite**（tests/roleplay/ai-patterns/）：repeated_pause / sigh / eye_contact / environment_ending / metaphor / emotion_explanation / not_but / summary / paragraph_shape——测"过度集中"而非"禁词"。示例：连续 10 轮害羞脸红→Turn1 PASS/Turn3 WARNING/Turn5 REPETITION/Turn6 RETRY，而非从头禁"脸红"。
- **Forced Creativity Test**：日常对话突然引爆炸/神秘组织/改世界观 → `FORCED_NOVELTY` + `FORCED_PLOT`，而非因 novelty=1.0 给高分。
- **Golden Conversation**（50–200 轮）：固定 Runtime Snapshot/Seed/Model/Character/Worldbook/Preset，比较 Quality Metrics 而非精确文本。

---

# 18. 验收标准

- **默认 Fast**：默认 RP 路径每轮恰 1 次模型调用，Quality=本地 Fast Checks；Slow/LLM 不默认启用（R1）。
- **硬约束优先**：Agency/Knowledge/Character/World 硬违反 → 阻断，不被文学分抵消。
- **不重写全文**：Quality 只产出 Decision + Feedback，由 Runtime 决定 Retry/Repair。
- **反重复**：六类重复按 cooldown/decay 处理，不做禁词。
- **闭环**：Quality Feedback → Director → 新 Directive，Feedback 不进 Prompt。
- **可观测**：每轮产 `RoleplayQualityReport + Decision Trace`，Inspector 可答"为什么这轮像 AI"。
- **原子一致**：候选提交、事务原子、Analyzer 失败 fail_open（Safety 除外）。

---

*关联文档：[roleplay-runtime-spec.md](./roleplay-runtime-spec.md) · [dialogue-director-spec.md](./dialogue-director-spec.md) · [roleplay-evaluation-engine-spec.md](./roleplay-evaluation-engine-spec.md) · [shared-contracts-spec.md](./shared-contracts-spec.md) · [agent-runtime-spec.md](./agent-runtime-spec.md) · [prompt-compiler-spec.md](./prompt-compiler-spec.md) · [database-schema.md](./database-schema.md) · [technical-design.md](../technical-design.md)*