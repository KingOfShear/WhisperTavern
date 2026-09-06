# 缓存友好型世界书设计（内容哈希分区机制）

> 回答核心问题：**这套"以内容哈希为指纹、按聊天维护已发送条目缓存"的机制可行吗？**
> 结论：**可行，方向完全正确**——它本质上是把世界书的装配从"按激活顺序重排"改为"按缓存友好性分区"，使 prompt 头部变成追加式（append-only），从而吃到各家的前缀缓存。但有 6 个决定成败的实现细节（§3），做不对命中率会从 90% 掉到 0。
>
> **文档层级（2026-09）**：本文是 [technical-design.md](./technical-design.md) 之下的 **Cache Engine 详细规格**。
> **2026-09 修订**：采纳总设计 §11 的 **physicalOrder 修正**——初版"两区各按 (order, uid) 排序"在"新条目排序键小于已毕业条目"时会让毕业动作移动字节、触发第二次历史失效（§3.1 已改写）；稳定区统一命名 stableWB（旧名已废弃）；§3.4 补充 summary 区位置决策（维持 history 之前）。
> **2026-09 二次修订**：§2.1 分区公式修正——stableWB 成员资格由 chatCache 决定、**与当轮激活解耦**（失活条目照常发送直到退休；Compatibility Mode 按 ST 语义即时移除但产生 WORLD_BOOK_DEACTIVATED 声明事件）。

## 1. 背景与问题

### 1.1 前缀缓存的工作原理

各家模型厂商的 prompt 缓存都是**前缀精确匹配**：请求的 token 序列与缓存中某前缀逐 token 一致，命中部分按约 1/10 价格计费。

| Provider | 机制 | 命中价格 | 写入价格 | TTL | 最小前缀 |
|---|---|---|---|---|---|
| Anthropic | 显式断点 `cache_control`（≤4 个） | ~1/10 | 1.25× | 5min（可选 1h） | 1024/2048 tok |
| OpenAI | 自动前缀缓存 | 1/2 | — | 分钟级 | 1024 tok |
| DeepSeek | 自动前缀缓存（硬盘） | ~1/10 | — | 小时级 | — |
| Gemini | 隐式 + 显式 context caching | ~1/4 | 显式另有存储费 | 可配 TTL | 4096 tok（隐式更低） |
| 本地 vLLM / llama.cpp | 自动前缀缓存 | 免费 | — | 内存允许即有效 | — |

推论：**prompt 中任何一处字节变动，其后所有内容全部失效**。稳定的放前面，易变的放后面，是唯一正确的布局。

### 1.2 酒馆传统装配为何毁缓存

酒馆按条目的 `order`/激活顺序/插入位置（角色前、角色后、@D 深度）动态装配世界书。绿灯条目随剧情触发与退场，导致：

- 头部内容**每轮重排**（哪怕条目集合不变，顺序也可能因触发路径不同而变化）；
- 条目插入/退出位置在 prompt 中部 → **其后全部历史每轮重发**。

典型后果：40k token 的历史 + 8k 设定，每轮按 ~48k 全新 token 计费。缓存命中率趋近 0。

## 2. 方案总览：分区模型

### 2.1 机制描述（采纳你的方案，形式化如下）

```
每轮生成前：
  1. 激活层：按酒馆语义（关键词/递归/概率/蓝绿灯）算出本轮激活条目集 A
  2. 渲染：对 A 中每条做宏展开，得最终文本；h = sha256(normalize(text))
  3. 分区（2026-09 二次修订：stableWB 成员资格与当轮激活解耦）：
       stableWB = { e | h(e) ∈ chatCache ∧ ¬retired(e) }   → 照常发送，无论本轮是否激活
       fresh    = { e ∈ A | h(e) ∉ chatCache }             → 本轮新条目，追加在稳定区物理尾
       （初版公式 hit = { e ∈ A | h(e) ∈ chatCache } 按字面执行：毕业条目一旦失活即被移出序列中部，
         造成"无失效事件的前缀断裂"，且与 §7 退休机制的前提——graduated 条目持续发送直到退休——自相矛盾。
         该矛盾由 prompt-compiler-spec §30 的评审暴露，两处已同步修正）
  4. 排序：stableWB 为 append-only——physicalOrder 在条目首次进入稳定区时分配、此后永不改变；
     freshWB 新条目追加在区尾。禁止每轮按 (order, uid) 重排稳定区（§3.1 修订）
  5. 更新：chatCache ← chatCache ∪ { h(e) | e ∈ A }   （并集，per-chatId 隔离）
```

