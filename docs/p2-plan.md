# WhisperTavern V2 — P2 实施明细计划（缓存层 · 最大差异化）

> **文件:** `docs/p2-plan.md`
> **版本:** V1.0(2026-09-22,P2 开工首会话细化产出——implementation-plan §6 阶段计划约定 B4)
> **状态:** Active(随会话执行更新 §11 看板;P2 完成后本文件归档为执行记录)
> **文档层级:** [implementation-plan.md](./implementation-plan.md) §6(P2 WP 概览与出场)的**会话级执行明细**。设计语义一律指向 spec,本文只管"会话里具体干什么"。
> **上游锚点:** 总设计 §36(P2 验收权威)/ implementation-plan §6 / compiler-spec §20–§45 / worldbook-cache-design §2–§7 / p1-plan(已归档)AGENTS 会话纪律。

---

# 1. P2 会话切分总览

```text
S16 WP2.1  Macro Engine(registry/security/cache rule;compiler-spec §37–§45)        1–2 会话
S17 WP2.2  stableWB/freshWB 分区 + physicalOrder append-only + 毕业/退休            1–2 会话
S18 WP2.3  per-chat 哈希缓存 + CachePlan + Budget + Elastic History                 1–2 会话
S19 WP2.4  缓存标记翻译(Anthropic cache_control / Gemini explicit 评估,还账 #6)    1 会话
S20 WP2.5  遥测面板 + 缓存二分工具 + Cache Simulator                               1 会话
S21 WP2.6  CI 硬门禁:100 轮稳定性 + 1000 轮模拟无未声明失效                         1 会话
```

合计约 6–9 会话。**P2 出场 = 真实 API 稳态命中率 ≥70% + 输入成本削减 ≥60%**(总设计 §36)。
每个会话以可验证状态收尾:测试绿或看板标注中间态 + 日记留恢复点(AGENTS §4)。

# 2. P2 范围裁决(开工前钉死,防会话自由发挥)

```text
R-P2-1  分区口径(采纳 2026-09 二次修订,worldbook-cache-design §2.1):
        stableWB 成员资格 = chatCache ∧ ¬retired,与当轮激活解耦——失活条目照常发送
        直到显式退休;fresh = 本轮新增(哈希未命中)。初版"hit=已激活∧已缓存"公式作废。
R-P2-2  stableWB append-only:physicalOrder 在条目首次进入稳定区时分配,此后永不改变;
        毕业只改 cacheState(fresh→stable),不改物理位置。禁止每轮按 (order,uid) 重排
        稳定区(§3.1 修订)。Compatibility Mode 回退酒馆语义序,放弃该优化(总设计 §11)。
R-P2-3  哈希对象 = 宏展开后的最终文本(规范化空白后,§3.2);`{{user}}` 改名/条目编辑
        自然变指纹 → 进 freshWB 重注入;旧指纹留缓存无害(死键惰性清理)。
R-P2-4  逐轮易变宏必须隔离(§3.3):`{{time}}/{{random}}/{{roll}}` 类条目/段落标 volatile
        → 一律进 tail;或 chat_state 按聊天冻结取值。预设置系统提示嵌 `{{date}}` 是
        隐性命中率杀手,Inspector 必须标红。
R-P2-5  预算裁剪序(§3.5):freshWB 尾部 → injection/tail → stableWB(最后手段,退休机制)。
        超预算预算 = Budget Manager 判(§15,总设计 §15)。
R-P2-6  @D 深度注入条目不参与分区(§3.6):尊重作者原语义直接进 injection 区;
        仅"角色前/角色后"位置条目进入 hit/fresh 分区。
R-P2-7  CachePlan 为跨层契约(§17,总设计 §17):core 分区结果输出 CachePlan,
        适配层翻译(§5 表:Anthropic 断点 / OpenAI 无标记 / Gemini 隐式或显式 / 本地无动作)。
        P0 的"CachePlan 恒空"到此终结,改为真实装配。
R-P2-8  Macro Security(compiler-spec §42):宏引擎不执行任意 JS;`{{eval:...}}` 禁止,
        除非经 Plugin Tool 权限体系。Compiler 本身零任意代码执行。
R-P2-9  群聊缓存命名空间(worldbook-cache-design §6):世界书哈希缓存按 chatId 一份;
        Provider 侧按前缀划分,每 (chat, character) 一条独立链;TTL 策略随 §5 表。
```

# 3. S16 — WP2.1 Macro Engine

**任务清单**:

