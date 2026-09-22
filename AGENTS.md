# WhisperTavern — AI 协作会话引导（AGENTS.md）

> 本文件是每个 AI 会话的**第一入口**：开工先读完本文件，再按 §1 顺序读文档。
> 维护纪律：本文件与 docs/ 体系冲突时，以 docs/ 为准并修订本文件；修订须在末尾登记日期。

**项目一句话**：仿 SillyTavern 的本地 AI RP 客户端，两大差异化——缓存友好型世界书（稳态命中率 ≥70%、输入成本削减 ≥60%）+ Agent 化对话（Agent Runtime / Roleplay Runtime 替代 MVU 填表插件）。

**当前状态**（2026-09-22）：**P1 已完成并出场**（§38 决策 38）——S9–S15 全部收口（卡/书/预设导入 + 世界书激活层 + 消息树 + Inspector + 金样测试体系），DoD 八条全勾销（§4.11），**全量 293 测试绿（36 文件）**，typecheck 全包 0，ESLint 绿。**S15 金样首战即抓出并修复 3 处 st-compat 真实生态缺口**：①ST position string 方言（多数卡内嵌书/老书写 "0".."7"）→ schema 收 number|string + toPositionInt 归一；②现代书条目 null（caseSensitive/matchWholeWords/useGroupScoring）+ role 魔数（0/1/2）→ 收 nullable + toRole 归一；③ST prompt_order 分组形态 [{character_id,order:[...]}] → flattenOrderIdentifiers 扁平化（此前全部预设 segments=0）。金样基线口径沉淀：跨进程只锁 serialized.parts（role/content），不锁 hash/id（含每次导入新建 UUID）。删除 4 个 X3 违例 probe，golden-verify 转正为 committed 测试。**P2 细化会话已完成**——[docs/p2-plan.md](./docs/p2-plan.md) 落盘（S16–S21 会话切分 / R-P2-1–9 范围裁决 / 出场 KPI=真实 API 命中率 ≥70% + 成本削减 ≥60%）。**S16（WP2.1 Macro Engine）已收口**（§38 决策 39）——宏引擎落 `packages/core/src/macro/`（types/parser/rng/registry/engine），pipeline 接线替换 P0 宏透传（R-P0-1 退役）；未知宏保留原文+info、{{random}}/{{roll}} 确定性种子流、Macro Cache Rule 三档落定。**S17（WP2.2 stableWB/freshWB 分区）已收口**（§38 决策 40）——worldbook-cache.ts 纯函数分区层 + worldbook.ts 接线；毕业=哈希命中、physicalOrder append-only、migration v7(first_seen_msg)、Compatibility 回退、决策 A（stableWB/freshWB 默认 session）/B（normalize 恒等）/C（排序键=physicalOrder）；**全量 329 测试绿（38 文件）**，typecheck 全包 0，ESLint 绿，金样基线零漂移。下一会话 = **S18（WP2.3 per-chat 哈希缓存 + CachePlan + Budget + Elastic History）**,见 [docs/p2-plan.md](./docs/p2-plan.md) §11 看板。

## 1. 开工必读顺序（每次会话，顺序执行）

1. **本文件**（§2 文档地图 → 按任务找对详设）。
2. **docs/technical-design.md**：§0 核心设计原则（铁律）→ **§38 已定决策记录（38 项，唯一权威）** → 与任务相关的章节。
3. **`.workbuddy/memory/` 最近日记**（会话连续性；决策 26 ③）。
4. 本次任务涉及的 spec（见 §2 地图）——先读其**头部版本行与修订说明**，确认没有并发会话改过。
5. 到 **[docs/implementation-plan.md](./docs/implementation-plan.md)** 认领工作包（WP）：核对 §12 状态看板与该包的入场/出场条件，未满足入场条件不得开工。

## 2. 文档地图（按任务找对详设——"三岔"分工，决策 26 ② + 31 修订）

