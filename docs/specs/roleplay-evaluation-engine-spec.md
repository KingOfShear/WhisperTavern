# WhisperTavern V2 — Roleplay Evaluation Engine Specification

> 版本：V1.0（2026-09-05，Roleplay Quality 子规格之实现层）
> 状态：Draft（与 roleplay-quality-spec / roleplay-runtime-spec / dialogue-director-spec / shared-contracts-spec 对齐，待 P4–P5 实施）
> 文档层级：`roleplay-quality-spec.md` 之下的 **子规格（实现层）**，"质量规格定义 What，本规格定义 How"。
> 依赖：`roleplay-quality-spec.md`（QualityDimensions / IssueCode / Decision）、`shared-contracts-spec.md`（类型）、`roleplay-runtime-spec.md`（状态/线程/表达历史）、技术总设计 §5.4（事件权威域）。
> 事件口径：并入 `roleplay.*` 权威域（roleplay.quality.completed / roleplay.pattern.detected / roleplay.drift.detected / roleplay.quality.warning），不引入 `evaluation.*` 自造域。

---

# 1. 文档目的

上一层的 `roleplay-quality-spec.md` 定义"什么叫高质量角色扮演"；本文件定义**如何实际检测这些质量问题**：

```text
Candidate → Analyze → Extract Features → Compare Runtime State
        → Calculate Scores → Detect Issues → Generate Report / Feedback / Decision
```

必须是**可执行、可解释、可复现**的评价机制（输入明确 / 算法明确 / 结果可解释 / 评分可复现 / Issue 可定位 / Decision 可执行）。本引擎**不生成回复、不改 State、不改 Prompt、不直接 Retry**（由 Agent Runtime 决定 retry）。它是 **Character Simulation 的反馈控制系统**，不是"AI 文本打分器"。

---

# 2. 非目标

不编写回复、修改 Character Card、直接改 Runtime State、直接改 Prompt、直接执行 Retry、直接调外部工具。只产出 `EvaluationResult = { report, features, issues, feedback, decision, latencyMs }`。

---

# 3. 架构与确定性

```text
Candidate → Response Preprocess → Text/Dialogue/Behavior/Emotion/... 特征提取 → 各 Evaluation Engines
（Character/Emotion/Agency/Knowledge/Repetition/Novelty/Initiative/Narrative）
→ Quality Aggregator → Issue Classifier → Decision Generator
```

**确定性硬约束**：相同 `Candidate + RuntimeState + Conversation + Policy + AnalyzerVersion + Seed` ⇒ 相同 `Features/Score/Issues/Decision`。**依赖 `Date.now() / Math.random() / Object 迭代序`，除非随机来自显式 seed**。引擎拆为 `EvaluationStage{ id, version, analyze(ctx): StageResult }` 便于按版本编排。

---

# 4. 特征提取与分段

先转结构化再评分（`RawText → Sentence → Clause → Dialogue → Action → Emotion → Behavior → SemanticEvent`）。`TextSegment{ id, type: paragraph|sentence|dialogue|action|thought|description, text, start, end, speaker? }`，需支持中英混合 / emoji / 特殊符号 / Markdown。`BehaviorEvent{ id, actor, behavior, category, target, intensity, confidence }`（`BehaviorCategory` 枚举：approach/withdraw/look/touch/gesture/speak/silence/laugh/cry/anger/comfort/tease/avoid/question/answer/refuse/agree/disagree/change_topic/reveal/conceal/other）。

**Semantic Behavior 归一**：`她移开视线/避开他目光/没有对视/看向别处 → avoid_eye_contact`，但保留 `surfaceExpression` 与 `semanticBehavior` 双层（`NormalizedBehavior`）——这是"测行为重复而非词重复"的基础。

---

# 5. 各评价引擎

