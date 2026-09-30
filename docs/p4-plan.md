# WhisperTavern V2 — P4 实施明细计划（Memory + Workflow + 群聊 + Roleplay Fast）

> **文件:** `docs/p4-plan.md`
> **版本:** V1.0（2026-09-27：P4 细化会话落盘——按 B4 滚动细化原则，S29–S36 会话切分 / R-P4-1–10 范围裁决 / 出场 KPI 对齐总设计 §36 P4 行）
> **状态:** 🟢 **执行中**——S29（WP4.1）+ S30（WP4.2a）✅ + S31（WP4.2b）✅ + S32（WP4.3）✅ + **S33a（WP4.4a）✅ 测试全绿闭环**（571/63 + typecheck 全 9 包 0 + ESLint 0 error 0 warning + P2 缓存门禁保绿 KPI 98.7% 原样）；下一会话 = **S33b（WP4.4b 群聊本体）**
> **2026-09-29 修订（S33 拆段）**：原 S33 任务清单第 1/3 条的前提**失实**（`{type:'character'}` 目 P0 起零生产者、`characters.description/personality` 零消费者、预设 fixture 的槽位标记全空）——命名空间照原计划建成即空转。经作者裁可拆为 **S33a（角色身份进 header + 命名空间键，已完成）** / **S33b（群聊本体，下一会话）**，详见 §8。
> **文档层级:** [implementation-plan.md](./implementation-plan.md) §8（P4 WP 概览）的**会话级执行明细**。设计语义一律指向 spec，本文只管"会话里具体干什么"。
> **上游锚点:** 总设计 §36（P4 行）/ §25（Memory）/ §26（群聊）/ implementation-plan §7·§8·§10 / [roleplay-runtime-spec.md](./specs/roleplay-runtime-spec.md) 及其三子规格（dialogue-director / roleplay-quality / roleplay-evaluation-engine）/ [database-schema.md](./specs/database-schema.md) §23·§25·§26·§29.1–29.5·§30–§31 / [api-spec.md](./specs/api-spec.md) §155 / [worldbook-cache-design.md](./worldbook-cache-design.md) §6 / §38 决策 28·36·45·46 / p3-plan（已归档） / AGENTS 会话纪律。

---

# 1. P4 会话切分总览

```text
S29 WP4.1  memory-runtime-spec 骨架 + memory 持久化底座(migration v10)              1 会话
S30 WP4.2a Summary 链(冻结块追加) + 四层记忆 + memories 双检索(FTS5+vec)            1–2 会话
S31 WP4.2b Scribe Agent + Memory HTTP 面(§155) + 还账 #8 勾销                       1 会话
S32 WP4.3  网络搜索工具(结果注 tail / agent 工具,origin 溯源)                       1 会话
S33  WP4.4   群聊本体(chat_members + Director 接线) + per-(chat,character) 缓存命名空间 1–2 会话
              → 2026-09-29 拆段:S33a 角色身份进 header + 命名空间键(✅ 已完成) / S33b 群聊本体
S34 WP4.5a Roleplay Runtime(五表 migration + 状态机 + Emotion/Relationship/Thread)  1–2 会话
S35 WP4.5b Roleplay Fast 端到端(BD 规则推导 + Directive→Compiler + Quality Fast)    1–2 会话
S36 收官   Workflow HTTP 面(§155) + World State 规则版(#18) + Simulation mock + UI   1–2 会话
```

合计约 8–12 会话。**P4 出场 = 通过 technical-design §36 P4 行验收标准**：

```text
① 300+ 楼长对话对照基线（P2 模式）质量与成本可测提升
② 3 角色群聊 50 轮缓存行为符合预期
③ RP Fast 档每轮恰 1 次调用且稳定前缀不变
```

每个会话以可验证状态收尾：测试绿或看板标注中间态 + 日记留恢复点（AGENTS §4）。

# 2. 入场条件核对

```text
✅ P1 出场（§38 决策 38）
✅ P2 六个 WP 全收口（S16–S21；§38 决策 44）——CI 侧达标
☐ P2 真实 API 实测（§36 出场条件之一；tests/smoke/real-provider-smoke.mjs 需作者自有 key）
   → 与技术工作无依赖，**不阻塞 P4 开工**；作者方便时需跑一次勾销（已登记 §38 决策 44）
✅ P3 出场（§38 决策 46）——B1（P4 并行）解锁
```

# 3. P4 范围裁决（开工前钉死，防会话自由发挥）

