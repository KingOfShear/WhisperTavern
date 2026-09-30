# WhisperTavern V2 — 实施计划总纲（Implementation Plan）

> **文件：** `docs/implementation-plan.md`
> **版本：** V3.2（2026-09-27：**S30/WP4.2a Summary 链 + 四层记忆 + 双检索完成进 §12 看板**——四层 Memory Runtime + Summary 链冻结块 + chunks_fts 关键词检索 + agent Memory Policy 兑现（R-P3-9）+ runAgent tail 接线 + filterContributions 消费修复；memory-runtime-spec 升 V0.2（锚点转已实现契约）；全仓 534 测试/59 文件 + typecheck 全包 0 + ESLint 0 + **P2 缓存门禁保绿**）；V3.1（2026-09-27：**S29/WP4.1 memory 持久化底座完成进 §12 看板**——memory-runtime-spec V0.1 + database-schema 三处修复 + migration v10 + runtime `memory/` 层 + catalog memory.created/updated；测试全绿闭环（runtime 15 条 / 全仓 517/57 + typecheck 0 + ESLint 0）；§10 #8 勾销（spec 部分，Runtime 接口归 S31）；V3.0（2026-09-27：**P4 细化会话完成**——[p4-plan.md](./p4-plan.md) 落盘（S29–S36 会话切分 / R-P4-1–10 范围裁决 / 出场 KPI 对齐 §36 P4 行）；§8 P4 WP 表补"会话"列并挂指针）；V2.9（2026-09-27：**P3 完成（S28/WP3.6 收官）进 §12 看板**——还账 #17 Agent Tree 递归护栏 + §154 Agent API 面 + 观测面 + CI 门禁 D5 + 出场登记；§38 决策 46；全量 507 测试 / 56 文件全绿 + typecheck 全包 0 + ESLint 0 + 守卫 19/19；§10 #17 勾销；p3-plan 归档）；V2.8（2026-09-26：**S22/WP3.1a 持久化底座完成进 §12 看板**——migration v8（10 表 + runs 十四列）+ runtime `execution/` 三模块 + §5.4 新增 23 条事件登记 + 架构守卫 B4；p3-plan §4 补落地实录、§13 看板 S22 ✅）；V2.7（2026-09-26：**P3 细化会话完成**——[p3-plan.md](./p3-plan.md) 落盘（S22–S28 会话切分 / R-P3-1–10 范围裁决 / 入场条件 + 首个待决项「Agent Runtime 落点方案 A/B」；出场 = agent-runtime-spec §173 七组 + §174 十场景）；§7 P3 WP 表补"会话"列并挂指针）；V2.6（2026-09-26：**P2 六个 WP（S16–S21）完成进 §12 看板**——WP2.6 CI 硬门禁收口（§38 决策 44），P2 完成（CI 侧），真实 API 出场待作者 key 实测）；V2.5（2026-09-15：S13/WP1.4 完成进看板 + §10 #20 勾销（api-spec §48 拼写对齐 contracts，方案 A）；V2.4：2026-09-12：P0 DoD/看板收口——G2/G4 随指令安全特性撤下的引用清理，测试数改引 p1-plan §11；V2.3：2026-09-06：P1 细化——§5 挂 p1-plan 指针、§4.11 P1 DoD/Non-goals、还账 #4/#15 绑定 WP1.5；V2.2：P0 完成；V2.1–V1.2：S7–S2 逐会话；V1.1 评审吸收；V1.0 首版，§38 决策 31/34）
> **状态：** Active（随执行滚动更新——WP 状态看板在 §12，每完成一个包即更新）
> **文档层级：** [technical-design.md](./technical-design.md) 之下的**执行层文档**。与 AGENTS.md 的分工：AGENTS 管**会话纪律**（怎么读、怎么改、何时问），本文管**执行顺序**（做什么、先做哪个、做到什么程度算完）。
> **决策锚点：** technical-design §38 **决策 31**。
> **维护纪律：** ①本文**零设计语义**（§1 边界）；②里程碑内容/规模/验收的权威是总设计 §36，冲突以 §36 为准；③每个 WP 出场必须完成其"还账"义务（§10）；④阶段推进在 §38 留痕。

---

# 1. 文档定位与不做什么

本文回答一个问题：**"下一个会话该做什么包？"**——以及每个包的入场条件、出场条件、验收方式和顺手要还的账。

```text
本文只管：工作包（WP）分解 / 构建顺序 / 依赖 / 验收触发 / 还账映射 / 状态看板
本文不管：任何"怎么做"——设计语义一律指向 spec（三岔地图见 AGENTS.md §2）
本文不复制：§36 路线图表、各 spec 的验收节（只引用节号）
```

**防平行详设声明**（决策 26 ② 的执行面）：本文任何条目若开始长出设计细节（字段、状态机、算法），就是越界——应把内容移入对应 spec，此处只留指针。

# 2. 全局构建原则（决定执行序的四个判据）