- **Character Consistency**：输入 Character Definition + Behavior Baseline + RuntimeState + Candidate → 输出 `{ score, compatibleBehaviors, contradictions, drift }`。约束分层：`L1 HardFacts(critical) → L2 CoreTraits → L3 StrongTendencies → L4 SoftPreferences → L5 Observed`。单轮反常不判 OOC，须 `repeated deviation` 或 `strong contradiction`。`CharacterDrift = Trait×0.30 + Behavior×0.25 + Speech×0.15 + Emotion×0.15 + Initiative×0.15`（按 Character Core/State/Events 修正）。**Contextual Exception**：强触发（用户遇险、角色大叫）不算 OOC；用 `BehavioralPlausibility{ triggerStrength, traitCompatibility, emotionalCompatibility, situationalCompatibility }` 判定。
- **Emotion Evaluation**：不读模型思维，只按 Dialogue+Action+Context+State 推断 `ObservedEmotion`。连续性用 `EmotionDelta = distance(previous,current)` vs `ExpectedDelta = triggerStrength × characterSensitivity`；超则 `EMOTION_JUMP`（confidence 足够高时）。距离用 Valence/Arousal/Intensity 的欧氏/余弦/加权距离，**不用 happy=1/sad=2 离散映射**。`EmotionalInertia`(0.2 快 / 0.9 慢) 约束 allowedDelta。
- **Relationship**：对比前后 + 互动 + Candidate → `{ delta, plausibility, jumpRisk }`；`trust 0.2→0.9` 而无强事件 → `RELATIONSHIP_JUMP`。**关系必须非对称**：`User→Character` 与 `Character→User` 分别评价（A→B ≠ B→A）。
- **Agency**（硬检测）：`AgencyEvaluation{ score, violations, controlledEntities }`，controlledEntities=用户说了/做了/想了/感觉/决定什么。分级 Level0（环境描述）安全 → L1（推测"你似乎有些犹豫"）允许 → L2（轻微行动）warning → L3（明确控制"你点头答应了"）reject → L4（重大决定）critical reject。**必须区分 prediction vs assertion**（"看起来你要离开" vs "你转身离开"）。
- **Knowledge**：`KnowledgeBoundary{ knownFacts, unknownFacts, secretFacts, forbiddenInference }`；角色"知道秘密"须找到合法 EvidenceSource（char memory/worldbook/visible dialogue/observed event/explicit user statement），否则 `KNOWLEDGE_VIOLATION`。区分 `Observed Fact / Derived Inference / Hidden Fact`——合理推断（"她握着刀→她可能想伤人"）不算越界。
- **Repetition（核心）**：六层 `Lexical → Phrase → Structural → Behavioral → Emotional → Narrative`。词法用 `TF + recentFrequency + relativeFrequency`；短语用 n-gram + semantic cluster；结构把段落转成 `A-D-A-E-D`（StructuralFingerprint{ sequence, depth, dialogueRatio, actionRatio, paragraphCount, avgSentenceLength }）；行为用 `behavior cluster` 统计次数比率；情绪用 `emotion→expression cluster`；叙事用 `NarrativePattern{ pattern[], frequency, recentFrequency, similarity }`。**`RepetitionRisk = lexical×.10 + phrase×.10 + structural×.20 + behavioral×.25 + emotional×.15 + narrative×.20`**（behavioral+narrative 最贴近 AI 味）。`TemporalDecay`：`Penalty(t)=basePenalty×e^(−λ×age)`（刚出现强罚、久远弱罚）；`BehaviorCooldown` 仅概率抑制、非禁止。
- **Novelty**：`Linguistic + Behavioral + Associative + Narrative`；候选与近期窗口比相似度（相似↑→novelty↓）；Behavioral 比当前行为 vs 行为分布。`ForcedNovelty = Novelty × (1−ContextFit)`（novelty .95 + fit .10 → FORCED_NOVELTY）；`optimal range 0.45–0.75`，不设 novelty=1 目标。
- **Initiative**：比 `Directive Initiative vs Observed`（directive medium 却零主动→LOW_INITIATIVE；directive low 却造大事件→FORCED_INITIATIVE）。`InitiativeFeatures{ askedQuestion, introducedTopic/Event/Action/Thread, changedDirection, initiativeMagnitude }`。
- **Life Texture / Dialogue Naturalness / Narrative Momentum / Baseline**：LifeTexture 是长期指标非每轮硬性要求；Text 检测 `over_answering / over_explaining / formalization / summary / generic_emotion / mismatch`（`emotionExplanationRatio` 过高→AUTHORIAL_INTERPRETATION；Show/Tell 用 `showTellBalance` 不禁 Tell）；Narrative 比 `progression/stagnation/forced progression`（`THREAD_OVERLOAD`，maxNewThreadsPerTurn 由 Director Policy 控制）；**Baseline** 统计行为/情绪/主动/长/对白占比分布，用 **Jensen-Shannon Divergence** 比较历史 vs 当前窗口；`STYLE_DRIFT` 仅 warning 除非连续。长期 Drift 分 `Short(20)/Medium(.35)/Long(.45)` 加权，避免一轮实验行为判崩。