```text
R-P4-1  缓存纪律在 P4 同等生效(延续 C2/R4/总设计 §0)：
        RP 动态内容 / 记忆检索结果 / 群聊状态 / Workflow 阶段产物 / Summary 追加一律落
        fresh / injection / tail,绝不进稳定前缀;Summary 追加 = 显式 CacheBreak 事件
        (§10.1 铁律),禁止无事件语义的摘要回写与重排。每次 Provider Request 必挂 snapshotId。
R-P4-2  Roleplay Fast = 默认单调用(R1/C1 延续)：
        禁止引入额外模型调用;Behavior Directive 由运行时启发式规则推导并折叠进单次 Prompt。
        LLM Behavior Director 与 Quality Critic 仅在 Balanced/Deep(Deep 默认不启用)出现。
        新增任何子 Agent 必须申报"几次调用、能否共享前缀"(§38 决策 36 全局判据)。
R-P4-3  四层记忆持久化在 P4 落独立表(R-P3-9 兑现)：memories(+versions) / timeline_events /
        documents / chunks + FTS5 关键词兜底 + sqlite-vec 语义检索;P3 的 Memory Policy
        空实现替换为真实 Memory Runtime(总设计 §25)。按纪律 3 先落 memory-runtime-spec
        骨架再写码(S29)。#18 World State 规则版在 S36 落 roleplay-runtime-spec 扩展
        章节 + database-schema 补表,同样 spec 先行。
R-P4-4  Summary 链 = 冻结块追加式(database-schema §24)：
        Summary 区只追加冻结块,追加 = 显式 CacheBreak;禁止摘要替换历史(会反复毁缓存)。
        Summary Checkpoint 只追加不回写。from_message_id..to_message_id + sequence 单调。
R-P4-5  群聊缓存命名空间 = per-(chat, character)(总设计 §26)：
        世界书缓存 = chat scope(内容寻址,角色间共享);Provider Prompt Cache =
        (chat, character) scope(每角色独立缓存链)。chat_members 表按成员扩展。
        轮换发言 TTL 过期接受较低命中(§26 已知代价),UI 显示每角色链温度。
R-P4-6  Workflow HTTP 面(api-spec §155)在 P4 落地(P3 挂账转正)：
        workflows / workflow-runs CRUD + runs 驱动 + workflow 定义版本钉住(§163);
        只暴露用户自建 Workflow 的 CRUD 与 Run 入口,**不新造 Workflow 语义**
        (引擎已在 S25 落地)。审批 fail-closed 四值(R-P3-5)在 HTTP 面同样生效。
R-P4-7  Simulation mock 面(P3 挂账)：Fake Time / Random / Model 三件套
        (roleplay-runtime-spec §35)。只作用于 Cache Simulator / Benchmark / Regression,
        不影响 RP 聊天历史(历史即产品,§21 约束)。Simulation Agent(LLM 世界推演)
        是 P5 决策点(#19),P4 不做。
R-P4-8  PV8 wire 翻译(P3 挂账转 P4/P5)：
        真实 Provider 接入后补齐签名块 / 工具清单 wire 翻译(形状已在 S24 落位)。
        本阶段以 fake provider + fixture 驱动,真实 wire 翻译**随作者跑真实 API 实测时
        一并补**(与 P2 真实 API 出场同一次)。
R-P4-9  RP Quality Fast(本地规则,默认启用,单调用内完成)：
        roleplay-evaluation-engine-spec Phase1 + Phase2 中 **P4 范围** = Text segmentation /
        Agency / Knowledge / 基础 Character consistency / 基础 Repetition / 长度/节奏 /
        Behavior normalization / Emotion/Relationship continuity / Structural & Behavioral
        repetition / Novelty / Initiative。**Narrative Critic 与 Slow 模型评价归 P5**(#10)。
        实现顺序按 evaluation-engine-spec §7：Evaluation Core → Text/Behavior Extractor →
        Agency → Knowledge → Repetition → Character Consistency → Emotion → Novelty →
        Initiative → Aggregator → Decision → Inspector → Replay
        (Narrative 归 P5)。资源有限时优先 **Agency + Repetition + Character Consistency**
        (对 RP 体验收益最高)。
R-P4-10 P4 明确不做(防范围膨胀)：
        · RP Deep 档(LLM Director/Critic/Quality Gate/Benchmark/Inspector)——归 P5;
        · Plugin SDK / Tauri 桌面化 / i18n / Skill 对齐 agentskills.io——归 P5;
        · Simulation Agent(LLM 世界推演)——P5 决策点(#19,凭 P4 规则版实测决定);
        · 工程性能预算三档——未排期(#12b);
        · Plugin 信任分档 / 开源发布套件 / 升级备份回滚——P5/用户触发。
```

# 4. S29 — WP4.1 memory-runtime-spec 骨架 + memory 持久化底座（1 会话）

**目标**：先落 spec 再写码（纪律 3），把四层记忆的数据形状 / 检索语义 / Scribe 写入语义钉死，为 S30/S31 扫清前置。

**任务清单**：

```text
1. 落盘 docs/specs/memory-runtime-spec.md 骨架：
   · 四层记忆（Summary / Dossier / Timeline / Data Bank-RAG）的职责边界与数据形状
     （总设计 §25；database-schema §23/§25/§26 为表结构真相源,本 spec 只写"怎么用"）
   · 双检索语义：FTS5 关键词兜底 + sqlite-vec 语义（§25.1 已有建表/触发器骨架,引用即可）
   · Scribe Agent 写入语义（总设计 §25：读新剧情 → 发现事实 → 更 Dossier → 追加 Timeline；
     Scribe 不直接改原始聊天记录）
   · 检索结果 → PromptContribution 的 zone 约束（tail 注入,不进稳定前缀,R4/C2 延续）
   · 事件域：memory.* 逐条登记 technical-design §5.4 并声明 durability 分档（X13）
2. migration v10：summary_blocks / memories(+embedding) / memories_fts / memory_versions /
   timeline_events / documents / chunks / chunks_fts
   （database-schema §23/§25/§25.1/§26 为准；timeline_events 与 Data Bank 两表 spec 未
     完整定义的,先落 spec §31 补齐再进 migration——与 S22 同工法）
3. `packages/runtime/src/memory/` 持久化层（Repository 接口 + SQLite 实现 + 双触发器）
4. 单测：migration 可重入 / FTS5 触发器写入与软删清理 / 双检索接口形状
```

**验收**：migration 可重入 + spec 头部版本行与修订说明齐全 + 双检索接口有类型契约。
**spec 锚点**：总设计 §25 / §41.1；database-schema §23/§25/§25.1/§26；agent-runtime-spec §155（memory provenance）。
**还账**：勾销 #8（memory-runtime-spec 骨架）。

