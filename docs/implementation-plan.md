# WhisperTavern V2 — 实施计划总纲（Implementation Plan）

> **文件：** `docs/implementation-plan.md`
> **版本：** V2.3（2026-09-06：P1 细化——§5 挂 p1-plan 指针、§4.11 P1 DoD/Non-goals、还账 #4/#15 绑定 WP1.5；V2.2：P0 完成；V2.1–V1.2：S7–S2 逐会话；V1.1 评审吸收；V1.0 首版，§38 决策 32/35）
> **状态：** Active（随执行滚动更新——WP 状态看板在 §12，每完成一个包即更新）
> **文档层级：** [technical-design.md](./technical-design.md) 之下的**执行层文档**。与 AGENTS.md 的分工：AGENTS 管**会话纪律**（怎么读、怎么改、何时问），本文管**执行顺序**（做什么、先做哪个、做到什么程度算完）。
> **决策锚点：** technical-design §38 **决策 32**。
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
- **还账**：shared-contracts-spec 从骨架充实为 P0 范围真相源（收编 compiler-spec §6–§17、instruction-security §9、provider-adapter §6 的草案类型）。
- **入场**：WP0.1。

## WP0.3 core：段模型 + Snapshot 结构 + token 计数双模式
- **交付**：core 包段模型实现（`ir/`）、PromptSnapshot 数据结构（不可变 + 八区哈希 §67）、本地估算器 + native 钩子（§52 双模式）。
- **入场**：WP0.2。

## WP0.4 Compiler 最小管线
- **交付**：P0 范围组装（preset 段 / persona / 角色卡描述 / 历史 / tail）+ Diagnostics 体系 + CompileMode（strict / preview）+ 编译结果与快照落点；Zone 类型全套就位但 stableWB/freshWB/summary 留空实现（P1/P2 填充）。
- **金样**：instruction-security G2（override 空槽零字节差异）、G4（档位不随文本变）——P0 范围内的两条。
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
- **交付**：四家 provider 流式聊天全链路演示；重启恢复；usage 入库可查；Snapshot 可查（Inspector 最简形态：能看每轮发了什么）；CI 全绿（不变量断言 + 金样 G2/G4 + fixture 七条）。
- **出场 = P0 完成**，在 §38 记录并更新 §12 看板。

## 4.10 P0 Definition of Done（含 Non-goals）

验收清单（全绿 = P0 完成，对应 WP0.9）：

```text
☑ 四家 provider（OpenAI 兼容 / DeepSeek / Anthropic / Gemini）各跑通一条真实流式链路——机制全就绪;真实冒烟脚本 tests/smoke/real-provider-smoke.mjs 待用户以自有 key 执行(§38 决策 35)
☑ streaming 正常渲染；中途取消产生 partial 且已生成部分可查——apps/server e2e(DoD 2)
☑ generation + usage 入库；重启后完整恢复（消息树 / 运行记录 / 快照可查）——apps/server e2e(DoD 3,usage_source 分对)
☑ Snapshot 能重建模型实际收到的内容（§5.5 不变量断言 CI 绿）——e2e:serialized.parts ≡ request.messages(DoD 4)
☑ 无任何路径绕过 Compiler 拼 prompt（断言门禁）——fake 调用入口四不变量闸口,故意违规变红(DoD 5)
☑ 金样 G2/G4 + fixture T1/T4/T6/T10/T11/T12/T14 全绿——core + adapters 套件(DoD 6)
☑ lint + tsc strict + 全量测试 CI 绿——177 tests / 四段门禁(DoD 7)
```

**P0 明确不做**（防止会话把 P1–P5 提前实现）：

```text
✗ 世界书激活语义与 stableWB/freshWB 分区（P1/P2）
✗ Macro Engine / CachePlan / 预算裁剪 / Elastic History（P2）
✗ override 槽位 UI 与 Inspector 完整形态（P1——P0 只交付元数据基线与 G2/G4 金样）
✗ Memory / Summary / Agent / Workflow / Tool / 群聊 / 插件 / 桌面化（P3–P5）
```

P1–P5 各自的 DoD（含 Non-goals）由各阶段开工的首个细化会话产出（B4），追加到对应小节。

