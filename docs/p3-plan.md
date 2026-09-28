# WhisperTavern V2 — P3 实施明细计划（Agent Runtime · 第二大差异化）

> **文件:** `docs/p3-plan.md`
> **版本:** V1.2（2026-09-27：**S28/WP3.6 收官完成 → P3 出场**——§13 看板 S28 ✅ 并登记挂账（Retry Agent 自动编排 / 轮内 provider 中断粒度 / Simulation mock / Memory Runtime / PV8 wire 翻译），§38 决策 46 落总设计，implementation-plan §12 WP3.1b–WP3.6 全部 ✅；本文件归档为执行记录。V1.1（2026-09-26：**S22/WP3.1a 完成**——§4 补落地实录（`tools` 表不在 spec 的处置、`agent_versions` 补建、runs 执行列扩展）、§13 看板 S22 ✅ 并登记两项遗留给 S23。V1.0 骨架，2026-09-26）
> **状态:** ✅ **已归档为执行记录（2026-09-27，P3 出场）**——P3 全部会话 S22–S28 完成，阶段目标（§173 七组 + §174 十场景）达成；后续按 P4 细化计划 + roleplay-runtime-spec 家族继续
> **文档层级:** [implementation-plan.md](./implementation-plan.md) §7（P3 WP 概览）的**会话级执行明细**。设计语义一律指向 spec，本文只管"会话里具体干什么"。
> **上游锚点:** 总设计 §36（P3 行）/ implementation-plan §7·§10 / [agent-runtime-spec.md](./specs/agent-runtime-spec.md) §4·§36·§115·§173·§174 / [database-schema.md](./specs/database-schema.md) §34.1–34.3·§33·§35·§36 / [api-spec.md](./specs/api-spec.md) §154 / [provider-adapter-spec.md](./specs/provider-adapter-spec.md) §11·§23 开放点 3 / §38 决策 13·17·18·21·22·24·36 / p2-plan（已收口）AGENTS 会话纪律。

---

# 1. P3 会话切分总览

```text
S22 WP3.1a 持久化底座:执行四层独立表 + 统一 ExecutionStatus + 事件 durability 全量      1–2 会话
S23 WP3.1b Agent 运行时:Definition/Type/Instance/State 机 + Lifecycle + Snapshot 强制    1–2 会话
S24 WP3.2  Tool Runtime + 审批 fail-closed + 权限/沙箱 + reasoning 签名回传            1–2 会话
S25 WP3.3  Workflow DAG(节点/边/并行/Join/条件/Loop/Cycle) + Director 三路径           1–2 会话
S26 WP3.4  Context Policy 族 + Artifact 冻结/提升 + Output Commit + Prompt 重编译      1 会话
S27 WP3.5  Resume / Crash Recovery / Deterministic Replay + §174 十个必测场景            1–2 会话
S28 收官   Agent Tree 递归护栏(还账 #17) + §154 API 面 + 观测 + CI 门禁扩展 + 出场登记    1 会话
```

合计约 7–12 会话。**P3 出场 = 通过 agent-runtime-spec §173 七组验收标准 + §174 全部 10 个必测场景**（总设计 §36）——单/多 Agent 的 Delegate / Await / Cancel / Resume / 崩溃恢复全部可用。

每个会话以可验证状态收尾：测试绿或看板标注中间态 + 日记留恢复点（AGENTS §4）。

# 2. 入场条件与首个会话必须先决的事

## 2.1 入场条件核对

```text
✅ P1 出场（§38 决策 38）
✅ P2 六个 WP 全收口（S16–S21；§38 决策 44）——CI 侧达标（两道硬门禁绿 + typecheck 全包 0 + 全量 404 测试绿）
☐ P2 真实 API 实测（§36 出场条件之一；tests/smoke/real-provider-smoke.mjs 需作者自有 key）
   → 与技术工作无依赖，**不阻塞 P3 开工**；但作者方便时需跑一次勾销，否则 P2 出场状态悬空（已登记 §38 决策 44）
```

## 2.2 Agent Runtime 落点与依赖方向（**已裁决：方案 A**，2026-09-26 作者拍板；§38 决策 45）

`packages/agent` 自 P0 起就是空壳（`src/{runtime,tools,skills,workflow,artifacts,memory}/.gitkeep`），但**依赖方向与职责边界从未定过**——它决定后面每一个会话把代码写在哪，必须在 S22 第一件事定下来。

```text
方案 A(推荐):两层分工 —— packages/agent 承载 Agent/Workflow/Tool 编排
  · runtime 保留"单次生成"原语(startRun 的 snapshot + provider + 事件 + 落库)
  · agent 在其之上做执行循环(§103)/工具循环/Workflow/审批/恢复
  · 依赖方向:agent → runtime → core → contracts(无环,与 architecture 守卫 B 组一致)
  · 优点:分层清晰,Agent 不污染生成路径;P4 的 memory/workflow API 天然落在 agent 侧
  · 代价:agent 需要 runtime 导出更细的原语(可能要补 1–2 个导出,不改语义)

方案 B:全部落进 packages/runtime(src/agent/)
  · 优点:零新导出,DB/事件/生成都在手边
  · 代价:runtime 变成"什么都装"的巨包;packages/agent 空壳作废(与 P0 包结构意图相悖)
```