# 5. S30 — WP4.2a Summary 链 + 四层记忆 + 双检索（1–2 会话）

**任务清单**：

```text
1. Summary 链(database-schema §24 Checkpoint 语义)：from_message_id..to_message_id
   冻结块,sequence 单调;追加式(新 block 追加,旧块 frozen 永不回写);
   summary 区位置按 compiler-spec §10
2. 四层记忆 Runtime:memories CRUD + type='fact' 承载 Dossier 实体维度 + entity 列;
   timeline_events 追加式;Data Bank(documents/chunks) 分块入表
3. 双检索:FTS5 关键词兜底(unicode61 + prefix 3 4) + sqlite-vec 语义检索(embedding BLOB);
   Repository 层封装 FTS5,不扩散进 Core 纯函数包(database-schema §70 可移植纪律)
4. 检索结果经 Context Policy 注 tail(不进稳定前缀,C2/R4);
   agent/src/memory/ 的 Memory Policy 空实现替换为真实实现(R-P3-9 兑现)
5. 单测:冻结块不可变 / 双检索命中与合并 / tail 注入与稳定前缀零干扰
```

**验收**：FTS5/sqlite-vec 两路都能命中且合并去重正确 + Summary 追加不破坏稳定前缀（P2 门禁保绿）。
**spec 锚点**：总设计 §25 / compiler-spec §10（summary 区）/ technical-design §0 铁律 5。
**S30 完成注记（2026-09-27）**：任务 1–5 全部 ✅——Summary 链（appendSummaryBlock 冻结块 sequence 单调 + listSummaryChain + buildSummaryContributions）+ 四层 Memory Runtime（memories CRUD/entity 约束 + timeline 读取 + Data Bank 分块入表 + chunks_fts 检索）+ 双检索（FTS5 关键词 + embedding 余弦 + 合并去重）+ Context Policy tail 注入（resolveMemoryPolicy 四策略 + runAgent memoryRetrieval 接线 + filterContributions 消费修复）+ 单测（冻结块不可变 / 双检索合并 / tail 与稳定前缀零干扰）。验收达成：全仓 534/59 全绿 + P2 门禁保绿（100 轮稳定前缀/KPI 98.7%）。memory-runtime-spec 升 V0.2。

# 6. S31 — WP4.2b Scribe Agent + Memory HTTP 面 + 还账 #8 勾销（1 会话）

> **✅ 已完成（2026-09-28）**。实现注：
> - **Scribe Agent**：`runScribe`（`packages/agent/src/memory/scribe.ts`）——影子会话 `scribe:<chatId>` 隔离（目标 chat 消息树零变化，契约测试直证），三 memory 工具（`memory.upsert_dossier`/`memory.append_timeline`/`memory.append_summary`）经 ToolRegistry 落 `tool_calls` 行 + durable 事件；Agent 定义 `type:'custom'` + `metadata.role:'scribe'` + 固定名 `__builtin_scribe`（**不新增 AGENT_TYPES 公共枚举**，决策协议 b）；runtimePolicy `maxTurns:4/maxToolCalls:12/maxExecutionTimeMs:300_000`（AgentBudget §39）。契约测试 `scribe.test.ts` 3 条（读剧情→三写入 + 原聊天树零变化 + 落库投影 / 空链 skipped）。
> - **Memory HTTP 面**：api-spec **V2.7** §88–§92 + §155 九路由全落地（`memory/search`（FTS ∪ 中文 LIKE 兜底）、summaries GET/POST、dossier GET/POST entities/PATCH、timeline GET/POST、`memory/scribe` 触发 202 长任务）；契约测试 `memory-api.test.ts` 7 条全绿。
> - **web 面板**：`MemoryPanel.tsx`（摘要链 / Dossier 卡 / Timeline / 检索测试 / ▶ Scribe）+ client.ts 8 方法 + App 接线。
> - **还账 #8 全勾销**：S29 落 spec（memory-runtime-spec V0.1）+ S31 兑现 Memory Runtime 接口（memory-runtime-spec V0.3 Implemented）——见 implementation-plan §10。
> - **门禁**：全量 **544/544 测试（61 文件）**、typecheck 全包 0、ESLint 0、P2 缓存门禁保绿。

**任务清单**：

```text
1. Scribe Agent(roleplay-runtime-spec §20/§25)：读取新剧情 → 发现重要事实 → 更新 Dossier →
   追加 Timeline;不直接修改原始聊天记录(原始消息永久保留);受 AgentBudget 约束(§39)   ✅
2. Memory HTTP 面(api-spec §155)：
   GET/POST /chats/:id/summaries / GET /chats/:id/dossier / GET /chats/:id/timeline /
   POST /chats/:id/memory/search                                            ✅(+entities PATCH / scribe 触发)
3. web 记忆管理面板(ui-design §4)：摘要链 / Dossier 浏览 / Timeline / 检索测试    ✅
4. 契约测试:§155 路由 + DTO 对齐                                                ✅(7 条)
```

**验收**：Memory HTTP 面契约测试绿 + Scribe 写入经 tool_calls / artifacts 落账。→ **✅ 达成**（memory-api.test.ts 7/7；scribe.test.ts 断言 tool_calls 三工具成功行 + memories/timeline_events/summary_blocks 行 + 原聊天树零变化）。
**还账**：勾销 #8（memory-runtime-spec 骨架——S29 落 spec,S31 兑现 Memory Runtime 接口）。→ **✅ 勾销**。

# 7. S32 — WP4.3 网络搜索工具（1 会话）