prompt 布局：

```
[header: 系统提示/人格/角色卡]     ← 逐字节稳定
[stableWB: 已命中(已毕业)条目]   ← append-only：physicalOrder 首次分配后不变，毕业只改状态不改位置
[freshWB: 本轮新条目]            ← 变化时其后的历史一次性失效（可接受）
[summary: (P4)冻结摘要链]        ← 追加式
[history: 对话历史]              ← 追加式
[injection: @D 条目/AN/阶段产物]  ← 贴近末端
[tail: 挥发宏/RAG/工作流指令/风格指令] ← 每轮可变，位于历史后 → 零伤害
```

### 2.2 为什么稳态命中率高

设定类内容在 RP 中是持久的：一旦注入过一轮，此后每轮哈希命中 → 进 stableWB → 头部字节与上轮完全一致 → **header + stableWB + 全部历史** 都是缓存前缀，每轮只有新消息（+尾部挥发区）是新鲜 token。新条目只在剧情触发新设定时偶发出现，失效被摊销。这就是 60–90% 命中率的来源（命中率以 token 计：`cached_tokens / prompt_tokens`）。

### 2.3 逐轮字节演化示例

```
轮1: H | A B C       (A,B,C 全新 → freshWB；存哈希；physicalOrder=1,2,3)   新鲜: H+A+B+C+史1
轮2: H | A B C | 史1  (A,B,C 毕业 → stableWB，字节原位)                     新鲜: 史1回复+史2
轮3: H | A B C D | 史1回复 史2   (D 新触发 → 追加，physicalOrder=4)         新鲜: 一次性重发史1回复
轮4: H | A B C D | 史1回复 史2 史3  (D 毕业：fresh→stable，字节原位不动)    新鲜: 史3回复
```

轮 3/4 的细节：D 首次出现时即按**首次激活顺序**追加在稳定区尾部并获得 physicalOrder；次轮毕业只把 cacheState 从 fresh 改为 stable，**字节位置永不改变**。只有真正的新条目（D 首次出现）才使其后历史重发一次，毕业动作零失效。

## 3. 决定成败的 6 个实现细节

这几点是原方案描述里没有、但不做对就白设计的部分：

1. **【2026-09 修订】稳定区 append-only：physicalOrder 首次分配后永不改变**。初版规则"两区各按 `(order, uid)` 排序且相邻放置"存在漏洞：当新条目 D 的静态排序键**小于**某个已毕业条目时，毕业会把 D 从 freshWB 移进 stableWB 中部——
   ```text
   Round N:   A B C | D    (D 首次出现)
   Round N+1: A D B C      (D 毕业重排进 stableWB → B/C 之后字节全部位移，历史失效)
   ```
   即毕业动作本身可能触发第二次历史重发（§2.3 初版声称的"毕业=字节原位"只在 D 的排序键大于全部已毕业条目时成立）。修正后：**graduation 只改 cacheState（fresh→stable），不改物理位置**；物理顺序 = 首次激活顺序，与新条目的 order 值无关。代价是条目物理顺序偏离酒馆 (order, uid) 语义序——由总设计的 Compatibility / Performance 双模式兜底（Performance 为默认，需通过 Semantic Equivalence Test；Compatibility Mode 回退语义序、放弃该优化；条目级 `zoning.pin` 可强制单条回语义位置）。不变的部分：**分区装配禁止依赖任何逐轮动态状态**。