**裁决（方案 A）落地的具体约束——S22 直接照此执行**：

```text
1. 依赖方向(硬):packages/agent → {contracts, core, runtime};runtime / core / contracts
   **不得**依赖 agent(无环)。architecture 守卫补一条 B4 哨兵断言("编排层是终点"),
   防未来有人把 Agent 逻辑塞回 runtime 或让 runtime 反向引用。
2. 代码落点(packages/agent/src/ 六个既存目录各归其位):
     runtime/    Agent Definition/Type/Instance/State/StateMachine(§5–§16)、执行循环(§103)、
                 Run Recovery(§96/§97)、Resume/Replay(§51–§58)、Context Resolution(§152–§155)
     tools/      Tool Runtime(§31–§36)+ 五段流水线(§36.1)+ 权限(§33/§34)+ 沙箱(§89)
     workflow/   Workflow Runtime(§62–§70)+ Node 族 + Scheduler(§93/§94)
     skills/     Skill Runtime(§154 的 GET /skills 面)
     artifacts/  Artifact(§71–§75)+ Frozen Artifact(§72)+ Output Commit(§74)
     memory/     Memory Policy **接口形状 + 空实现**(R-P3-9:P4 才有四层记忆表)
3. runtime 侧允许的改动:为 agent 补"更细的生成原语"导出(如快照/事件/goal 落库的复用点),
   前提 = **不改任何既有语义、不新增对 agent 的依赖**;若某原语必须改语义才能复用,
   停下来问(AGENTS §4b)。
4. packages/agent/package.json 的 dependencies 在本会话补齐(contracts / core / runtime),
   并保持"零 IO 不进 contracts"等既有纪律不变。
```

> 决策纪律留痕：A 属"补导出 + 包内抽象"、B 属"作废 P0 包结构意图"，两者都触 AGENTS §4 的"先停下来问"，故不在会话内自行拍定——已请作者裁决并落 §38 决策 45。上面的 A/B 候选记录保留，供日后回溯取舍依据。

# 3. P3 范围裁决（开工前钉死，防会话自由发挥）

```text
R-P3-1  缓存纪律对 Agent 全路径生效(延续 C2/R4 + 总设计 §0)：
        Agent 的全部动态内容(工具结果/State Patch/Workflow 阶段产物/审批记录)一律落
        injection / tail,绝不进稳定前缀;每次 Provider Request 必挂 snapshotId 且快照存在
        (§19.2 / §27 / 决策 17)。"不用 Prompt 修架构问题"红线在 P3 同等有效。
R-P3-2  单聊快速路径 = 退化为单节点 Workflow,Director 不参与(裁决 C1/决策 13/§23.2)：
        Director 只在群聊与显式开启完整工作流时介入。**Agent Tree 只能是 Balanced/Deep
        可选档**——新增任何子 Agent 必须申报"几次调用、能否共享前缀"（§38 决策 36 全局判据）。
R-P3-3  四层执行层级在 P3 切独立表(决策 18 + database-schema §34 注)：
        attempts / step_runs / execution_operations 三表 P3 新建;runs.attempt 列降为
        "聚合 attemptNo",不再承载 attempt 实体。Retry 一律新建记录(§47),Run 本体永不
        从终态改回 running(§12);用户重试 = 新建 Run + origin_run_id(C3)。
R-P3-4  reasoning 默认**不回传**;Anthropic 工具循环**强制**回传签名块(PV8 / §11 / §25)：
        签名块缓存在消息组装侧,缺签名 = API 400(INVALID_REQUEST)。开放点 3(普通多轮是否
        也回传)在 S24 联调时**以缓存指标定**,不凭感觉(provider-adapter §23 开放点 3)。
R-P3-5  审批 fail-closed 四值(P 决策 22 / §115.1)：allowed_once / rejected / cancelled /
        unavailable,只有第一种放行。**无回答者(后台 workflow / 定时任务 / 群聊跑批)默认拒绝**。
        approval.requested 与 approval.decided 成对落库且 log-only,不进模型转录。
R-P3-6  并行工具结果按 **model order** 回灌,不按完成顺序(决策 21 / §36.3)。
        这是确定性 Replay 与缓存前缀稳定性的硬前提,不是风格偏好。
R-P3-7  Workflow **引擎**在 P3(内部使用 + 测试可驱动),Workflow **HTTP 面**留 P4：
        api-spec §154(P3)只列 agents / agent-runs / tools / skills;§155(P4)才是
        workflows / workflow-runs。P3 不做用户自建 workflow 的 CRUD。
R-P3-8  换 Provider / Model 必须**派生新 Prompt Snapshot**(derivedFromSnapshotId,决策 17)：
        §129 Provider Fallback / §130 Model Switching 一律走该路径,不许绕过快照直接发请求。
R-P3-9  P3 明确不做：Memory 实装(四层记忆表/FTS5/sqlite-vec 归 P4)——
        P3 只落 Memory Policy 的**接口形状 + 空实现**;群聊运行态(§76/§77)归 P4 的 WP4.4;
        Roleplay Fast(三表/BD 规则推导)归 P4;Plugin SDK / Tauri 归 P5。
R-P3-10 Agent Tree 递归护栏**不新造模块**(纪律 5):maxDepth / maxChildren / maxTotalAgents /
        maxRuntime 进 AgentBudget(§39)+ Scheduler(§93),超限拒绝 spawn + 诊断码。
        还账 #17 的落点;spec 骨架先落再写码(纪律 3)。
```

