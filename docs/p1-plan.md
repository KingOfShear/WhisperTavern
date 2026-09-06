# DesireGrimoire V2 — P1 实施明细计划(ST Compatibility)

> **文件:** `docs/p1-plan.md`
> **版本:** V1.0(2026-09-06,P1 开工首会话细化产出——implementation-plan §11 阶段计划约定 B4)
> **状态:** Active(随会话执行更新 §11 看板;P1 完成后本文件归档为执行记录)
> **文档层级:** [implementation-plan.md](./implementation-plan.md) §5(P1 WP 概览与出场)的**会话级执行明细**。设计语义一律指向 spec,本文只管"会话里具体干什么"。
> **上游锚点:** 总设计 §36(P1 验收权威)/ implementation-plan §5 / p0-plan(已归档)AGENTS 会话纪律。

---

# 1. P1 会话切分总览

```text
S9  WP1.1a 资产导入:ST 卡 V2/V3 JSON + PNG tEXt + charx → 原生 .dgcard(含报告)   1–2 会话
S10 WP1.1b 世界书导入:老 8 字段/现代 42 字段 → .dgworld(语义不变结构重组)          1 会话
S11 WP1.2  世界书激活层全集(§23–§29;激活条目进 prompt,缓存分区仍空)               1–2 会话
S12 WP1.3  预设映射(ST Prompt Order §80–§81)+ Persona 库                           1 会话
S13 WP1.4  消息树完整交互:编辑变体/swipe 生成填充/分支激活 API 完整                 1 会话
S14 WP1.5  Prompt Inspector v1 + override 槽位 UI(默认关)+ 还账 #4/#15              1–2 会话
S15 WP1.6  金样测试体系(真实资产脱敏 → 导入→编译→序列化)                          1 会话
```

合计约 7–9 会话(单人 3–4 周,对齐总设计 §36)。**WP1.2 出场即解锁 P2 并行(B1)**。每个会话以可验证状态收尾:测试绿或看板标注中间态 + 日记留恢复点(AGENTS §4)。

# 2. P1 范围裁决(开工前钉死,防会话自由发挥)

```text
R-P1-1  激活层与分区边界:P1 只做激活层(compiler-spec §23–§29——哪些条目进 prompt);
        激活条目的 cache placement 一律 freshWB(当轮新鲜),stableWB 毕业/退休/物理序
        append-only 属 P2 Cache Engine。Compatibility/Performance 模式分野随 P2 落地,
        P1 compiler 走 preview 等价语义。
R-P1-2  导入支持面:ST 卡 V2/V3 JSON、PNG tEXt(chara+ccv3 双内嵌,优先 ccv3)、
        charx(ZIP);世界书老 8 字段与现代平铺字段;预设 JSON。**导出(PNG 双写/
        .dg 回写)不在 P1**(§21:导出随 P5);资产文件按混合存储落 data/(决策 11)。
R-P1-3  导入不改档(instruction-security §15/I2-b):导入产物 authority 一律按 §10
        来源推导(卡→character、书→world),卡文本自述一律无效;资产元数据声明提升
        仅经用户确认路径,导入报告必须含"档位与越权槽位"小节(§25)。
R-P1-4  金样资产:真实资产经**结构等价脱敏**复制进 tests/fixtures/(AGENTS X3——
        密钥/NSFW 内容合成替换,协议形状与字节结构保持);测试不直接引用
        酒馆参考文件/ 与根目录原 json。
R-P1-5  Override 槽位:UI 随 WP1.5 交付但**默认关**(§12.2);P0 的 preset 白名单
        路径延续;UI 启用须显式用户操作并落资产元数据(R5)。
R-P1-6  兼容报告:Import Compatibility Report 为 P1 出场要件——逐资产产出
        (字段映射/未建模字段 compat 清单/档位与越权槽位),Technical 深度对齐
        technical-plan §5.9。
```

