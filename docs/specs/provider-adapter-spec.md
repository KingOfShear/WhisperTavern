# DesireGrimoire V2 — Provider Adapter Specification

> **文件：** `docs/specs/provider-adapter-spec.md`
> **版本：** V1.2（2026-09-05 S4'-b 实施：§8.1 reasoning_delta 增 signature 载体（PV8/§11 签名块"缓存于消息组装侧"的归一流通道）；V1.1 S4'-a（开放点 2 落定、Capabilities 定稿）；V1.0.x 骨架期）
> **状态：** Active（P0 范围定稿：§6–§8/§12/§14/§15 已随 S4'-a 实现落地并过契约测试；§16 缓存标记翻译随 WP2.4）
> **文档层级：** [technical-design.md](../technical-design.md) 之下的 **Provider Adapter 模块规格（第六份模块规格）**
> **决策锚点：** 技术总设计 §38 **决策 31**（含三岔分工修订：Provider 拆"归一契约"与"接入实务"两层）
> **依赖：** 技术总设计 §18（Provider 层 / §18.2 Capabilities / §18.3 Usage）、[worldbook-cache-design.md](../worldbook-cache-design.md) §5（CachePlan→provider 原语翻译）、[agent-runtime-spec.md](./agent-runtime-spec.md)（C5 执行四层 / §49.1 反循环 / §115.1 审批）、[instruction-security-spec.md](./instruction-security-spec.md) §17–§18（分层投影与 capability）、[api-spec.md](./api-spec.md)（generation.* SSE 投影）
> **分工声明：** 本规格管**归一契约**（请求/流式/工具/错误/usage 的统一形状与语义）；接入方式、自定义插头、代理、密钥存储等**生态实务**在 [technical-plan.md](../technical-plan.md) §5.1（决策 31 修订的分工边界，见 §3）。

---

# 1. 文档目的

Provider Adapter 是本应用与一切外部 LLM 服务的**唯一边界**：

```text
Compiler / Agent Runtime          外部世界
        │                            ▲
        ▼                            │
  统一 IR + CachePlan ──► Adapter ──► OpenAI 兼容 / Anthropic / Gemini / 本地端点
        ▲                            │
        └── 归一事件流 / usage / 错误 ◄┘
```

P0 验收（"三家流式聊天 + usage 入库"）的技术难点全部在本模块的**归一语义**上，而这些细节此前无家可归（technical-plan §5.1 仅 13 行实务描述）。本规格补齐：流式事件归一、工具调用归一、错误分类学、重试与多 key 轮换、取消与超时、能力探测降级链、契约测试清单。

# 2. 边界声明（适配器只翻译，不做语义）

```text
适配器不做的事：
✗ 不修改内容字节（不 trim、不改写、不重排文本 delta）
✗ 不做裁剪 / 预算 / 放置决策（归 Compiler / CachePlanner）
✗ 不理解角色 / 世界书 / 指令档位（instruction 层面仅按 §15 capability 透明投影）
✗ 不做运行时重试决策（归 Operation 层，唯一例外见 PV2）
✗ 不做审批 / 权限判断（归 Agent Runtime）
```

语义修改权唯一在 Prompt Compiler；协议翻译权唯一在 Adapter。两者之间没有第三层。

# 3. 与三岔分工的关系（决策 31 修订）

决策 26 ② 原三岔把"Provider 实务"整体放 technical-plan §5。本规格落成后拆为两层：

| 内容 | 归属 |
|---|---|
| 统一 IR / 流式事件 / 工具归一 / 错误分类 / usage 归一 / 不变量 / 契约测试 | **本规格（specs/）** |
| 四类接入方式（OpenAI 兼容 / 官方原生 / 本地推理 / 自定义插头）、插头配置实务、代理设置、密钥存储（DPAPI / Keychain） | technical-plan §5.1 |

technical-plan §5.1 已挂指向；后续 Provider 语义问题改本规格，接入生态问题改 §5.1，禁止互相抄写。

# 4. 模块位置与依赖方向

```text
packages/core        纯 TS，无 IO（Compiler / IR / CachePlanner）
packages/adapters    本模块：adapter 契约 + 各家实现（openai / anthropic / gemini / local）
                     + 归一类型（IO 边界唯一合法层之一）
packages/runtime     Agent Runtime（消费归一事件流，发起点）
packages/contracts   本规格 §6 类型收编地（shared-contracts-spec）
```

