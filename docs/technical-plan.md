# WhisperTavern 工程实施规格

> **文档层级（2026-09 更新）**：总体设计已上移至 [technical-design.md](./technical-design.md)（唯一总设计：架构、IR、Zone、缓存生命周期、Agent Runtime、路线图）。本文降级为**工程实施规格**——§5 各子系统实施细节、§6 数据模型、§7 AI 协作编码规范、§8 测试策略、§10 风险与对策、§11 决策记录继续有效，与总设计重复的部分以总设计为准。
> 缓存机制（本项目最核心的差异化设计）详见 [worldbook-cache-design.md](./worldbook-cache-design.md)，交互界面设计见 [ui-design.md](./ui-design.md)。

## 1. 定位与目标

定位、目标与非目标以 [technical-design.md](./technical-design.md) §1–§3 为准。要点：单用户本地优先的 RP 客户端、缓存友好 prompt 管线（多轮长对话目标削减 60–90% 输入成本）、多模型接入、Agent 化对话（替代酒馆数据库/MVU 填表插件）、多阶段写作工作流、群聊与前端插件系统；非目标：多人/云端、直接运行酒馆 JS 扩展、图像/语音等外围能力。

## 2. 总体架构

以 [technical-design.md](./technical-design.md) §4 架构图与 §5 四大基础设施为准，本文不再重复。原三条设计主线在总设计中以更严格形式表述：Prompt 编译器是心脏（§0 铁律 1、§5.1）、激活与放置解耦（§9、§12）、前缀稳定性契约（§0 铁律 4、§14.1）。

## 3. 技术选型

以 [technical-design.md](./technical-design.md) §6 技术栈表为准（含选型理由）。原表的备选项（Fastify / Svelte/Solid / Electron / 酒馆式纯文件存储）已随选型落定而废弃，相关决策记录见总设计 §38。

## 4. 仓库结构

以 [technical-design.md](./technical-design.md) §7 为准（apps/server 只做传输层；事件/权限/调度/快照在 packages/runtime；core 保持纯 TS 无 IO；data/ 文件区 + chats.sqlite 不变）。

## 5. 核心子系统设计

### 5.1 Provider 适配层

> **分工（决策 31，2026-09-05）**：归一契约 / 流式事件 / 工具与 reasoning 归一 / 错误分类学 / usage 归一 / 不变量 / 契约测试的**真相源在 [specs/provider-adapter-spec.md](./specs/provider-adapter-spec.md)**；本节只保留**接入方式与生态实务**（四类接入、自定义插头、代理、密钥存储）。两者禁止互相抄写。

- **统一 ChatRequest/ChatResponse IR**：消息、工具调用、采样参数、usage。适配器只做协议翻译。
- **接入方式（P0 交付，用户可自助添加）**：
  1. **OpenAI 兼容**（主力）：`{名称, baseUrl, apiKey, 模型列表}` 四元组，覆盖 OpenAI/DeepSeek/GLM/Qwen/Kimi/OpenRouter 及一切中转站；
  2. **官方原生**：Anthropic / Gemini 适配器，对齐缓存原语、系统块结构、思考输出等原生能力；
  3. **本地推理**：ollama / LM Studio / vLLM / llama.cpp 均暴露 OpenAI 兼容端点——走方式 1 + 模型自动发现（`/v1/models`、`/api/tags`），免密钥；
  4. **自定义插头**（社区硬需求——狐神抚作者文档原话"插头用自定义！不要用官方！！"）：在方式 1 基础上支持自定义请求头（`x-api-key`/cookie 等）、URL 前缀改写、模型名映射，兼容各类中转/逆向端点。
  另：全局与按提供商代理配置（HTTP/SOCKS）；密钥本地加密存储（Windows DPAPI / macOS Keychain），绝不入库明文。
- **能力声明（capabilities）**：每个模型声明 `systemRole / tools / caching机制 / 最大窗口 / 推理输出` 等；编译器据此自适应（如对不支持 system 的模型把系统段折叠进首条 user）。
- **缓存标记翻译**：core 产出 CachePlan（哪些区可加缓存断点），适配器翻译为各家原语——Anthropic 的 `cache_control` 断点、Gemini 的显式 context caching、OpenAI/DeepSeek/本地的自动前缀缓存（无需标记，只保证前缀稳定）。详见缓存设计文档 §5。
- **usage 归一化**：把 `prompt_tokens_details.cached_tokens`（OpenAI）、`prompt_cache_hit_tokens`（DeepSeek）、`cache_read_input_tokens`（Anthropic）、`cachedContentTokenCount`（Gemini）归一为 `{cached, fresh, output}` 入库，驱动遥测面板。
- 其余：流式（SSE 统一为增量事件流）、重试与降级链（主模型失败切备选）、密钥管理（本地加密存储）、代理设置。

### 5.2 Prompt 编译器（packages/core）