```text
B1  价值序：P2 缓存层是最大差异化 → P1 只需先落"世界书激活层"即解锁 P2 并行，
    P1 其余（UI 完整度/资产格式全家桶）可让路。
B2  防腐化序：不变量断言与 CI 门禁越早越好——fake provider 在第一个有 IO 的包
    就位，§5.5 四不变量断言从第一个发请求的包开始生效。
B3  会话粒度：一个 WP ≈ 1–2 个 AI 会话可完成且可独立验证（可跑测试/可演示）；
    跨会话未完成的 WP 必须在日记留中间态并在本文 §12 标注。
B4  滚动细化：P1–P5 的 WP 是初版分解。每个里程碑开工的**第一个会话**先做
    "阶段细化"：细化该阶段 WP + 落缺失的前置 spec 骨架（如 WP4.1）。
    不在现在过度规划——半年后的细节现在写必错。
```

# 3. 里程碑与依赖 DAG

```text
P0 Core Runtime ──► P1 ST 兼容 ──► P2 Cache Engine ──► P3 Agent ──► P4 记忆/群聊/RP ──► P5 插件/桌面
     骨架与主链          激活层先落       （WP1.2 出场即可并行）                                  │
                                                                          └─ P2.4 缓存标记翻译随 WP2.4
节奏与规模估算见总设计 §36（P2 建议尽早并优先打磨）。

P0 包级 DAG（──► 硬依赖；虚线软依赖见下）：

WP0.1 ──► WP0.2 ──┬──► WP0.3 ──┬──► WP0.4 ──┐
                  │            └──► WP0.5 ──┼──► WP0.7 ──► WP0.8 ──► WP0.9
                  └──► WP0.6 ──────────────┘

软依赖：WP0.8 的 UI 骨架可在 WP0.7 出场前并行开发（api-spec SSE 契约冻结后即不阻塞）。
测试依赖：fake provider 于 WP0.1 就位——WP0.4/0.5/0.6/0.9 的不变量断言与测试全部经它。
并行轨：WP0.5 与 WP0.4 互不阻塞；WP0.6 只依赖 WP0.2，可提前。
P1–P5 的包级 DAG 由各阶段细化会话产出（滚动细化 B4），不在本文件预写。
```

# 4. P0 工作包分解（当前阶段，最细粒度）

P0 验收标准（总设计 §36）：四家 provider 流式聊天、可保存可重启、usage 入库、Snapshot 可查。分解为 9 个 WP。**会话级任务分解、范围裁决（R-P0-1–R-P0-7）与逐会话看板见 [p0-plan.md](./p0-plan.md)**——本节保留 WP 概览与 DoD，不重复任务明细：

## WP0.1 仓库与工具链 bootstrap
- **交付**：pnpm workspaces 骨架（总设计 §7 全部目录就位）；ESLint + `tsc --strict` + Vitest 跑通；CI 骨架 + **门禁分级清单**（blocking：lint / tsc / 不变量断言 / 金样与 fixture；warning：覆盖率类）；测试资产目录约定（`tests/fixtures/` 收真实资产，**只读**——AGENTS §5 红线的落点）；`data/` 目录约定。
- **入场**：无。**出场**：空包全量 build + lint + test 绿。
- **spec 锚点**：总设计 §6/§7。

## WP0.2 contracts 骨架 + shared-contracts 充实（chat 面）
- **交付**：`packages/contracts` 第一版——IR 段模型 / Zone 与双 Placement / PromptRole / Diagnostics 形状 / chat 面运行态最小集；Zod schema 与类型同源。
- **还账**：shared-contracts-spec 从骨架充实为 P0 范围真相源（收编 compiler-spec §6–§17、provider-adapter §6 的草案类型）。
- **入场**：WP0.1。

## WP0.3 core：段模型 + Snapshot 结构 + token 计数双模式
- **交付**：core 包段模型实现（`ir/`）、PromptSnapshot 数据结构（不可变 + 八区哈希 §67）、本地估算器 + native 钩子（§52 双模式）。
- **入场**：WP0.2。

## WP0.4 Compiler 最小管线
- **交付**：P0 范围组装（preset 段 / persona / 角色卡描述 / 历史 / tail）+ Diagnostics 体系 + CompileMode（strict / preview）+ 编译结果与快照落点；Zone 类型全套就位但 stableWB/freshWB/summary 留空实现（P1/P2 填充）。
- **金样**：G2/G4 于 2026-09-08 随指令安全特性撤载一并移除——原为越权槽位/档位稳定性两条。
- **入场**：WP0.3。

## WP0.5 adapters：三类适配器 + fixture 测试
- **交付**：openai-compat / anthropic / gemini 三类（流式 + usage 归一 + 错误分类 + 取消/超时 + redact + 分层超时）；fixture 测试 T1/T4/T6/T10/T11/T12/T14（provider-adapter §20）。
- **还账**：总设计 §18.2 ProviderCapabilities 随实现定稿；provider-adapter §23 开放点 2（本地 tokenizer 选型）在本包内定。
- **入场**：WP0.3（可与 WP0.4 并行）。

## WP0.6 runtime：Event Bus + SQLite 持久化 + 消息树
- **交付**：Event Bus 最小版（P0 事件子集，durability 分档照 §5.4）；usage 入库；chats/messages/branches 表 + Drizzle migrations 框架启用（database-schema §77/§78）+ **迁移执行流程细化**（开发期自动应用；用户侧 = 检测版本 → 自动备份 → 迁移 → 完整性校验 → 失败回滚并阻止启动）；§5.5 四不变量断言埋入 fake provider 调用入口。
- **入场**：WP0.2（与 0.4/0.5 并行度高）。