> **✅ 已完成（2026-09-28）**。实现注：
> - **网络搜索工具**：`packages/agent/src/tools/web-search.ts` —— `web.search`(wire 名点号命名空间，
>   与 `memory.*` 同规)经 **ToolRegistry 五段流水线**执行(不另起并行抽象)：落 `tool_calls` 行 +
>   `tool.call.started/completed/failed/denied` durable 四件套(S24 面复用)。`permissions: ['network.request']`
>   (§33 权限目录既有项)、`sideEffectLevel: 'none'`(§50：只读 → §47 C3 瞬时重试生效)。
> - **§89 网络沙箱 = 结构性而非尽力而为**：出站目标只能是注入配置里那**一个** endpoint
>   (入参**没有** URL 字段，模型无法指定目标)；per-Run 外发次数封顶(`maxOutboundRequests`，超限
>   `RUN_BUDGET_EXCEEDED` fail-closed)；**未配置 endpoint = 确定性 `TOOL_FAILED`**，
>   绝不返回空结果/伪造结果——"没连上"与"网上查不到"必须对模型可区分。
> - **tail 注入 + origin 溯源**：工具**不碰 zone**。`toolCallId` 随消息元数据落库
>   (`messages.metadata`，`CreateMessageInput.metadata` 新增，缺省 `'{}'` 零回归)，
>   编译期 `buildContributions` 升格为 `source.type='toolResult'` + `toolCallId` 并注 **tail**。
>   **精确口径 = 末尾连续输入段**：只把链尾连续的 `role ∈ {user, tool}` 注 tail
>   (`runtime/generation/run.ts` `trailingInputStart`)，其余回落 history——因为 pipeline 排序是
>   **zone-first**，把中间轮次的 tool 结果也挪进 tail 会让 `[u,a1,t1,a2,t2]` 序列化成
>   `[u,a1,a2,t1,t2]`，tool 结果与其调用错位 → provider 协议报错。
>   `tail` 默认稳定性 `volatile`(§16) 且居 §15.1 裁剪序首位 → 既不进稳定前缀也不挤占稳定区预算。
> - **结果缓存与去重**：同 query 短窗内**不重复外发**(按 query 归一键 + 窗口 TTL，含全部限定条件
>   防"同词不同站点"错误合并)；**同批并发同 query 共享在飞请求**(否则一批两个相同调用仍打两次网络)；
>   在飞项亦受窗口约束——后端挂起时该键不会永久钉死后续同 query(§46 超时只包在 execute 外层，
>   中断不了被共享的 Promise)。去重缓存/在飞表**跨 Run 共享**，外发预算**按 runId 隔离**(§39 预算是 Run 级资源)。
> - **审批：默认 auto-approve 但走 §115.1 管线不绕过**：三件同批装配——①工具注册；
>   ②`ToolRegistry.requireApproval(name)` **静态审批门**(与 pre-execute 的动态 `ask` 取或)；
>   ③`createAutoApprover(APPROVAL_GATED_TOOLS)` 作**默认回答者**。审批侧新增**回答者链**
>   (per-chat → default → `unavailable`)：弃权可下探，抛异常/枚举外**当场 fail-closed 不下探**
>   (否则一次 UI 崩溃会静默滑到自动批准器上 = 用故障换放行)。自动批准器只放行白名单内**且**
>   权限全落在只读集合里的工具——白名单人工维护、权限由工具声明，用后者约束前者，
>   保证"往白名单里加错工具"的后果只是**拒绝**而非**越权**；判据不含 `risk`。
>   `policy='never'` 仍在链之前生效，自动批准无法越过。
> - **单测 19 条**(`web-search.test.ts`)，逐条对上任务清单 5 项：未配置 fail-closed / 同 query 短窗去重
>   (第二次 `deduped=true` 且零新外发) / 并发同 query 共享在飞 / 超窗重新外发 / 外发预算超限
>   `RUN_BUDGET_EXCEEDED` / **预算按 Run 隔离** / **审批四值+审计成对**(allowed_once、unavailable、
>   rejected(policy=never)、白名单外弃权) / 白名单内带写权限工具**仍被弃权**(不提权) /
>   链序不封死人工路径(per-chat 回答者优先) / **结果注 tail 且 source.type=toolResult + toolCallId 可追回** /
>   历史 tool 结果回落 history(只末尾段注 tail) / §46 超时 `status='timeout'` / 形状不识别 → `TOOL_FAILED` /
>   空 query → `INVALID_INPUT` 且不外发 / 429·5xx 归一为可重试瞬时码、4xx 为确定性失败 / wire 投影与只读声明。
> - **组合根 / `GET /tools` 读面**：`ServerDeps.webSearch`(端点/凭据/传输注入) + `server.ts` 组合根三件装配 +
>   `main.ts` 读 `DG_WEB_SEARCH_ENDPOINT`/`DG_WEB_SEARCH_API_KEY`。**未配置也照常注册**：
>   注册面必须与部署环境无关，配置差异收敛到工具**执行**里，结构面保持恒定。
>   **api-spec 不动**(无新路由)：§154 `GET /tools` 的契约是"返回当前已注册工具"，注册面变化
>   不构成契约变更——但既有测试把它当基线断言，故 `agent-api.test.ts` 的两处期望值按新注册面更新
>   (+`web.search`，并新增 `?capability=network.request` 断言)。
> - **门禁**：全量 **565/565 测试(62 文件)**、typecheck 全包 0、ESLint **0 error 0 warning**、
>   **P2 缓存门禁保绿**(100 轮稳定前缀 / KPI 98.7% 不变)。`GET /tools` 基线按新注册面更新(+`web.search`)。
> - **新增架构守卫 D6/D7**(AGENTS 纪律 7：纪律必须有机器卡点)——D6 断言自动批准只读白名单
>   是 §33 权限目录的真子集且不含写类/提权类(**跨文件双向比对**：types.ts 的目录 vs approval.ts
>   的集合，任一侧单独改都不红、两侧不一致才红)；D7 断言组合根三件同批装配(防"少装一行"——注册了
>   工具却漏 `requireApproval` 或漏默认回答者，在类型检查与单测里都是静默的，因为单测自己会装齐)。
>   **两条都用负例实测能真变红**：白名单塞 `filesystem.write` → D6 报 privileged；拼错成
>   `memory.readd` → D6 报 unknown。