段落 IR 以 [technical-design.md](./technical-design.md) §8 为准（`source / semanticPlacement / cachePlacement / stability / dependencies` 多维分离，替代单一 `zone + order`）；`id` 的稳定 ID 约定不变：预设条目 identifier / 世界书 uid / 摘要块 id。

分区布局（自上而下）与稳定性契约（zone 枚举见总设计 §10；stableWB 采 append-only physicalOrder，见 [worldbook-cache-design.md](./worldbook-cache-design.md) §3.1 修订）：

| 区 | 内容 | 稳定性要求 |
|---|---|---|
| header | 系统提示、预设核心段、用户人格、角色卡描述 | **逐字节稳定**（宏须按聊天冻结） |
| stableWB | 世界书"已命中/已毕业"条目 | 稳定，append-only：physicalOrder 首次分配后不变，毕业只改状态不改位置 |
| freshWB | 本轮新触发的世界书条目 | 变更时一次性失效其后内容（可接受） |
| summary | (P4) 冻结的滚动摘要块 | 追加式 |
| history | 对话历史 | 追加式（编辑/重roll/切分支时从该点失效，接受） |
| injection | 深度注入（AN、@D 条目、阶段产物） | 贴近末端，失效窗口小 |
| tail | 挥发宏（时间/随机）、RAG 结果、工作流指令、jailbreak/风格指令 | 每轮可变，位于历史之后 → 零缓存伤害 |

编译管线阶段以总设计 §5.1 为准：`宏展开 → 世界书激活 → Context Resolution → 分区归类 → 稳定区 physicalOrder 排序（append-only） → 预算裁剪 → CachePlan 标注 → 序列化 → Prompt Snapshot`。每个阶段产出可快照的中间结构，供 Inspector 展示与测试断言。Compiler 模块的完整实施规格（IR 字段、Diagnostics code 表、CompileMode、不变量、测试矩阵、Definition of Done）见 [specs/prompt-compiler-spec.md](./specs/prompt-compiler-spec.md)。

### 5.3 世界书引擎

两层职责分离：

- **激活层（兼容酒馆语义）**：主键/副键、selectiveLogic（AND ANY / AND ALL / NOT ANY / NOT ALL）、扫描深度、递归扫描、概率、大小写/全词匹配、蓝灯（constant）/绿灯（selective）。产出"本轮激活条目集"。
- **放置层（本项目新增）**：缓存分区（stableWB/freshWB；**stableWB 成员由 chatCache 决定、与当轮激活无关**，失活条目照常发送直到退休，见 [worldbook-cache-design.md](./worldbook-cache-design.md) §2.1）、append-only 物理序、预算裁剪（超预算时**从 freshWB 尾部先裁**，裁 stableWB 会移动历史，代价大）。深度注入型条目（@D / AN 位置）不参与分区，按作者本意进 injection 区。详见缓存设计文档。

**原生世界书格式（.dgworld，JSON）**。设计前提是真实生态的形态跨度：从 `地点.json` 式 8 字段老格式（`insertion_order`、数字 `position`、uid 键对象）到现代书每条 42 个平铺字段（sticky/cooldown/delay 定时效应、excludeRecursion/preventRecursion/delayUntilRecursion 递归控制、group/groupOverride/groupWeight/useGroupScoring 分组计分、六个 `match*` 匹配范围、triggers 向量触发、characterFilter、outletName、ignoreBudget…）。原生格式**语义不变、结构重组**：

```jsonc
{
  "schemaVersion": 1,
  "meta": { "name": "地点", "description": "…", "author": "…", "attribution": "…", "tags": [] },
  "scan": {                          // 书级触发配置随书走（酒馆把扫描深度/预算/递归放在全局 settings.json，跨用户不可移植）
    "scanDepth": null,               // null = 跟随会话配置
    "caseSensitive": null, "matchWholeWords": null,
    "recursive": true,
    "budget": { "percent": 25, "cap": null }
  },
  "entries": [
    {
      "id": "e-xxxx", "uid": 12,     // uid 原样保留（往返映射键）
      "title": "酒馆",               // ← comment 语义正名（它实际就是条目标题）
      "content": "…",
      "enabled": true,               // ← disable 极性反转
      "activation": {                // 触发：mode = constant(蓝灯)|selective(绿灯)|vectorized
        "mode": "selective",
        "keys": ["酒馆", "旅馆"], "secondaryKeys": ["剑"],
        "logic": "andAny",           // andAny|andAll|notAny|notAll（替代 0-3 魔数）
        "chance": 100,               // 概率
        "matchScope": [],            // 六个 match* 字段合并：persona/charDescription/… 是否参与扫描
        "triggers": [],              // 向量触发词
        "characterFilter": []
      },
      "lifecycle":   { "sticky": 0, "cooldown": 0, "delay": 0 },          // 定时效应
      "recursion":   { "excluded": false, "prevent": false, "delayedUntil": false },
      "placement": {                                                        // 放置
        "slot": "charBefore",        // charBefore|charAfter|atDepth|anTop|anBottom|emTop|emBottom|outlet（替代 position 0-7 魔数）
        "order": 100, "depth": 4, "role": "system", "outletName": null
      },
      "budget":  { "ignore": false },                                       // ignoreBudget
      "group":   { "id": null, "override": false, "weight": 100 },          // 酒馆"包含组"计分语义（≠预设的"选一"开关组）
      "zoning":  { "retirement": "auto", "pin": false },                    // ★ 新增：缓存分区策略覆盖（条目级退休/钉住）
      "compat":  { }                                                        // 未建模字段原样暂存，导出时原样回写
    }
  ]
}
```