## WP0.7 server：HTTP/SSE 传输层
- **交付**：api-spec P0 范围——chat CRUD、消息树 API、生成启动/取消/SSE 流（信封 + sequence）、设置与密钥（DPAPI/Keychain 存储）。
- **还账**：provider-adapter §22 的"api-spec generation SSE 投影复核"在此包联调时完成。
- **入场**：WP0.4 + WP0.5 + WP0.6。

## WP0.8 web：基础 Chat UI
- **交付**：ui-design §4.1 精简版（会话列表 / 聊天工作台 / 流式渲染 / swipe 基础操作）+ 设置页（provider/模型/密钥/代理）。
- **入场**：WP0.7。

## WP0.9 P0 端到端验收
- **交付**：四家 provider 流式聊天全链路演示；重启恢复；usage 入库可查；Snapshot 可查（Inspector 最简形态：能看每轮发了什么）；CI 全绿（不变量断言 + fixture 七条；G2/G4 已随指令安全特性撤下）。
- **出场 = P0 完成**，在 §38 记录并更新 §12 看板。

## 4.10 P0 Definition of Done（含 Non-goals）

验收清单（全绿 = P0 完成，对应 WP0.9）：

```text
☑ 四家 provider（OpenAI 兼容 / DeepSeek / Anthropic / Gemini）各跑通一条真实流式链路——机制全就绪;真实冒烟脚本 tests/smoke/real-provider-smoke.mjs 待用户以自有 key 执行(§38 决策 34)
☑ streaming 正常渲染；中途取消产生 partial 且已生成部分可查——apps/server e2e(DoD 2)
☑ generation + usage 入库；重启后完整恢复（消息树 / 运行记录 / 快照可查）——apps/server e2e(DoD 3,usage_source 分对)
☑ Snapshot 能重建模型实际收到的内容（§5.5 不变量断言 CI 绿）——e2e:serialized.parts ≡ request.messages(DoD 4)
☑ 无任何路径绕过 Compiler 拼 prompt（断言门禁）——fake 调用入口四不变量闸口,故意违规变红(DoD 5)
☑ fixture T1/T4/T6/T10/T11/T12/T14 全绿——core + adapters 套件（G2/G4 已随指令安全特性撤下，DoD 6）
☑ lint + tsc strict + 全量测试 CI 绿——四段门禁(DoD 7；测试数随阶段增长，见 p1-plan §11)
```

**P0 明确不做**（防止会话把 P1–P5 提前实现）：

```text
✗ 世界书激活语义与 stableWB/freshWB 分区（P1/P2）
✗ Macro Engine / CachePlan / 预算裁剪 / Elastic History（P2）
✗ Prompt Inspector 完整形态（P1）
✗ Memory / Summary / Agent / Workflow / Tool / 群聊 / 插件 / 桌面化（P3–P5）
```

P1–P5 各自的 DoD（含 Non-goals）由各阶段开工的首个细化会话产出（B4），追加到对应小节。

# 5. P1 工作包分解（**已细化**——会话级明细见 [p1-plan.md](./p1-plan.md),S9–S15;范围裁决 R-P1-1–R-P1-6;DoD 见 §4.11）

| WP | 内容 | 关键锚点 / 还账 |
|---|---|---|
| WP1.1 | 资产导入：卡 V2/V3/PNG/charx + 原生 .dgcard/.dgworld/.dgpreset | technical-plan §5.3/§5.10；导入不改档 |
| WP1.2 | 世界书激活层全集（触发/递归/sticky/cooldown/group/蓝绿灯） | compiler-spec §23–§29；**此包出场即解锁 P2 并行**（B1） |
| WP1.3 | 预设映射 + Persona 库 + ST Prompt Mapping | compiler-spec §80–§81 |
| WP1.4 | 编辑/swipe/分支完整交互 + 消息树 API 完整 | api-spec §16–§23 |
| WP1.5 | Prompt Inspector v1（段/哈希/diff 视图） | override 编辑器/档位徽标随指令安全撤下，不再交付 |
| WP1.6 | 金样测试体系完整（真实资产导入→编译→序列化） | technical-plan §8.2 |

出场（§36）：目录内真实资产导入跑通、金样绿、Import Compatibility Report 产出。

## 4.11 P1 Definition of Done（含 Non-goals,S8 细化会话产出）

验收清单（全绿 = P1 完成,对应 p1-plan S15）：

```text
✅ 目录内真实资产(ST 卡 V2/V3/PNG/charx、世界书两代格式、预设)导入跑通,产原生 .dg 格式 —— S9/S10/S12 + S15 金样锁定
✅ 世界书激活层全集语义单测 + 真实书金样(compiler-spec §23–§29) —— S11 + S15 字节金样(Table 激活进 prompt)
✅ 预设映射(ST Prompt Order §80–§81)→ contributions 顺序 —— S12 + S15 金样(主预设 217→212 段编译稳定)
✅ 消息树完整交互(编辑变体/swipe 生成填充/分支激活,§16–§23 契约测试) —— S13
✅ Prompt Inspector v1（段/哈希/diff 视图） —— S14
✅ Import Compatibility Report（字段映射/compat 清单） —— S9/S10/S12 + S15 导入层断言
✅ 金样测试体系(真实资产脱敏 → 导入→编译→序列化,technical-plan §8.2) —— S15
✅ lint + tsc strict + 全量测试 CI 绿 —— 293 绿(36 文件) 2026-09-22
```