**任务清单**：

```text
1. 网络搜索工具(Web Search)作为 agent 工具注册(tool registry 五段流水线):
   结果注 tail(origin 溯源,不进稳定前缀,R4)                                        ✅
2. 搜索结果 ToolCall 落 tool_calls 表 + tool.call.* 事件四件套(S24 面复用)          ✅
3. 结果缓存与去重:同一 query 短窗内不重复外发(HTTP 层去重;超出预算 fail-closed)      ✅(+并发在飞去重)
4. 审批策略:默认 auto-approve(低风险,只读外网)但走 §115.1 审批管线不绕过             ✅(+回答者链)
5. 单测:审批四值 / 超时 / 预算 / tail 注入 / origin 溯源                          ✅(19 条)
```

**验收**：工具注册 + 审批 + 沙箱预算 + 结果注 tail 全链路绿；不破坏 P2 缓存门禁。→ **✅ 达成**（web-search.test.ts 19/19；全量 565/565；缓存门禁 100 轮稳定前缀 + KPI 98.7% 原样保绿）。
**spec 锚点**：agent-runtime-spec §31–§36（Tool Runtime 复用）；总设计 §15（tail 注入）。→ **已同步**：agent-runtime-spec 升 V2.3（§115.1 回答者链 + `createAutoApprover` 边界 + `requireApproval` 静态门；§89 network 限制落地口径与去重规则；§155 登记 toolResult 缺口并维持五源不变）；prompt-compiler-spec 升 V2.6（§86 "默认进 tail"精确口径 = 末尾连续输入段 + zone-first 排序为何要求连续性）。

# 8. S33 — WP4.4 群聊 + per-char 缓存命名空间（1–2 会话）

**⚠️ 原任务清单前提失实（本会话侦察发现并修订）**：原清单第 1/3 条假设"per-(chat, character) 命名空间可直接建起来"，但实测发现——契约 `SegmentSourceSchema` 自 P0 起就声明了 `{ type:'character', assetId, field }`（`core/serializer/diff.ts` 亦早已把它映射成 `CHARACTER_CHANGED` 缓存破裂因），**但全仓没有任何生产者**；`characters.description/personality/scenario` 三列同样**零消费者**（只有 `variables.ts` 读 `name` 供 `{{char}}`）；且 10 个真实预设 fixture 里 `charDescription`/`charPersonality`/`personaDescription` 全是 `content:""` 的**空壳标记**。

**后果**：每个角色产出的 header 逐字节相同 —— 命名空间即便建起来也是**空转**（§26 要求的"多角色各自前缀"根本不存在），3 角色群聊 50 轮会全绿却什么都没证明，且三个角色会给出完全相同的回复。

**故拆为两段**（作者本会话裁可）：

```text
S33a（本会话，已完成）—— 修前提：角色身份真的进 prompt + 命名空间键落地
1. ✅ character.ts：全仓第一个 `{type:'character',assetId,field}` 生产者
   —— slot 填充（charDescription/charPersonality **原地**替换，位置不动，§81 顺序即语义序）
   + 独立 header 贡献（段 ID `character:<id>:<field>`，§9 稳定 ID）
   （只填这两个槽：worldInfo*/chatHistory/personaDescription 归各自生产者，防双注入）
2. ✅ migration v11：prompt_snapshots.character_id + 复合索引 (chat_id, character_id, created_at)
   （不建独立 chatCache 哈希表——S17 三次修订已裁决；cache_runtime_states 保持未迁移）
3. ✅ chats.character_id 写入路径（POST/PATCH + CHARACTER_NOT_FOUND 404 + null 解绑）
4. ✅ 命名空间感知前驱：cache-break 按 (chat, character) 取前驱（sameNamespaceCondition，
   NULL 安全——`x = NULL` 恒 UNKNOWN 会让未绑定 chat 静默退化）
5. ✅ buildCacheTelemetry 按命名空间分链（各链 round 各自从 1 起）+ §41 characterId 过滤面
6. ✅ 验收：6 条测试（slot 填充 / 未绑定零漂移 / 命名空间分组 / 双角色 header 分歧 /
   绑定 API / 遥测分链）+ 4 个负例探针确认真能变红；
   全量 571 测试 / 63 文件绿，typecheck 9 包 0，ESLint 0，P2 门禁 100 轮 + KPI 98.7% 原样保绿

S33b（下一会话）—— 群聊本体
1. migration v12:chat_members(chat_id, character_id, joined_at, settings) + 索引
2. 群聊 Agent Runtime:Director → Character Agent A/B/C(总设计 §26;agent-runtime-spec §76/§77)
   ST 原生 NATURAL/LIST/MANUAL/POOLED 策略为子集(st-reference-analysis §5)
   —— Director 用启发式（零额外模型调用，R1/C1/R-P3-2）；character.ts 输入从
   "chat 单值绑定"换成"chat 成员集"（段身份口径不变）；snapshotCharacterId 收 override 参数
3. Turn Selection:由群聊 Director 决定谁去 + Roleplay 决定该角色怎么做(R2 分界,
   roleplay-runtime-spec §36;S33 只做 Director 路径,RP 状态归 S34)
4. 群聊 UI:群聊控制台 + per-character 链温度显示(ui-design §4.6+)
   —— 遥测 characterId 过滤面已在 S33a 就位，UI 直接消费
5. 验收:3 角色群聊 50 轮缓存行为符合预期(§36 P4 DoD ②)
```