要点：

- **语义零改动**：激活层的全部酒馆语义（含定时效应、递归控制、分组计分、匹配范围）以 world-info.js 为权威源实现，原生格式只是重新序列化，不是语义重设计。
- **compat 暂存袋保证真无损**：42 字段还会继续进化，未建模字段进 `compat` 原样保留、导出时回写——往返保证不依赖"我们恰好建模了所有字段"。
- **哈希不在文件里**：内容哈希/缓存指纹是 per-chat 运行态，存 chat_state；世界书文件保持纯内容——作者改条目 → 新哈希 → 走 freshWB 重新注入（缓存设计文档 §7 的既定行为）。
- **导入兼容两种形态**：uid 键对象与数组、老字段名（`insertion_order`→`order`）、缺省字段按酒馆默认值补齐。
- 存储：`data/worldbooks/*.dgworld`，Zod 校验；导出回酒馆时 `zoning/meta/compat 之外的本有能力字段`（如 zoning）提示丢弃，其余无损。

### 5.4 会话存储与消息树

- 消息为**追加式事件**，编辑与 swipe 不覆盖历史，而是产生**变体兄弟节点 + 当前指针**；分支（时间旅行）= 指向历史节点的子树。
- 表：`chats / messages(id, chat_id, parent_id, variant_of, role, content, model, usage_json, created_at) / chat_state(chat 的世界书哈希缓存、宏冻结值) / summary_blocks / usage_records`。
- 导出兼容酒馆 chat JSONL（选当前分支线性化导出）。

### 5.5 预设（Prompt Manager 语义映射）与预设的定位

以仓库内 `简单预设_V2.0.json` 为基准：预设 = `prompts[]`（identifier、role、content、marker、injection_position/depth/order）+ `prompt_order[]`（启用/顺序）+ 采样参数。

**预设在新项目中的定位**：预设仍是核心用户资产与一等兼容对象（存量用户 15+ 个预设），但角色重新定义——旧酒馆里预设靠走私 JS/正则/宏变 Hacks 承载机制（小猫之神的 post-script、狐神抚的 setvar 开关体系），新项目里缓存/记忆/工作流/正则美化全部上移为原生能力或插件 API，**预设回归"纯声明式提示词配置"**：段列表 + 顺序 + 插槽 + 稳定性标注 + 采样参数。用户不需要再往预设里塞脚本。

映射规则：
- prompt 条目 → IR 段落，`identifier` 作为稳定 ID。
- marker（`charDescription / worldInfoBefore / chatHistory / personaDescription …`）→ 动态插槽，编译时由对应子系统填充。
- `injection_position/depth` → 归入 injection 或 tail 区。
- 采样参数 → ChatRequest 采样段；不同 provider 的参数差异（如 Anthropic 无 frequency_penalty）由适配器声明能力并降级。
- 兼容导入优先，项目自身的预设编辑器按同样的 IR 概念设计（所见即所得的段列表）。

**原生预设格式（.dgpreset，JSON）**——与酒馆格式的差别是刻意设计：酒馆格式是三段式分散结构（~52 个顶层散键 + `prompts[]` + 按 `character_id` 魔数分组的 `prompt_order[]`），无稳定性元数据、无开关组概念、机制靠 `extensions` 走私（狐神抚一个预设 4.8MB 里 87% 是内嵌 JS/ZIP/正则）。原生格式只承载"纯声明式提示词配置"，机制全部外置为被引用的独立 artifact：

```jsonc
{
  "schemaVersion": 1,
  "meta": { "name": "…", "author": "…", "attribution": "原样保留酒馆作者声明", "tags": [] },
  "segments": [                            // prompts + prompt_order 合一，启用状态内联
    {
      "id": "uuid-or-slug",
      "name": "📝文风（选一）|s喵特调",
      "role": "system",
      "content": "…",
      "enabled": true,
      "slot": null,                        // 或 "worldInfoBefore"|"charDescription"|"chatHistory"…（显式插槽枚举，替代魔法 identifier）
      "placement": { "zone": "header" },   // 或 { "injection": { "depth": 4, "order": 100 } }
      "stability": "stable",               // stable|appended|volatile；默认由挥发宏检测自动标注，可手动覆盖
      "group": { "id": "wenfeng", "exclusive": true }   // 原生"选一"开关组，替代 setvar 惯例
    }
  ],
  "params": { "temperature": 1, "topP": 0.88, "topK": 40, "maxContext": 128000, "maxTokens": 8192, "stream": true },
                                        // 归一化采样参数；provider 差异由适配层按能力声明降级，不再是 52 个顶层散键
  "bindings": {                          // 机制引用（不内嵌任何代码）
    "workflow": "default-rp-workflow",   // 工作流 profile（对应狐神抚主/Agent 双预设的分工，单引用合一）
    "displayRules": ["fox-thinking-theme"],  // 显示规则（承接酒馆正则美化）
    "skills": ["banword-rules"]          // 技能包
  }
}
```

