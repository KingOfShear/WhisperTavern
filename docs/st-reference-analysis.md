# SillyTavern 1.18.0 代码库参考分析

> 调研对象：本地部署 `C:\MySpecialFolder\SillyTavern`（sillytavern 1.18.0）。
> **文档层级（2026-09）**：本文是 [technical-design.md](./technical-design.md) 之下的 **兼容性参照（Level B 语义基准）**。
> 目的：为 DesireGrimoire 的 P1/P2 实现提供**语义对照源**与**兼容性基准**。引用格式 `文件:行号`。

## 1. 架构总评

**酒馆是"胖前端"架构**：Node 服务端（`src/`）基本只做 I/O 代理与文件存储，全部 prompt 智能在浏览器端（`public/scripts/`）。

| 文件 | 行数 | 职责 |
|---|---|---|
| `public/scripts/openai.js` | 7249 | Chat Completion 全流程：消息收集 → prompt 集合构建 → PromptManager 排序 → 最终 messages 数组 |
| `public/scripts/world-info.js` | 6289 | 世界书引擎：扫描/触发/递归/预算/装配 |
| `public/scripts/slash-commands.js` | 7095 | STscript 脚本引擎 |
| `public/scripts/PromptManager.js` | 2149 | prompt_order 条目管理 UI 与数据 |
| `public/scripts/group-chats.js` | 2490 | 群聊协调 |
| `public/scripts/extensions.js` | 2315 | 扩展系统加载与事件 |
| `src/endpoints/backends/chat-completions.js` | ~2600 | 服务端协议转换（含 Anthropic/Gemini 缓存断点） |

**对本项目的意义**：酒馆前端独占 prompt 组装，导致扩展/脚本只能在浏览器里做字符串手术（参考小猫之神预设的 post-script）。我们"编译器下沉服务端"的决策正确且必要。

## 2. 世界书引擎语义清单（P1 实现对照源）

`public/scripts/world-info.js`：

- **位置枚举**（`:855`）：`before=0 / after=1 / ANTop=2 / ANBottom=3 / atDepth=4 / EMTop=5 / EMBottom=6 / outlet=7`。注意 1.18 新增了 `outlet`（世界书出口，自定义注入点）——我们的 IR 需预留同概念。
- **预算**：`world_info_budget`（默认 25% 上下文占比）+ `world_info_budget_cap`（`:73-81`）。裁剪语义：按 order 优先级保留。
- 其余语义（selectiveLogic 四种、递归扫描、scan_depth、probability、stickiness/cooldown/delay 定时效应、全词/大小写匹配、automation_id）以此文件为唯一权威，P1 时逐段移植测试。

## 3. Chat Completion 组装流程（语义参照）

`openai.js`：`prepareOpenAIMessages`（`:1533`）→ `preparePromptsForChatCompletion`（`:1358`，把 WI 包成 system 消息：`worldInfoBefore`/`worldInfoAfter` 两个 identifier，`:1367-1368`）→ PromptManager 按 `prompt_order` 排列 → `populateChatCompletion`（`:1176`）遍历构建最终 messages；@D 深度注入走 `extensionPrompts`（setExtensionPrompt 机制，可带 role）。

要点：**marker 是"以 identifier 命名的动态槽位"**，与我们 IR 的 zone/segment 设计一一对应；顶层 `squash_system_messages` 选项已原生支持合并 system 消息。

## 4. 前缀缓存现状（P2 差异化判据，代码坐实）

全核心代码检索结论：

1. **Claude**：`claude.enableSystemPromptCache`（config.yaml，默认 **false**）——仅在 system prompt 末条 + tools 上打**一个** `cache_control: ephemeral` 断点（`chat-completions.js:260-277`）；`claude.cachingAtDepth`（默认 **-1 关闭**，`:103-104`）——开启后在历史深度 N 处打断点（`cachingAtDepthForClaude`，`:300`），这是酒馆唯一的"历史缓存"能力，仅限配置文件、仅限 Claude。
2. **Gemini**：`gemini.enableSystemPromptCache` 同类开关（`:2280-2291`）。
3. **遥测为零**：openai.js 中 "cache" 只出现在图片加载 HTTP 缓存；全核心不读 `cached_tokens`。
4. 世界书/预设/宏层面**没有任何缓存友好性考虑**——条目按激活动态装配，前缀必然抖动。