**P1 明确不做**（P2 起接管）：

```text
✗ stableWB 毕业/退休/物理序 append-only、CachePlan、Budget 裁剪、Elastic History(P2)
✗ Macro Engine 展开(P2;P1 延续 R-P0-1 宏透传)
✗ Compatibility/Performance 模式分野与缓存标记翻译(P2/WP2.4)
✗ Agent/Tool/Workflow(P3);Memory/群聊/RP(P4);PNG 导出双写/桌面化(P5)
```

# 6. P2 工作包分解（**已细化**——会话级明细见 [p2-plan.md](./p2-plan.md),S16–S21;范围裁决 R-P2-1–R-P2-9;出场 = 真实 API 命中率 ≥70% + 成本削减 ≥60%）

| WP | 内容 | 关键锚点 / 还账 |
|---|---|---|
| WP2.1 | Macro Engine（registry / security / cache rule） | compiler-spec §37–§45 |
| WP2.2 | stableWB/freshWB 分区 + physicalOrder append-only + 毕业/退休 | worldbook-cache-design §2–§4；compiler-spec §20–§31 |
| WP2.3 | per-chat 哈希缓存 + CachePlan + Budget + Elastic History | 总设计 §14–§17 |
| WP2.4 | 缓存标记翻译（Anthropic cache_control 已实现 ✅ S19；Gemini explicit caching 已决：隐式默认、显式暂缓）+ 多 key 轮换 | worldbook-cache-design §5；provider-adapter §23 开放点 1（已决） |
| WP2.5 | 遥测面板 + 缓存二分工具 + Cache Simulator | ui-design §4.6；总设计 §20/§33 |
| WP2.6 | CI 硬门禁：100 轮稳定性 + 1000 轮模拟无未声明失效 | technical-plan §8.1 |

出场（§36）：CI 绿 + 真实 API 稳态命中率 ≥70% + 输入成本削减 ≥60%。

# 7. P3 工作包分解（**已细化**——会话级明细见 [p3-plan.md](./p3-plan.md)，S22–S28；范围裁决 R-P3-1–10；**入场条件与首个待决项（Agent Runtime 落点方案 A/B）见其 §2**；出场 = agent-runtime-spec §173 七组 + §174 十场景）

| WP | 内容 | 关键锚点 | 会话 |
|---|---|---|---|
| WP3.1 | 执行四层 Run/Attempt/StepRun/Operation + 事件 durability 全量 + Agent 定义/状态机/生命周期 | agent-runtime-spec §4 / §5–§16 / §5.4 | S22（持久化底座）/ S23（Agent 运行时） |
| WP3.2 | Tool Runtime + 审批 fail-closed + 权限沙箱 | agent-runtime §31–§42/§88–§94/§115–§119；provider-adapter §23 开放点 3（thinking 回传默认）在此定 | S24 |
| WP3.3 | Workflow DAG（引擎；HTTP 面留 P4）+ Director 三路径 | 总设计 §23；api-spec §154 vs §155 | S25 |
| WP3.4 | Context Policy 族 + Artifact 冻结/提升（提升 = 显式确认，不自动） | compiler-spec §87；agent-runtime §18–§22/§71–§75 | S26 |
| WP3.5 | Resume/Recovery/Replay + §174 十个必测场景 | agent-runtime §50–§58/§96–§98/§143–§151/§173/§174 | S27 |
| 收官 | Agent Tree 护栏（还账 #17）+ §154 API 面 + 观测 + CI 门禁扩展 + 出场登记 | agent-runtime §39/§93/§121–§125 | S28 |

# 8. P4 工作包分解（初版）

> **会话级明细见 [p4-plan.md](./p4-plan.md)**（S29–S36 会话切分 / R-P4-1–10 范围裁决 / 出场 KPI 对齐 §36 P4 行，2026-09-27 落盘）。

| WP | 内容 | 关键锚点 / 还账 | 会话 |
|---|---|---|---|
| WP4.1 | **前置：memory-runtime-spec 骨架**（四层记忆/双检索/Scribe 实施语义） | 挂账还清后 WP4.2 才开工 | S29 |
| WP4.2 | Summary 链 + 四层记忆 + FTS5/sqlite-vec 双检索 | 总设计 §25；database §25 | S30–S31 |
| WP4.3 | 网络搜索工具（结果注 tail / agent 工具，origin 溯源） | （—） | S32 ✅ |
| WP4.4 | 群聊 + per-char 缓存命名空间 | 总设计 §26；worldbook-cache-design §6 | S33 |
| WP4.5 | Roleplay Fast 档（三表 + BD 规则推导 + Story Thread） | roleplay-runtime-spec；R1 单调用 | S34–S35 |
| WP4.6 | ~~scope 边界确认还账~~（roleplay scope 与指令归属——随指令安全撤下） | （—） | （已撤下） |
| S36 收官 | Workflow HTTP 面（§155）+ World State 规则版（#18）+ Simulation mock + UI | api-spec §155；还账 #18/#21 | S36 |

# 9. P5 工作包分解（初版）

Plugin SDK + iframe sandbox + 权限；备份/导入导出 + 酒馆聊天记录导入；Tauri 桌面壳；i18n + Skill 对齐 agentskills.io；Roleplay Deep 档（LLM Director/Critic/Quality Gate）；**前置还账：evaluation-engine-spec 充实**。