# 4. S22 — WP3.1a 持久化底座（**已完成**，2026-09-26）

**任务清单**：

```text
1. migration v8:agents / agent_runtime_states / tools / tool_calls / artifacts /
   runtime_checkpoints / approvals / attempts / step_runs / execution_operations
   （database-schema §34.1–34.3 + §33 + §35 + §36 + §36.1 + §36.2 为准；Drizzle schema 同步）
2. 统一 ExecutionStatus（§4.3）+ ID/Sequence 规则（§4.1.2）+ 持久化不变量（§4.1.1）
3. 事件 durability 全量落地（决策 19）：§5.4 权威表新增域(agent.* / tool.call.* /
   approval.* / workflow.*)逐条声明分档,注册进 runtime EVENTS catalog
4. 恢复语义骨架：§96 Run Recovery / §97 Zombie Run 的状态流转（不含 Resume 完整实现）
5. 单测：四层写入/状态转换合法性(§11 非法转换必须拒绝)/durability 分档断言
```

**落地实录（两处与上述清单的偏差，均已在交付时核对 spec 后处置）**：

```text
① 清单里的 `tools` 表 **在 database-schema 中不存在**——全量 CREATE TABLE 扫描确认
   只有 `tool_calls`(§35),没有 tools 段。工具定义是**代码内置 + P5 插件提供**,
   §154 的 `GET /tools` 是只读列举面,不需要注册表。故 v8 **不建 tools 表**;
   若 S24 联调时确实需要持久化自定义工具,再以 spec 先行方式补(纪律 3)。
② 清单漏列 `agent_versions`(§28)——§163 版本钉住依赖它,且与 character/persona/preset
   的 `X + X_versions` 范式一致,属既有 spec 内的表。v8 一并建立。
③ 清单未提但必需的:`runs` 的 **P3 执行列扩展**(§34;P0 建表注释已写"agent 执行列
   随 P3 扩展")。14 列 ALTER 追加,`attempt` 列降为聚合 attemptNo(R-P3-3)。
```

**实际交付**：migration v8（10 张新表 + runs 十四列扩展）+ `packages/runtime/src/execution/`
（status / store / recovery 三模块）+ 事件目录 23 条新登记 + 架构守卫 B4 + 33 条新单测。

**验收**：migration 可重入（跑两遍无差异）+ 四层表写入落库 + 事件分档与 §5.4 逐条一致 + 架构守卫 A 组绿。
**spec 锚点**：agent-runtime-spec §4.1–4.6 / §11 / §96 / §97 / §161；database-schema §34.1–34.3；technical-design §5.4。

# 5. S23 — WP3.1b Agent 运行时

**任务清单**：

```text
1. Agent Definition / Agent Type / Agent Instance / Agent State（§5–§9）
2. Agent State Machine（§10）：允许与非法转换的全集 + 断言
3. Agent Execution Lifecycle（§16）+ Agent Turn 开合与空 Turn 记账（§37/§37.1）
4. Prompt Compiler 调用（§26）+ Prompt Snapshot 强制（§27）：所有 Provider Request 走
   compile(),不挂 snapshotId 的路径必须不可能存在（fake provider 入口不变量闸口守）
5. Context Resolution Pipeline（§152–§155）：只做解析与 provenance,不做 Layout（§153）
6. 单 Agent 最终流程（§170）端到端跑通 → §174 Test 1(普通聊天) / Test 9(Prompt Snapshot) 绿
```

**验收**：单 Agent 端到端（§170）+ 状态机全集单测 + 不变量闸口（绕过 Compiler 自己拼 prompt 的路径立刻红）+ §174 Test 1/9。
**spec 锚点**：agent-runtime-spec §5–§16 / §26 / §27 / §37 / §152–§155 / §170。

# 6. S24 — WP3.2 Tool Runtime + 审批 + 权限