依赖方向（对齐 shared-contracts §1 与 compiler §138–139）：

```text
runtime → adapters → contracts
core → contracts（core 不依赖 adapters；CachePlan 类型经 contracts 传递）
adapters 不得反向依赖 runtime / core 内部
```

# 5. 裁决（PV1–PV8，必须 code assertion 或契约测试锁定）

```text
PV1  只翻译不做语义（§2 清单即断言清单）。
PV2  重试决策归 Operation 层（C5 设施级重试）；适配器内部唯一例外是
     同 Provider 多 key 轮换（§41.1，RATE_LIMIT/AUTH 触发，§13）。
PV3  usage 事件恰好一次，且必须在 finish 事件之前到达（§17）。
PV4  错误必须分类：一切失败以 ProviderError{code,...} 抛出（§12 码表唯一权威），
     禁止裸 Error / 裸字符串穿透到 Runtime。
PV5  密钥零泄漏：key / Authorization 头不得出现在错误消息、日志、
     快照、事件、fixture 任何位置（redact 规则 §17.2）。
PV6  取消优先：AbortSignal 贯穿全链路；取消 = 立即停止网络读 + 产出
     partial 事件序列（已到达内容照常归一），随后 CANCELLED 终止（§14）。
PV7  确定性回放：同一 fixture 字节流 + 同一请求 → 完全相同的归一事件序列
     （契约测试硬门禁，§20）。
PV8  reasoning / thinking 内容不丢弃：一律归一为 reasoning 增量事件；
     是否进入后续请求（历史回传）由 Runtime Context Policy 决定——
     唯一硬约束是 Anthropic thinking 签名块在工具循环中必须原样回传（§11）。
```

# 6. 核心类型（草案，实施期收编入 shared-contracts）

```ts
// packages/contracts（草案）

interface ProviderChatRequest {
  snapshotId: string                     // §5.5 不变量：模型可见必挂快照
  model: string
  messages: ProviderMessage[]            // 已由 Compiler 序列化，见 §8.1 分层投影
  tools?: ProviderToolSpec[]             // P3 起
  sampling: { temperature?: number; topP?: number; maxOutputTokens: number
              stopSequences?: string[]; seed?: number }
  cachePlan?: CachePlanMarkers           // §16；core 产出，adapter 只翻译
  stream: true                           // P0 Chat 面恒为流式（§9）
  signal?: AbortSignal
  metadata?: { runId?: string; requestId?: string }   // 仅遥测，绝不出网（PV5/§5.5）
}

type ProviderMessage =
  | { role: 'system'; content: string }        // 分层投影见 §8.1
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: string | ContentBlock[] }
  | { role: 'tool'; toolCallId: string; content: string }   // P3

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }  // PV8 签名回传

interface ProviderError {
  code: ProviderErrorCode                // §12 码表
  retryable: boolean
  retryAfterMs?: number                  // 尊重 Retry-After
  keyRotatable: boolean                  // 是否建议换 key（§13）
  providerStatus?: number
  detail?: string                        // 已 redact（PV5）
  raw?: unknown                          // 调试用，不得进日志默认输出
}
```

# 7. 适配器契约（接口形状）

```ts
interface ProviderAdapter {
  readonly providerId: string            // 'openai-compat' | 'anthropic' | 'gemini' | ...
  capabilities(model: string): ProviderCapabilities   // §15 探测结果

  stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent>
  // P0 唯一主路径。非流式不设（§9）。

  listModels?(): Promise<ModelInfo[]>    // /v1/models、/api/tags 自动发现（§15）
  countTokensNative?(req): Promise<number>   // Anthropic count_tokens / Gemini countTokens
                                         // compiler-spec §52 双模式的 native 侧钩子
}
```

Adapter 工厂按 provider 配置实例化；配置形状（四元组、插头、代理、key 列表）定义在 technical-plan §5.1，经 contracts 传入。

# 8. 流式事件归一

## 8.1 归一事件类型

```ts
type ProviderStreamEvent =
  | { type: 'message_start' }                                  // 恰一次，首位
  | { type: 'text_delta'; text: string }                       // 原样字节（PV1）
  | { type: 'reasoning_delta'; text: string }                  // PV8
  | { type: 'tool_call_delta'; index: number; id?: string;
      name?: string; argsFragment?: string }                   // P3；按 index 聚合
  | { type: 'usage'; usage: ProviderUsage }                    // PV3：恰一次，finish 前
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_use'
        | 'content_filter' | 'error' }                         // 恰一次，末位
  | { type: 'error'; error: ProviderError }                    // 终止流（finish reason=error）
```