**导入/导出与往返保证**：
- 导入（酒馆→原生）：`prompts[] + prompt_order[] + 顶层采样参数` 无损转换为 segments/params（marker identifier→slot、injection_position/depth→placement、按命名惯例识别"（选一）"→group 建议）；`extensions.*` 按 §5.9 策略处理并出具可迁/不可迁清单。
- 导出（原生→酒馆）：segments/params 无损回写为酒馆格式（slot→marker identifier、zone→injection_position=0、injection→position=1/depth/order）；`stability/group/bindings` 无法承载，导出时提示丢弃。
- 承诺：**提示词层双向无损**；机制层单向（酒馆机制→原生能力映射，导出不回走私代码）。
- 存储：`data/presets/*.dgpreset`，Zod 校验 + schemaVersion 演进。

### 5.6 群聊

- 发言策略：手动 @、轮询、LLM 导演（由廉价模型根据场景选 1–N 名发言者并给出动机提示）。
- 每角色一个"视图"：角色卡区不同 + 共享世界书与历史 → **per-(chat, character) 缓存命名空间**；世界书哈希缓存按 chat 共享（内容寻址，天然无冲突）。
- 已知代价：轮换发言使各角色前缀的缓存 TTL 容易过期（Anthropic 5min）→ 群聊模式自动建议 1h TTL（Anthropic）或接受较低命中。详见缓存设计文档 §6。

### 5.7 扩展系统（前端插件）

- **事件总线**：核心从第一天就发事件（`message:appended / prompt:compiled / turn:finished / group:speaker_selected …`），扩展订阅。
- **UI 扩展**：iframe 沙箱 + postMessage 桥，声明式权限（读聊天 / 自定义面板 / 消息按钮槽位 / 自有存储命名空间）。
- **服务端钩子（后期）**：具名钩子点 + 白名单参数（如 `prompt:postBuild` 只允许改 tail 区），避免重蹈"扩展随便改 prompt 毁缓存"的覆辙。
- 迁移目标：酒馆的纯 UI 类扩展（如 UI 增强、统计面板）思路可平移；依赖酒馆内部 API 的不做。

### 5.8 Agent 层

> 实施阶段以总设计 §36 为准（Agent Runtime = P3，Roleplay = P4）；模块章节只描述"是什么"，不携带阶段号。

> **完整实施规格见 [specs/agent-runtime-spec.md](./specs/agent-runtime-spec.md)**（与总设计 §21 的关系：总设计定边界与架构口径，模块规格定对象模型、状态机、API 与验收）。下文保留的是**从狐神抚 V18 实战资产中提炼的产品决策**，不是 Runtime 实现细节。

- **Director（编排器）**：每轮决策走哪条路径——快速路径（单次调用，等价酒馆体验）、完整工作流、记忆密集路径；群聊里负责选人。
- **三段工作流**：大纲（可选，廉价模型出节拍）→ 正文（主力模型）→ 润色（去 AI 味风格指南 + 连贯性自检，可调记忆检索工具核对事实）。**所有阶段共享同一 context header（只缓存一次），各阶段指令与上游产物全部放 tail 区**；只有润色终稿进入 history。
- 每阶段独立配置模型/温度/预设（大纲用快模型，正文高温度，润色低温度）。
- **记忆服务四层**：
  1. 滚动摘要链：历史分块摘要为冻结块 S1..Sk，追加式注入 summary 区（自身也吃缓存）；
  2. 实体档案（dossier）：角色/地点/物品的结构化事实卡，由 Scribe（后台记忆员 agent）或正文 agent 的工具调用维护，存 SQLite + 向量索引；
  3. 时间线事件账本；
  4. **资料库（Data Bank 等价）**：用户给会话/角色附加文档（txt/md/pdf/epub…）→ 分块嵌入 → 每轮按需检索注 tail 区，或作为 agent 工具按需读取；与记忆共用 sqlite-vec 基础设施——对应酒馆"内置 RAG：将文档添加到您的聊天中"。
- 这套东西**替代** MVU/表格插件的核心动机（`表格预设/` 里的那类）：表格类插件每轮把整张表挥发注入，既烧 token 又毁缓存；档案化 + 按需检索 + tail 注入，两者兼得。确定性变量（如状态数值）后续做成可选插件：`set_variable` 工具 + 服务端存储 + 只把相关切片注 tail。

