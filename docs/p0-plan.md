# WhisperTavern V2 — P0 实施明细计划（Core Runtime）

> **文件：** `docs/p0-plan.md`
> **版本：** V1.0（2026-09-05，P0 开工前落成——implementation-plan B4 滚动细化的首例）
> **状态：** **Archived(执行记录)**——P0 于 2026-09-06 完成(§13 看板全 ✅、§38 决策 35);后续执行以 implementation-plan 与 p1-plan 为准
> **文档层级：** [implementation-plan.md](./implementation-plan.md) §4（WP 概览与 DoD）的**会话级执行明细**。设计语义一律指向 spec，本文只管"会话里具体干什么"。
> **上游锚点：** implementation-plan §3 DAG / §4 WP / §4.10 P0 DoD 与 Non-goals；AGENTS.md 会话纪律。

---

# 1. P0 会话切分总览

```text
S1  WP0.1 仓库与工具链 bootstrap                        1 会话
S2  WP0.2 contracts 骨架 + shared-contracts 充实         1–2 会话
S3  WP0.3 core 段模型 / Snapshot / token 计数            1–2 会话
S4  WP0.4 Compiler 最小管线                             1–2 会话   ┐
S4' WP0.5 adapters ×3 + fixture（与 S4 并行）            2–3 会话   ┘ S4 与 S4' 可交错
S5  WP0.6 runtime 事件 / SQLite / 消息树                 1–2 会话   （只依赖 S2，可提前）
S6  WP0.7 server 传输层                                 1–2 会话
S7  WP0.8 web Chat UI                                   1–2 会话
S8  WP0.9 端到端验收                                    1 会话
```

P0 合计约 10–13 个会话（单人 2–3 周，对齐总设计 §36）。**每个会话必须以可验证状态收尾**：测试绿或看板标注中间态 + 日记留恢复点（AGENTS §4）。

# 2. P0 范围裁决（开工前钉死，防会话自由发挥）

```text
R-P0-1  宏引擎不在 P0：预设文本中的 {{macro}} 原样透传 + info 级诊断
        （MACRO_UNEXPANDED_P0），P2 的 Macro Engine 接管。P0 验收不含 ST 资产导入。
R-P0-2  预算只有硬上限：序列化后超过模型 maxContextTokens → PROMPT_CONTEXT_TOO_LARGE
        报错终止；不做裁剪 / Elastic History / CachePlan（P2）。
R-P0-3  指令安全 P0 = 元数据基线：instruction 字段 + §10 默认推导 + 可触发的不变量
        断言（I1/I4/I5）+ 诊断码 AUTHORITY_OVERRIDE_DENIED / UNTRUSTED_IN_STABLE_ZONE
        （后者 P0 无 untrusted 源，码注册但不可触发）。G2/G4 金样必须绿。
R-P0-4  CachePlan 为空：P0 不产出任何缓存断点标记（automatic-prefix 家族本来就
        无需标记；Anthropic cache_control 从 WP2.4 开始）。
R-P0-5  FTS5 / sqlite-vec 不启用（P4）；build 期排除扩展依赖。
R-P0-6  密钥存储实现选型在 S6 首任务定：OS keychain 优先（Windows DPAPI /
        macOS Keychain 的可用 npm 绑定），加密文件兜底；**明文永不落盘、永不入库**。
R-P0-7  多 choice / swipe 后端在 P0 只做消息树基础操作（api-spec 分阶段范围 P0 列），
        生成侧 n=1（provider-adapter §9）。
```

# 3. S1 — WP0.1 仓库与工具链 bootstrap

**任务清单**：

```text
1. pnpm workspaces 初始化（pnpm-workspace.yaml + root package.json）
2. 目录脚手架（总设计 §7 逐一就位）：
   apps/server  apps/web
   packages/{contracts, api-types, core, runtime, agent, adapters, st-compat}
   （agent / st-compat 本阶段仅建壳 + README 占位，防误放代码）
3. TS 基线：tsconfig.base.json（strict / verbatimModuleSyntax 等），各包继承
4. ESLint flat config + Vitest workspace 配置
5. CI 工作流：lint → typecheck → test 三段门禁（blocking），覆盖率 warning
6. tests/fixtures/ 目录 + README（**真实资产只读**声明 + 脱敏规范）
7. data/ 目录 + .gitignore（chats.sqlite、密钥、备份不入库）
8. fake provider 骨架（packages/adapters/src/fake/）：可按脚本回放假 token 流的
   内存 adapter——本会话只立形状，断言埋点 S5 完成
```