# 5. P1 工作包分解（**已细化**——会话级明细见 [p1-plan.md](./p1-plan.md),S9–S15;范围裁决 R-P1-1–R-P1-6;DoD 见 §4.11）

| WP | 内容 | 关键锚点 / 还账 |
|---|---|---|
| WP1.1 | 资产导入：卡 V2/V3/PNG/charx + 原生 .dgcard/.dgworld/.dgpreset | technical-plan §5.3/§5.10；导入不改档（instruction-security §20） |
| WP1.2 | 世界书激活层全集（触发/递归/sticky/cooldown/group/蓝绿灯） | compiler-spec §23–§29；**此包出场即解锁 P2 并行**（B1） |
| WP1.3 | 预设映射 + Persona 库 + ST Prompt Mapping | compiler-spec §80–§81 |
| WP1.4 | 编辑/swipe/分支完整交互 + 消息树 API 完整 | api-spec §16–§23 |
| WP1.5 | Prompt Inspector v1（段/哈希/diff 视图） | **前置还账**：ui-design 补 override 编辑器 + 档位徽标小节；api-spec SegmentSnapshot 补 authority 只读字段（instruction-security §25） |
| WP1.6 | 金样测试体系完整（真实资产导入→编译→序列化） | technical-plan §8.2；override 槽位 UI 随 WP1.5 交付（默认关） |

出场（§36）：目录内真实资产导入跑通、金样绿、Import Compatibility Report 产出（含"档位与越权槽位"小节）。

## 4.11 P1 Definition of Done（含 Non-goals,S8 细化会话产出）

验收清单（全绿 = P1 完成,对应 p1-plan S15）：

```text
☑(待执行) 目录内真实资产(ST 卡 V2/V3/PNG/charx、世界书两代格式、预设)导入跑通,产原生 .dg 格式
☑(待执行) 世界书激活层全集语义单测 + 真实书金样(compiler-spec §23–§29)
☑(待执行) 预设映射(ST Prompt Order §80–§81)→ contributions 顺序
☑(待执行) 消息树完整交互(编辑变体/swipe 生成填充/分支激活,§16–§23 契约测试)
☑(待执行) Prompt Inspector v1(段/哈希/diff + authority 徽标;override 槽位 UI 默认关)
☑(待执行) Import Compatibility Report(含"档位与越权槽位"小节,instruction-security §25)
☑(待执行) 金样测试体系(真实资产脱敏 → 导入→编译→序列化,technical-plan §8.2)
☑(待执行) lint + tsc strict + 全量测试 CI 绿
```

**P1 明确不做**（P2 起接管）：

```text
✗ stableWB 毕业/退休/物理序 append-only、CachePlan、Budget 裁剪、Elastic History(P2)
✗ Macro Engine 展开(P2;P1 延续 R-P0-1 宏透传)
✗ Compatibility/Performance 模式分野与缓存标记翻译(P2/WP2.4)
✗ Agent/Tool/Workflow(P3);Memory/群聊/RP(P4);PNG 导出双写/桌面化(P5)
```

# 6. P2 工作包分解（初版，最大差异化——优先打磨）

| WP | 内容 | 关键锚点 / 还账 |
|---|---|---|
| WP2.1 | Macro Engine（registry / security / cache rule） | compiler-spec §37–§45 |
| WP2.2 | stableWB/freshWB 分区 + physicalOrder append-only + 毕业/退休 | worldbook-cache-design §2–§4；compiler-spec §20–§31 |
| WP2.3 | per-chat 哈希缓存 + CachePlan + Budget + Elastic History | 总设计 §14–§17 |
| WP2.4 | 缓存标记翻译（Anthropic cache_control / Gemini explicit caching 评估）+ 多 key 轮换 | worldbook-cache-design §5；provider-adapter §23 开放点 1 在此定 |
| WP2.5 | 遥测面板 + 缓存二分工具 + Cache Simulator | ui-design §4.6；总设计 §20/§33 |
| WP2.6 | CI 硬门禁：100 轮稳定性 + 1000 轮模拟无未声明失效 | technical-plan §8.1 |

出场（§36）：CI 绿 + 真实 API 稳态命中率 ≥70% + 输入成本削减 ≥60%。

# 7. P3 工作包分解（初版）