---

# 6. 聚合 / 决策 / 阈值（全部配置化）

- `QualityScore{ overall, character, emotion, relationship, relevance, dialogue, novelty, initiative, narrative, agency, knowledge, repetitionRisk, aiPatternRisk }`（0–1）。
- **Hard Constraint Override**：`agencyCritical/knowledgeCritical/safetyCritical → overall=0`。
- `AI Pattern Risk = Repetition×.40 + Template×.25 + Generic×.15 + OverExplain×.10 + StructuralUniformity×.10`；Template 比较最近 3–10 轮（Fingerprint+embedding+behavior seq）；**Embedding 不作唯一标准**（"你还好吗/你今天还好吗"天然相似）；`PatternRisk = similarity×frequency×recency×semanticImportance`。
- 阈值：`warning<0.65 / error<0.45 / critical=硬违反`；重复 `>0.60 warning / >0.78 error / >0.90 retry`。
- **Decision Algorithm**：`critical 硬违反→BLOCK；严重 agency/knowledge/character→RETRY；严重重复/模板/forced→RETRY；局部格式→REPAIR；略低于理想→ACCEPT_WITH_WARNING；否则 ACCEPT`。

---

# 7. 反馈闭环

Quality 生成**最多 3–5 条 `AdjustmentHint`**（压缩）给 Director，**不传原始 Report 给模型**。`AdjustmentHint{ target: emotion|behavior|initiative|novelty|pacing|dialogue|expression, action: increase|decrease|avoid|prefer, value, reason }`。`RetryContext` 只传 `previousCandidateId + adjustmentHints + failedIssueCodes + preserve`，不塞整份 Report。多候选排名先 `Hard constraint → Character → Agency → Relevance → Naturalness → Novelty → Style`，并加 **DiversityBonus**（≤ QualityScore 的 10%）防止 Quality 偏好导致同质化。`ControlledRisk{ deviation, plausibility, narrativeValue, acceptable }` 允许"有故事价值的小偏离"以 accept_with_warning。**Quality 不应阻止角色成长**：`Consistency ≠ Static`，`Identity + State + Experience = Evolution`。

---

# 8. 意图性重复 / Callback（防误杀）

重复本身不是错误：`"会回来吗/会/真的/会"` 有情绪价值。用 `RepetitionMeaning{ semanticFunction: emphasis|rhythm|humor|emotion|callback|dramatic|none, value }`，`meaningfulRepetition > repetitionRisk` 则降罚。**Narrative Callback**（几十轮后呼应"窗外下雨"）不得误判为 environment repetition；`CallbackScore{ referencedMemoryId, semanticSimilarity, narrativeRelevance, payoff }` 高→Novelty/NarrativeQuality↑。Container 作用域：`Global Pattern / Character Pattern（角色签名，不罚）/ Conversation Pattern（用户与角色的特殊语言游戏，exception）`。`PatternException{ characterId?, patternId, action: ignore|reduce_penalty, reason? }`（"我就是喜欢说嗯"）。`EvaluationCalibration{ issueCode, falsePositiveRate, falseNegativeRate, sampleCount }` 记录 FPR，>15% 则调阈值。User Override 支持"ignore this pattern"。