**任务清单**：

```text
1. Tool Runtime（§31–§36）+ 五段流水线 pre→approval→guards→execute→post（§36.1，
   approval 必须排在 guards **之前**）+ 抛错归一化（§36.2，纪律 D2）
2. Tool Loop 与上限（§36/§38）+ Budget 两层与 reservation（§39–§42）
3. 审批：Approval Request（§115）+ 四值 fail-closed（§115.1）+ Waiting State（§116）+
   Wakeup Event（§117）+ 幂等事件处理（§119）
4. Tool Result（§35）与并行回灌顺序 = model order（§36.3 / R-P3-6）
5. 权限与隔离：Tool Permission（§33）/Permission Check（§34）/Secret Isolation（§88）/
   Tool Sandboxing（§89）+ 读并行 / 写串行（§90–§94）
6. reasoning 签名回传（PV8/§11）+ 开放点 3 联调定案（以缓存指标定）
7. 还账 #5（剩余诊断码随触发源落地，compiler-spec §71）+ #7（结构化/审批提升）
```

**验收**：§174 Test 2（Tool Loop）/ Test 3（Cancellation）/ Test 4（Retry）/ Test 8（Permission）绿 + 审批四值与"无回答者必拒"断言 + 并行回灌顺序断言（乱序完成仍按 model order）。
**spec 锚点**：agent-runtime-spec §31–§42 / §88–§94 / §115–§119；provider-adapter-spec §11 / §23 开放点 3。

> **【2026-09-26 实录·S24 收口】**
> ①**Tool Runtime**（`packages/agent/src/tools/`）：`registry.ts` 五段流水线
> pre→approval→guards→execute→post + 归一化（§36.2：流水线 throw → `TOOL_PIPELINE_ERROR`
> 收敛为 status='error'，**不升格为 Run 失败**；cancellation → 'cancelled' 不算失败 §45）
> + finalizeContent + tool_calls 表落账（started/completed/denied/failed 四态 + durable
> 事件四件套）+ §46 工具超时（status='timeout'，D1：`outcome.timedOut` 独立上报）
> + §47 C3 瞬时重试（NETWORK_ERROR/RATE_LIMIT/TEMPORARY/TIMEOUT 同 Run 重试；
> PERMISSION_DENIED 等不重试）。`budget.ts`：§39 RunBudget 唯一判据 + §41 usage +
> §42 reserve/settle + §38 `RUN_BUDGET_EXCEEDED`（Turn endReason='budget_exceeded'）。
> `approval.ts`：§115.1 四值 fail-closed——无回答者/跨 chat/抛异常/枚举外 → `unavailable`；
> policy `never` 在**派发之前**生效；审计落库失败直接拒；`approval.requested/decided`
> 成对 durable + approvals 表双行（pending→decided，含 policyAtRequest 供 Replay）。
> ②**run-agent 工具循环**（§36/§170）：改由执行层原语建 Run（createExecutionRun）+
> 新生成原语 **`prepareIteration`**（runtime `run.ts`：同一编译路径、不建 runs 行、
> 不要求链尾 user、dispatch 同步可 await——循环拥有消息写入与状态收尾）。
> 每轮 Provider Request 走完整 compile→快照（Test 9 循环版成立）；**世界书/persona/preset
> 贡献首轮算一次、循环内复用**（副作用不重复记账 + 前缀稳定）；assistant 中间消息与
> tool 结果消息逐轮入树（树尾即下一轮编译输入）。Turn 欠账集合（§37.1）逐条清零。
> ③**契约扩展**（provider-adapter-spec §10 落地注）：`ProviderToolSchema` + request.tools +
> `role:'tool'` 消息 + assistant 可选 blocks（PV8 形状就位）；`DispatchResult.toolCalls`
> （tool_call_delta 按 index 聚合）+ `reasoningBlocks`（签名块收集）；不变量 2 比较键
> role/content/blocks（**toolCallId 不参与**——会话内关联 ID 真相源 = tool_calls 表；
> wire 缺 ID 时按序合成占位 `tool_part_N`）。不变量 3 放宽至 blocks/toolCallId/isError。
> ④**验收**：§174 Test 2/3/4/8 + 审批四值（无回答者/never/抛异常/枚举外/allowed_once）
> + §36.3 乱序完成按 model order 回灌 + §38 超限 → agent 包 **19/19 绿**。
> ⑤**挂账**：PV8 签名块回传的完整 wire 翻译随真实 Provider 接入补（形状已就位）；
> adapter 侧 tools 翻译（OpenAI functions / Anthropic tools）同批。

# 7. S25 — WP3.3 Workflow DAG + Director 三路径

**任务清单**：