**验收**：`pnpm -r lint && pnpm -r typecheck && pnpm -r test` 全绿；CI 首跑绿；目录与总设计 §7 逐一对照无缺。
**spec 锚点**：总设计 §6/§7；technical-plan §7（注释纪律自此生效）。

# 4. S2 — WP0.2 contracts 骨架 + shared-contracts 充实

**任务清单**：

```text
1. packages/contracts 第一版（类型 + Zod 同源）：
   - ir.ts        Segment / PromptIR / PromptRole（compiler-spec §7–§11）
   - placement.ts SemanticPlacement / CachePlacement / Stability（§12–§17）
   - snapshot.ts  PromptSnapshot / 八区哈希形状（§66–§67）
   - diagnostics.ts Diagnostic 形状（§70）
   - instruction.ts InstructionMetadata / Authority / Trust / Scope
     （instruction-security §6–§9 草案类型收编）
   - provider.ts  ProviderChatRequest / StreamEvent / ProviderError
     （provider-adapter §6 / §8.1 / §12 码表）
   - chat.ts      P0 运行态最小集（chats / messages / 分支形状——按 database-schema
     P0 表清单与 shared-contracts 映射约定命名）
2. Zod schema 与 TS 类型同源（schema 推导类型或类型推导 schema，二选一定死）
3. api-types 包建壳（contracts 的线格式投影约定，先只有类型出口）
```

**还账（本 WP 勾销）**：shared-contracts-spec 从 124 行骨架充实为 P0 范围真相源（头部版本行升版 + §38 决策 29 体系内的 C1–C4 约束自查）。
**验收**：类型单测（Zod round-trip / branded ID / 枚举穷尽性）；contracts 无 IO 依赖（依赖方向 lint 规则或 import 约束测试）。

# 5. S3 — WP0.3 core：段模型 + Snapshot + token 计数

**任务清单**：

```text
1. 段模型实现（packages/core/ir/）：以 contracts 类型为准的运行时构造器 +
   不可变性保证（冻结 / readonly）
2. Snapshot 构建器：八区哈希逐字节计算（compiler-spec §67）；Snapshot 不可变
   （§68）；authorityFingerprint 元数据（instruction-security §19.1）
3. token 计数双模式（§52）：本地估算器（选型注意 provider-adapter §23 开放点 2，
   与 S4' 协调——openai 系 tiktoken 逼近，其余启发式）+ countTokensNative 钩子接口
4. 不可变性 / 确定性单测：同输入 → 同哈希（字节级）
```

**验收**：同输入两次构建 Snapshot 哈希一致；估算器对已知文本误差记录在案；core 包零 IO（import 约束测试）。

# 6. S4 — WP0.4 Compiler 最小管线

**任务清单**：

```text
1. 管线（compiler-spec §3 精简为 P0 子集）：
   Context Resolution（chat 状态 → 段）→ 分区归类 → stable sorting（§94）
   → 硬上限检查（R-P0-2）→ 序列化（§62）→ CachePlan=空（R-P0-4）
   → Snapshot 落点 → CompileResult
2. CompileMode：strict / preview 两个（compatibility/performance/simulation/
   replay 留 P1+；strict 服务金样与 CI）
3. Diagnostics 体系落地（§70）：码表 + StrictMode 升格规则
4. instruction 元数据：PromptContribution 可选字段 + §10 默认推导表 +
   I1（来源投影查表）/ I4（override 只经显式配置，P0 无 UI 即恒关闭）/
   I5（元数据不进字节）断言
5. Compile Trace（§101）最小版：阶段耗时与关键决策记录（Inspector 数据源）
6. 金样：G2（override 空槽 = 零字节差异）/ G4（世界书式自述指令不改档——P0 用
   合成段替代，真实世界书 P1）
```

**验收**：金样绿；同输入任意次编译字节级一致（确定性测试）；管线各阶段有单测；`MACRO_UNEXPANDED_P0` 透传行为按 R-P0-1 锁定。
**明确不做**：stableWB/freshWB/summary 区（类型在、实现空）；预算裁剪；CachePlan。

# 7. S4' — WP0.5 adapters ×3 + fixture（与 S4 并行，2–3 会话）

**切分**：S4'-a openai-compat（含 DeepSeek reasoning_content 分支与本地端点）；S4'-b anthropic；S4'-c gemini + fixture 测试全家桶。

**任务清单（每家相同骨架）**：