| 任务涉及 | 真相源 |
|---|---|
| Prompt Compiler / IR / 缓存分区 / 宏 / 诊断码 | [docs/specs/prompt-compiler-spec.md](./docs/specs/prompt-compiler-spec.md)（+ [worldbook-cache-design.md](./docs/worldbook-cache-design.md)） |
| 数据库 / 表结构 / 运行态 | [docs/specs/database-schema.md](./docs/specs/database-schema.md) |
| Agent Runtime / 工具 / 审批 / Workflow | [docs/specs/agent-runtime-spec.md](./docs/specs/agent-runtime-spec.md) |
| HTTP/SSE API 契约 / DTO | [docs/specs/api-spec.md](./docs/specs/api-spec.md) |
| Provider Adapter（流式/工具/错误归一、多 key、能力探测） | [docs/specs/provider-adapter-spec.md](./docs/specs/provider-adapter-spec.md)；接入实务（四类接入/插头/代理/密钥）在 [docs/technical-plan.md](./docs/technical-plan.md) §5.1 |
| Roleplay / Dialogue Director / Quality / 评价引擎 | specs/roleplay-runtime-spec.md 及其三个子规格 |
| 跨模块核心类型 | [docs/specs/shared-contracts-spec.md](./docs/specs/shared-contracts-spec.md)（`packages/contracts` 单一真相源） |
| UI / 交互 | [docs/ui-design.md](./docs/ui-design.md) |
| 工程实施 / 测试基建 / st-compat / 资产格式 | [docs/technical-plan.md](./docs/technical-plan.md) |
| 执行顺序 / 工作包分解 / 还账看板 | [docs/implementation-plan.md](./docs/implementation-plan.md)（总纲）· [docs/p1-plan.md](./docs/p1-plan.md)（P1 明细，当前阶段）· [docs/p0-plan.md](./docs/p0-plan.md)（P0 明细，已归档） |

**文档优先序**（决策 27）：模块规格（对象形状/状态机）> API 规格（线格式投影）> 总设计（架构口径）。事件名唯一权威 = technical-design §5.4；Capability 唯一权威 = §18.2。

## 3. 编码纪律（决策 26 摘要；全文见 technical-plan §7）

1. **注释分层**：导出 API/模块头用 TSDoc；必注触及 spec 铁律的 **why**（指向 spec 节号并带节标题）；禁注 what 型逐行翻译；量化锚点——**行内** `//` 注释与代码行比 ≈ 1:10（TSDoc 与模块头不计入）。
2. **spec 是真相源**：不另产平行详设；改代码触及 spec 语义必须同步修订 spec（含头部版本行）；冲突时**能改代码就改代码**，确属 spec 错误才改 spec 并记入 §38。
3. **新核心模块先落 spec 骨架再写码**（带状态机/对外契约/缓存语义的模块）。
6. **代码风格底线**：显式类型（禁 `any` 出口）、禁 magic string（枚举/常量收 contracts）、小函数、单向依赖；机械执行交给 ESLint + `tsc --strict`，本条只立底线。
7. **纪律必须有机器卡点**：凡是能一句话说清、能用一行断言表达的纪律，写进 **`tests/architecture.test.ts`（架构守卫 / fitness function）**，不要只写在文档里。新增门禁当下必须是绿的。
   **门禁红了必须当天修**——红了不修的门禁等于没有门禁（2026-09-08 教训：CI 的 lint 段自 9/6 建立起就因 Node globals 缺失虚红两天，无人察觉，形同摆设）。

## 4. 决策协议（何时直接做、何时停下来问）

判断标准不是"任务类型分类表"，而是**是否触碰公共语义**：

```text
直接做（做完按纪律 4 记录）：
  单模块内、不新增对外契约、不改变任何 spec 语义的局部实现与 bug 修复
  （正确性基准 = spec / 不变量，不是"跑起来了"）

先停下来问（一句话影响分析，等用户确认）：
  a. 新增抽象 / 新包（纪律 5 清单）
  b. 跨模块语义变更：事件名、表结构、状态机、Zone/缓存口径、信任档位
  c. 公共契约破坏性变更——spec 修订说明必须标注 Breaking: Y/N + 迁移路径
     （版本机器已存在：api-spec §3 versioning + If-Match、compiler-spec §6、
      快照不可变 + derivedFromSnapshotId、资产版本快照；本条只补标注纪律）
  d. §38 没有的新架构决策
```

**红线：不用 Prompt 修架构问题。** 行为异常先查 Compiler / Runtime 语义层，而不是往 system prompt 里加字；任何 Prompt 相关改动一律过 §8 验收四问。

## 5. 工作纪律（含并发防护）

- **改文档前先整读目标文件 + 读 §38**；**改完立即 grep 复核**。本仓库曾有外部并发改写/回退记录：同一行反复被回退时**停止编辑并报告用户**，勿无限重试。
- 同一会话内小步编辑，优先 Edit 而非整文件重写。
- 引用 spec 节号时带节标题（如 `compiler-spec §12（Semantic Placement）`）。
- **实验要留痕**：涉及模型行为 / Prompt / Provider 对比的实验，记录落