设计参考来自狐神抚 Agent 预设（详见 [hushenfu-v18-analysis.md](./hushenfu-v18-analysis.md)），直接采纳四项：

- **默认工作流模板**：fox-writer 四轮 tool-call 模式——准备（读激活世界书目录/按需检索/条件读技能包）→ 写稿 + **固定并发批次**委派审查者 → **等待期流水线化**（不等子 agent，先自查并立即 patch 已发现问题，再 await）→ 综合修正（critical>major>minor 排序采纳，允许拒绝误报）→ commit 落为消息。"await 不混进并发批次、等待期绝不空转"是延迟优化的实战守则。
- **Agent Profile 声明式 schema**（JSON 配置而非提示词）：模型/预设快照复用、工具白名单与 deny 列表、maxInvocationsPerRun / maxConcurrentInvocations / resultBudgetTokens 预算、allowedCallers 调用方权限、产物 artifact（path/kind/target=messageBody 落为聊天消息）。
- **技能包（skills）机制**：ZIP + SKILL.md + references/，agent 按需条件读取（先判断再读、禁止预读），配 maxReadCharsPerCall/PerRun 字符预算——上下文经济性。
- **上下文经济性守则**：按需读取、预算上限、楼层重编号防 AI 误判、审查者只读化。

### 5.9 酒馆生态兼容（st-compat 包）

导入优先级按用户真实资产排序（详见 [st-reference-analysis.md](./st-reference-analysis.md) §6 与 [hushenfu-v18-analysis.md](./hushenfu-v18-analysis.md)）：

1. **OpenAI/Chat Completion 预设**（prompts + prompt_order + injection 字段）——资产主力，最高优先级；
2. **世界书 JSON**（V2/V3 条目语义）与**角色卡**（PNG/JSON/charx）；
3. **聊天记录**（JSONL，含 swipes 变体与 chat_metadata）；
4. **预设内嵌扩展命名空间的处理**：`SPreset`（ChatSquash/RegexBinding——正则脚本尝试映射到显示层规则，ChatSquash 标记为不可迁）、`tavern_helper`（3MB 级 JS 引擎——**明确标记"机制已由原生能力替代"**，不迁移不执行）、`tauritavern`（agent profiles——尝试映射到我们的 Agent Profile schema）、`regex_scripts`（显示正则映射，prompt 正则标记人工复核）。导入时逐项报告可迁/不可迁清单，尊重预设内作者声明并原样保留。

### 5.10 角色卡（格式与资产）

酒馆生态的角色卡有三种载体（本机实测）：**PNG 内嵌**（`tEXt` 块里同时写 `chara`(V2) 与 `ccv3`(V3) 两份 base64，顶层 15 个旧字段 + `data{}` 16 个字段双层冗余）、**JSON 明文**、**charx**（ZIP：`card.json` + `assets[]` 清单，情绪贴图/图标解包到角色名目录，如本机 `Seraphina/` 的 28 张情绪贴图）。

**原生格式（.dgcard，JSON + 资产目录）**——设计要点是"定义与运行态分离、资产结构化、内嵌书外置"：

```jsonc
{
  "schemaVersion": 1,
  "meta": { "name": "…", "creator": "…", "characterVersion": "…", "tags": [], "attribution": "…", "license": "…" },
  "persona": { "description": "…", "personality": "…", "scenario": "…", "mes_example": "…" },
  "greetings": { "first": "…", "alternates": ["…"], "groupOnly": ["…"] },   // V3 group_only_greetings 原生支持
  "prompts": { "system": "…", "postHistory": "…" },                          // system_prompt / post_history_instructions
  "assets": [ { "id": "a1", "type": "avatar|icon|emotion|background", "uri": "assets/a1.png", "emotion": "joy" } ],
  "worldbookRef": "wb-xxxx",      // 内嵌 character_book 导入时抽取为独立 .dgworld 并双向引用
  "compat": { }                   // 未建模字段暂存，导出回写
}
```

与酒馆格式的差别：

| 维度 | 酒馆 | 原生 |
|---|---|---|
| 载体 | PNG tEXt 双内嵌（V2+V3 两份）/ JSON / charx ZIP，三态并存 | `.dgcard.json` + 资产目录；**PNG 仅作分享交换格式**（导出时双写 chara+ccv3 保持社区流通性） |
| 冗余 | 顶层 15 旧字段与 `data{}` 重复 | 单层结构 |
| 运行态混入 | `talkativeness/fav/chat/avatar` 混在卡文件里（定义与状态同文件） | **移出卡文件**，fav/活跃度/统计进 DB；卡文件纯定义，可版本化可同步 |
| 资产 | charx assets 解包后散落在角色名目录、靠命名约定关联 | 结构化 `assets[]` 清单（type/emotion 显式绑定） |
| 内嵌世界书 | `data.character_book` 藏在卡里 | 导入即抽取为独立 `.dgworld` 双向引用（世界书编辑器直接可编辑）；导出回嵌 |
| 群聊问候 | V3 才有 group_only_greetings | 原生字段 |