```text
1. SSE 客户端工具：增量 UTF-8 解码（R1）/ 帧解析（R2）/ [DONE]（R3）/
   伪造 200 → PARSE_ERROR（R5）——三 adapter 共用一个实现
2. 归一事件流实现（§8.1 顺序不变量）；DeepSeek reasoning → reasoning_delta；
   Anthropic thinking 签名块缓存待回传（PV8）；Gemini SAFETY → content_filter
3. 错误映射表（§12，表驱动）；分层超时（§14：connect / first-token / idle）；
   AbortSignal 贯穿 + partial + CANCELLED（PV6）
4. usage 归一（§17.1）：OpenAI include_usage / Anthropic 双帧合成 / Gemini
   累积定稿；缺失 → estimated 降级（source:'estimated'）
5. redact 中间件（§17.2，PV5）
6. capabilities 静态预设表（§15）+ 总设计 §18.2 形状定稿（还账）
7. fixture：录制脚本（脱敏）+ T1/T4/T6/T10/T11/T12/T14（§20）
```

**验收**：七条 fixture 测试全绿；T14 重复回放字节级一致；真实 API 手工冒烟（用户提供 key，不入库）；错误码穷尽性单测。
**还账（本 WP 勾销）**：总设计 §18.2 ProviderCapabilities 定稿；§23 开放点 2（tokenizer 选型）与 S3 协调后定案。

# 8. S5 — WP0.6 runtime：Event Bus + SQLite + 消息树

**任务清单**：

```text
1. Event Bus 最小版：发布/订阅 + durability 分档落库（§5.4 权威表 P0 子集：
   generation.* / usage.* / chat.* / provider.*）
2. Drizzle 建表（database-schema P0 阶段清单）：chats / messages /
   chat_branches（含血缘位：parent_message_id + seed_length + is_seeding
   语义）/ providers（key 走 keychain 引用不落库）/ usage / events /
   schema_metadata + migrations
3. 迁移框架：开发期自动应用；用户侧流程（检测 → 备份 → 迁移 → integrity
   check → 失败回滚阻止启动）——§77/§78 实施注记落 database-schema（还账）
4. 消息树操作：创建/编辑/swipe/分支/激活（api-spec §16–§23 语义，
   leaf_message_id 活跃指针唯一）
5. usage 入库：reported / estimated 区分（estimated 不入命中率分母——
   该指标 P2 才有，但字段先分对）
6. 四不变量断言埋入 fake provider 调用入口（§5.5）：
   snapshotId 必挂 / 模型可见可重建 / 元数据不出网 / waiting 有 durable 事件
```

**验收**：迁移流程测试（含失败回滚路径）；消息树操作单测（swipe/分支/激活指针）；不变量断言在故意违规的测试路径上确实变红。

# 9. S6 — WP0.7 server：HTTP/SSE 传输层

**任务清单**：

```text
1. Hono 应用骨架（apps/server 纯传输层，无业务逻辑——总设计 §7 结构注记）
2. 路由（api-spec P0 阶段范围）：chats CRUD / 消息树 / 生成启动-取消 /
   SSE 事件流（信封 + run 内 sequence 单调 + Last-Event-ID 续传）/
   设置与 provider 配置 CRUD / 密钥读写（经 keychain，响应永不回显明文）
3. 密钥存储实现（R-P0-6 首任务定案）：DPAPI / Keychain 绑定选型 +
   加密文件兜底；写入 database-schema providers.secret_refs 语义
4. 错误信封与错误码（api-spec §7–§8）+ Request ID（§5）
5. 长任务原则：生成请求立即返回 runId/generationId + SSE（api-spec 原则）
6. provider-adapter §22 还账：generation.* SSE 投影口径与 §19 三层映射联调复核
```

**验收**：api-spec P0 范围路由的契约测试（信封/错误码/幂等头/SSE sequence）；Last-Event-ID 断线续传测试；密钥泄露扫描（响应体/日志 grep 断言）。

# 10. S7 — WP0.8 web：基础 Chat UI

**任务清单**：

```text
1. Vite + React + Tailwind + shadcn/ui + Zustand 初始化（总设计 §6 栈）
2. api-types 接入（线格式 DTO 从 packages/api-types 引入，禁止手写形状）
3. SSE 客户端：事件信封解析 + sequence 校验 + Last-Event-ID 续传 + 增量渲染
4. 聊天工作台精简版（ui-design §4.1）：会话列表 / 消息流 / 输入框 / 流式渲染 /
   停止生成 / swipe 切换
5. 设置页：provider/模型/密钥/代理表单（密钥只写不读回）
6. 快照可查最简形态：最近一轮 messages 原文查看（Inspector 完整形态是 P1）
```

**验收**：对 fake provider 全流程可操作；对真实 provider 流式渲染 + 中断续传可用；类型零 any（tsc strict 全绿）。

# 11. S8 — WP0.9 端到端验收