# 3. S9 — WP1.1a 卡导入

**任务清单**:

```text
1. packages/st-compat 落码:卡 V2/V3 JSON 解析(顶层 15 字段 + data{} 16 字段双层
   冗余归一)、PNG tEXt 块读取(chara/ccv3 base64,优先 ccv3)、charx 解包(ZIP)
2. 归一 → 原生 .dgcard 模型(technical-plan §5.10 schema):定义与运行态分离,
   character_book 抽取为独立 .dgworld 双向引用,未建模字段进 compat
3. Compatibility Report v1(字段映射表/compat 清单/档位小节)
4. 落库:characters 注册索引 + version 1 快照(S8 迁移 v3 已备);资产文件落 data/
5. 契约测试:三类载体 → 同一原生模型(结构等价);R-P1-3 档位断言
```

**验收**:三类载体样卡导入绿;报告产出;`pnpm -r test` 全绿。
**spec 锚点**:technical-plan §5.10;instruction-security §15/§25。

# 4. S10 — WP1.1b 世界书导入

**任务清单**:

```text
1. 老格式(8 字段/insertion_order/数字 position/uid 键对象)与现代平铺(42 字段)
   → 原生 .dgworld(§5.3:语义不变、结构重组;scan 块随书走)
2. 全字段往返映射测试(uid 原样保留为映射键;42 字段逐一核对,补遗漏进 compat)
3. worldbooks 注册落库 + 版本快照;报告接入
```

**验收**:真实生态两代书导入往返绿;字段覆盖清单进报告。
**spec 锚点**:technical-plan §5.3;database-schema §12–§14。

# 5. S11 — WP1.2 世界书激活层

**任务清单**:

```text
1. packages/core/src/worldbook/ 激活管线(compiler-spec §23–§29):主/副键 +
   selectiveLogic 四值、扫描深度、递归扫描(excludeRecursion/preventRecursion/
   delayUntilRecursion)、概率掷骰、大小写/全词、蓝灯 constant/绿灯 selective、
   sticky/cooldown/delay 定时效应、group 计分(groupOverride/useGroupScoring)、
   六个 match* 范围、triggers、characterFilter、budget percent+cap(超预算裁剪序)
2. Activation Engine 有状态化(决策 9:拆出为前置阶段,Compiler 保持纯计算):
   worldbook_runtime_entries 状态落库(database-schema §15)、激活审计 §16
3. Compiler 接线:激活结果 → contributions(worldbook 来源,cache placement
   freshWB——R-P1-1);injection 型条目按作者本意进 injection 区
4. 单测:§23–§29 每条语义一测;真实书金样数据驱动
```

**验收**:激活语义全集单测绿;**WP1.2 出场 = P2 解锁(B1)**。
**spec 锚点**:compiler-spec §23–§29;worldbook-cache-design §2–§3(激活侧)。

# 6. S12 — WP1.3 预设映射 + Persona

**任务清单**:

```text
1. ST Prompt Order → contributions 顺序(compiler-spec §80–§81):promptOrder /
   generationSettings / contextSettings 映射;预设段注入 header/tail
2. Persona 库(personas 表 + 版本快照)chat 绑定 → user 档注入(§10 persona 行)
3. macro 占位延续 R-P0-1(透传 + info 诊断;Macro Engine 仍 P2)
```

**验收**:真实预设导入 → 编译顺序符合 §81;persona 注入档位断言。
**spec 锚点**:compiler-spec §80–§81;technical-plan §5.5。

# 7. S13 — WP1.4 消息树完整交互

**任务清单**:

```text
1. swipe 完整语义(§20):POST swipe 建壳 + 触发生成填充变体(P0 挂账解除);
   生成完成写入 variant 而非新消息(startRun variantGroupId 接线)
2. 编辑变体(§19)、删除(软删 + message.deleted)、分支激活 UI 接线(§21/§22)
3. chats PATCH/DELETE + messages 分页(limit/before/after,§16)
4. web 工作台接线:swipe ◀▶、编辑、分支菜单
```