**结论**：酒馆的缓存能力 = "两个手动开关 + 单断点 + 零观测"。我们的 CachePlan（多断点自动规划 + 分区世界书 + 命中率遥测 + 二分定位）是代差级差异，且用户现实中只能靠第三方插件（SPreset/小白盒）自救。

## 5. 群聊机制（P3 参照）

`group-chats.js:122-131`：激活策略 `NATURAL(0) / LIST(1) / MANUAL(2) / POOLED(3)`；生成模式 `SWAP / APPEND / APPEND_DISABLED`（成员回复替换还是追加）；`auto_mode_delay` 自动模式间隔。协调者逻辑为成员按策略逐个生成。我们的 Director 策略（选人+动机）是 NATURAL 的强化版，接口上可直接扩展枚举。

## 6. 存储格式与兼容基准（以本机实际资产为准）

- **聊天**：每会话一个 JSONL；首行元数据含 `chat_metadata`（其中原生嵌有 `sheets` 表格数据——st-memory-enhancement 表格/MVU 数据就存在这里，`integrity`/`chat_id_hash` 等）。消息行含 `swipes[]`（变体文本数组）+ `swipe_id` + `swipe_info[]`（各变体生成元数据）。分支=整文件复制。
- **本机资产清单**（决定兼容优先级）：OpenAI 预设 15+（**Gemini 系预设占多数**：Kemini/Astro 系列；另有 ZOD 变量预设、DS 系），世界书含 MVU 表格书（`！！Table`），角色卡含 charx 格式（`Seraphina/` 目录），已用 `vectors/`（Data Bank 向量存储）。
- **已装第三方生态**：LittleWhiteBox（小白盒）——模块含 `agent-core / story-outline / story-summary / fourth-wall(长期记忆) / variables / assistant / ena-planner / scheduled-tasks / template-editor / debug-panel`，部分模块在读取 `cached_tokens`（社区已在第三方生态里原型化 agent 工作流与缓存遥测）。

**兼容结论**：
1. OpenAI 预设导入（prompt_order/prompts/injection 字段）是**最高优先级**——用户资产主力；
2. 世界书 JSON、PNG/charx 角色卡次之；
3. MVU/表格：读取 `chat_metadata.sheets` 展示为只读兼容，写入路径由我们的档案记忆替代（不承诺双向同步）；
4. 小白盒的 agent/记忆模块证明需求真实，其依赖的扩展 API 面（事件、iframe、injects）应作为我们 P5 扩展 API 的设计输入。

## 7. 对路线图的具体影响

- P1 移植 WI 语义时，**以 world-info.js 为权威源**逐项对拍（含 sticky/cooldown/outlet 这类易漏项）。
- P2 的 CachePlan 直接对标并超越 `cachingAtDepthForClaude`：它只有"深度 N 单断点"，我们做"分区感知的多断点 + 自动规划"。
- P5 扩展 API 设计前，先精读 LittleWhiteBox 用到的 ST API 子集（postMessage/iframe 注入、事件订阅、定时任务），保证主流社区扩展有迁移路径。
- `chat_metadata.sheets` 的存在说明"表格"已是社区事实标准——我们替代方案（实体档案）必须提供**一次性迁移工具**（sheets → 档案卡）才能说服存量用户。

---

*关联文档：[technical-plan.md](./technical-plan.md) · [worldbook-cache-design.md](./worldbook-cache-design.md) §9（小猫之神/SPreset 参考实现）· [ui-design.md](./ui-design.md)*