```text
1. Workflow Runtime（§62）+ Node 族（§63–§66）+ Edge（§67）
2. 并行执行与失败策略（§68/§69）+ Agent-to-Agent 通信（§70）
3. Resume（§110）/ Failure（§111）/ Cycle（§112）/ Loop Policy（§113）
4. Director Agent（§80）+ Structured Output（§81）+ Repair（§82）
5. **单聊快速路径 = 单节点 Workflow 退化**（R-P3-2：Director 不参与）+ Writer/Checker
   Workflow（§172）跑通
6. §174 Test 7（并行 Workflow：B/C/D 并行，E 等全部完成）绿
```

**验收**：§174 Test 7 绿 + DAG/条件/并行/Join/Retry/Resume/Loop Limit 七项各一测（§173 Workflow 组）+ 单聊路径**不产生额外模型调用**（调用计数断言）。


> **【2026-09-26 实录·S25 收口】**
> ①**Workflow 引擎**（`packages/agent/src/workflow/engine.ts`）——**波次调度**:每波把
> 入边全部满足的节点**并发**执行(§68 fan-out/join 天然成立);§69 三种失败策略
> (fail_fast/wait_all 判死但账本保留 / best_effort 失败记账后带部分结果继续);
> §110/§111 **节点账本 Resume**(已完成默认不重执行,失败节点 Resume 时重试;
> 账本可注入,checkpoint 表持久化归 S27);§112/§113 **有界环**——回边必须显式
> LoopPolicy 否则校验拒绝,回边触发时清除环体下游完成态(保留回边源,防 W←K 死锁),
> 次数受 maxIterations/maxTotalRuns/maxExecutionTimeMs 三重封顶。
> ②**受限条件 DSL**(condition.ts):比较 + and/or(不混用) + 括号字面量拒绝——
> **无任何 eval 路径**(§66 铁律);§66 表达式对象与 §67 字符串同词法;变量缺失 = false。
> ③**Director/结构化输出**(director.ts):§80 `{nextAgent,reason}` 结构化决策——
> 路由 = 决策变量拍平(`decision.<id>.nextAgent`)+ 条件边,**不解析自然语言**;
> §81 validate→accept/repair/fail;§82 repair 再调一次模型,受 repairAttempts 封顶。
> AgentNode 收编 structuredOutputPolicy/dispatch 字段(spec 未定义节点字段,落调和注)。
> ④**§172 Writer/Checker**:Agent 节点委托**真实 runAgent**,产物经变量/outputMapping
> 通信(§70 不碰彼此内部状态)。
> ⑤**验收**:§174 Test 7 + §69×2 + §66×2 + §65(真实 Registry 五段流水线) + §112×2 +
> §110/§111 + §80–§82×2 + §172 + R-P3-2 单聊零额外模型调用 → workflow **15/15 绿**。
> ⑥**两处引擎真 bug(测试首跑抓出)**:回边被计入前置条件 → 环失去入口首波死锁
> (回边是闩锁不是前置);findBackEdges 重建合成边丢失 condition → 回边闩锁失效。
> ⑦**挂账**:ApprovalNode 执行面归 S26(形状已校验);账本持久化接 runtime_checkpoints
> 表归 S27(Resume/Replay 会话)。

# 8. S26 — WP3.4 Context Policy 族 + Artifact + Output Commit

**任务清单**：

```text
1. Context Policy（§18）+ History / Memory / Worldbook / Artifact 四个 Policy（§19–§22）
   （Memory Policy 只落接口形状 + 空实现,R-P3-9）
2. Artifact Policy（§22）+ Artifact 主数据结构（§71）+ Frozen Artifact（§72）
   + 冻结/提升=**显式确认不自动**（compiler-spec §87 + 决策 14：冻结产物仍进 injection/tail）
3. Agent Output（§73）/ Output Commit（§74）/ Output Policy（§75）
4. Prompt Recompile After Tool（§104）+ Cache Interaction（§105）+ Cache Break Event（§106）
   （与 P2 的 CachePlan/diff 严格对齐,不另造口径）
5. State Mutation / State Patch / State Conflict（§107–§109）
```

**验收**：四个 Policy 各一测 + 冻结产物不进稳定前缀的断言（缓存纪律）+ 工具后重编译前后快照可 diff。
**spec 锚点**：agent-runtime-spec §18–§22 / §71–§75 / §104–§109；compiler-spec §87；决策 14。