```text
1. packages/core/src/macro/ 落码(compiler-spec §37–§45):
   analyze(content, context) → MacroAnalysis(macros/stability/dependencies/diagnostics)
   expand(content, context) → ExpandedContent
2. macro-registry.ts(MacroDefinition 表,§40–§41):{{user}}/{{char}}/{{persona}} SESSION、
   {{lastMessage}} MESSAGE、{{time}}/{{date}}/{{random}} VOLATILE、{{roll:1d20}} REQUEST;
   Macro 表不在 Compiler 硬编码
3. Macro Security(§42):{{eval:...}} 拒绝 + 诊断;RuntimeVariables(§44)/MacroContext(§45)
4. Macro Cache Rule(§43):stable zone 含 volatile macro → CACHE_UNSAFE_MACRO 诊断;
   strict=compile error / normal=move to tail / compat=preserve+mark unsafe
5. pipeline.ts 接线:替换 P0 的 MACRO_UNEXPANDED_P0 透传路径(宏透传期结束,R-P0-1 退役);
   宏展开进哈希对象(R-P2-3)
6. 单测:§37–§45 每节语义一测;金样断言(预设内嵌 {{date}} 的 Inspector 标红路径)
```

**验收**:宏展开/安全/缓存规则全集单测绿;stable zone volatile 宏三档处置断言;全量回归绿。
**spec 锚点**:compiler-spec §37–§45;worldbook-cache-design §3.3。

# 4. S17 — WP2.2 stableWB/freshWB 分区

**任务清单**:

```text
1. ✅ 分区核心(§2.1 修订公式):chatCache 哈希集(per-chatId)驱动的成员资格判定
   —— worldbook-cache.ts 纯函数层(zoneWorldbook/computeContentHash/CacheRowView)
2. ✅ physicalOrder 分配器:首次进入分区时分配、永不改变(§3.1);毕业只改 cacheState
   —— fresh 阶段即分配;max(全部既有,含 retired 不回收)+1
3. ✅ chat_state 缓存记录(WBCacheEntry,§4):hash/uid/cacheState/physicalOrder/firstSeenMsg
   —— 落 worldbook_runtime_entries 行(不建独立哈希表);migration v7 增 first_seen_msg
4. ✅ 退休机制(§7):retired 判定 + 移除(默认关闭,chats.runtime_state 配置);
   预算裁剪序常量 BUDGET_TRIM_ORDER(动作归 S18)
5. ✅ Compatibility Mode 回退(§11):worldbook 层跳过分区 + 失活即时移除
   (WORLD_BOOK_DEACTIVATED 诊断);pipeline 六模式 gate 不动
6. ✅ 单测:毕业零失效(§2.3 轮1–4 字节演化)、失活照发、退休移除、裁剪序、
   volatile 预检、编辑重注入、per-chat 隔离、Compatibility
```

**验收**:分区语义全集单测绿;§2.3 逐轮演化字节断言(轮1–4 对照)。
**spec 锚点**:worldbook-cache-design §2–§4/§7;compiler-spec §20–§31;database-schema。

# 5. S18 — WP2.3 per-chat 哈希缓存 + CachePlan + Budget + Elastic History

**任务清单**:

```text
1. ✅ per-chat 哈希缓存服务(§2.1 更新公式) —— S17 已覆盖(行存储读/写 + 行覆盖惰性清理);
   S18 审计确认不新建服务层(纪律 5)
2. ✅ CachePlan 真实装配(core/compiler/cacheplan.ts,§53–§55):stablePrefixSegments/freshSegments/
   volatileSegments/checkpoints(三处 automatic 断点)/invalidationRisk/breakReasons——
   version=1,R-P0-4 退役;buildPrefixHash 逐段累积
3. ✅ Budget Manager(core/compiler/budget.ts,§46–§51):可用=maxContext-output-safety margin;
   裁剪序对齐 §49 权威序(contracts BUDGET_TRIM_ORDER);percent+cap 配额(P1 挂账解除);
   header protect;enabled=false 语义(§91)
4. ✅ Elastic History(§50):Pinned/Elastic 分区 + 整体推出(无状态;pinnedMessageCount 缺省 0)
5. ✅ 单测:budget(8)/cacheplan(6)/elastic(并入 budget)+ pipeline 裁剪断言 + 金样 CachePlan 断言
```

**验收**:CachePlan 真实装配 + 预算裁剪 + Elastic History 单测绿;金样 serialized 含 CachePlan。
**spec 锚点**:总设计 §14–§17;worldbook-cache-design §2.1/§3.5/§4;compiler-spec §47–§53。

# 6. S19 — WP2.4 缓存标记翻译

**任务清单**:

```text
1. Provider 标记翻译(§5 表):Anthropic cache_control 断点 / OpenAI 无标记仅保前缀 /
   Gemini 隐式默认 + 可选显式 cachedContent / 本地无动作
2. 还账 #6:Gemini explicit caching 评估(provider-adapter §23 开放点 1,在此定)
3. 最小前缀阈值提示(§5 注:Anthropic 1024 / OpenAI 1024 / Gemini 4096):
   header+stableWB 低于阈值时遥测给"前缀过小"提示
4. DeepSeek prompt_cache_hit_tokens 单独计费字段接入(usage 归一侧)
5. 契约测试:各 provider 标记翻译 fixture 回放
```