**验收**：3 角色群聊 50 轮缓存行为符合预期（per-(chat,character) 命名空间按成员正确分链）。
**spec 锚点**：总设计 §26；worldbook-cache-design §6；agent-runtime-spec §76/§77；roleplay-runtime-spec §36。
**S33a 已同步 spec**：api-spec 升 **2.8**（§41 `characterId` query + `CacheRoundMetric.characterId` 投影、§43 体字段同口径、§8 补 `CHARACTER_NOT_FOUND`）。

# 9. S34 — WP4.5a Roleplay Runtime 持久化 + 状态机（1–2 会话）

**任务清单**：

```text
1. migration v12:roleplay_states / story_threads / roleplay_snapshots /
   relationship_states / character_state_events（database-schema §29.1–29.5 为准）
2. `packages/agent/src/roleplay/` 落 Roleplay Runtime 核心模块（决策 45 依赖方向:
   agent 承载编排,Roleplay Runtime 参与 Agent Run 步骤,不反向调 Compiler）：
   · CharacterRuntimeState 存取(roleplay_states,UNIQUE(chat,agent))
   · EmotionalState 惯性转移:previous + eventImpact × transitionSpeed(spec §8)
   · RelationshipState 边模型 8 维 + 渐进变化(§9;群聊关系图 A↔B/A↔User/B↔C)
   · StoryThread open/dormant/resolved + revisit_probability(§14)
   · CharacterTendency 加权选择 Score = Base × TriggerMatch × EmotionalFit ×
     RelationshipFit × ContextFit × CooldownFactor(§11,非 if-trigger)
3. character_state_events 事件溯源(§29.5):patch + prev/next version;
   roleplay_snapshots 落 decision_trace + state_hash(§26 规范化 JSON 哈希,X14)
4. roleplay.* 事件域逐条登记 §5.4(§33:durable 六条 + deferred-durable 六条,X13)
5. 验收:20+ 轮同角色情绪无源漂移 / 关系渐进可 Replay(§41 前两条)
```

**验收**：Emotion Transition 确定性（同 State+Event+Seed ⇒ 同 Decision）+ 关系边渐进 + 快照 state_hash 可校验。
**spec 锚点**：roleplay-runtime-spec §7–§14 / §26 / §33–§35；database-schema §29.1–29.5。

# 10. S35 — WP4.5b Roleplay Fast 端到端（1–2 会话）

**任务清单**：

```text
1. Dialogue Director 规则引擎(dialogue-director-spec,Rule Engine 路径):
   输入角色状态 + DialogueEvent → 输出 Behavioral Directive(方向,非台词,§2.2);
   Fast 下零额外模型调用(R1/C1);PromptContribution 落 injection/tail,不进稳定前缀
2. Directive → Prompt Compiler 接线:生成前 Directive 折叠进单次 Prompt
   (roleplay-runtime-spec §5 生命周期 resolve→apply→retrieve→directive→compile→call)
3. Quality Gate Fast(本地规则,R-P4-9):优先 Agency + Repetition + Character Consistency;
   阻断只限 Agency/Knowledge Violation + Severe Drift/OOC/重复(quality-spec §默认阻断集);
   RegenerationAdjustment + 最大 Retry 0–1(§29 预算)
4. RP Inspector v1(roleplay-runtime-spec §32):Emotion/Relationship/Intent/Behavior/
   Initiative/Repetition/Directive 分层视图 + 可跳转 PromptSnapshot
5. 验收(§36 P4 DoD ③ + §41):RP Fast 档每轮恰 1 次调用且稳定前缀不变;
   30+ 轮反重复;不越界(AgencyPolicy);P2 缓存门禁保绿
```

**验收**：§36 P4 DoD ③（每轮恰 1 次调用 + 稳定前缀不变）+ roleplay-quality-spec Fast 本地规则全绿。
**spec 锚点**：dialogue-director-spec（Rule Engine）；roleplay-quality-spec；roleplay-evaluation-engine-spec Phase1/Phase2。

# 11. S36 — 收官：Workflow HTTP 面 + World State 规则版 + Simulation mock + UI（1–2 会话）

**任务清单**：

```text
1. Workflow HTTP 面(api-spec §155,R-P4-6):GET/POST /workflows / POST /workflows/:id/runs /
   GET /workflow-runs/:id;definition 版本钉住(§163);审批 fail-closed 四值在 HTTP 面生效
2. 默认工作流模板(P4 工作流,worldbook-cache-design §201 四轮 tool-call 模式):
   写稿→并发委派→等待期自查→patch→commit;Agent profile 声明式 schema
   (模型快照复用/工具白名单/调用与 token 预算/allowedCallers/artifact 落消息)
3. World State 规则版(还账 #18):地点/时间/物品/任务/派系/知识补表 + 规则化推演;
   **禁额外 LLM 调用**(R1/C1);先落 roleplay-runtime-spec 扩展章节 + database-schema
   补表再写码(纪律 3);SKILL.state 背书(#21)纳入 #18 细化——只作用于 agent/工具执行
   子路径,不适用于 RP 聊天历史
4. Simulation mock 面(P3 挂账,R-P4-7):Fake Time/Random/Model(roleplay-runtime-spec §35);
   服务 Cache Simulator / Benchmark / Regression
5. Workflow UI(ui-design §4.7):DAG 面板——串行段横向排布,**并行节点必须分泳道**
   (不许压成单线,P4 返工警告);工作流面板 + 记忆管理面板收尾
6. P4 出场登记:§36 P4 行 DoD 三条核验 + §38 决策 + implementation-plan §12 看板 +
   AGENTS 当前状态更新 + 本文件归档
```

