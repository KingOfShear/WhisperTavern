# 狐神抚 V18.2 三预设分析（毓忻/GYYSF）

> 分析对象：仓库内 `[主预设] V18.2 狐神抚 · 毓忻.json`（4.8MB）、`[Agent] V18.2 狐神抚 · 毓忻.json`（5.0MB）、`[轻量] 狐狐~ 🦊.json`（0.9MB）。
> 结论先行：与【小猫之神】相比，狐神抚的机制重心从"请求管线内的字符串手术"升级为"**常驻运行时 JS 引擎 + 声明式多智能体**"，其缓存策略（弹性楼层窗口 / Phase1-Phase2 分离 / 指纹失效）和多智能体工作流（fox-writer 四轮 tool-call）是本项目的两项直接输入。
> 素材声明：预设作者 GYYSF（Discord 类脑OΔYΣΣEIA），允许私下传播、需保留声明。本项目**不内置**其提示词文本，仅做机制分析与导入兼容。
> **文档层级（2026-09）**：本文是 [technical-design.md](./technical-design.md) 之下的 **Agent / Workflow 参照**。

## 1. 结构与体积构成

| 项 | 主预设 | Agent | 轻量 |
|---|---|---|---|
| prompts 总数 / 启用 | 217 / 62 | 217 / 69 | 215 / 51 |
| extensions 总量 | 4.2MB (87%) | 4.3MB | 336KB |
| `tavern_helper.scripts` | **3.81MB（玄狐 3.72MB）** | 同主（逐字节相同） | 10KB（引擎移除） |
| `tauritavern`（agent/skills） | 无 | 61KB | 空壳 |
| `SPreset` | 207KB（ChatSquash **禁用**） | 同 | 同 |
| `regex_scripts` | 39 条 206KB | 39 条 | 24 条 |

- 4.8MB 里 76.7% 是玄狐脚本；最大单条 prompt 是 SPreset 配置（207KB，与 extensions.SPreset 双份存储，约 414KB 冗余）。
- **轻量版 = 提示词骨架 + 正则美化，砍掉整个 JS 引擎**——证明作者自己就把"机制"和"提示词"分层了。
- 提示词层资产：setvar 开关体系（初始化清 ~40 个变量，选一互斥组）、空 content 注入槽（大总结填入/用户偏好/搜索注入/长期拷打/长期喜欢，position=0/depth=4）、草稿自检（`<draft>` 内多轮自检才出正文）、杀八股/去AI味（去欧规范）/防全知/防媚 user。

## 2. 玄狐引擎（extensions.tavern_helper.scripts[1]）

3.72MB 常驻 JS，宿主为酒馆助手 TavernHelper，跑在 `about:srcdoc` iframe 经 `window.parent` 操作酒馆。模块：狐裁（思维链两阶段）、狐构（大纲）、狐忆（记忆）、狐搜（搜索）、狐映（前端渲染）、狐刻（时间）、狐析、狐略、平行世界、大总结（自动总结 generateRaw→写回注入槽）、小说模式、任务队列 `xhAutoQueue`（Promise 链串行化防止多模块 generateRaw 冲突）、localStorage→文件持久化代理（20 个 `SPreset_*` 前缀映射到模块）。

关键工程细节（均值得本项目借鉴）：

- **dry-run 请求捕获**：顶层 fetch 代理拦截 `/chat-completions/generate`，静默发一次 generateRaw 并在到达上游前短路，从而拿到**与主模型完全一致**的组合 prompt 体（含预设条目/世界书/聊天楼层）。这是浏览器侧拿不到完整 prompt 的 workaround——我们服务端原生拥有它，无需此 hack。
- **世界书直读**：`getCharLorebooks` / `worldinfo.read_activated`，供狐裁等模块绕过装配管线直接读设定。
- **楼层重编号**：隐藏楼层剔除后连续编号，"避免 AI 看到高楼层数字而误判"。

## 3. 狐裁：两阶段思维链 + 三件套缓存策略

### 3.1 Phase1 / Phase2 分离（推理侧的"静态前置/动态后置"）

- **Phase1 = 长期规则手册**（按角色卡缓存）：prompt 明确定位"【长期规则梳理】，不是本轮场景分析"，输出会被跨轮复用，"禁止把结论绑死在当前剧情走到哪儿"——错误示范连"推进速度/烈度结论绑当前场景"都列了。**缓存与轮次解耦是这个机制的根基。**
- **Phase2 = 本轮动态思维链**：角色内心预演/导演检查/反套路/用户输入处理，prompt 可由模块拼装；用户输入单独注入。
- 两阶段各自带重试（maxRetries=3、空回检测、1500ms 退避、结构校验 ≥50 字符）；产物以 `START THINKING：…THINKING END` 标记注入主请求，主模型"立即参照思考结果输出正文，不再思考"。
- 请求组织：全部 system（头部指令 / 结构化上下文整体 / 强度+阶段提示词）+ 固定 user 触发串；**聊天历史不作为 history 传入，而是扁平化进上下文串**（`max_chat_history: 0`）。