---

# 9. Replay / 版本化 / 可观测

- **Replay**：`Original PromptSnapshot + RuntimeSnapshot + Candidate + EvaluationVersion + Seed` 重跑结果必须一致。
- **EvaluationSnapshot**：`{ id, candidateId, runtimeSnapshotId, promptSnapshotId?, analyzerVersions, policyVersion, features, report, createdAt }` 落 `artifacts`（`type='roleplay_evaluation'`）。
- **Versioning**：`evaluation-engine-v1 / character-analyzer-v1 / emotion-analyzer-v1 / repetition-engine-v1 / novelty-engine-v1 / agency-engine-v1`——算法更新后同回复可能不同分，须版本化（对应 shared-contracts 的 analyzerVersions）。
- **可解释**：任何 RETRY/BLOCK/WARNING 都须给出 Reasons（如 `BEHAVIORAL_REPETITION risk .84`）。`Evidence{ type, reference, value? }` 供 Inspector 点 Issue 跳证据。
- **事件**：`roleplay.quality.completed`（Report 详情落 artifacts）+ `roleplay.pattern.detected / roleplay.drift.detected / roleplay.quality.warning`，均 deferred-durable（见 technical-design §5.4）。

---

# 10. MVP 分阶段（对齐里程碑）

- **Phase1（P4/Fast）**：Text segmentation、Agency、Knowledge、基础 Character consistency、基础 Repetition、长度/节奏——本地规则、默认启用、单调用内完成。
- **Phase2（P4）**：Behavior normalization、Emotion/Relationship continuity、Structural/Behavioral repetition、Novelty、Initiative。
- **Phase3（P5）**：Semantic embeddings、长期 behavior baseline、Narrative pattern、Callback、Associative novelty、Small-model evaluator。
- **Phase4（P5）**：个性化 Quality Model、Learned Preferences、Candidate Ranking、Adaptive Evaluation、自动政策校准。

实现顺序：`Evaluation Core → Text/Behavior Extractor → Agency → Knowledge → Repetition → Character Consistency → Emotion → Novelty → Initiative → Narrative → Aggregator → Decision → Inspector → Replay`。**资源有限时优先 Agency + Repetition + Character Consistency**（对 RP 体验收益最高）。Evaluation 归 P4（Fast 本地）/ P5（Slow 模型），不改变默认每轮调用数（R1）。

---

# 11. 验收标准

- **确定性**：同输入+版本+seed ⇒ 同得分/Issue/Decision（Replay 一致）。
- **可解释**：所有 Retry/Block/Warning 有 Reason + Evidence。
- **不越界**：Agency/Knowledge 分层且硬违反一票否决；角色成长与 Intentional Repetition/Callback 不被误杀。
- **反重复**：六层 + 时间衰减 + cooldown，不做全局禁词。
- **单调用缺省**：Fast 本地引擎零模型调用；Slow LLM 不默认启用（R1）。
- **闭环**：只产 AdjustmentHint（≤3–5 条）给 Director，不传原始 Report。
- **不阻止成长**：ControlledRisk 允许有故事价值的小偏离（accept_with_warning）。

---

*关联文档：[roleplay-quality-spec.md](./roleplay-quality-spec.md) · [shared-contracts-spec.md](./shared-contracts-spec.md) · [roleplay-runtime-spec.md](./roleplay-runtime-spec.md) · [dialogue-director-spec.md](./dialogue-director-spec.md) · [technical-design.md](../technical-design.md)*