# 10. 还账总表（跨 spec 挂账的执行映射）

三份 spec 各自有同步清单；此处汇总为执行序，**每项绑定 WP，出场必须勾销**：

| # | 挂账 | 绑定 WP | 出处 |
|---|---|---|---|
| 1 | ~~shared-contracts 充实（chat 面）~~ **✅ 2026-09-05 WP0.2 勾销**（spec 升 V2.0：§2.1 模块清单 / §2.2 Schema 同源 / §2.3 开放形状 / §2.4 C1–C4 自查 / §9.1 落地证据） | WP0.2 | shared-contracts / provider-adapter §22 |
| 2 | ~~ProviderCapabilities 定稿 + 本地 tokenizer 选型~~ **✅ 2026-09-05 WP0.5 勾销**（§18.2 全形；tokenizer 选型 = P0 启发式估算、tiktoken 归 P2,adapter-spec V1.1 §23） | WP0.5 | 总设计 §18.2；adapter §23 开放点 2 |
| 3 | ~~api-spec generation SSE 投影复核~~ **✅ 2026-09-05 WP0.7 勾销**（三层映射落地:provider 归一 → bus generation.*(§5.4 分档)→ SSE 信封{id,type,runId,timestamp,sequence,data},run 内 sequence 单调 + Last-Event-ID 续传;契约测试锁定) | WP0.7 | provider-adapter §22 |
| 4 | ~~ui-design override 编辑器 + 档位徽标；api-spec authority DTO~~ **✅ 2026-09-08 随指令安全特性撤下** | WP1.5 | — |
| 5 | 剩余诊断码随触发源落地（P0 两码 → P3 全量） | WP0.4 / WP3.2 | compiler-spec §71 |
| 6 | ~~Gemini explicit caching 评估~~ **✅ 2026-09-22 S19/WP2.4 勾销**（provider-adapter §23 开放点 1 关闭：隐式缓存默认，显式 `cachedContent` 暂缓——显式缓存有创建/存储成本与 TTL 管理，KPI 命中率经 usage `cachedContentTokenCount`（§17.1 已归一）同样可观测；待 S20 遥测证明显式收益再启用） | WP2.4 | adapter §23 开放点 1 |
| 7 | ~~untrusted 工具回灌~~（随指令安全撤下）；结构化/审批提升 | WP3.2 | — |
| 8 | ~~memory-runtime-spec 骨架~~ **✅ 2026-09-27 S29 勾销（spec 骨架）**：[memory-runtime-spec.md](./specs/memory-runtime-spec.md) V0.1 落盘（四层记忆职责/数据形状 + 双检索语义 + Scribe 写入不变量 + zone 约束 + memory.* 事件登记 + Repository 契约）；**Runtime 接口兑现归 S31**（p4-plan §4/§6） | WP4.1 | 上次文档盘点结论 |
| 9 | ~~roleplay scope 边界确认~~（随指令安全撤下） | WP4.6 | — |
| 10 | evaluation-engine-spec 充实 | P5 | 各挂账 |
| 11 | 重启恢复逐状态矩阵核对 + non-idempotent 工具对账（reconciliation）——§50/§51–55 已有幂等分类与 Resume 骨架，补"每状态重启后行为"表 | WP3.1 | agent-runtime-spec §50/§51–55 |
| 12 | 工程性能预算三档（target / warning / hard-limit；compile 侧已有 compiler-spec §126，补 worldbook 匹配 / SQLite / UI / 检索） | WP2 细化 | compiler-spec §126 |
| 12b | **补记（2026-09-26 S21）**：S21 千轮门禁已成为**事实上的性能门禁**——首跑即抓出 3 处 O(n²)（cacheplan `includes`-in-filter / budget `find`-in-reduce / hash `buildPrefixHash` 逐段 concat，末者 222s→2s 并已修）。**三档预算（target/warning/hard-limit）细化本身仍未做**，本项不勾销；后续若做，应把千轮门禁的耗时基线一并纳入 hard-limit。 | 未排期 | compiler-spec §126；p2-plan §8 落地记录 |
| 13 | 升级/备份/回滚流程（backup → migration → validate → rollback） | WP5 | 总设计 §36 P5 |
| 14 | **开源发布套件**：LICENSE 落盘（§38 决策 32）、SECURITY.md / CONTRIBUTING.md（引用 AGENTS 决策协议与纪律 5，不复写）/ CODE_OF_CONDUCT.md / Issue·PR 模板（architecture_proposal 对齐 §37 四问）/ 产品化 README；依赖许可证兼容性纪律（运行时依赖禁引入 GPL/AGPL） | 开源/推送公开仓库**前**（用户触发，不绑阶段 WP） | 2026-09-05 开源评审择优 |
| 15 | ~~**Sanitized Debug Export / Reproduction Bundle**：RedactionPolicy（去用户聊天内容 / 匿名化 ID / 默认 sanitized 非 full；密钥沿用 PV5 redact），导出可 Replay~~ **✅ 2026-09-17 S14 勾销**:api-spec §161 + `POST /api/v2/debug/export`(默认 sanitized:user/assistant 正文占位、ID 匿名化 redact-N、idMap 恒空;full 显式;PV5 密钥两模式必 redact);验收=sanitized bundle 喂 FakeProviderAdapter 可回放(server 契约测试) | ~~WP1.5(Inspector v1)细化会话~~ | 总设计 §19/§32；provider-adapter §17.2 |
| 16 | Plugin 信任分档（built-in / trusted / community / untrusted）补入 §29 权限模型——P0–P4 只按 §21.5 Capability 执行 | WP5 细化会话 | 总设计 §29/§21.5 |
| 17 | ~~**Agent Tree 递归护栏**：`maxDepth` / `maxChildren` / `maxTotalAgents` / `maxRuntime` 进 AgentBudget + Scheduler（不新造模块，纪律 5）+ 超限拒绝 spawn 的诊断码；spec 骨架先落~~ | ✅ 2026-09-27 S28 勾销 | §38 决策 36 增量①；agent-runtime-spec §39/§93/§100 + api-spec §70/§8（`AGENT_RECURSION_LIMIT`→409）+ `packages/agent/src/runtime/scheduler.ts`（`assertCanSpawn`，测试 6/6 绿）；§38 决策 46 |
| 18 | **World State 全局态（规则版）**：地点/时间/物品/任务/派系/知识补表 + 规则化推演；**禁止额外 LLM 调用**（R1/C1）；按纪律 3 先落 roleplay-runtime-spec 扩展章节 + database-schema 补表 | P4 | §38 决策 36 增量③；roleplay-runtime-spec；database-schema |
| 19 | Simulation Agent（LLM 世界推演）决策点：凭 P4 规则版实测（覆盖率/延迟/成本）决定是否引入 | P5 决策点 | §38 决策 36 暂缓项 |
| 20 | ~~**世界书槽位/逻辑枚举三套拼写归一**~~ **✅ 2026-09-15 S13 开工前勾销(作者拍板方案 A)**:api-spec §48 修订对齐 contracts 单一真相源——`selectiveLogic` 取 `andAny/andAll/notAny/notAll`(对齐 `keyword_logic`)、`position` 取 `anTop/anBottom/depth/emTop/emBottom`(对齐 `WorldbookPositionSchema`);Breaking: N(§152 P0 范围未投产,无消费方) | ~~S13(WP1.4) 前~~ | api-spec §48;contracts placement;database-schema §13 |
| 21 | **外部方向背书：SKILL.state（arXiv 2608.26263，EMNLP）**：以"显式可变执行状态替换 append-only 历史、推理丢弃只保留验证后的 ΔΣ 字典更新"实现 prompt 足印 `O(T²)→O(T)`——为 #18 World State 规则版与 **agent 执行循环有界状态**提供生产验证背书（2026-09-09 摘要已阅；§5.1 PDF 拉取确认基线=ReAct 逐条 append / Summarization 记忆压缩 / 本方法，口径=准确率·平均 prompt 大小·累计 token）。**量化结果（§5.2–5.6）待补**，纳入 #18 的定量判定留待该数字。**约束：只作用于 agent/工具执行子路径，不适用于 RP 聊天历史（历史即产品）** | P4（#18 细化时） | §38 决策 36 增量③；shared-contracts §StatePatch