往返保证：三载体（PNG/JSON/charx）全量导入；导出 PNG 双写 `chara`(V2)+`ccv3`(V3) + 内嵌书回嵌 + 情绪贴图按 ST 目录约定落盘——社区流通零障碍。`meta/attribution` 原样保留作者声明。

### 5.11 用户角色（Persona）子系统

酒馆的 persona 是独立功能（personas.js 3000+ 行）：多套用户人设（名字+描述+头像），按会话绑定，`{{user}}` 宏取自当前 persona。本项目补齐为一等子系统：

- **用户角色库**：多 persona（名称/描述/头像），CRUD + 导入导出；从酒馆 `settings.json` 的 `personas` 数组与 `User Avatars/` 目录迁移。
- **三级作用域**：全局默认 persona → 按角色卡绑定（不同角色面前用不同人设）→ 按会话覆盖；聊天顶栏显示当前生效 persona，一键切换。
- **与缓存契约联动**：persona 是 header 区内容，切换 persona = 显式前缀失效事件（Inspector 标注），`{{user}}` 宏按会话冻结（§5.2 既定语义）。
- 群聊中 persona 即"你自己"这个参与者的卡。

### 5.12 外观系统（主题与聊天背景）

- **主题** = CSS 变量集（色板/圆角/字号/消息气泡样式），内置暗色默认；主题文件可导入导出（兼容 ST themes 格式）。
- **聊天背景三级覆盖**（纯显示层，不参与 prompt 编译，与缓存零耦合）：
  1. **全局默认**背景；
  2. **角色卡绑定**——`.dgcard` 的 `assets[type=background]`（charx/V3 卡自带背景资产，导入即关联，对应 ST `characters/{name}/backgrounds/` 约定）；
  3. **会话级自定义**（最高优先）——用户可为单个对话单独设置背景图案。
- 背景形态：整图（cover/fit）与**平铺图案（tile）**两种；配"遮罩透明度"与"模糊度"两个可读性滑杆，正文可读性优先。
- 背景资产库：`data/backgrounds/`，与 ST 背景目录同构，ST 背景包直接导入。
- **自定义 CSS**：允许但隔离注入（作用域限定在应用根内 + 安全警告），归入 §5.7 扩展安全模型。
- 实现成本低（纯前端），不必等 P5——可作为 P1/P2 的穿插小项提前交付。

## 6. 数据模型（要点）

数据模型已由 [specs/database-schema.md](./specs/database-schema.md) 全面取代（五层表体系、UUIDv7 主键、版本快照、运行态专用表），本节不再维护列级清单。与本文件相关的三个口径变化：

- 原 `chat_state(chat_id, key, value)` KV 由 **worldbook_runtime_entries + cache_runtime_states 专用表**取代；
- 原 `usage_records` 并入 **generations**（挂 run_id / snapshot_id，含 cached_tokens 与估算标记）；
- 文件区不变，仍是资产事实源：`data/cards/`、`data/worldbooks/`、`data/presets/`（导入导出即拷贝；DB 侧存索引与版本快照，见总设计 §38 决策 11）。

**收编 agent-runtime-spec 后的三个口径变化（2026-09）**：

- 一次执行 = 一条**不可变 Run**（`runs`），`attempt` 记 Attempt 级重试、`origin_run_id` 记用户触发的新建重试（总设计 §38 决策 15）；执行树靠 `parent_run_id`，恢复点靠新增的 `runtime_checkpoints`（≠ `cache_checkpoints`，后者是 Provider 缓存断点）；
- 等待人工批准不再只是 UI 状态：新增 `approvals` 表持久化，配合事件唤醒（Agent 的 waiting 不能依赖内存 Promise）；
- 产物 `artifacts.frozen` 只标记"内容不再变化"，**不提升缓存分区**——一律 injection / tail（总设计 §38 决策 14）。

**参照 DeepSeek Harness 补强后的三个口径变化（2026-09-05）**：

- `events` 表新增 **`durability` 列**（`durable` / `deferred-durable`，NOT NULL）。`live` 档（`generation.delta`、`prompt.compiling`）**不落表**——`generation.delta` 每 token 一条，落表会直接撑爆这张表。新增事件类型必须显式声明分档。
- `approvals` 表拆 `status`（审计配对进度 `pending` → `decided`）与 **`outcome`**（四值封闭枚举 `allowed_once / rejected / cancelled / unavailable`）。**fail-closed**：只有 `allowed_once` 放行，无回答者一律 `unavailable` = 拒绝。
- `chat_branches` 新增分支血缘位 `fork_message_id` / `seed_length` / `is_seeded`。继承前缀视为**可复用的缓存前缀**，fork 出去的分支可直接命中父分支已缓存的前缀。