| WP | 内容 | 关键锚点 |
|---|---|---|
| WP3.1 | 执行四层 Run/Attempt/StepRun/Operation + 事件 durability 全量 | agent-runtime-spec §4 / §5.4 |
| WP3.2 | Tool Runtime + 审批 fail-closed + **untrusted 工具回灌流** | agent-runtime §36/§115；instruction-security P3 还账；provider-adapter §23 开放点 3（thinking 回传默认）在此定 |
| WP3.3 | Workflow DAG + Director 三路径 | 总设计 §23 |
| WP3.4 | Artifact 冻结/提升（提升 = 显式确认，不自动） | compiler-spec §87；instruction-security §14 |
| WP3.5 | Resume/Replay + §174 十个必测场景 | agent-runtime §173/§174 |

# 8. P4 工作包分解（初版）

| WP | 内容 | 关键锚点 / 还账 |
|---|---|---|
| WP4.1 | **前置：memory-runtime-spec 骨架**（四层记忆/双检索/Scribe 实施语义） | 挂账还清后 WP4.2 才开工 |
| WP4.2 | Summary 链 + 四层记忆 + FTS5/sqlite-vec 双检索 | 总设计 §25；database §25 |
| WP4.3 | 网络搜索工具（结果注 tail / agent 工具，untrusted 通道 + origin 溯源） | instruction-security §13/§15 |
| WP4.4 | 群聊 + per-char 缓存命名空间 | 总设计 §26；worldbook-cache-design §6 |
| WP4.5 | Roleplay Fast 档（三表 + BD 规则推导 + Story Thread） | roleplay-runtime-spec；R1 单调用 |
| WP4.6 | scope 边界确认还账（roleplay scope 与 BD/世界书文本指令归属） | instruction-security §25 |

# 9. P5 工作包分解（初版）

Plugin SDK + iframe sandbox + 权限；备份/导入导出 + 酒馆聊天记录导入；Tauri 桌面壳；i18n + Skill 对齐 agentskills.io；Roleplay Deep 档（LLM Director/Critic/Quality Gate）；**前置还账：evaluation-engine-spec 充实**；差分测量工具（instruction-security §23.1 全套）+ 指纹对照报告。

# 10. 还账总表（跨 spec 挂账的执行映射）

三份 spec 各自有同步清单；此处汇总为执行序，**每项绑定 WP，出场必须勾销**：