# 11. 会话运转节奏（与 AGENTS.md 衔接）

```text
开工：AGENTS §1 必读顺序 → 本 §12 看板认领 WP → 核对入场条件
执行：严格按 WP 交付物清单；发现设计问题 → 改 spec（决策 26 ②），不顺手绕过
收尾：日记 → 更新本文 §12 看板（☐→✅ + 会话注记）→ §10 还账勾销 → 里程碑级推进落 §38
禁止：跳过未满足入场条件的 WP；绕过出场条件"先往后写"；在本文里写设计细节
```

**阶段计划文件约定**：每个阶段开工的**首个细化会话**产出 `docs/pN-plan.md`（与 p0-plan 同构：范围裁决 / 会话切分 / 任务清单 / 验收命令 / 横切纪律 / 看板）。**未进入细化会话的阶段不得预建占位文件**——B4 滚动细化的落点就是这批文件，而不是在总纲里膨胀。

# 12. 状态看板

| WP | 状态 | 会话/日期注记 |
|---|---|---|
| WP0.1 bootstrap | ✅ | 2026-09-05 S1 完成（pnpm workspaces + §7 目录 + 三段门禁绿 + fake provider 骨架；详见 p0-plan §13 恢复点注记） |
| WP0.2 contracts | ✅ | 2026-09-05 S2 完成（八模块 Zod-first + 30 单测 + 零 IO lint 约束；adapters 收编完毕，还账 #1 勾销） |
| WP0.3 core 段模型/Snapshot/token | ✅ | 2026-09-05 S3 完成（构造器深冻结 + 八区哈希 netstring 规范框架化 + 快照 authority 指纹（随指令安全撤下）+ 双模式 token 估算；零 IO 约束测试 + lint 双保险；16 条新测试） |
| WP0.4 Compiler 最小管线 | ✅ | 2026-09-05 S4 完成（P0 管线 + strict/preview + §10 推导表 + I4/R2/R3/I3/I5 断言 + 宏透传 R-P0-1 + 硬上限 R-P0-2 + Trace；金样 G2/G4 与越权断言当时绿，已于 2026-09-08 随指令安全特性撤下；14 条新测试） |
| WP0.5 adapters ×3 | ✅ | 2026-09-05 S4'-a/b/c 完成（openai-compat / anthropic / gemini + 共享 SSE/HTTP/超时层 + fixture 全家桶 T1/T4/T6/T10/T11/T12/T14 ×3 家;还账 #2 勾销;73 条 adapter 测试） |
| WP0.6 runtime 事件/持久化 | ✅ | 2026-09-05 S5 完成（Event Bus 分档落库 + §77/78 迁移器（备份/integrity/回滚）+ 消息树五操作 + dispatchGeneration 四不变量闸口；38 条新测试） |
| WP0.7 server 传输层 | ✅ | 2026-09-06 S6 完成（Hono 骨架 + §152 P0 路由 + 信封/Request ID + SSE 续传 + SecretStore R-P0-6 定案(§38 决策 33)+ migration v2(runs/prompt_snapshots);11 条契约测试;§152 的 characters/worldbooks/presets CRUD 挂 S8 补齐(需 §6-§11 资产表迁移)） |
| WP0.8 web Chat UI | ✅ | 2026-09-06 S7 完成（脚手架 + api-types 填充 + SSE 客户端 + 工作台 + 设置页 + 快照面板；真机冒烟全链路绿；类型零 any） |
| WP0.9 P0 端到端验收 | ✅ | 2026-09-06 S8 完成（e2e ×3 + 资产 CRUD 补齐 + 冒烟脚本;DoD 见 §4.10 勾选;真实四链路待用户 key 冒烟） |
| WP1.1a 卡导入 | ✅ | 2026-09-06 S9 完成（st-compat 卡模块 + 三载体归一 + .dgcard + 导入路由 + 兼容报告；详见 p1-plan §11） |
| WP1.1b 世界书导入 | ✅ | 2026-09-07 S10 完成（st-compat 世界书模块：三容器 × 两代字段集 → .dgworld + 方言回写往返；migration v4 worldbook_entries/entry_versions；POST /api/v2/worldbooks/import；全量 208 测试绿；详见 p1-plan §11） |
| WP1.2 世界书激活层 | ✅ | 2026-09-12 S11 完成（core 激活管线 §23–§29 + ChatWorldbookBinding 契约 + chat_worldbooks v6 + 绑定路由 + startRun 接线；全量 233 绿；**P2 解锁（B1）达成**；详见 p1-plan §11） |
| WP1.3 预设映射 + Persona | ✅ | 2026-09-15 S12 完成（st-compat 预设模块 + buildPreset/PersonaContributions 接线 + 导入/绑定路由；详见 p1-plan §11） |
| WP1.4 消息树完整交互 | ✅ | 2026-09-15 S13 完成（§16–§23 全路由：swipe 生成填充/编辑变体/软删/分支/激活/chats DELETE/messages 分页 + web 交互面；全量 262 绿；详见 p1-plan §11） |
| WP1.5 Inspector v1 + 导出 | ✅ | 2026-09-17 S14 完成（core diffSnapshots + §107 inspector/§38 diff/§36 快照列表/§161 debug export 四路由 + 还账 #15 勾销 + web PromptInspector 面板；全量 278 绿；详见 p1-plan §11） |
| WP1.6 金样测试体系 | ✅ | 2026-09-22 S15 完成（金样套件：导入层 ImportReport 断言 + 字节 parts 基线 preset/Table + 卡四载体完整性/脱敏；**金样抓出并修复 3 处 st-compat 生态缺口**：position string 方言 / null 与 role 魔数 / prompt_order 分组形态；删除 4 个 X3 违例 probe；全量 293 绿 36 文件；**P1 出场完成**，归档 §38 决策 38；详见 p1-plan §11） |
| **P1 完成** | ✅ | 2026-09-22 出场（§36）：DoD 八条全勾销（§4.11）+ 293 测试绿 + 报告产出。下一阶段 = P2（缓存层，最大差异化，B1 已解锁） |
| WP2.1 Macro Engine | ✅ | 2026-09-22 S16 完成（macro/ 五文件 + pipeline 接线替换 R-P0-1；§38 决策 39；详见 p2-plan §11） |
| WP2.2 stableWB/freshWB 分区 | ✅ | 2026-09-22 S17 完成（worldbook-cache 纯函数层 + physicalOrder append-only + migration v7；§38 决策 40） |
| WP2.3 CachePlan + Budget + Elastic History | ✅ | 2026-09-22 S18 完成（budget/cacheplan + pipeline 接线；R-P0-4 退役；§38 决策 41） |
| WP2.4 缓存标记翻译 | ✅ | 2026-09-22 S19 完成（providerStrategy + adapters translate + anthropic wire 挂载；还账 #6 勾销；§38 决策 42） |
| WP2.5 遥测 + 二分诊断 + Cache Simulator | ✅ | 2026-09-22 S20 完成（api-spec §41–§44 转已实现契约 + core simulator + web 面板；金样抓出 2 处口径缺陷；§38 决策 43） |
| WP2.6 CI 硬门禁 | ✅ | 2026-09-26 S21 完成（两道门禁：core 千轮确定性回放 + server 百轮真实管线；KPI 预演真资产达标 + Table 反面对照；§43 scenarios 转回放；**首跑抓出并修 3 处 O(n²) 性能坑**；全量 404 绿 151 套件；§38 决策 44；详见 p2-plan §11） |
| **P2 完成（CI 侧）** | ✅ | 2026-09-26：六个 WP（S16–S21）全收口 + 门禁/typecheck/lint/金样全绿 + KPI 预演达标。**真实 API 出场待作者 key 实测**（`tests/smoke/real-provider-smoke.mjs`）——故 p2-plan 暂不归档。下一阶段 = P3（Agent 化对话） |