## 7. AI 协作编码规范（2026-09 新增）

> 本项目代码由 AI 会话接力生成、每次会话无记忆——**代码的读者是「下一位 AI 同事 + 作者」，注释与文档是跨会话传递上下文的唯一载体**。本规范约束 AI 生成代码的注释与文档行为，防止两件事：注释噪音化，以及 spec 与实现分叉。

### 7.1 注释分层（管位置，不管数量）

判据一句话：**注释解释 why，不解释 what**——代码本身应当可读，注释只写代码说不出口的事。

机制（TS strict）：**导出 API / 模块头用 `/** */` TSDoc**（IDE 悬停可见，将来自动生成文档）；**why 决策用 `//` 行内注释**。两类用途不同，互不混写。

- **必注：公共 API / 模块头（TSDoc）**。签名、参数、返回、抛错、调用方须知；一句"这个函数 / 模块为什么存在"。
- **必注：决策与不变量（why，行内 `//`）**。凡触及 spec 铁律（Run 不可变、按 model order 回灌、冻结产物不进前缀、事件命名等）或做过权衡的地方，注释里写明理由并**指向 spec 节号（带节标题，防重编号后引用漂移）**，例：
  ```ts
  // 并行工具结果必须按 model order 回灌，不得按完成顺序——否则 Replay 失效
  //（agent-runtime-spec §36.3 并行工具的结果回灌顺序）
  ```
- **禁注：实现细节（what）**。不逐行翻译代码、不给显然的赋值加注释、不写"这行把 x 加一"。
- **量化锚点（仅针对行内 `//`；TSDoc 与模块头不计入）**：平均每函数 0–3 行；直觉判据是"行内注释与代码行比 ≈ 1:10"，超过 10% 即视为噪音。

### 7.2 spec 是真相源：防漂移，不另产平行详设

- **动手前先读对应详设——按模块找对文档**：Prompt Compiler / Database / Agent Runtime / Provider Adapter（归一契约·错误分类·不变量）/ HTTP·SSE API 契约在 `specs/`；Provider 接入实务（四类接入/自定义插头/密钥/代理）、st-compat、资产格式在 [technical-plan.md](./technical-plan.md) §5；UI 在 [ui-design.md](./ui-design.md)。
- **改代码触及 spec 语义（表结构、事件名、状态机、Zone / 缓存口径）必须同步修订 spec**，不许"代码先跑起来再补文档"；修订时同步更新该 spec 头部版本行与修订说明（一句话，注明日期）。
- **新核心模块先落 spec 骨架再写码**：带状态机、对外契约或缓存语义的新模块（如未来的 Macro Registry、Plugin Runtime），先在 `specs/` 建 spec（骨架即可），沿用收编惯例；纯局部实现不需要 spec，决策用 §7.1 注释就地记录。
- **不另产平行详设**：上述文档已是权威详设；避免第二份注定漂移的文档。
- **冲突处理**：实现与 spec 冲突时，能改代码就改代码；确属 spec 错误才改 spec，并把变更记入 [technical-design.md](./technical-design.md) §38 决策记录（注明日期与原因）。

### 7.3 会话变更记录（延续性）

- 收尾写 `.workbuddy/memory/YYYY-MM-DD.md`：改了什么 / 为什么 / 踩了什么坑；跨会话决策必须落 technical-design §38。
- 新会话开工先读：memory 最近日记 + technical-design §38 + 相关 spec 头部版本说明。

### 7.4 兜底红线（记不住上面全部时至少守这三条）

1. 不注释显而易见之事；注释解释 why 不解释 what。
2. 不为"像人类写的"加戏（花哨命名、多余抽象、表演性注释）。
3. "顺手同步 spec" 永远优先于 "顺手绕过 spec"——spec 与代码分叉是长项目最贵的腐化。

## 8. 测试策略（本项目成败所系）

1. **前缀稳定性测试（CI 硬门禁）**：用 fake provider 跑 N 轮模拟对话脚本（含新条目触发、编辑、swipe、预算裁剪、群聊换人），断言：
   - 第 k 轮的 header+stableWB 序列化字节 == 第 k+1 轮的对应前缀（毕业条目原位）；
   - history 区追加式（除编辑/分支等显式事件外）；
   - 每轮记录"预期失效 token 数"，超阈值报警。
   ——上线前就能在零 API 成本下验证 60–90% 命中率 claim。