**验收**:api-spec §16–§23 逐路由契约测试;swipe 生成填充变体 e2e。
**spec 锚点**:api-spec §16–§23;database-schema §19–§22。

# 8. S14 — WP1.5 Inspector v1 + Override UI

**任务清单**:

```text
1. Inspector v1(ui-design §30.2 精简版):段列表(来源/角色/区/stability)/
   八区哈希/诊断/serialized 原文;快照 diff(相邻两轮)
2. authority/trust/scope 徽标 + untrusted origin 展示(instruction-security §19.2)
3. override 槽位 UI(默认关,R-P1-5)+ sanitized debug export(还账 #15:
   RedactionPolicy 去用户内容/匿名化 ID/默认 sanitized)
4. 还账 #4:ui-design 补 override 编辑器与档位徽标小节;api-spec SegmentSnapshot
   补 authority 只读字段(§25)
```

**验收**:Inspector 对真实编译结果展示;导出 sanitized bundle 可回放。
**spec 锚点**:ui-design §30.2;instruction-security §19/§25;compiler-spec §101。

# 9. S15 — WP1.6 金样测试体系

**任务清单**:

```text
1. 真实资产脱敏复制进 tests/fixtures/assets/(R-P1-4):卡×3 载体、书×2 代、预设
2. 金样:导入 → 编译 → 序列化 → 字节级快照(防语义回归;technical-plan §8.2)
3. Import Compatibility Report 验收(出场要件,含"档位与越权槽位"小节)
4. P1 DoD 核验 + 归档
```

**验收**:**P1 出场(§36)**——目录内真实资产导入跑通、金样绿、报告产出。
**spec 锚点**:technical-plan §8.2;总设计 §36。

# 10. 横切纪律

延续 p0-plan §12 全部条款(X1–X6),P1 特别加:

```text
X7  导入产物一律过 §10 推导投影,导入代码禁止任何"内容识别档位"路径(I1);
    报告只报告,不改档。
X8  真实资产只进 tests/fixtures/(脱敏后),原文件保持只读不引用(AGENTS §6)。
```

# 11. P1 看板

| 会话 | WP | 状态 | 恢复点注记 |
|---|---|---|---|
| S9 | WP1.1a | ✅ | 2026-09-06 完成:st-compat 卡模块落码(V2/V3 JSON 双层冗余归一 data 层优先/PNG tEXt chara+ccv3 优先 ccv3/charx fflate 解包)+ .dgcard 归一(运行态剥离/内嵌书抽取 passthrough/compat 收集/compatFields 全列)+ ImportReport(路径化、无内容值)+ server 导入路由(落盘 cards/<slug>/ + worldbooks 双向注册 + v1 快照)。10 条 st-compat 测试 + 5 条路由契约测试。踩坑:zod looseObject 不剥未知键(广收集靠 modeled 集合反查);report.compatFields 须从 compat 对象全列。 |
| S10 | WP1.1b | ☐ | |
| S11 | WP1.2 | ☐ | |
| S12 | WP1.3 | ☐ | |
| S13 | WP1.4 | ☐ | |
| S14 | WP1.5 | ☐ | |
| S15 | WP1.6 | ☐ | |

---

*关联文档:[implementation-plan.md](./implementation-plan.md) §5/§4.11(P1 DoD)· 总设计 §36/§30 · [technical-plan.md](./technical-plan.md) §5.3/§5.9/§5.10/§8.2 · [prompt-compiler-spec](./specs/prompt-compiler-spec.md) §23–§29/§80–§81 · [instruction-security-spec](./specs/instruction-security-spec.md) §15/§25 · [ui-design.md](./ui-design.md) §30.2 · [p0-plan.md](./p0-plan.md)(已归档)*