### 3.2 弹性楼层窗口（缓存友好的上下文裁剪）

`foxJudgeBuildElasticChatRows`：**稳定 N 楼钉死（pinned）+ 尾部 ≤10 楼弹性区；新楼撑满弹性区后锚点整段向前推进**。注释原话："动态内容永远位于稳定聊天之后，避免每轮输入提前截断服务端 prefix cache"。锚定状态持久化（pinnedIds + 每楼 FNV-1a 内容签名 `role:length:hash`），任一签名不匹配→整窗重建。日志可观测（"推进锚定/新建锚定/复用锚定，稳定 N 楼 + 弹性 x/10 楼"）。

### 3.3 指纹失效机制（多层、stale 而非删除）

`foxJudgeCalcCharFingerprint`：段式指纹 `||` 连接——角色四件套（charId/name/description/personality/scenario）、contextFloors、过滤设置、聊天 scopeId、快捷开关组、单选组、杀八股开关、**自定义条目（`id=enabled:length:head32:tail32`——"只取内容长度+首尾哈希，避免内容微调触发缓存失效"）**、狐析内容指纹。哈希用 FNV-1a（`length:hash36`）。

失效语义讲究：指纹变更**只置 `stale: true`，不删缓存**（保护用户手编的 phase1 文本）；`phase1Fixed` 视为永久新鲜（用户手编规则手册）；`forceRefresh` 强制重跑；`phase2Only`（reroll/swipe 专用）忽略 stale 直接复用 phase1——**swipe 重roll 时连 phase2 的输入都省了**。缓存按角色卡存 localStorage（key 仅 charId，新鲜度靠指纹），超 2MB 按 created_at 淘汰保留 3 张卡。

### 3.4 与小猫之神/本项目方案的对照

| 维度 | 小猫之神 | 狐神抚 | 本项目 |
|---|---|---|---|
| 作用对象 | 主请求的世界书 | 狐裁辅助请求的全上下文 | 主请求全量（原生编译器） |
| 机制 | 内容哈希→前置/后置占位符分区 | 弹性楼层窗口 + Phase 分离 + 指纹失效 | 世界书分区 + CachePlan + 遥测 |
| 缓存存储 | 内存（刷新丢失） | localStorage→文件 | SQLite 持久化 |
| 失效策略 | 只增不减 | stale 标记/固定态/强制刷新 | 指纹失效 + 退休机制 |
| 依赖 | SPreset 扩展 | 酒馆助手扩展 | 无（一等能力） |

两套参考实现**互补**：小猫之神解决主请求世界书分区；狐神抚没做主请求分区，但在辅助推理请求与工作流缓存上走得更远。本项目把两边的一等化合并。

## 4. Agent 版：TauriTavern 多智能体运行时

### 4.1 声明式 agent profile（extensions.tauritavern.agentProfiles）

| profile | 角色 | 关键配置 |
|---|---|---|
| fox-writer | 主写手（前台） | maxInvocationsPerRun:12 / maxConcurrentInvocations:3 / canDelegate+canHandoff / resultBudgetTokens:8571 / 产物 `output/main.md`（kind:markdown, target:messageBody） |
| fox-persona-checker | 人设审查（后台只读） | allowedCallers:["fox-writer"] / maxInvocationsPerRun:1 / resultBudgetTokens:2285 / 输出 findings.md |
| fox-banword-checker | 禁词审查（后台只读） | 同上，3428 |

模式 `currentPromptSnapshot`：子 agent 复用主请求的模型/预设快照，不配独立 API。工具白名单（agent.list/delegate/await/handoff、workspace.*、skill.*、worldinfo.read_activated、chat.search/read_messages、dice.roll），checker 用 deny 去掉 commit/finish 保持只读。虚拟工作区：`output/scratch/plan/summaries/persist`。

### 4.2 fox-writer 四轮工作流（agentSystemPrompt，196 行）

- **头部铁律**：TOOL-CALL MODE 禁止直出文本；工具参数必须是 JSON 对象字面量（字符串化会 `tool.invalid_arguments` 截断本轮）；`task` 字段最小化。
- **脚本注入块识别**：`<fox_extra>`、`XUANHU_CURRENT_PROMPT_INJECT`、`<SearchResults>`、五个记忆/大纲标签、`START THINKING` 块——按标签说明执行，不编造模块。
- **NSFW Skill 读取铁律**：先判断本轮是否写 NSFW → 命中才按路由表读精确文件 → 且必须早于写稿；"绝对禁止无判断读取，会严重占用上下文"。
- **Round 1**：`worldinfo_read_activated` + 按需 `chat_search` + 条件 skill 读取（同轮并发）。
- **Round 2**：**恰好 4 个调用一次并发**：`workspace_write_file(output/main.md 初稿)` + `agent_delegate(fox-persona-checker)` + `agent_delegate(fox-banword-checker)` + `skill_read(fox-format-rules)`；明确禁止把 `agent_await` 混进本批。
- **Round 2.5（等待期流水线化）**：收到结果后**立刻**（不等 agent）写 `scratch/format-self-check.md` 自查并 `workspace_apply_patch` 修已发现的 critical/major，然后才 `agent_await({mode:"allCompleted", timeoutMs:120000})`。两条"严禁"直指空等。
- **Round 3**：汇总自查+两 checker findings，按 critical>major>minor 采纳，"误报或与用户最新请求冲突时记录拒绝理由"，patch 修正（允许连锁多次），最后 `workspace_commit` + `workspace_finish`。
- **格式检查内联**："不要委派 fox-format-checker，格式检查由你自己完成"——4 个 skill 只配 3 个 profile。