| # | 挂账 | 绑定 WP | 出处 |
|---|---|---|---|
| 1 | ~~shared-contracts 充实（chat 面）~~ **✅ 2026-09-05 WP0.2 勾销**（spec 升 V2.0：§2.1 模块清单 / §2.2 Schema 同源 / §2.3 开放形状 / §2.4 C1–C4 自查 / §9.1 落地证据） | WP0.2 | shared-contracts / instruction-security §25 / provider-adapter §22 |
| 2 | ~~ProviderCapabilities 定稿 + 本地 tokenizer 选型~~ **✅ 2026-09-05 WP0.5 勾销**（§18.2 全形 + instructionLayers 收编 contracts；tokenizer 选型 = P0 启发式估算、tiktoken 归 P2,adapter-spec V1.1 §23） | WP0.5 | 总设计 §18.2；adapter §23 开放点 2 |
| 3 | ~~api-spec generation SSE 投影复核~~ **✅ 2026-09-05 WP0.7 勾销**（三层映射落地:provider 归一 → bus generation.*(§5.4 分档)→ SSE 信封{id,type,runId,timestamp,sequence,data},run 内 sequence 单调 + Last-Event-ID 续传;契约测试锁定) | WP0.7 | provider-adapter §22 |
| 4 | ui-design 补 override 编辑器 + 档位徽标；api-spec 补 authority DTO | WP1.5 | instruction-security §25 |
| 5 | 剩余诊断码随触发源落地（P0 两码 → P3 全量） | WP0.4 / WP3.2 | compiler-spec §71 |
| 6 | Gemini explicit caching 评估 | WP2.4 | adapter §23 开放点 1 |
| 7 | untrusted 工具回灌 + 结构化/审批提升 | WP3.2 | instruction-security §14 |
| 8 | memory-runtime-spec 骨架 | WP4.1 | 上次文档盘点结论 |
| 9 | roleplay scope 边界确认 | WP4.6 | instruction-security §25 |
| 10 | evaluation-engine-spec 充实 + 差分测量工具 | P5 | 各挂账 |
| 11 | 重启恢复逐状态矩阵核对 + non-idempotent 工具对账（reconciliation）——§50/§51–55 已有幂等分类与 Resume 骨架，补"每状态重启后行为"表 | WP3.1 | agent-runtime-spec §50/§51–55 |
| 12 | 工程性能预算三档（target / warning / hard-limit；compile 侧已有 compiler-spec §126，补 worldbook 匹配 / SQLite / UI / 检索） | WP2 细化 | compiler-spec §126 |
| 13 | 升级/备份/回滚流程（backup → migration → validate → rollback） | WP5 | 总设计 §36 P5 |
| 14 | **开源发布套件**：LICENSE 落盘（§38 决策 33）、SECURITY.md / CONTRIBUTING.md（引用 AGENTS 决策协议与纪律 5，不复写）/ CODE_OF_CONDUCT.md / Issue·PR 模板（architecture_proposal 对齐 §37 四问）/ 产品化 README；依赖许可证兼容性纪律（运行时依赖禁引入 GPL/AGPL） | 开源/推送公开仓库**前**（用户触发，不绑阶段 WP） | 2026-09-05 开源评审择优 |
| 15 | **Sanitized Debug Export / Reproduction Bundle**：RedactionPolicy（去用户聊天内容 / 匿名化 ID / 默认 sanitized 非 full；密钥沿用 PV5 redact），导出可 Replay | WP1.5（Inspector v1）细化会话 | 总设计 §19/§32；provider-adapter §17.2 |
| 16 | Plugin 信任分档（built-in / trusted / community / untrusted）补入 §29 权限模型——P0–P4 只按 §21.5 Capability 执行 | WP5 细化会话 | 总设计 §29/§21.5 |

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
| WP0.3 core 段模型/Snapshot/token | ✅ | 2026-09-05 S3 完成（构造器深冻结 + 八区哈希 netstring 规范框架化 + authorityFingerprint + 双模式 token 估算；零 IO 约束测试 + lint 双保险；16 条新测试） |
| WP0.4 Compiler 最小管线 | ✅ | 2026-09-05 S4 完成（P0 管线 + strict/preview + §10 推导表 + I4/R2/R3/I3/I5 断言 + 宏透传 R-P0-1 + 硬上限 R-P0-2 + Trace；金样 G2/G4 绿；14 条新测试） |
| WP0.5 adapters ×3 | ✅ | 2026-09-05 S4'-a/b/c 完成（openai-compat / anthropic / gemini + 共享 SSE/HTTP/超时层 + fixture 全家桶 T1/T4/T6/T10/T11/T12/T14 ×3 家;还账 #2 勾销;73 条 adapter 测试） |
| WP0.6 runtime 事件/持久化 | ✅ | 2026-09-05 S5 完成（Event Bus 分档落库 + §77/78 迁移器（备份/integrity/回滚）+ 消息树五操作 + dispatchGeneration 四不变量闸口；38 条新测试） |
| WP0.7 server 传输层 | ✅ | 2026-09-06 S6 完成（Hono 骨架 + §152 P0 路由 + 信封/Request ID + SSE 续传 + SecretStore R-P0-6 定案(§38 决策 34)+ migration v2(runs/prompt_snapshots);11 条契约测试;§152 的 characters/worldbooks/presets CRUD 挂 S8 补齐(需 §6-§11 资产表迁移)） |
| WP0.8 web Chat UI | ✅ | 2026-09-06 S7 完成（脚手架 + api-types 填充 + SSE 客户端 + 工作台 + 设置页 + 快照面板；真机冒烟全链路绿；类型零 any） |
| WP0.9 P0 端到端验收 | ✅ | 2026-09-06 S8 完成（e2e ×3 + 资产 CRUD 补齐 + 冒烟脚本;DoD 见 §4.10 勾选;真实四链路待用户 key 冒烟） |

（P1–P5 WP 在各阶段开工细化时进看板。）

---

*关联文档：[technical-design.md](./technical-design.md)（§36 路线图权威 / §38 决策 32）· [technical-plan.md](./technical-plan.md)（§8 测试基建 / §9 路线图指针）· [AGENTS.md](../AGENTS.md)（会话纪律）· 全部模块规格（设计真相源）*
