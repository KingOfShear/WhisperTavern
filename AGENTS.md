# DesireGrimoire — AI 协作会话引导（AGENTS.md）

> 本文件是每个 AI 会话的**第一入口**：开工先读完本文件，再按 §1 顺序读文档。
> 维护纪律：本文件与 docs/ 体系冲突时，以 docs/ 为准并修订本文件；修订须在末尾登记日期。

**项目一句话**：仿 SillyTavern 的本地 AI RP 客户端，两大差异化——缓存友好型世界书（稳态命中率 ≥70%、输入成本削减 ≥60%）+ Agent 化对话（Agent Runtime / Roleplay Runtime 替代 MVU 填表插件）。

**当前状态**（2026-09-06）：P0 已完成并提交里程碑（63aa7e1);**P1 细化会话已完成**——[docs/p1-plan.md](./docs/p1-plan.md) 落盘(S9–S15 会话切分 / R-P1-1–6 范围裁决 / §4.11 P1 DoD);下一会话 = **S9(WP1.1a 资产导入:ST 卡 → 原生 .dgcard)**,见 [docs/p1-plan.md](./docs/p1-plan.md) §11 看板。

## 1. 开工必读顺序（每次会话，顺序执行）

1. **本文件**（§2 文档地图 → 按任务找对详设）。
2. **docs/technical-design.md**：§0 核心设计原则（铁律）→ **§38 已定决策记录（33 项，唯一权威）** → 与任务相关的章节。
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
| 指令安全 / 信任边界 / override / untrusted | [docs/specs/instruction-security-spec.md](./docs/specs/instruction-security-spec.md) |
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
4. **会话收尾**写 `.workbuddy/memory/YYYY-MM-DD.md`（改了什么/为什么/踩了什么坑）；跨会话决策落 §38。
5. **架构扩展限制**：不得为局部需求新造 Service / Manager / Engine / Runtime / Store 类模块或新包——先回答"现有模块为何满足不了"；确需新建，按纪律 3 先落 spec 骨架并落 §38。类型层面的同类约束见 shared-contracts C4（不重造、不复制、不定义同义核心类型）。
6. **代码风格底线**：显式类型（禁 `any` 出口）、禁 magic string（枚举/常量收 contracts）、小函数、单向依赖；机械执行交给 ESLint + `tsc --strict`，本条只立底线。

## 4. 决策协议（何时直接做、何时停下来问）

判断标准不是"任务类型分类表"，而是**是否触碰公共语义**：

```text
直接做（做完按纪律 4 记录）：
  单模块内、不新增对外契约、不改变任何 spec 语义的局部实现与 bug 修复
  （正确性基准 = spec / 不变量，不是"跑起来了"）

先停下来问（一句话影响分析，等用户确认）：
  a. 新增抽象 / 新包（纪律 5 清单）
  b. 跨模块语义变更：事件名、表结构、状态机、Zone/缓存口径、authority 档位
  c. 公共契约破坏性变更——spec 修订说明必须标注 Breaking: Y/N + 迁移路径
     （版本机器已存在：api-spec §3 versioning + If-Match、compiler-spec §6、
      快照不可变 + derivedFromSnapshotId、资产版本快照；本条只补标注纪律）
  d. §38 没有的新架构决策
```

**红线：不用 Prompt 修架构问题。** 行为异常先查 Compiler / Runtime 语义层，而不是往 system prompt 里加字；任何 Prompt 相关改动一律过 §8 验收四问。

## 5. 工作纪律（含并发防护）

- **改文档前先整读目标文件 + 读 §38**；**改完立即 grep 复核**。本仓库曾有外部并发改写/回退记录（.workbuddy 2026-09-05 日记）：同一行反复被回退时**停止编辑并报告用户**，勿无限重试。
- 同一会话内小步编辑，优先 Edit 而非整文件重写。
- 引用 spec 节号时带节标题（如 `compiler-spec §12（Semantic Placement）`）。
- **实验要留痕**：涉及模型行为 / Prompt / Provider 对比的实验，记录落 `.workbuddy/experiments/YYYY-MM-DD-<主题>.md`，字段对齐 instruction-security-spec §23 指纹（model / 参数 / 环境 / 预期 / 实际 / 结论）；没有留痕的"感觉有效"不得作为决策依据。

## 6. 仓库结构速览

```text
AGENTS.md            ← 本文件（会话入口）
docs/                ← 文档体系（technical-design.md 为唯一总设计脊柱）
docs/specs/          ← 模块规格 / 子规格 / 跨模块规格（数量持续增长，以目录与总设计 §40.1 树为准，此处不写死数量）
reference/SillyTavern/  ← 外部参照代码（只读，不是本仓库代码）
*.json / 表格预设/    ← 用户真实资产（Kemini、狐神抚预设、地点.json 等）
                        = 测试金样与生态参照（technical-plan §8.2 引用）——勿修改、勿上传
.workbuddy/memory/      ← 会话日记（YYYY-MM-DD.md）
.workbuddy/experiments/ ← 实验记录（§5 留痕纪律）
```

## 7. 勿做清单（红线）

- **不内置任何用户提示词/预设文本**（作者授权边界）：只做导入并保留作者声明。
- **不收录越狱提示词/规避配方**；指令安全只做 authority/trust 机制与差分测量（instruction-security-spec §2/§23.3）。
- **不绕过 Compiler 拼 prompt**：任何"图省事直接拼字符串"的路径都会踩 §5.5 不变量断言（technical-plan §8.5）。
- SQLite 是唯一目标库；事件名不用大写枚举、一律取 §5.4 权威域；适配器只翻译不做语义（provider-adapter PV1）。

## 8. 验收锚点

任何新功能进 Core 前过**版本验收四问**（technical-design §37）：会改变 Prompt？会破坏 Cache？会影响 Agent？有没有办法 Debug？Compiler 模块另加**五问**（compiler-spec §147）。测试基建见 technical-plan §8（前缀稳定性 CI 硬门禁 / 金样 / fixture 录制回放 / 不变量断言）。

## 9. 修订记录

- 2026-09-05 初版（随 provider-adapter-spec 骨架一同落成，决策 31）。
- 2026-09-05 二版（吸收外部评审，择优采纳：新增 §4 决策协议、纪律 5 架构扩展限制 / 纪律 6 代码风格底线、实验留痕；§6 去数量化防过期。**拒绝**另立 `ai-agent-development-policy.md`——平行文档违反决策 26 ②；拒绝复述 §37 四问式 Prompt 清单——已有验收门禁，只留"不用 Prompt 修架构问题"红线）。
- 2026-09-05 三版（小步同步：当前状态更新为 S1 完成、决策计数 31→33；License 定 **Apache-2.0**（§38 决策 33），开源挂账登记 implementation-plan §10 #14–#16。开源评审"重排 13 包结构"方案拒绝——违反 §7 结构 / 纪律 5 / shared-contracts C4）。