2. **哈希对象 = 宏展开后的最终文本**（规范化空白后）。`{{user}}` 改名、条目编辑都会正确地变成新指纹进 freshWB 重注入。注意哈希后**旧指纹留在缓存里无害**（死键，可惰性清理）。

3. **逐轮易变宏必须隔离**。`{{time}}`/`{{random}}`/`{{roll}}` 类宏若出现在 header 或世界书里，每轮改字节 → 全盘失效。策略：此类条目/段落标记为 volatile → 一律进 tail 区（历史之后）；或在 chat_state 里按聊天冻结取值。酒馆预设里常见的系统提示嵌 `{{date}}` 是隐性的命中率杀手，Inspector 要能标红。

4. **历史必须追加式**。编辑消息 / swipe 换回复 / 切分支是显式失效事件（从该点重发一次，之后恢复稳态），可接受；但**摘要替换历史**（传统总结插中间）会反复毁缓存 → P4 的摘要链采用追加式冻结块（S1..Sk），只追加不回写，从布局上规避。
   **summary 区位置决策（2026-09）**：summary 位于 history **之前**（总设计 §10.1）。V2 草案曾将其移到 history 之后以免"新摘要块插入位移历史"，但那样摘要链字节永远无法进入前缀缓存、每轮全价重发且随链增长——长对话累计成本远高于"每次追加摘要块重发一次历史"（40–80 楼才一次）。故维持现状布局，并把"追加摘要块"定义为显式 CacheBreak 事件。

5. **预算裁剪从 freshWB 尾部开始**。超上下文预算时优先裁 freshWB（其后失效窗口小），再裁 injection/tail；裁 stableWB 等于移动历史，是最后手段（"退休"机制见 §7）。

6. **@D 深度注入条目不参与分区**。作者把条目设为 @D 就是要它贴近对话（注意力更近），尊重原语义直接进 injection 区；只有"角色前/角色后"位置的条目进入 hit/fresh 分区。

## 4. 数据结构与接口

```ts
// chat_state 中的缓存记录
type WBCacheEntry = {
  hash: string            // sha256(normalizedRenderedText)
  uid: number             // 来源条目
  cacheState: 'unseen' | 'fresh' | 'stable' | 'stale' | 'retired'   // 与总设计 §14.2 生命周期对齐（原 retired: boolean 并入）
  physicalOrder: number   // 首次进入稳定区时分配，此后永不改变（§3.1 修订）
  firstSeenMsg: number    // 首次注入的消息序号（供二分/调试）
}

interface WorldbookZoning {
  stableWB: RenderedEntry[]   // chatCache 成员（含本轮未激活者），append-only
  freshWB: RenderedEntry[]   // 本轮新增
  nextCache: WBCacheEntry[]  // 本轮结束后写入 chat_state 的并集
  evicted: RenderedEntry[]   // 本轮因预算被裁的条目（供 UI 提示）
}
```

首轮行为：**只把本轮激活的条目**写入 freshWB 并入缓存（蓝灯常驻 + 绿灯已触发）。不做"全量塞入"——未触发的绿灯条目塞进去是纯浪费；需要强设定覆盖率的小世界书可开 `preloadAll` 开关。

## 5. Provider 映射（CachePlan）

core 的分区结果输出为 CachePlan，适配层翻译：

| Provider | 翻译 |
|---|---|
| Anthropic | 断点1 = header+stableWB+freshWB 末尾；断点2 = summary+history 末尾（最后一条 user 之前）；断点3 = injection 末尾（服务 swipe 重生成）。群聊/低频场景建议 1h TTL |
| OpenAI 兼容（含 DeepSeek） | 无需标记，仅保证前缀稳定；DeepSeek 注意 `prompt_cache_hit_tokens` 单独计费字段 |
| Gemini | 默认走隐式缓存；长设定 + 稳态会话可选显式 cachedContent（管理 TTL） |
| 本地 vLLM/llama.cpp | 自动前缀缓存，无动作；llama.cpp 的 prompt cache 文件持久化可选 |