**任务清单**：

```text
1. 逐项过 implementation-plan §4.10 DoD 清单（七条全绿）
2. 真实四链路演示：OpenAI 兼容（含本地 ollama 端点）/ DeepSeek / Anthropic / Gemini
   ——流式、取消、断线续传、usage 入库、重启恢复
3. CI 全绿归档：lint / typecheck / 不变量断言 / 金样 G2+G4 / fixture ×7
4. §12 看板全部 ✅；§38 落 P0 完成记录；本文件标记归档
5. 复盘：P0 实际耗时 vs §36 估算；经验写入日记（供 P1 细化会话引用）
```

# 12. P0 期间持续生效的横切纪律

```text
X1  注释纪律自第一行代码生效（technical-plan §7.1；TSDoc / why 1:10 锚点）
X2  触及 spec 语义的代码改动 → 同会话修订 spec（头部版本行 + 节号引用）
X3  fixture 与日志强制 redact（PV5）；真实密钥/用户资产永不入库、永不上传
X4  每会话：开工读 AGENTS §1 → 认领会话号 → 收尾更新本文件 §13 + 日记
X5  并发防护（AGENTS §4）：改 spec 前整读，改后 grep 复核，回退即停
X6  决策出现分叉 → 按 AGENTS §4 决策协议判级：触碰公共语义先问，否则就地做并记录
```

# 13. P0 会话看板