**验收**：§155 路由契约测试绿 + World State 表落地（规则版零 LLM 调用）+ DoD 三条全过。
**还账**：#18 World State 规则版勾销；#19（Simulation Agent）转入 P5 决策点留 P4 实测数据。

# 12. 横切纪律（延续 p3-plan X12–X15,P4 全程有效）

```text
X12 Agent/Roleplay 不得绕过 Compiler:RP Directive / Memory 检索结果全部经
    PromptContribution 进 compile,无直拼 Prompt 路径。
X13 新事件域先登记 technical-design §5.4 并声明 durability(memory.* / roleplay.* 全量),
    架构守卫 A 组会红;不许代码先造名后补表。
X14 确定性到逐字节:RP Emotion/Relationship/Tendency 推导必须固定 now/种子
    (roleplay_snapshots.random_seed);"跑得起来"不算验收,同 State+Event+Seed
    ⇒ 同 Decision 才算(X14 延续,S27 Replay 纪律在 RP 侧同样适用)。
X15 新子 Agent 必须申报调用数与前缀共享(Scribe Agent / 群聊 Character Agent 逐个申报);
    RP Fast 缺省单调用,任何"每轮 N 次调用"的新路径必须显式 Balanced/Deep 档。
X16 sqlite-vec / FTS5 只由 Repository 层封装(§70 可移植纪律):不进 Core 纯函数包、
    不进 Compiler、不进 contracts。
X17 金样纪律延续:P4 新增 RP/记忆面若触及 serialized.parts 语义,金样基线必须同步
    (跨进程只锁 serialized.parts,不锁 hash/id)。
```

# 13. 出场验收与挂账

```text
出场(总设计 §36 P4 行)：
  ① 300+ 楼长对话对照基线（P2 模式）质量与成本可测提升
  ② 3 角色群聊 50 轮缓存行为符合预期
  ③ RP Fast 档每轮恰 1 次调用且稳定前缀不变
收尾：P4 出场登记 §38 决策；implementation-plan §12 看板更新；AGENTS 当前状态更新；
     p4-plan 归档为执行记录。

本阶段勾销的挂账(implementation-plan §10)：
  #8  memory-runtime-spec 骨架 → S29(spec)+S31(Runtime 接口)
  #18 World State 全局态(规则版) → S36
  #21 SKILL.state 背书引入判定 → S36(#18 细化时;量化结果待补则只记背书不记判定)
明确不在本阶段(不勾销、留后续)：
  #10 evaluation-engine-spec 充实 → P5(Narrative Critic/Slow 模型)
  #19 Simulation Agent → P5 决策点(凭 P4 规则版实测数据)
  #12b 工程性能预算三档 → 未排期
  #13 升级/备份/回滚 / #14 开源套件 / #16 Plugin 信任分档 → P5/用户触发
P3 转正挂账的 P4 归属：
  Workflow HTTP 面 → S36;Simulation mock 面 → S36;Memory Runtime → S29–S31;
  PV8 wire 翻译 → 随真实 API 实测(R-P4-8);Retry Agent 自动编排 / 轮内 provider
  中断粒度 → P4 后半视进度,未排死(P5 兜底)。
```

# 14. P4 看板