> **【2026-09-26 实录·S26 收口】**
> ①**Context Policy 族**(`packages/agent/src/context/policy.ts`)——§18 七族总装;
> §19 History(include 开关/pinned 豁免/maxMessages 保最新)/§21 Worldbook(白名单 +
> maxEntries 保前 N)/§22 Artifact(maxItems,allowedTypes 在贡献构造面执行)为**纯过滤层**,
> dropped 审计逐条可追;§20 Memory 只落形状+空实现(R-P3-9);Summary/ToolResult spec
> 未定义形状 → 调和注最小面。**§155 五源维持不变**(unmapped 继续显式上报,扩源归 P4+)。
> 过滤落点 = runtime `prepareIteration` 新增 `filterContributions` 钩子(依赖方向
> runtime←agent 保持,runtime 只认函数)。
> ②**Artifact**(`artifacts/store.ts`)——§71 主结构接通 artifacts 表(sha256 contentHash);
> §72 冻结=**显式 API**(冻结后拒改);**C2 缓存纪律钉死在 zone 映射**:frozen→injection /
> working→tail,永不 header/stableWB——测试直证 compile 后 artifact 段落位于全部 history
> 之后。ArtifactRef 引用物化归 Compiler(挂账)。
> ③**Output Commit**(`output/commit.ts`)——§74 四模式:message(落树)/artifact(落表)/
> silent/custom(**未注册 fail-closed 拒绝**,§115 同哲学);§75 role 枚举扩 character
> (RP 一等角色,Breaking:N,spec 已加调和注)。runAgent 收尾从硬编码落消息改为走
> commitOutput,缺省 policy 保 S23 行为。
> ④**State Mutation**(`state/mutation.ts`)——§107 显式事务 Validate→Commit(序贯校验,
> 同批 patch 允许链式依赖,任一失败整笔拒绝无部分提交);§108 五操作(copy-on-write
> 点分 path);§109 乐观并发 VERSION_CONFLICT(版本嵌 state JSON `__version` 键,
> 加列属表结构变更再议;reload/merge/retry 归调用方)。
> ⑤**§104–§106 缓存交互**——工具执行上下文增 `reportWorldbookMutation` 上报面:
> 发布 cache.invalidated(deferred-durable)+ 收集 WORLD_BOOK_CONTENT_CHANGED 进下轮
> compile 重算 CachePlan + **清 recurring 复用重跑激活**(Tool Result → Context Update →
> Recompile);前后快照经 core `diffSnapshots` 可 diff(稳定前缀逐段 same 直证)。
> ⑥**验收**:四 Policy 各一测 + C2 冻结不进稳定前缀 + Output 四模式 + StatePatch 五操作
> + VERSION_CONFLICT + 端到端缓存交互 → S26 测试 **12/12**;agent 包 46/46。
> ⑦**挂账**:Memory Runtime 检索面(R-P3-9,P4);ArtifactRef 引用物化(Compiler 会话);
> Output custom 注册面(随群聊/编排需求落)。

# 9. S27 — WP3.5 Resume / Recovery / Replay

**任务清单**：

```text
1. Resume 与核心原则（§51/§52）+ Runtime Checkpoint 与类型（§53/§54）+ Resume 安全性（§55）
2. Deterministic Replay（§56）+ Replay 模式（§57）+ Replay Provider（§144）/
   Tool Replay（§145）/ Replay Safety（§146）+ Runtime Determinism（§143）
3. Runtime Modes 四态（§147–§151）：Live / Simulation / Replay / Debug
4. 还账 #11：**重启恢复逐状态矩阵**（每状态重启后行为表）+ non-idempotent 工具
   reconciliation 对账（§50 幂等分类 + §51–55 Resume 骨架的补全）
5. §174 Test 5（Resume：Turn3 暂停→重启→续跑）/ Test 6（Crash Recovery：running→
   崩溃→重启→interrupted→recover）/ Test 10（Deterministic Replay）绿
```

**验收**：§174 Test 5/6/10 绿 + 逐状态矩阵表落 spec + "崩溃后不产生永久 Zombie Run"（§173 Recovery 组）+ Replay 两次逐字节一致（X14）。
**spec 锚点**：agent-runtime-spec §50–§58 / §96–§98 / §143–§151；implementation-plan §10 #11。