注意最小前缀阈值（Anthropic 1024 / OpenAI 1024 / Gemini 4096）：header+stableWB 合计低于阈值时缓存不激活，遥测面板需给出"前缀过小"提示。

## 6. 群聊的缓存命名空间

- 世界书哈希缓存按 chatId 一份（内容寻址，与角色无关，天然共享）。
- Provider 侧缓存按前缀划分：每个角色的视图 = 自己的 header（人格+角色卡）+ 共享 stableWB + 共享历史 → **每 (chat, character) 一条独立缓存链**。
- 轮换发言 → 各角色链的访问间隔拉长，5min TTL 易过期。对策：Anthropic 用 1h TTL；Director 连续追问同一角色的调度优先保持链热；UI 显示每角色的链温度。

## 7. 边界情况与长期策略

- **条目退休（retirement）**：长对话中 graduated 条目只增不减，stableWB 膨胀。策略：连续 N 轮未再触发 且 优先级低于阈值的条目，标记 retired 移出 stableWB（一次性重发历史，之后恢复稳态）。默认关闭，给 UI 手动开关。
- **编辑已注入条目**：新哈希 → 进 freshWB 重注入（正确行为，模型需要看到新文本）；旧字节仍在缓存前缀里，此后不再发送 → 该点一次性失效，可接受。
- **swipe / 重roll**：同前缀完整命中（用户最常做的操作反而最省钱）。
- **分支切换**：从分支点一次性重发，恢复稳态。
- **与 Agent 记忆的协同（P4）**：摘要链冻结块追加进 summary 区（自身稳定）；RAG 检索结果进 tail 区；工作流三阶段共享同一 header（跨阶段只缓存一份），阶段指令与上游产物（大纲/草稿）全部放 tail——最终只有润色终稿写入 history。

## 8. 验证方案

1. **CI 稳定性测试**（零 API 成本）：fake provider + 脚本化 100 轮对话（含新触发/编辑/swipe/裁剪），断言轮 k 的 header+stableWB 字节是轮 k+1 的前缀；记录每轮"理论新鲜 token"曲线。
2. **真机遥测**：usage 归一化采集 `cached_tokens`，聊天面板画命中率曲线；目标：稳态 ≥ 70%，30 轮累计输入成本对照传统装配 ≥ 60% 削减。
3. **缓存二分工具**：相邻两轮序列化文本的哈希链 diff，第一个分歧段直接点名"谁毁了缓存"（改动的宏 / 移动的条目 / 编辑的消息）。

## 9. 参考实现分析：【DarkSide-小猫之神】v1.1 预设

仓库内 `【DarkSide-小猫之神】v1.1.json` 是该机制的现存参考实现（提取的脚本存于 `docs/_extracted_squashed_post_script.js`）。实现载体**不是酒馆原生能力**，而是第三方插件 SPreset 的 ChatSquash 功能 + 预设内嵌的一段后处理脚本（`extensions.SPreset.ChatSquash.squashed_post_script`）：

1. **压扁**：ChatSquash 把全部消息压成单条 system 消息，用 DeepSeek 特殊 token 作角色分隔符（`<｜system｜>` / `<｜User｜>…<｜Userend｜>` / `<｜Assistant｜>…<｜end▁of▁sentence｜>`）——整条 prompt 变成一个扁平字符串，为全局文本手术创造条件（也是为 DeepSeek 前缀缓存优化）。
2. **打标**：世界书条目经正则包上标记；插件压扁时将世界书块包为 `<|world_info|>…</|world_info|>`（生产端在外部 inject.js，不在预设文件内）。
3. **分区**（后处理脚本核心，与本文 §2.1 逐一对应）：提取所有 `<|world_info|>` 块 → 32 位字符串哈希为指纹 → `window.SPresetTempData.NekoGodC_worldBook[chatId]` 维护哈希集合（**内存态，刷新即失**）→ `isFirstRun`（缓存为空）时全部视为已缓存（即"首次全部写入角色前"）→ 命中条目替换预设条目「角色前」里的 `<|前置世界书|>` 占位符（prompt_order 槽位 4，角色描述之前），包裹 `<world_settings>`；未命中替换「角色后」条目里的 `|小猫之神_世界书|` 占位符（槽位 15，角色块之后、历史之前），包裹 `<additional_info>` → 缓存取并集。
4. 同一脚本还顺带实现了：`|delete|` 块清理、`<|set/get/if/eval|>` 微模板引擎、旧摘要段标记（`---第N段剧情总结---`，保留最后 3 段不标）；配套正则「小总结1」（promptOnly、minDepth 16）把 16 层以前的历史消息压缩为各自的 `<summary>` 内容——**用正则实现了历史摘要压缩**。