| 会话 | WP | 状态 | 恢复点注记 |
|---|---|---|---|
| S29 | WP4.1 | ✅ 完成 | 测试全绿闭环:runtime 15 条(migrate 7 / repository 8)+ 全仓 517/57 全绿 + typecheck 全部 0 + ESLint 0;catalog.test.ts 域白名单补 memory(守卫漂移);migrate.test.ts 三处变量类型泄漏 + repository spread 类型修复;**环境关键发现:better-sqlite3(ABI 127)用 node 22 跑,系统 node 24 会 ABI 不匹配——本机埋点 `D:\BaiduNetdiskDownload\muyootools-v1.0.1\node`(v22.14.0),AGENTS 七版"用 node 24"过时,以 technical-plan §8.7 教训①为准 |
| S30 | WP4.2a | ✅ 完成 | 测试全绿闭环:runtime memory 全套(repository 14 + summary-contributions 3)+ agent memory/policy 6 + context-policy 14 + **全仓 534/59 全绿** + typecheck 全部 0 + ESLint 0 + P2 缓存门禁保绿(100 轮稳定前缀/KPI 98.7%);交付:四层 Memory Runtime(CRUD+timeline 读取+Data Bank 分块入表)+ Summary 链(appendSummaryBlock 冻结块 sequence 单调 + buildSummaryContributions 注 summary 区)+ chunks_fts 关键词检索 + agent Memory Policy 兑现(R-P3-9,resolveMemoryPolicy 四策略 + tail 注入)+ runAgent memoryRetrieval 接线;**顺带修复 S26 缺口:prepareIteration.filterContributions 此前已声明但从未被消费,现于 compile 前应用**;memory-runtime-spec 升 V0.2(锚点转已实现契约) |
| S31 | WP4.2b | ☑ 完成 | 测试全绿闭环:**全仓 544/61 全绿**(S30 534 起 +10:runtime search 3 / agent scribe 3 / server memory-api 7 + agent-api 工具断言重编 -13...) + typecheck 全部 0 + ESLint 0 + P2 缓存门禁保绿(100 轮);交付:Scribe Agent(runScribe 影子会话隔离 + 三 memory 工具落账)+ Memory HTTP 面(api-spec V2.7 §88–§92/§155 九路由:search/search 中文 LIKE 兜底/summaries/dossier entities PATCH/timeline/scribe 202)+ MemoryHit 行级投影(时间戳/version/sourceMessageIds)+ web MemoryPanel;还账 #8 勾销;顺带修复 runtime timeline rowid 平局序(X14 确定性) |
| S32 | WP4.3 | ☑ 完成 | 测试全绿闭环:**全仓 565/62 全绿**(S31 544 起 +21:web-search.test.ts 19 条 + 架构守卫 D6/D7)+ typecheck 全部 0 + ESLint 0(**0 error 0 warning**)+ P2 缓存门禁保绿(100 轮稳定前缀 / KPI 98.7% 原样);交付:`web.search` 工具(tool_calls 行 + `tool.call.*` 四件套、§89 结构性网络沙箱:出站目标唯一/外发次数封顶/未配置即 fail-closed、短窗 query 去重 + 并发在飞去重 + 预算按 Run 隔离)+ 审批回答者链(per-chat → default → unavailable;弃权可下探、抛异常/枚举外当场 fail-closed)+ `createAutoApprover`(白名单 ∩ 只读权限双重守门,判据不含 risk)+ `requireApproval` 静态审批门 + **结果注 tail + origin 溯源全链路**(`CreateMessageInput.metadata` → tool 结果消息 `toolCallId` → `buildContributions` 升格 `source.type='toolResult'`;精确口径 = **末尾连续输入段**,因 pipeline zone-first 排序要求连续性)+ `context/policy.ts` toolResult 同时过 History 与 ToolResultPolicy 双门 + server 组合根三件装配 + `DG_WEB_SEARCH_ENDPOINT/API_KEY`;spec 同步:agent-runtime-spec V2.3(§115.1/§89/§155)、prompt-compiler-spec V2.6(§86) |
| S33a | WP4.4a | ☑ 完成 | 测试全绿闭环:**全仓 571/63 全绿**(S32 565 起 +6:character-namespace.test.ts)+ typecheck 全 9 包 0 + ESLint 0 error 0 warning + **P2 缓存门禁保绿**(100 轮稳定前缀 / KPI 98.7%/98.7% 与反面对照 28.2% **原样不变**——零基线漂移得证)+ 架构守卫 17/17;交付:`generation/character.ts`(全仓第一个 `{type:'character'}` 生产者,兼供槽位填充表 + 角色贡献两面)+ **slot 原地填充**(preset.ts 收 `slotContents`,命中则原地换 content,段 id/role/placement/**prompt_order 一概不动**——§81「顺序即语义序」;正白名单仅 `{charDescription→description, charPersonality→personality}`,防双注入)+ **migration v11** `prompt_snapshots.character_id` + 复合索引(不落 cache_runtime_states——S17 三次修订裁决 + 快照表是缓存链唯一真相源)+ `chats.character_id` HTTP 写入路径(POST/PATCH + `CHARACTER_NOT_FOUND` 404)+ **命名空间感知前驱**(`sameNamespaceCondition` **NULL 安全**——SQL `x = NULL` 恒 UNKNOWN,误用 `eq(col,null)` 让未绑定 chat 每轮静默退化"首轮",不报错只降智)+ **遥测分链**(此前全 run 压平铺序列致角色 B 首轮被当角色 A 延续轮 → 理论承接基数错位/CacheBreak 虚假/Simulator 恒不命中;现各链 round 各自从 1 起 + 轮带 `characterId` 投影 + §41 `characterId` 查询面);4 个负例探针逐一确认真能变红(禁用 slot 填充→①红 / chat-only 前驱→③红 / `eq(col,null)`→⑤红 / 禁用遥测过滤→⑥红);spec 同步:api-spec **V2.8**、prompt-compiler-spec **V2.7**、database-schema + §15 群聊预留修订。**原 S33 前提失实**已在 §8 整节实录 |
| S33b | WP4.4b | ☐ | 群聊本体(下一会话):`chat_members`(migration v12)+ Director 启发式选人(零额外模型调用)+ `character.ts` 输入从单值 chat 绑定切到成员集 + `snapshotCharacterId` 覆盖参数 + 3 角色 50 轮缓存门禁 + 群聊 UI + per-character 链温度显示 |
| S34 | WP4.5a | ☐ | |
| S35 | WP4.5b | ☐ | |
| S36 | 收官 | ☐ | |

---

*关联文档：[implementation-plan.md](./implementation-plan.md) §8/§10/§12 · 总设计 §36 / §25 / §26 / §5.4 · [roleplay-runtime-spec.md](./specs/roleplay-runtime-spec.md) 及其三子规格 · [database-schema.md](./specs/database-schema.md) §23/§25/§26/§29.1–29.5 · [api-spec.md](./specs/api-spec.md) §155 · [worldbook-cache-design.md](./worldbook-cache-design.md) §6 · [p3-plan.md](./p3-plan.md)（已归档）· [p2-plan.md](./p2-plan.md)（待真实 API 出场）· [p1-plan.md](./p1-plan.md) / [p0-plan.md](./p0-plan.md)（已归档）*