> **【2026-09-27 实录·S27 收口】**
> ①**runAgent 循环接入执行层**(§53/§54/§97):每轮 heartbeatRun + 检查点四点
> (before_provider 带 promptSnapshotId / after_tool 带 toolState / before_pause /
> 恢复点);createExecutionRun 落 mode(§147–§151 四态)+ dependencyManifest
> (compiler/agent 版本 + model,§166)——S23–S26 的 runs 行此前连 agentId 都没记。
> ②**Pause 语义**(§51):pauseToken 每轮模型调用前检测 → before_pause 检查点 →
> Run=paused → outcome 增 \`paused\`(非终态;Turn 未关闭,AgentTurnEndReason 调和注
> 扩 paused(调和注);Resume = 新 Attempt 新 Turn 续跑,Turn1/2 产物已在树里不重执行。
> ③**resumeRun**(§51–§55):兼容性校验(manifest vs 当前 compiler/model,不兼容 →
> RESUME_INCOMPATIBLE 可 force)→ §50 对账 → paused/interrupted→resuming→running →
> 复用 runAgent 循环(existingRunId 模式:不建 Run、不走 pre-step、不重发 started)。
> ④**Recovery**(§96/§97 + 还账 #11):scanInterruptedRuns(running/waiting 心跳超时 →
> interrupted,Zombie 清零)+ planRecovery(检查点+幂等性 → resume/retry/fail 三选一)+
> reconcileToolCalls(幂等→orphaned 重执行;非幂等→缺省阻塞,显式 allow → reconciled);
> **逐状态重启行为矩阵表已落 spec §97.1**。
> ⑤**Replay**(§143–§146):ReplayAdapter 按 rowid 序回放 generations 录制;
> replayToolResults 从 tool_calls 读录制结果替代真实执行(§146:副作用无触发路径);
> runAgent mode='replay' 分流。X14 验收 = 同种子两次执行 + 重放,serialized.parts
> 逐字节一致(测试直证)。
> ⑥**两处真 bug(测试首跑抓出)**:**tool_calls 行主键直接用 wire 调用 id**——模型爱
> 复用 call_1,两个 Run 即撞 UNIQUE → 行 id 改 uuidv7(wire id 只做请求内关联);
> **Replay 轮次分组依赖 createdAt**——固定时钟下时间戳全等,边界塌缩 → 改 rowid 序。
> ⑦**验收**:§174 Test 5(Test 3 轮暂停→Resume 续跑+§55 不兼容/force)/ Test 6(崩溃→
> interrupted→recover,Zombie 清零,非幂等对账两分支)/ Test 10(两次执行逐字节一致+
> Replay 重放一致)→ S27 测试 **5/5**;agent 包 **51/51**。
> ⑧**挂账**:recovery 的 retry 分支(无检查点重放)未接自动编排;Checkpoint 恢复粒度
> = 轮级(轮内 provider 中断靠 Attempt 重放);Simulation Mode 专属 mock 面归 P4。

# 10. S28 — 收官（护栏 + API 面 + 观测 + 门禁 + 出场）

**任务清单**：

```text
1. 还账 #17 Agent Tree 递归护栏：maxDepth / maxChildren / maxTotalAgents / maxRuntime
   进 AgentBudget(§39) + Scheduler(§93) + 超限拒绝 spawn + 诊断码（先落 spec 骨架）
2. §154 API 面落地：GET/POST /agents、POST /agents/:id/runs、GET /agent-runs/:id、
   cancel / pause / resume / delegate / handoff、GET /tools、GET /skills
3. 观测面：Run Timeline（§121）/ Cost Tracking（§122）/ Agent Inspector（§124）/ Debug 模式（§125）
4. CI 门禁扩展：P2 两道缓存门禁保持绿 + P3 新增**恢复/重放确定性门禁**
   （崩溃恢复 + Replay 逐字节一致,挂进 vitest projects；架构守卫补对应哨兵断言）
5. 出场登记：§173 七组逐条核验 + §174 十场景全绿 → §38 决策 + implementation-plan §12 看板 +
   AGENTS 状态；p3-plan 归档
```

**验收**：§173 七组全勾销 + §174 十场景全绿 + typecheck 全包 0 + ESLint 绿 + 架构守卫绿。
**spec 锚点**：agent-runtime-spec §39 / §93 / §121–§125；api-spec §154；implementation-plan §10 #17。

# 11. 横切纪律

延续 p0-plan X1–X6 / p1-plan X7–X8 / p2-plan X9–X11，P3 特别加：

```text
X12 Agent 路径不得绕过 Compiler：任何"图省事直接拼 prompt"的实现必须在 fake provider
    入口的不变量闸口立刻变红（technical-plan §8.5 四条不变量）。这是长项目最常见的腐化起点。
X13 新事件域必须先登记 §5.4 权威表并声明 durability 分档（决策 16/19）——架构守卫 A 组
    （A1–A4）会红；不许在代码里先造名后补表。
X14 确定性：Agent 测试必须固定 now / 种子 / 录制回放（延续 X10）；Replay 模式禁 wall-clock
    与随机；"跑得起来"不算验收，**逐字节可复现**才算。
X15 每次新增子 Agent / 工具 / 节点，必须在会话记录里申报"带来几次模型调用、能否共享前缀"
    （§38 决策 36 全局判据）——多 Agent 与核心 KPI 直接冲突，不许默认开。
```

# 12. 出场验收与挂账

```text
出场(总设计 §36)：通过 agent-runtime-spec §173 七组验收标准（Agent / Workflow / Tool /
Context / Prompt / Replay / Recovery）+ §174 全部 10 个必测场景；单/多 Agent 的
Delegate / Await / Cancel / Resume / 崩溃恢复全部可用。
收尾：P3 出场登记 §38 决策；implementation-plan §12 看板更新；AGENTS 当前状态更新；p3-plan 归档。

本阶段勾销的挂账(implementation-plan §10)：
  #5  剩余诊断码随触发源落地 → S24
  #7  结构化/审批提升 → S24
  #11 重启恢复逐状态矩阵 + reconciliation 对账 → S27
  #17 Agent Tree 递归护栏 → S28