## 6. 仓库结构速览

```text
AGENTS.md            ← 本文件（会话入口）
docs/                ← 文档体系（technical-design.md 为唯一总设计脊柱）
docs/specs/          ← 模块规格 / 子规格 / 跨模块规格（数量持续增长，以目录与总设计 §40.1 树为准，此处不写死数量）
reference/SillyTavern/  ← 外部参照代码（只读，不是本仓库代码）
*.json / 表格预设/    ← 用户真实资产（Kemini、狐神抚预设、地点.json 等）
                        = 测试金样与生态参照（technical-plan §8.2 引用）——勿修改、勿上传
```

## 7. 勿做清单（红线）
- SQLite 是唯一目标库；事件名不用大写枚举、一律取 §5.4 权威域；适配器只翻译不做语义（provider-adapter PV1）。

## 8. 验收锚点

任何新功能进 Core 前过**版本验收四问**（technical-design §37）：会改变 Prompt？会破坏 Cache？会影响 Agent？有没有办法 Debug？Compiler 模块另加**五问**（compiler-spec §147）。测试基建见 technical-plan §8（前缀稳定性 CI 硬门禁 / 金样 / fixture 录制回放 / 不变量断言）。

## 9. 修订记录

- 2026-09-05 初版（随 provider-adapter-spec 骨架一同落成，决策 31）。
- 2026-09-05 二版（吸收外部评审，择优采纳：新增 §4 决策协议、纪律 5 架构扩展限制 / 纪律 6 代码风格底线、实验留痕；§6 去数量化防过期。**拒绝**另立 `ai-agent-development-policy.md`——平行文档违反决策 26 ②；拒绝复述 §37 四问式 Prompt 清单——已有验收门禁，只留"不用 Prompt 修架构问题"红线）。
- 2026-09-05 三版（小步同步：当前状态更新为 S1 完成、决策计数 31→33；License 定 **Apache-2.0**（§38 决策 33），开源挂账登记 implementation-plan §10 #14–#16。开源评审"重排 13 包结构"方案拒绝——违反 §7 结构 / 纪律 5 / shared-contracts C4）。
- 2026-09-06 四版（**项目更名：DesireGrimoire → WhisperTavern**，用户指令。全仓机械替换两形态：`@desiregrimoire/*` 作用域包名 → `@whispertavern/*`（118 处，含 pnpm-lock 同步 sed + `pnpm install` 重链接）；`DesireGrimoire` 品牌串/类型名 → `WhisperTavern`（91 处，含 `DesireGrimoireDb`→`WhisperTavernDb`）。工作区目录同步改名。**保留项**：`.dg*` 资产扩展名（.dgcard/.dgpreset/.dgworld）与 `dg` 内部前缀暂不迁移——属公共契约破坏性变更（决策协议 c），是否改 `.wt*` 另议需登记 §38。验证：grep 复核清零 + 全量测试。
- 2026-09-06 五版（**更名重链接修复与四版记录更正**，决策 36）：四版所谓"pnpm install 重链接"实测并未在改名后生效——pnpm 工作区 junction 的 Target 是绝对路径，文件夹改名不自动更新，即使 grep 清零 + lockfile 干净，junction 仍指向已不存在的旧路径 `D:\Workspace\DesireGrimoire\...`，node_modules 呈死链接失效态。重跑 `pnpm install --frozen-lockfile` 修复（重装遇 better-sqlite3 `ERR_PNPM_ENOENT` 的 Windows 已知瞬态，清理残留后重跑成功），修后 `@whispertavern` 全部 junction 指回 `WhisperTavern` 路径、`@desiregrimoire` 死链接清除、旧名 grep 清零、全量 192 测试绿。**沉淀约定（§38 决策 36）：目录/工作区改名不得只以 grep 清零为验收，必须重跑 `pnpm install` 并核验 workspace junction 的 Target。**
- 2026-09-07 六版（**外部多智能体提案评审**，决策 37）：评审"主 Agent 动态调度 Character / Event / State / Memory / Writer 子智能体 + Simulation Agent + Agent Orchestrator"方案，结论 = 约 80% 已被现有 spec 覆盖且口径更严，**仅 3 项真增量**（Agent Tree 递归护栏 / World State 全局态 / Simulation Agent）。作者拍板**采纳①护栏（P3）+ ③World State 规则版（P4，禁额外 LLM 调用）**，②Simulation Agent 暂缓至 P5 决策点。三条明确拒绝：重写 api-spec 为 Agent Orchestration API Spec（毁决策 16/19/27 事件名权威与版本机器）、每轮走 Director 多 Agent（撞 R1/C1）、Style Policy 塞 system prompt（踩"不用 Prompt 修架构问题"红线）。**新增全局判据（后续任何多 Agent 提案先过此条）：每轮 N 次调用 = N 个独立新前缀、只共享前缀可命中，与核心 KPI（命中率 ≥70% / 成本削减 ≥60%）直接冲突——多 Agent 只能是 Balanced/Deep 可选档，新增子 Agent 必须申报"几次调用、能否共享前缀"。** 挂账 implementation-plan §10 #17/#18/#19。
- 2026-09-07 七版（**S9/S10 完成后状态同步**）：当前状态改为 S11 待办；WP1.1a/WP1.1b 进 implementation-plan §12 看板。**新增两条可执行约定**：③原生资产格式新增语义字段时须同步 technical-plan §5.3/§5.10 样例（S10 已补 `activation.scanDepth/caseSensitive/matchWholeWords`、`group.scoring`，slot 枚举对齐 contracts `WorldbookPositionSchema`）；④本机跑含 better-sqlite3 的测试须用系统 node 24（`C:\Program Files\nodejs\node.exe`），托管 node 22 的 NODE_MODULE_VERSION 不匹配会整片失败。
- 2026-09-08 八版（**可维护性体检 + A 档架构守卫落地**）：**新增纪律 7：纪律必须有机器卡点**，落地 `tests/architecture.test.ts`（A 事件名权威域 / B 依赖方向 / C 禁 any / D 测试门禁完整性 / E Capability 权威域），并在根 `vitest.config.ts` 以 inline project 挂载。守卫首跑即抓出真实漂移：`contracts` 的 ProviderCapabilities 分层能力字段未登记于 technical-design §18.2，已补 spec（该字段此后随指令安全特性撤下）。**同批修复 CI lint 段自 9/6 起的虚红**（`tests/smoke/*.mjs` 缺 Node globals）。全量 219 测试绿。
- 2026-09-08 九版（**撤下指令安全特性**，承接 §38 决策 37）：删除指令安全模块（spec 已删、原相关决策已移除并按序重排编号）；**连代码 / 契约 / 诊断码 / 能力 / 测试 / 架构守卫同步撤下**——authority/trust/scope 类型、快照 authority 指纹字段、ProviderCapabilities 指令分层能力字段、override 槽位 / I3 缓存安全规则、越权与不可信诊断码、st-compat 档位报告与金样 G2/G4。文档侧同步改写/删除 compiler / shared-contracts / provider-adapter / api / ui-design / implementation-plan / p1-plan / p0-plan 相关表述；`prompt_snapshots` 表保留 authority 指纹列向后兼容。**决策计数 36→37**；§4 决策协议 b 的 "authority 档位" 措辞改为通用跨模块语义（信任档位）。
- 2026-09-12 十版（**状态同步：撤下指令安全后的收口**）：当前状态补记“指令安全特性已撤下（§38 决策 37，撤下改动当前在工作区未提交）”；P0 里程碑 commit 对齐当前分支（`63aa7e1` → `adcef03`）；清理 `implementation-plan` §4.10/§12 中已撤下的 G2/G4 验收引用，并去掉 P0 测试数硬编码（改引 p1-plan §11）；在 `technical-design` 决策 34 补 G2/G4 撤下注记；在归档的 `p0-plan` 状态行补“G2/G4 仅为当时执行留痕”注记；S11 仍阻塞于 chat↔worldbook 绑定契约。
- 2026-09-12 十一版（**S11(WP1.2)收口**）：补齐 chat↔worldbook 绑定契约解除 startRun 接线阻塞——contracts 新增 `ChatWorldbookBinding`（shared-contracts-spec §5.1）、DB `chat_worldbooks` 表 + migration v6、server 绑定路由（GET/POST/DELETE `/api/v2/chats/:id/worldbooks`）；ST position 0-7→slot 映射上提至 contracts（`WORLDBOOK_SLOT_BY_ST_POSITION`/`ST_POSITION_BY_SLOT`）满足 C4 避免 runtime→st-compat 反向依赖；runtime `buildWorldbookContributions` 接线 `run.ts` startRun（激活→freshWB/injection 贡献 + 运行时态落库 + 审计）。新增 `WORLDBOOK_NOT_FOUND` 错误码注册（api-spec §8 错误信封 → 404）。**全量 233 测试绿（28 文件）**；原十版状态行“242 测试绿”为过计数，以本次实测 233 为准。下一会话 = S12（WP1.3 预设映射 + Persona）。
- 2026-09-15 十二版（**S13(WP1.4)收口 + 还账 #20 勾销**）：消息树完整交互落地——runtime `deleteMessage`（软删 + message.deleted + leaf 回退最近未删祖先）/`deleteChat`（§15 软删与 purge；purge 按 FK 拓扑序清 chat_branches→messages→generations（经 runs 子查询）→runs→prompt_snapshots→绑定/运行时态/审计→chats）/`startRun` 新增 `variantMessageId`（**swipe 生成完成写入变体壳本身**，api-spec §20/§22“写入 variant 而非新消息”，P0 挂账解除；壳不入 prompt，事件用 chat.updated action=variant_filled——§5.4 无 message.filled，目录不私增名）/`loadActiveChain` 跳过软删消息/`swipeMessage` §20 角色校验（只允许 assistant/character）；错误码 `VALIDATION`→`VALIDATION_ERROR` 对齐 api-spec §8 映射表。server 补齐 §16–§23 全路由（messages edit/delete/GET 单条、chats branch/DELETE(soft+purge)/PATCH name、messages 分页 limit·before·after 互斥游标 + **variants 兄弟链投影**，api-spec §16 已补响应口径）。web 工作台接线（swipe ◀▶ n/m、重摇、编辑变体、删除、分支菜单）。**还账 #20 勾销（作者拍板方案 A）**：api-spec §48 枚举拼写对齐 contracts（anTop/anBottom/depth + andAny 等，Breaking: N——§152 P0 范围未投产无消费方）。踩坑沉淀：fake 轮次按 provider 回放（adapter 每请求新建），多轮测试每轮一个 provider；purge 删除顺序必须 chat_branches 先于 messages（leaf/root/fork REFERENCES messages）。**全量 262 测试绿（31 文件，含 14 条 S13 契约测试）**；typecheck core·st-compat·runtime·server·web·api-types 六包 0。下一会话 = S14（WP1.5 Prompt Inspector v1 + sanitized debug export）。
- 2026-09-17 十三版（**跨会话工作区收口**）：S11/S12/S13 三个会话的产出与指令安全撤下变更集此前一直滞留工作区未提交（决策 37 撤下、S11 激活管线 + migration v5/v6 + 绑定路由 + startRun 世界书接线、S12 预设/Persona 导入与注入 + 宏诊断持久化修复、S13 消息树全量 + 还账 #20、以及 S14 起步文件 `core/src/serializer/diff.ts`（api-spec §38 Prompt Diff 构建器，已被 `core/index.ts` 导出）与 `apps/server/src/api/debug-export.ts`（已被 `server.ts` 引用，无法与里程碑拆分））——本会话一并收口为单一提交。收口前修复 S14 起步文件两处门禁红：`diff.ts` `classifyBreak` 参数改收 `DeepReadonly`（TS2345）、`diff.test.ts` 删未用 `snapshotId`（TS6133）。**全量 268 测试绿（32 文件 = S13 的 262 + diff 6 条）**；typecheck 六包 0。`.gitignore` 补 `.pnpm-store/`（pnpm store 曾被重定向进仓库根）。下一会话 = S14（WP1.5，diff/debug-export 已起步，剩 Inspector v1 视图 / override UI / 还账 #4）。
- 2026-09-17 十四版（**S14(WP1.5)收口 + 还账 #15 勾销**）：Prompt Inspector v1 + sanitized debug export 落地。contracts `snapshot.ts` 落 SegmentDiff/SegmentProjection/PromptDiff/RedactionPolicy/DebugExportBundle；core `serializer/diffSnapshots`（对齐键=段 ID、框架哈希 netstring(id,role,content) SHA-256、firstDivergence=首个非 same、tokenDelta={input,cached,fresh}、cacheBreak 按首分歧段来源族启发式）+ 6 单测；server 四路由：GET `runs/:id/inspector`（§107:snapshot+cache+provider+usage+warnings+diagnostics+durable events，404=GENERATION_NOT_FOUND）、GET `prompt-snapshots/:a/diff/:b`（§38,自 §153 P2 提前）、GET `chats/:id/prompt-snapshots`（§36 修订,降序 limit≤50）、POST `debug/export`（§161 新节:默认 sanitized——user/assistant 正文 `[user-content removed]`、ID 匿名化 `redact-N` **deep-walk 全字符串含段 ID 内嵌 chatId**、idMap 恒空=导出文件零原始 ID;full 显式;PV5 已知密钥表+Bearer/sk- 两模式必 redact）;api-types PromptSnapshotDto 修正为服务器真实投影(id 而非 snapshotId,补 ir/messageId)+ChatSnapshotSummary/InspectorData/PromptDiff/DebugExportBundle DTO;web `PromptInspector` 面板(§4.5 精简版:八区哈希条+区色双通道、stability 三值投影徽标、诊断、serialized 切换、相邻 diff 内联红绿+kind 文字、导出 sanitized/full 下载),SnapshotPanel 移除。10 条 S14 契约测试,**回放验收=sanitized bundle.messages 构造 ProviderChatRequest 喂 FakeProviderAdapter 复现同轮**。踩坑:①`resolvePolicy` 不能 spread 兜底——显式 undefined 键会覆盖默认值,须逐字段 `??`;②段 ID(`chat:<chatId>:message:N`)内嵌原始 ID,仅逐字段匿名化不够,必须 deep-walk;③api-spec §160 已存在,新节落 §161。**还账 #4(override 编辑器)维持"随指令安全撤下"状态,不在 S14 范围**(p1-plan §11 已注记)。**全量 278 测试绿(33 文件)**;typecheck 七包 0;ESLint 绿。api-spec 升 2.3。下一会话 = **S15(WP1.6 金样测试体系,P1 出场验收)**。
- 2026-09-22 十五版（**S15(WP1.6)收口 + P1 出场**，§38 决策 38）：金样测试体系落地 + DoD 八条全勾销。**金样套件**：apps/server `golden-assets.test.ts`（导入层：10 卡三载体同源 + 书两代 + 6 预设 ImportReport 断言；字节金样：preset/Table 首跑生成基线、此后 serialized.parts 严格比对）+ tests `golden-card-verify.test.ts`（卡四载体 1:1:1:1 + 脱敏断言）。**金样首战即抓出并修复 3 处 st-compat 真实生态缺口**：①ST `position` string 方言（多数卡内嵌书/老书写 "0".."7"）→ `StWorldbookEntrySchema.position` 收 number|string + `toPositionInt` 归一（此前 ZodError→500）；②现代书条目 `caseSensitive/matchWholeWords/useGroupScoring` 用 null 表"未设置" + `role` 是魔数（0/1/2）→ schema 收 nullable + `toRole` 魔数归一；③ST `prompt_order` 是分组形态 `[{character_id, order:[{identifier,enabled}]}]` → `flattenOrderIdentifiers` 扁平化（此前全部预设 segments=0）。**金样测试自身修正**：sourceFormat 断言对齐权威表（st-v2|st-v3|png-v2|png-v3|charx）；type=table 资产是 ST "AI Table" 扩展（非 prompt-manager 预设，S12 §80–§81 范围外，不进预设断言）；**字节金样只比 parts（role/content）非完整 serialized**——hash/id 含每次导入新建 UUID（presetId/worldbookId），跨 harness 必不同，金样锁"同输入同内容"而非运行标识；`FakeProviderAdapter` 增可选 `capabilities` overrides（大上下文场景）；金样建真实 provider 行满足 `generations.provider_id` FK。删除 4 个 probe（3 个引用 `酒馆参考文件/` 违 X3 且诊断已完成；golden-verify 转正）。**全量 293 测试绿（36 文件）**，typecheck 全包 0，ESLint 绿。**P1 出场完成**：B1（P2 并行）已解锁；下一阶段 = P2（缓存层，最大差异化）。**顺带修复**：AGENTS §1 开工顺序第 3 条（memory 日记）此前被并发会话误删导致 1/2/4/5 断号，本轮恢复为 1–5 连续。
- 2026-09-22 十六版（**P2 细化会话完成**）：按 B4 滚动细化原则落 `docs/p2-plan.md`（S16–S21 会话切分 / R-P2-1–R-P2-9 范围裁决 / 出场 KPI = 真实 API 命中率 ≥70% + 成本削减 ≥60%）。范围裁决要点：分区口径采纳 2026-09 二次修订（stableWB 成员资格与当轮激活解耦）、stableWB append-only（physicalOrder 首次分配永不改变）、哈希对象 = 宏展开后最终文本、逐轮易变宏隔离、预算裁剪序、@D 不参与分区、CachePlan 为跨层契约、Macro Security 禁任意 JS、群聊缓存命名空间。P1 挂账"budget percent+cap 超预算裁剪留 P2"绑定 S18；还账 #6（Gemini explicit caching 评估）绑定 S19。implementation-plan §6 挂 p2-plan 指针。下一会话 = **S16（WP2.1 Macro Engine，compiler-spec §37–§45）**。
- 2026-09-22 十七版（**S16(WP2.1)收口**，§38 决策 39）：宏引擎落 `packages/core/src/macro/`（types/parser/rng/macro-registry/engine 五文件 + 13 单测），pipeline 接线替换 P0 宏透传（R-P0-1 退役，MACRO_UNEXPANDED_P0 移除）。关键口径：宏类型收 core 不进 contracts（evaluate 函数/now Date/rng 对象违反 contracts JSON-serializable 铁律）；未知宏（{{trim}} 等）保留原文 + info UNKNOWN_MACRO、volatility=static（S15 金样主预设含 {{trim}} → 基线零漂移，实测确认）；{{random}}/{{roll}} 确定性种子流（sha256(now|chatId)→mulberry32，不含 snapshotId/messageId）；Macro Cache Rule 三档（stable zone={header,stableWB,freshWB,summary}；macroCachePolicy 独立字段，缺省 strict→'strict'/preview→'normal'，不扩六模式 gate；normal 只改 cachePlacement.zone 不改 semanticPlacement——§13 双 Placement 分离）；R-P2-3 落定（哈希对象=宏展开后文本）。contracts P0_DIAGNOSTIC_CODES 改名 DIAGNOSTIC_CODES + 新码 CACHE_UNSAFE_MACRO/UNKNOWN_MACRO/EVAL_MACRO_REJECTED。runtime buildRuntimeVariables + run.ts/server.ts 传参。**全量 313 测试绿（37 文件，P1 收口 293 起 +20）**；typecheck 全包 0；ESLint 绿；金样基线零漂移。compiler-spec 升 V2.2。下一会话 = **S17（WP2.2 stableWB/freshWB 分区 + physicalOrder append-only）**。
- 2026-09-22 十八版（**S17(WP2.2)收口**，§38 决策 40）：stableWB/freshWB 分区落地——纯函数层 `packages/runtime/src/generation/worldbook-cache.ts`（zoneWorldbook/computeContentHash/BUDGET_TRIM_ORDER + 13 单测）+ worldbook.ts 接线（volatile 预检/哈希/分区装配/毕业/退休/Compatibility mode）。关键口径：决策 A（ZONE_DEFAULT_STABILITY stableWB/freshWB 默认 static→session，防含 {{user}} 条目被 Macro Cache Rule 全量移 tail）/决策 B（哈希 normalize 恒等，空白差异必须产不同指纹防"命中但字节不同"前缀断裂）/决策 C（稳定区贡献 semanticPlacement.order=physicalOrder，保两区拼接字节=物理序升序）；毕业=本轮渲染哈希命中（fresh 未激活也毕业）；WBCacheEntry 落 worldbook_runtime_entries 行（不建独立哈希表），migration v7 增 first_seen_msg；两处展开不变量（分区条目必过 volatile 预检，宏 ∈ {static,session} 不消耗 rng/now/message）；Compatibility 在 worldbook 层回退（跳过分区+失活即时移除 WORLD_BOOK_DEACTIVATED），pipeline gate 不动；退休默认关闭（chats.runtime_state.worldbookRetirement）；outlet 槽位并入 injection。contracts 诊断码新增 WORLD_BOOK_RETIRED/WORLD_BOOK_DEACTIVATED。**全量 329 测试绿（38 文件，S16 收口 313 起 +16）**；typecheck 全包 0；ESLint 绿；金样基线零漂移；server 前缀稳定集成断言（轮 k+1 以轮 k 为字节前缀）绿。compiler-spec 升 V2.3。下一会话 = **S18（WP2.3 per-chat 哈希缓存 + CachePlan + Budget + Elastic History）**。