### 对本设计的验证与差距

| 维度 | 参考实现 | 本项目方案 |
|---|---|---|
| 缓存存储 | 内存（刷新丢失，isFirstRun 语义漂移） | SQLite 持久化 per-chat 缓存 |
| 指纹 | 32 位字符串哈希（千条目级有碰撞风险，碰撞=静默丢条目） | SHA-256（渲染后文本） |
| 分区实现 | 字符串占位符替换（用户消息含占位符即出错） | IR 分区，无字符串手术 |
| 毕业原位 | **未做**：两区被角色块隔开（槽 4 vs 槽 15），命中条目按当轮扫描序排列——新条目毕业时插入命中区中部，其后字节全部位移 | physicalOrder 首次分配后永不改变，毕业只改 cacheState（§3.1 修订） |
| 失效成本 | 每个新条目触发**两次**历史重发（首次注入一次、次轮毕业移位一次） | 新条目仅注入时一次（初版"共用静态键排序"方案在特定 order 分布下同样存在毕业移位，已由 physicalOrder 修正消除） |
| @D 条目 | 一并被提取重分区（覆盖作者意图） | 保留 injection 区 |
| 可验证性 | 无遥测，命中率不可见 | usage 采集 + 命中率面板 + 缓存二分 |
| 依赖 | 外部 GitHub Pages 插件（供应链单点） | 服务端一等能力，无外部依赖 |

结论：参考实现验证了机制在真实生产环境可行（面向 DeepSeek，2M 上下文配置），其分区布局与本文 §2.1 一致；上表差距即本项目 P2 的实现要点。

## 10. 狐神抚（玄狐引擎）对 P2 的补充输入

详见 [hushenfu-v18-analysis.md](./hushenfu-v18-analysis.md)。与小猫之神互补：小猫之神解决主请求的世界书分区；狐神抚的缓存创新在辅助推理请求与工作流侧，三项机制直接进本设计：

1. **预算溢出裁剪改为"整段滑动推进"**（狐裁弹性楼层窗口）：上下文超限时，不逐轮微裁（每轮都破坏前缀），而是保留稳定 N 楼钉死 + 尾部弹性区，撑满后锚点整段前推一次、随后恢复稳态。锚定带每楼内容签名（role:length:FNV），编辑/删除自动失效重建。此策略与 §3.5 的"从 freshWB 尾部先裁"共同构成两级裁剪：先裁 volatile/新条目，再整段滑动历史。
2. **失效语义规范**（狐裁指纹机制）：缓存条目变更时置 `stale` 标记而非删除（保护用户手编内容，可回滚）；提供"固定态"（用户手动维护、永不自动失效）与"强制刷新"两个显式覆盖；swipe/reroll 走专用复用路径。chat_state 的世界书缓存与摘要块均采用此语义。
3. **"长周期产物按角色缓存"模式**（Phase1/Phase2 分离）：与轮次解耦的静态产物（写作规则手册类）按角色卡缓存、跨轮复用、段式指纹（含条目 `length:head32:tail32` 摘要指纹）检测变更——用于 P4 工作流的静态产物缓存，也提醒我们：指纹不必全量哈希，大文本用"长度+首尾摘要"即可低代价检测微调。

---

*关联文档：[technical-plan.md](./technical-plan.md) §5.2/§5.3/§8*