顺序不变量（PV7 契约测试断言）：

```text
message_start 恰一次且最先；finish 恰一次且最后；
usage 在 finish 之前（PV3）；text_delta 仅在 message_start 与 finish 之间；
tool_call_delta 按 index 单调聚合；error 后不得再有任何事件。
```

## 8.2 各家映射总表（P0 三类）

| 归一事件 | OpenAI 兼容（含 DeepSeek/GLM/本地） | Anthropic Messages | Gemini streamGenerateContent |
|---|---|---|---|
| message_start | 首个 chunk | `message_start`（含 input usage 预存） | 首个 chunk |
| text_delta | `choices[0].delta.content` | `content_block_delta`(text_delta) | `candidates[0].content.parts[].text` |
| reasoning_delta | DeepSeek `reasoning_content`；o 系列按模型注记 | `content_block_delta`(thinking_delta) | `parts[].thought=true` |
| usage | 需 `stream_options.include_usage`；末帧 `usage` | `message_start.usage.input` + `message_delta.usage.output` 合成 | 每帧 `usageMetadata` 累积，末帧定稿 |
| finish | `finish_reason`：stop/length/tool_calls/content_filter | `message_delta.stop_reason`：end_turn/max_tokens/tool_use | `finishReason`：STOP/MAX_TOKENS/SAFETY |
| 差异注记 | 中转站可能不发 usage 帧或缺 include_usage（§17.3 降级） | thinking 签名块须缓存待回传（PV8） | SAFETY → finish=content_filter + CONTENT_FILTERED |

## 8.3 SSE 解析纪律（工程细节，均为历史级高频 bug）

```text
R1  多字节 UTF-8 缓冲：网络分块可能切断多字节字符，必须经 TextDecoder
    {stream:true} 式增量解码，禁止按 chunk 直接 toString。
R2  SSE 帧解析：多行 data: 拼接、CRLF/LF 兼容、注释行（:）忽略、
    event: 字段各家基本不用（按 data JSON 内字段判型）。
R3  [DONE] 哨兵（OpenAI 系）不产出事件，仅标记流尾。
R4  半开连接检测：first-token 超时 + idle 超时（§14 分层超时表）。
R5  伪造 200（中转站返回 200 + HTML/错误 JSON）：JSON 解析失败 → PARSE_ERROR，
    不得当成空流静默成功。
```

# 9. 流式唯一、多 choice 不做

P0 Chat 面恒为流式（非流式仅保留给内部批处理工具，不走本接口）。`n > 1` 不支持——swipe / 多候选在应用层串行多次请求实现（每次独立 snapshot，符合决策 17）。理由：多 choice 在流式协议三家差异大且与消息树/缓存模型冲突，收益不抵复杂度。

# 10. 工具调用归一（P3）

- schema 翻译：统一 `ProviderToolSpec{name, description, jsonSchema}` → OpenAI `functions` / Anthropic `tools[].input_schema` / Gemini `functionDeclarations`。
- 增量聚合：adapter 产出 `tool_call_delta`；**聚合为完整调用是 Runtime 的事**（对齐 agent-runtime §36.1–36.3：并行工具结果按 model order 回灌，聚合顺序同理按 index/model order，不按完成顺序）。
- id 规则：OpenAI `call_*`、Anthropic `toolu_*` 原样保留；provider 不发 id 时 adapter 生成稳定 id（`tc_{index}`），并在契约测试锁定。
- 回传格式：`role:'tool'`（OpenAI 系）/ `tool_result` block（Anthropic）/ functionResponse part（Gemini）——翻译由 adapter 做，组装由 Runtime 做。
- 结果信任：回灌内容按 instruction-security §14 处理（adapter 无责，但不得在翻译层"顺手"改写结果文本）。

# 11. 思考输出归一（PV8）

| 家族 | 形态 | adapter 行为 |
|---|---|---|
| DeepSeek R 系 | `reasoning_content` 字段 | → reasoning_delta |
| Anthropic | thinking block + signature | → reasoning_delta；**签名块缓存于消息组装侧**，工具循环回传时经 ContentBlock.thinking 原样回传（缺签名 = API 400，属 INVALID_REQUEST） |
| Gemini | `thought: true` parts | → reasoning_delta |
| OpenAI o 系列 | 不外显 / 摘要 | 无事件；capability.reasoning 标注即可 |