| 会话 | WP | 状态 | 恢复点注记 |
|---|---|---|---|
| S1 | WP0.1 | ✅ | 2026-09-05 完成:pnpm workspaces + §7 目录全就位(9 包含 agent/st-compat 占位壳)+ TS strict 基线 + ESLint/Vitest/CI 三段门禁全绿(fake provider ×7 形状测试);`pnpm -r lint && pnpm -r typecheck && pnpm -r test` 验收通过。注:adapters/src/contract.ts 为归一契约**临时占位,S2 收编入 contracts 后删除**;CI 首跑待仓库推送远端后验证(当前无 remote)。 |
| S2 | WP0.2 | ✅ | 2026-09-05 完成：contracts 八模块（core/placement/instruction/ir/diagnostics/snapshot/provider/chat）Zod-first 同源 + 30 条单测（round-trip/branded ID/枚举穷尽）+ 零 IO lint 约束；adapters 临时 contract.ts 已删除、import 走 @whispertavern/contracts；api-types 建壳（type-only 投影约定）；shared-contracts-spec 升 V2.0（还账 #1 勾销）。注：SerializedPart/providerStrategy/PromptMetadata/registeredBy 四个开放形状记录于 spec §2.3，随 WP0.4/WP2.4 定稿。 |
| S3 | WP0.3 | ✅ | 2026-09-05 完成：core/ir 段构造器（contracts schema 验证后深冻结，§68 运行期兜底）；serializer 八区哈希（netstring 框架化 (id,role,content)，§57"哈希是验证手段"，空区=SHA-256 空字节外部基准测试）；authorityFingerprint（§19.1，覆盖显式 instruction 段）；token 双模式（§52 tokenCountMode 记录 + 本地估算器误差基线在案，tiktoken 选型仍挂 WP0.5 还账 #2）；零 IO 双保险（imports 约束测试 + ESLint）。 contracts 增 tokenCountMode/authorityFingerprint 两字段（均 spec 强制）。 |
| S4 | WP0.4 | ✅ | 2026-09-05 完成:管线八阶段(normalize→指令解析→宏扫描→I3 隔离→排序→硬上限→IR 组装(I5 断言)→snapshot)+ strict/preview 升格 + §10 推导表(instruction-security)+ R2/R3 越权裁决 + I4 INVARIANT_VIOLATION + 宏透传 MACRO_UNEXPANDED_P0 + Trace(§101);金样 G2(空槽零字节差异)/G4(自述不改档)绿;67 测试全绿。明确不做按 Non-goals:宏展开/三区填充/裁剪/CachePlan。contracts 增 compiler.ts(§88/§72/§101 收编)。 |
| S4'-a/b/c | WP0.5 | ✅ | S4'-c 完成(2026-09-05):gemini adapter(usageMetadata 累积末帧定稿/thought parts→reasoning_delta/SAFETY→finish content_filter/context-cache 族/systemInstruction 顶层化/x-goog-api-key 头)+ **fixture 全家桶**(§20 必测 T1/T4/T6/T10/T11/T12 × 3 家 + T14 重复回放 PV7 硬门禁;合成字节流由 record-fixtures.mjs 确定性生成,18 份 JSON 只读)。**WP0.5 出场:还账 #2 勾销**。前段——S4'-a 完成(2026-09-05):openai-compat adapter(SSE 共用解析 R1-R3/DeepSeek reasoning_content→reasoning_delta/usage include_usage+estimated 降级/错误表驱动 §12/分层超时 §14/PV6 取消/R5 伪造 200/PV5 redact/capabilities 静态预设+覆盖);ProviderCapabilities §18.2 定稿入 contracts(还账 #2 第一半);开放点 2 tokenizer 选型落定(adapter-spec V1.1:P0 启发式,tiktoken 归 P2)。15 条契约测试(T1/T4/T5/T6/T10/T11/T12+401/429/redact/超时)。**S4'-b 完成(2026-09-05)**:anthropic adapter(usage 双帧合成 PV3/thinking+签名载体 PV8/stop_reason 映射/流内 error 分类/请求翻译 system 顶层化+max_tokens 必填);contracts reasoning_delta 增 signature 载体(adapter-spec V1.2 §8.1 同步)。15 条契约测试(T1/T3/T4/T5/T6/T10/T11/T12/401/429/529/redact/超时/capabilities/请求翻译)。待:S4'-c gemini+fixture 全家桶。 |
| S5 | WP0.6 | ✅ | 2026-09-05 完成:Event Bus(§5.4 目录源码常量化 + durable 同步落库/deferred 批量/live 内存 + D5 吞订阅者异常);迁移器(§77/78:checksum 可重复检测/事务原子/integrity check/失败回滚/用户侧备份);消息树五操作(§16–§22,leaf 指针唯一,建分支即激活 §21"只改 active leaf");dispatchGeneration(§5.5 四不变量断言独立导出,故意违规路径测试变红);usage 入库(generations.usage_source 分对 reported/estimated,§52 V2.7 注记)。P0 建表 = p0-plan 清单(chats/messages/chat_branches/providers/generations/events/schema_metadata/migrations);快照注册表 P0 内存态,prompt_snapshots 表随 S6。 |
| S6 | WP0.7 | ✅ | 2026-09-06 完成:Hono 骨架(createApp 组合根,app.request 契约测试不走端口)+ §152 P0 路由(chats CRUD/消息树/generate 立即返回 ids/runs cancel/SSE events/compile/snapshot 查询/providers CRUD+models/密钥只写)+ 错误信封 §7-§8(ProviderError→§8 码映射)+ Request ID §5 + EventBus 按 run 分配 sequence(§27)+ Last-Event-ID 续传(活跃=buffer 重放,已结束=events 表 durable 行重放,§141 live 不落库)+ SecretStore R-P0-6 定案(§38 决策 34)+ migration v2(runs/prompt_snapshots,§34/§39 P0 子集)。11 条契约测试全绿。挂账:§152 的 characters/worldbooks/presets CRUD 归 S8(需 §6-§11 资产表迁移)。 |
| S7 | WP0.8 | ✅ | 2026-09-06 完成:web 脚手架(Vite6+React19+Tailwind4+Zustand;shadcn 形制手工基础件)+ api-types DTO 投影填充(信封/SSE/chat/message/generate/provider)+ SSE 客户端(EventSource 原生 Last-Event-ID 续传 + §27 sequence 校验纯函数)+ 工作台(会话列表/消息流/流式渲染/停止/设置页密钥只写/快照面板)+ server 增 swipe/active-leaf 路由与 main.ts 真实监听(tsx)。真机冒烟:fake provider 全链路(建会话→发消息→generate→SSE sequence 1→7 终态→回复入树)。注:swipe=建壳+切换,生成填充随 P1;代理仅存配置。 |
| S8 | WP0.9 | ✅ | 2026-09-06 完成:e2e ×3(取消 partial/重启恢复/快照重建)+ §152 资产 CRUD 补齐(migration v3)+ 真实链路冒烟脚本。**DoD 七条核验记录见 §38 决策 35 与 implementation-plan §4.10**;DoD 1 真实四链路待用户以自有 key 跑冒烟脚本后勾销。**本文件标记归档(P0 完成记录);P1 细化会话产出 p1-plan**。 |

---

*关联文档：[implementation-plan.md](./implementation-plan.md)（WP 概览 / DoD / 还账总表）· AGENTS.md（会话纪律）· [prompt-compiler-spec](./specs/prompt-compiler-spec.md) · [provider-adapter-spec](./specs/provider-adapter-spec.md) · [instruction-security-spec](./specs/instruction-security-spec.md) · [database-schema](./specs/database-schema.md) · [api-spec](./specs/api-spec.md) · [shared-contracts-spec](./specs/shared-contracts-spec.md)*