2. **金样快照**：用仓库内的真实资产（`地点.json`、`简单预设_V2.0.json`）做导入→编译→序列化金样，防语义回归。
3. **适配器契约测试**：每个 provider 用录制回放（fixture）测流式/usage/缓存字段归一。
4. **线上遥测闭环**：Inspector 展示每轮实际发送内容 + 命中率曲线；**缓存二分工具**——连续两轮 prompt 各段哈希链 diff，第一个分歧字节定位"谁毁了缓存"（某轮被改的宏、被裁的条目、被编辑的消息）。
5. **运行期不变量断言（CI 硬门禁，2026-09 补）**：总设计 §5.5 的四条不变量必须在代码里断言，不是靠评审发现：
   - 发模型请求前必挂 `snapshotId` 且该快照存在；
   - 模型可见内容必须能从 snapshot / 事件日志重建；
   - 元数据（遥测 / 调试 / 追踪 ID）不得出现在 `messages` / `system` / tool schemas 里；
   - `waiting` 状态必须有对应的 durable 事件。
   实现方式：在 fake provider 的调用入口埋断言，任何一条测试路径绕过 Compiler 自己拼 prompt 都会立刻红。这条是防架构腐化的廉价保险——长项目里"某个新路径图省事直接拼字符串"是最常见的腐化起点。
6. **工程纪律 D1–D5 的代码审查清单（2026-09 补）**：总设计 §5.5 五条纪律（正交结果独立上报 / 公共契约两边都守 / 异步状态不是同步状态 / Dispose 到达静默态 / 派发器吃掉订阅者异常）应固化为 PR review checklist。它们对应的都是生命周期、并发、teardown 代码里的真实缺陷类别。

## 9. 路线图

路线图已上移至 [technical-design.md](./technical-design.md) §36（P0–P5，含单人规模估算与量化验收标准），以总设计为准。原六个里程碑与 P0–P5 一一对应（旧编号废弃）；P2（缓存层）仍是本项目最大差异化价值，建议尽早并优先打磨，P1 落"激活层"后即可并行开工；原独立群聊里程碑并入 P4。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 预设/世界书语义长尾（酒馆行为细节极多） | 以真实资产金样驱动；语义不确定处按"酒馆为准"清单化决策 |
| provider 缓存策略变动（价格/TTL/阈值） | 缓存策略集中在 CachePlan 一处；遥测面板使变化立刻可见 |
| 某些模型/中转站不回传缓存 usage | 降级为"前缀稳定性"间接指标（自家序列化哈希链） |
| 前缀 < 1024 token 不触发缓存（小设定卡场景） | 遥测标注"前缀过小，缓存未激活"；合并 header 提示 |
| 群聊缓存失效率高 | 1h TTL 选项、减少 per-char header 差异（共享系统区） |
| 摘要链质量（信息丢失/污染） | 摘要只进 summary 区不动原始历史（原始消息永久保留，可回溯重摘要） |
| Agent 工作流延迟（三段串行） | 阶段并行化（大纲与记忆检索并行）、快速路径兜底、流式展示各阶段产物 |
| SQLite 数据损坏（本地单文件库） | WAL 模式 + 定期自动备份（data/backups/，滚动保留）；启动 integrity check，失败引导从备份恢复（2026-09-05 补） |
| Schema migration 失败 | 迁移前自动备份；失败回滚并阻止启动（database-schema §78 + implementation-plan WP0.6）（2026-09-05 补） |
| 崩溃后 non-idempotent 工具被重放 | 工具幂等性分类（agent-runtime-spec §50）+ Resume 安全检查（§51–55）；逐状态恢复矩阵与 reconciliation 对账在 WP3.1 细化还账（implementation-plan §10 #11）（2026-09-05 补） |
| 插件权限逃逸（P5） | iframe sandbox + 权限模型（总设计 §29/§21.5）；P5 细化时补逃逸测试清单（2026-09-05 补） |
| 性能预算无界漂移（"半年后从 50ms 变 1.8s 无人察觉"） | 工程性能预算三档（target / warning / hard-limit）随 WP2 细化落定（implementation-plan §10 #12；compile 侧已有 compiler-spec §126）（2026-09-05 补） |

## 11. 开放决策点（默认已选，可推翻）

1. 前端用 React（而非 Svelte/Solid）——为组件生态妥协。
2. 消息与状态用 SQLite（而非酒馆式纯文件）——为消息树与查询妥协；文件仅存可移植资产。
3. prompt 组装放服务端（酒馆在前端）——为 Agent/插件/遥测共用同一管线。
4. 首轮世界书注入范围：**仅本轮激活条目**进缓存（而非全量塞入）——小世界书可开"预载全量"开关。
5. 桌面化放 P5（总设计 P5），P0–P4 均为本地 web 应用（`localhost` 运行）。

6. **summary 区位于 history 之前**，摘要块追加 = 显式 CacheBreak 事件（合并稿决策，成本推导见 [worldbook-cache-design.md](./worldbook-cache-design.md) §3.4 与总设计 §10.1）。
7. **stableWB 默认 first-seen append-only 物理序**（Performance Mode）；Compatibility Mode 回退酒馆语义序（初版排序漏洞分析见 [worldbook-cache-design.md](./worldbook-cache-design.md) §3.1）。
8. **编辑已注入条目 = 旧化身退役 + 新化身进 freshWB 尾部**（失效窗口与原位重注入相同，且保持分区连续，总设计 §11.4）。