reasoning 是否进入下一轮请求（含缓存影响——thinking 内容逐轮变化，回传会打断前缀）由 Runtime Context Policy 决策，默认不回传（Anthropic 工具循环例外，强制项）。

# 12. 错误分类学（码表唯一权威）

| code | 典型来源 | retryable | keyRotate | fallback |
|---|---|---|---|---|
| `TRANSPORT_ERROR` | 断连 / ECONNRESET / DNS | ✓ 指数退避 | ✗ | ✓ |
| `TIMEOUT_FIRST_TOKEN` | §14 分层超时 | ✓（一次） | ✗ | ✓ |
| `TIMEOUT_IDLE` | §14 | ✓（一次） | ✗ | ✗ |
| `AUTH_INVALID` | 401/403 | ✗ | ✓（可标记 key 停用） | ✗ |
| `RATE_LIMIT` | 429（尊重 Retry-After） | ✓ 延后 | ✓ | 最便宜档 |
| `QUOTA_EXCEEDED` | 402 / insufficient_quota | ✗ | ✓ | ✗（终止+提示） |
| `CONTEXT_TOO_LARGE` | 400 context length / Gemini INVALID_ARGUMENT | 由 Runtime 反循环管（agent-runtime §49.1：降级后确实前进才重试一次） | ✗ | ✗ |
| `CONTENT_FILTERED` | Gemini SAFETY / OpenAI content_filter / 中转站拦截文案 | ✗ | ✗ | ✗ |
| `MODEL_OVERLOADED` | Anthropic 529 / OpenAI 503 | ✓ 指数退避 | ✗ | ✓ |
| `PROVIDER_ERROR` | 其余 5xx | ✓（≤2 次） | ✗ | ✓ |
| `INVALID_REQUEST` | 400 参数 / schema / 缺签名 | ✗（fail fast，多半是本应用 bug） | ✗ | ✗ |
| `PARSE_ERROR` | R5 伪造 200 / JSON 解析失败 | ✓（一次，标记兼容性问题） | ✗ | ✗ |
| `CANCELLED` | PV6 | ✗ | ✗ | ✗ |
| `UNKNOWN` | 兜底 | ✗（fail-closed：未知错误不自动重试） | ✗ | ✗ |

映射纪律：HTTP 状态 → code 的映射表按 provider 家族各一张，**表驱动，不写 if 链**；新错误码进表 = 改本规格 + §38 记录。`CONTEXT_TOO_LARGE` 上抛后由 Runtime 命名映射为 `PROMPT_CONTEXT_TOO_LARGE`（compiler/agent 既有口径），adapter 不做降级。

# 13. 重试与多 key 轮换（PV2 唯一例外）

```text
层 1  Operation 层重试（C5）：RETRYABLE 错误按 §12 矩阵重试，指数退避 +
      Retry-After 尊重；每次重试新建 Operation 记录。
层 2  key 轮换（adapter 内，唯一例外）：RATE_LIMIT / AUTH_INVALID / QUOTA_EXCEEDED
      时在同一次 provider.call 内轮换该 Provider 其余 key；受 AgentBudget 约束；
      轮换不派生新 Prompt Snapshot（§41.1 既有裁决）。
层 3  模型 fallback（Runtime ModelPolicy，决策 17）：primary→fallback→cheap，
      换 Provider 必派生新 Snapshot。
三层各司其职，禁止跨层代做（adapter 不做层 1/3，Runtime 不插手层 2）。
```

# 14. 取消与超时

分层超时（全部可配置，默认值实施期定）：

| 超时 | 触发 | 处置 |
|---|---|---|
| connect | TCP/TLS 建连 | TRANSPORT_ERROR |
| first-token | 建连后 N 秒无首事件 | TIMEOUT_FIRST_TOKEN |
| idle | 流中途 N 秒无任何字节 | TIMEOUT_IDLE |

取消（PV6）：signal 触发 → 立即 abort 网络读 → 把已缓冲事件正常归一发出（含可达的 usage）→ `finish` 不再发出，改以 `CANCELLED` 错误终止。Run 级取消语义（含"取消优先于重试/降级"）在 agent-runtime §49.1，adapter 只保证不吞取消。

# 15. 能力探测与降级链