### 4.3 skills 技能包

4 个 base64 ZIP（`ttskill-archive-base64-v1`）：fox-nsfw-rules（10 文件：发情控制/风格/ASMR/人设加强）、fox-format-rules（格式检查清单）、fox-persona-rules（人设铁律）、fox-banword-rules（禁词表）。每 profile 配 `skills.visible/deny` + `maxReadCharsPerCall/PerRun`（checker 20,000/60,000）控制上下文经济性。注：fox-writer 引用了未随包分发的 `fox-novel-workflow`，来源未确认。

## 5. 三预设分工与依赖

- **主预设**：单请求体验 + 玄狐全引擎（狐裁开关可开可关；开狐裁建议 DeepSeek V4F 端点）。
- **Agent 预设**：主预设 + TauriTavern 运行时，多 8 个条目（Agent Task / Agent System Prompt / Agent请打开 / Agent Results 四个 marker + NSFW/双语等），`function_calling:true`，marker 由玄狐 `installAgentMarkerGuard`（Object.defineProperty 锁只读）防宿主清洗。
- **轻量版**：无引擎的提示词骨架（换引擎也换不掉的底层体验）。
- 依赖链：SillyTavern + TavernHelper（必需）+ SPreset + TauriTavern（仅 Agent 版）+ ST 正则扩展。无小白盒/小猫之神依赖。
- 采样参数：temp 1 / top_p 0.88 / top_k 40 / max_context 2,000,000 / max_tokens 65,535 / reasoning_effort low / 主预设 media_inlining true，其余两版 false。

## 6. 可提取清单（映射到本项目）

| # | 狐神抚机制 | 提取方式 | 落点 |
|---|---|---|---|
| 1 | Phase1/Phase2 分离（长期规则手册按角色缓存） | 直接采纳为工作流设计模式："写作规则手册"作为按角色卡缓存的静态产物，跨轮复用、指纹失效 | P4 工作流 |
| 2 | 弹性楼层窗口（稳定前缀+弹性尾+整段推进+签名失效） | 采纳为**预算溢出裁剪策略**：上下文超限时整段滑动而非逐轮微裁，保持前缀字节稳定 | P2 预算管理 |
| 3 | 指纹失效（多层段式指纹、stale 而非删除、固定态、强制刷新） | chat_state 缓存记录的失效语义规范 | P2 |
| 4 | 四轮 tool-call 工作流（写稿→并发委派→等待期自查→patch→commit） | 默认工作流模板之一；"固定并发批次+await 不混批+等待期流水线化"是延迟优化实战经验 | P4 编排器 |
| 5 | agent profile 声明式 schema（模型快照复用/工具白名单/调用与 token 预算/allowedCallers/artifact 落消息） | 我们的 agent 配置文件 schema 设计基准 | P4 |
| 6 | skills 技能包（ZIP+SKILL.md、条件读取、每轮字符预算） | agent 知识包机制；与 ZCode/Zapier 式 skill 生态同构 | P4/P5 |
| 7 | 上下文经济性（按需读取/预算上限/楼层重编号） | 写进工作流系统提示词的设计守则 | P4 |
| 8 | setvar 开关体系 / 选一互斥组 / 空槽注入点 | 对应我们的"开关组"原生 UI 与注入插槽——不再需要宏 Hack | P1 预设 |
| 9 | dry-run fetch 拦截 | **不需要**：服务端原生拥有完整 prompt | — |
| 10 | 杀八股/去AI味/防全知/防媚等提示词文本 | 不内置（版权与作者授权边界）；st-compat 保证可完整导入，尊重作者声明 | st-compat |

## 7. 未确认项（后续验证）

- V4P/V4F 端点对应 DeepSeek 的哪个产品命名（作者文档假设读者知道）。
- `fox-novel-workflow` skill 的分发来源。
- `workspace_commit/finish` 在 TauriTavern 宿主内的确切行为（依据 artifact 配置推断）。
- 玄狐对 prompt 条目的运行时改写路径（promptMap 为静态阅读推断）。
- 版本号体系不一致（文件名 V18.2 / SPreset 配置 5.1 / 内部 name V14.7 / skills V14.x）。

---

*关联文档：[worldbook-cache-design.md](./worldbook-cache-design.md) §9（小猫之神参考实现）· [st-reference-analysis.md](./st-reference-analysis.md)（酒馆 1.18 代码库）· [technical-plan.md](./technical-plan.md)（总规划）*