**验收**:四类 provider 标记翻译契约测试绿;Gemini explicit 评估落定(开放点 1 关闭)。
**spec 锚点**:worldbook-cache-design §5;provider-adapter-spec §23 开放点 1/§16。

# 7. S20 — WP2.5 遥测面板 + 缓存二分工具 + Cache Simulator

**任务清单**:

```text
1. 遥测面板(ui-design §4.6;总设计 §20/§33):每轮实际发送内容 + 命中率曲线 +
   cached_tokens/prompt_tokens 口径(token 计,§2.2);"前缀过小"提示
2. 缓存二分工具:连续两轮 prompt 各段哈希链 diff,首个分歧字节定位"谁毁了缓存"
   (复用 S14 diffSnapshots;technical-plan §8 要点 4)
3. Cache Simulator:零 API 成本模拟(记录→分区→哈希),输出预期命中率/成本削减预测
4. web 接线:命中率仪表 + 二分定位视图
```

**验收**:遥测展示真实编译结果命中率;二分工具定位真实 CacheBreak 源;Simulator 输出对齐金样。
**spec 锚点**:ui-design §4.6;总设计 §20/§33;technical-plan §8 要点 4。

# 8. S21 — WP2.6 CI 硬门禁

**任务清单**:

```text
1. 100 轮稳定性门禁(technical-plan §8.1):fake provider 跑 N 轮模拟对话(含新条目触发/
   编辑/swipe/预算裁剪/群聊换人),断言 header+stableWB 前缀逐字节稳定、history 追加式、
   每轮预期失效 token 超阈值报警
2. 1000 轮模拟无未声明失效:确定性回放 + 断言无意外 CacheBreak
3. 门禁进 CI(vitest project + architecture 同挂载);金样套件并入
```

**验收**:两道硬门禁 CI 绿;P2 出场 KPI 预演(Simulator 报告命中率 ≥70%/成本削减 ≥60%)。
**spec 锚点**:technical-plan §8.1;worldbook-cache-design §2.2(命中率来源)。

# 9. 出场验收与挂账

```text
出场(总设计 §36):CI 绿 + 真实 API 稳态命中率 ≥70% + 输入成本削减 ≥60%。
借冒烟脚本 tests/smoke/real-provider-smoke.mjs(需用户自有 key)实测命中率/成本;
P2 出场登记 §38 决策;implementation-plan §12 看板更新;AGENTS 当前状态更新。
挂账:P1 注记的"budget percent+cap 超预算裁剪留 P2"(S18 解除);还账 #6(S19 勾销)。
```

# 10. 横切纪律

延续 p1-plan §10 全部条款(X7/X8)与 p0-plan X1–X6,P2 特别加:

```text
X9  Zone/缓存口径变更(稳定区成员资格、physicalOrder、CachePlan 形状)属决策协议 b——
    触碰前先停下来问,落 §38。
X10 缓存语义测试必须用确定性输入(固定 now/种子/资产):禁止依赖 wall-clock 或随机。
X11 命中率/成本削减是产品级 KPI:任何"看起来快"的局部改动必须能落到
    命中率/成本口径上论证(§2.2 token 计),不得以"感觉"验收。
```

# 11. P2 看板

| 会话 | WP | 状态 | 恢复点注记 |
|---|---|---|---|
| S16 | WP2.1 | ✅ | 宏引擎落地(macro/ 五文件 + pipeline 接线替换 R-P0-1);MACRO_UNEXPANDED_P0 退役;三档 CACHE_UNSAFE_MACRO 处置断言绿;全量 313 测试(37 文件) |
| S17 | WP2.2 | ✅ | worldbook-cache.ts 纯函数分区层 + worldbook.ts 接线;毕业=哈希命中;physicalOrder append-only;migration v7(first_seen_msg);Compatibility 回退;决策 A(stableWB/freshWB 默认 session);全量 329 测试(38 文件) |
| S18 | WP2.3 | ✅ | budget.ts(Budget Manager:裁剪序权威化/percent+cap/header protect/elastic 整体推出)+ cacheplan.ts(CachePlan v1,R-P0-4 退役)+ pipeline 接线(enabled 语义)+ run.ts cacheInvalidations;全量 345 测试(40 文件) |
| S19 | WP2.4 | ☐ | |
| S20 | WP2.5 | ☐ | |
| S21 | WP2.6 | ☐ | |

---

*关联文档:[implementation-plan.md](./implementation-plan.md) §6/§10(P2 WP 与还账)· 总设计 §36/§14–§17 · [prompt-compiler-spec](./specs/prompt-compiler-spec.md) §20–§45 · [worldbook-cache-design.md](./worldbook-cache-design.md) §2–§7 · [provider-adapter-spec](./specs/provider-adapter-spec.md) §16/§23 开放点 1 · [technical-plan.md](./technical-plan.md) §8 · [ui-design.md](./ui-design.md) §4.6 · [p1-plan.md](./p1-plan.md)(已归档)*