capabilities 来源三层（高→低）：用户手动覆盖 > 静态预设表（内置 provider/模型模板，随版本更新）> `/v1/models` 等自动发现。探测结果记入 provider 配置（版本化），不阻塞聊天（探测失败 = 用保守默认）。

| 能力缺失 | 降级行为 |
|---|---|
| systemRole | 折叠决策在 **Compiler Provider Serialization（compiler-spec §63）**：capability 不可用时由编译器在**序列化期**把 system 段折叠进首条 user，快照记录折叠后的最终形态（总设计 §5.5"模型可见即已记录"）；adapter 收到 system 角色而模型不支持 = **fail-fast INVALID_REQUEST**，禁止在发送期自行折叠（否则快照 ≠ 线格式，快照重建不变量被破坏） |
| tools | 禁用工具并提示（P3 起） |
| structuredOutput | json_schema → json_mode → 提示词约束 + Runtime repair（§18.2 既有降级链） |
| parallelToolCalls | 串行调用 |
| usage 帧缺失（中转站常见） | §17.3 估算降级，标 `estimated` |
| instructionLayers（决策 30 §18） | 缺省 'flat'，保守单层序列化 |

# 16. 缓存标记翻译

CachePlan（core 产出区级断点）→ provider 原语，**断点选择归 CachePlanner，adapter 只翻译**：

| 家族 | 翻译 |
|---|---|
| Anthropic | zone 边界 → `cache_control` 断点（≤4 个，映射规则见 worldbook-cache-design §5） |
| Gemini | explicit context caching（P2 评估是否启用，见 §23 开放点） |
| OpenAI / DeepSeek / 本地 | automatic-prefix：无标记，adapter 的唯一义务是**保证请求前缀字节稳定**（前缀已由 Compiler 契约保证） |

# 17. usage 归一与成本估算

## 17.1 归一形状（总设计 §18.3 为准）

```ts
{ inputTokens, cachedInputTokens, outputTokens, reasoningTokens?,
  estimatedCost?: number, source: 'reported' | 'estimated' }
```

- Anthropic：input 取 `message_start`，output 取 `message_delta` 合成（PV3 的"合成一次"实现点）。
- Gemini：各帧 `usageMetadata` 累积，末帧定稿。
- reasoningTokens：OpenAI `completion_tokens_details.reasoning_tokens`；Anthropic thinking 计入 outputTokens（不单列）。

## 17.2 密钥 redact（PV5 实现）

统一 redact 中间件：错误消息、日志、事件、fixture 录制在出模块前经过滤——`Authorization`/`x-api-key`/`api-key` 头、URL query 中的 key、配置对象整体，替换为 `[redacted]`。

## 17.3 估算降级

usage 帧缺失（部分中转站/本地端点）→ `source:'estimated'`，用 core 本地估算器（compiler-spec §52 同源）填充；estimated usage 照常入库与遥测，但缓存命中率统计须区分（§33.2 四层指标口径不变，estimated 不参与命中率分母）。

成本表（各模型价格）为用户可编辑配置；estimatedCost 仅当价格表命中时计算。

# 18. 网络实务指针（不在本规格展开）

四类接入方式、自定义插头（自定义头/URL 前缀改写/模型名映射）、全局与按 provider 代理（HTTP/SOCKS）、密钥本地加密存储（DPAPI/Keychain）——**定义与实务在 technical-plan §5.1**；本规格只约束：插头配置经 contracts 传入 adapter（§7），密钥经 redact 中间件（§17.2）。

# 19. 三层事件映射（与权威事件表的关系）

```text
provider 归一事件（本规格 §8）
   ↓ Runtime 消费并转为
generation.* 运行事件（technical-design §5.4 权威表：generation.delta / usage / completed…）
   ↓ 经 HTTP 层投影为
API SSE 事件（api-spec §26–29：信封 + sequence + Last-Event-ID）
```

provider 归一事件是**模块内部契约**，不出进程、不进 §5.4 权威表、不经 SSE 直通前端——防止把 provider 字段形状泄漏到公共 API（api-spec §1.2 文档优先序）。

# 20. 契约测试（fixture 录制回放，technical-plan §8.3 的必测清单）

录制来源：真实 API 响应字节流（脱敏，PV5），按 provider 家族建 fixture 库。必测场景：