| WP3.1a 持久化底座 | ✅ | 2026-09-26 S22 完成（migration v8：10 表 + runs 十四列；`runtime/src/execution/{status,store,recovery}`；§5.4 新增 23 条事件登记；架构守卫 B4；33 条新单测；详见 p3-plan §4） |
| WP3.1b Agent 运行时 | ✅ | 2026-09-26 S23 完成（`packages/agent/src/runtime/` 六模块 + migration v9（runs.status 回填）+ §174 Test 1/9 + agent 9/9；详见 p3-plan §5） |
| WP3.2 Tool Runtime + 审批 + 权限 | ✅ | 2026-09-26 S24 完成（tools/ 四模块五段流水线 + prepareIteration 工具循环 + 审批四值 fail-closed + model order 回灌；§174 Test 2/3/4/8；agent 19/19；详见 p3-plan §6） |
| WP3.3 Workflow DAG + Director | ✅ | 2026-09-26 S25 完成（workflow/ 四模块：波次并发 + 失败策略 + 有界环 + 账本 Resume + 受限 DSL + Director 三路径；§174 Test 7；workflow 15/15；详见 p3-plan §7） |
| WP3.4 Context Policy + Artifact + Output | ✅ | 2026-09-26 S26 完成（context/policy + artifacts + output/commit + state/mutation + 缓存交互 §104–§106；S26 12/12、agent 46/46；详见 p3-plan §8） |
| WP3.5 Resume / Recovery / Replay | ✅ | 2026-09-27 S27 完成（pauseToken + resumeRun + 崩溃恢复 §96/§97 + Replay §143–§146 逐字节一致；§174 Test 5/6/10；S27 5/5、agent 51/51；详见 p3-plan §9） |
| WP3.6 P3 收官 | ✅ | 2026-09-27 S28 完成（还账 #17 Agent Tree 递归护栏 + §154 Agent API 面 12 路由 + 观测面 timeline/cost/inspector + CI 门禁 D5 + 出场登记；**全量 507 测试 / 56 文件全绿 + typecheck 全包 0 + ESLint 0 + 守卫 19/19**；§38 决策 46；详见 p3-plan §10–§13） |
| **P3 完成** | ✅ | 2026-09-27 出场（§36）：agent-runtime-spec §173 七组全勾销 + §174 十场景全绿；单/多 Agent 的 Delegate / Cancel / Resume / 崩溃恢复可用（Retry Agent 自动编排与 Memory Runtime 明确挂账 P4）。下一阶段 = P4（并行解锁 B1） |
| WP4.1 memory 持久化底座 | ✅ 完成 | 2026-09-27 S29：memory-runtime-spec.md V0.1 骨架（四层/双检索/Scribe/zone/事件/契约）+ database-schema §23/§25.1–§25.5/§26 表定义修复（去冗余 UNIQUE、metadata_→metadata、§25.5 存储位置口径）+ migration v10（八表 + FTS5 双组触发器）+ runtime `memory/` 持久化层（Repository/Writer + 双检索引擎）+ catalog memory.created/updated 登记。**测试全绿闭环**：runtime 15 条（migrate 7 / repository 8）+ 全仓 517 测试/57 文件 + typecheck 全包 0 + ESLint 0；守卫漂移修复（catalog 域白名单补 memory / migrate.test 变量类型泄漏 / repository spread 类型）。环境：better-sqlite3 用 node 22（muyootools v22.14.0），系统 node 24 ABI 不匹配（technical-plan §8.7 教训①） |
| WP4.2a Summary 链 + 四层记忆 + 双检索 | ✅ 完成 | 2026-09-27 S30：四层 Memory Runtime（memories CRUD + entity 约束 + timeline 读取 + Data Bank 分块入表 + chunks_fts 检索）+ Summary 链（appendSummaryBlock 冻结块 sequence 单调 / listSummaryChain / buildSummaryContributions 注 summary 区）+ 双检索引擎（FTS5 关键词 + embedding 余弦 + via=both 合并去重）+ agent Memory Policy 兑现（R-P3-9：resolveMemoryPolicy 四策略 + resolveMemoryItems 纯过滤 + runAgent memoryRetrieval 接线注 tail）+ **修复 S26 缺口（prepareIteration.filterContributions 此前已声明但从未被消费,现于 compile 前应用）** + memory-runtime-spec 升 V0.2（锚点转已实现契约）。**测试全绿闭环**：全仓 534 测试/59 文件 + typecheck 全包 0 + ESLint 0 + **P2 缓存门禁保绿**（100 轮稳定前缀/KPI 98.7%） |

（P4–P5 WP 在各阶段开工细化时进看板。）

---

*关联文档：[technical-design.md](./technical-design.md)（§36 路线图权威 / §38 决策 31）· [technical-plan.md](./technical-plan.md)（§8 测试基建 / §9 路线图指针）· [AGENTS.md](../AGENTS.md)（会话纪律）· 全部模块规格（设计真相源）*