明确不在本阶段(不勾销、留后续)：
  #8  memory-runtime-spec 骨架 → P4(WP4.1 前置)
  #10 evaluation-engine-spec 充实 → P5
  #12 工程性能预算三档 → 未排期(见 #12b 补记:S21 千轮门禁已成为事实上的性能门禁)
  #13 升级/备份/回滚 → P5
  #14 开源发布套件 → 推送公开仓库前(用户触发)
  #16 Plugin 信任分档 → P5
  #18 World State 规则版 / #19 Simulation Agent / #21 SKILL.state 背书 → P4/P5
```

# 13. P3 看板

| 会话 | WP | 状态 | 恢复点注记 |
|---|---|---|---|
| S22 | WP3.1a | ✅ | 落点已裁决 = **方案 A**（§2.2，§38 决策 45）；交付 migration v8（10 表 + runs 十四列）+ `runtime/src/execution/{status,store,recovery}` + §5.4 新增 23 条事件登记 + 架构守卫 **B4**（编排层是终点）/ **D4**（禁硬编码迁移版本号）。**两处偏差已处置**见 §4 实录（`tools` 表不在 spec → 不建；`agent_versions` 漏列 → 补建）。**全量门禁**：434 测试 / 158 套件 / 48 文件全绿 + typecheck 全包 0 + ESLint 绿 + 守卫 14/14。**遗留**：`runs.status` 的 P0 遗留词（`streaming`/`completed`）仅做别名归一，**存量回填归 S23**；`events` 表无 `attempt_id`/`trace_id` 列（`RuntimeEvent` 有该字段而 sink 落库时丢弃）——**待作者裁决**是否在 S23 随迁移补列 |
| S23 | WP3.1b | ✅ | 交付 `packages/agent/src/runtime/` 六模块 + migration v9（runs.status 回填）+ §174 Test 1/9 + agent 9/9；状态机两条调和注已落 spec（§9 interrupted / §10 聚合复位）。**实录见 §5** |
| S24 | WP3.2 | ✅ | Tool Runtime 五段流水线 + 工具循环（prepareIteration 原语）+ 审批四值 fail-closed + §36.3 model order 回灌 + §38 预算上限；§174 Test 2/3/4/8 绿；agent 包 19/19。**实录见 §6**（含挂账：PV8 签名块/工具清单的 wire 翻译随真实 Provider 接入补） |
| S25 | WP3.3 | ✅ | Workflow 引擎(波次并发/§69 策略/有界环/账本 Resume)+ 受限 DSL + Director 结构化输出与 Repair;§174 Test 7 绿;workflow 15/15。**实录见 §7**(挂账:ApprovalNode 执行面归 S26;账本持久化归 S27) |
| S26 | WP3.4 | ✅ | 2026-09-26 | |
| S27 | WP3.5 | ✅ | 2026-09-27 | |
| S28 | 收官 | ✅ | 2026-09-27 | **P3 出场完成**（§38 决策 46）。交付：①还账 #17 Agent Tree 递归护栏（§39 RunBudget 四字段 + §93 `assertCanSpawn` + §100/§8 `AGENT_RECURSION_LIMIT`→409；`scheduler.ts` 6/6 绿）；②§154 P3 Agent API 骨架转已实现契约（12 路由 + DTO + 契约测试 12/12 绿）；③观测面（`GET /agent-runs/:id/timeline|cost`、`GET /agents/:id/inspector`，零新存储；§125 Debug 实现注）；④CI 门禁扩展（架构守卫 **D5** 恢复/重放确定性哨兵，P2 缓存门禁保绿）；⑤出场登记（§173 七组 / §174 十场景全覆盖核验）。**全量 507 测试 / 56 文件全绿，typecheck 全包 0，ESLint 0，守卫 19/19**。**挂账**：Retry Agent 自动编排 / 轮内 provider 中断粒度 / Simulation mock / Memory Runtime / PV8 wire 翻译（均 P4/P5，不阻塞出场）。P3 出场 = B1（P4 并行）解锁。**归档注**：本阶段计划已收口，后续按 roleplay-runtime-spec 家族 + P4 细化计划继续 |

---

*关联文档：[implementation-plan.md](./implementation-plan.md) §7/§10/§12 · 总设计 §36 / §23 / §5.4 · [agent-runtime-spec.md](./specs/agent-runtime-spec.md)（§4 / §36 / §115 / §173 / §174 为主锚点）· [database-schema.md](./specs/database-schema.md) §34.1–34.3 · [api-spec.md](./specs/api-spec.md) §154 · [provider-adapter-spec.md](./specs/provider-adapter-spec.md) §11/§23 · [p2-plan.md](./p2-plan.md)（已收口）· [p1-plan.md](./p1-plan.md) / [p0-plan.md](./p0-plan.md)（已归档）*