```text
T1  纯文本流：delta 原样性（PV1 逐字节断言）+ 顺序不变量（§8.1）
T2  tool_call 增量聚合 + 稳定 id（§10）
T3  reasoning 流（DeepSeek reasoning_content / Anthropic thinking+signature）
T4  usage 三形态：OpenAI include_usage / Anthropic 双帧合成 / Gemini 累积
T5  usage 缺失 → estimated 降级（§17.3）
T6  流中途取消 → partial + CANCELLED（PV6）
T7  429 + Retry-After → keyRotate（§13 层 2）
T8  401 → key 停用标记
T9  Anthropic 529 overloaded → RETRYABLE + fallback 建议
T10 伪造 200（HTML/错误 JSON）→ PARSE_ERROR（R5）
T11 多字节 UTF-8 跨 chunk 切断（R1）
T12 CONTEXT_TOO_LARGE 400 → 正确分类、不自动重试（§12）
T13 Gemini SAFETY → finish=content_filter + CONTENT_FILTERED
T14 同 fixture 重复回放字节级一致（PV7）
```

# 21. 分阶段落地

| 阶段 | 内容 |
|---|---|
| **P0** | 三类 adapter（openai-compat / anthropic / gemini）+ 流式归一 + usage 归一 + 错误分类 + 取消/超时 + redact + fixture 测试（T1/T4/T6/T10/T11/T12/T14）+ 单 key + 代理 |
| **P1** | 自定义插头配置面（实务随 §5.1）；本地端点模型自动发现完善 |
| **P2** | 缓存标记翻译（Anthropic cache_control / Gemini explicit caching 评估）+ 多 key 轮换完善 + 遥测面板对接（命中率指标） |
| **P3** | 工具归一全量（T2/T3/T7/T8/T9/T13）+ structuredOutput 降级链 + ModelPolicy fallback 联调 |
| **P4** | 网络搜索等工具型请求的流式与取消打磨 |
| **P5** | 插件自定义 provider（若有）；契约测试工具化（用户可自助录制 fixture 报兼容性问题） |

# 22. 既有文档同步清单（实施期跟踪）

| 文档 | 同步点 | 时机 |
|---|---|---|
| technical-plan §5.1 | 已挂指向本规格（2026-09-05） | 已同步 |
| technical-plan §7.2 | 三岔分工表述已修订（决策 31） | 已同步 |
| shared-contracts-spec | §6 类型收编 `packages/contracts` | P0 实现期 |
| technical-design §18.2 | ProviderCapabilities 为 adapter 声明的权威形状；instructionLayers 登记随实现 | 首个 adapter 落地 |
| api-spec | generation.* SSE 投影口径复核（本规格 §19 映射）——✅ 2026-09-06 S6 复核:三层映射落地,bus 分档 + SSE sequence/续传实现 | 已同步 |
| instruction-security-spec §18 | instructionLayers capability 探测落地 | P2 |

# 23. 开放决策点（不阻塞 P0，实施期落定）

1. **Gemini explicit context caching 是否启用**：显式缓存有创建/存储成本与 TTL 管理，P2 用 Cache Simulator 对比后定。
2. **本地估算器的 tokenizer 选型**——**已决（V1.1，S4'-a 实施期）**：P0/P1 采用 core 启发式估算器（CJK ≈ 1 token/字、其余 ≈ 4 字符/token，误差基线记录于 core tokens 测试），**不引入 tiktoken 运行时依赖**。理由：①P0 硬上限检查（R-P0-2）与 usage 降级（§17.3）只需要稳定、确定性的口径，不需要绝对精确；②精确 token 预算是 P2 Cache Engine（compiler §47 Context Budget）的需求，届时再引入精确计数（本地 gpt-tokenizer 类纯 JS 词表 + Anthropic/Gemini countTokensNative 钩子双轨），口径由 §52 tokenCountMode 记录，缓存命中率统计继续排除 estimated（§33.2）。
3. **Anthropic thinking 回传的默认策略**：仅工具循环强制回传之外，普通多轮是否也回传（缓存代价 vs 推理连贯性），P3 联调时以缓存指标定。

---

*关联文档：[technical-design.md](../technical-design.md)（§18 / §38 决策 31）· [technical-plan.md](../technical-plan.md)（§5.1 接入实务 / §8.3 fixture 策略）· [worldbook-cache-design.md](../worldbook-cache-design.md) §5 · [agent-runtime-spec.md](./agent-runtime-spec.md) · [instruction-security-spec.md](./instruction-security-spec.md) · [api-spec.md](./api-spec.md) · [shared-contracts-spec.md](./shared-contracts-spec.md)*
