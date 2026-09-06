import { z } from 'zod'

/**
 * Provider 归一契约 —— provider-adapter-spec §6(核心类型)/ §8.1(流式事件)/
 * §12(错误码表)/ §17.1(usage 归一)的收编落地。本模块取代 S1 在
 * packages/adapters 下的临时占位(p0-plan S2 收编任务)。
 *
 * 铁律:适配器只翻译不做语义(PV1);一切失败以 ProviderError 抛出,禁止裸
 * Error 穿透(PV4);usage 恰好一次且在 finish 前(PV3);reasoning 不丢弃(PV8)。
 */

/** 错误码表唯一权威 = provider-adapter-spec §12;P0 全表注册(fail-closed 语义见表) */
export const ProviderErrorCodeSchema = z.enum([
  'TRANSPORT_ERROR',
  'TIMEOUT_FIRST_TOKEN',
  'TIMEOUT_IDLE',
  'AUTH_INVALID',
  'RATE_LIMIT',
  'QUOTA_EXCEEDED',
  'CONTEXT_TOO_LARGE',
  'CONTENT_FILTERED',
  'MODEL_OVERLOADED',
  'PROVIDER_ERROR',
  'INVALID_REQUEST',
  'PARSE_ERROR',
  'CANCELLED',
  'UNKNOWN',
])
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>

/**
 * 一切失败以 ProviderError 抛出(PV4)。detail 必须已 redact(PV5 / §17.2):
 * key / Authorization 头不得出现在错误消息、日志、快照、事件、fixture 任何位置。
 */
export const ProviderErrorSchema = z.object({
  code: ProviderErrorCodeSchema,
  retryable: z.boolean(),
  /** 尊重 Retry-After(§12 RATE_LIMIT 行) */
  retryAfterMs: z.number().int().nonnegative().optional(),
  /** 是否建议换 key(§13 多 key 轮换,PV2 唯一例外) */
  keyRotatable: z.boolean(),
  providerStatus: z.number().int().optional(),
  detail: z.string().optional(),
  /** 调试用,不得进日志默认输出(PV5) */
  raw: z.unknown().optional(),
})
export type ProviderError = z.infer<typeof ProviderErrorSchema>

/**
 * P0 子集:content 为纯文本;ContentBlock(text | thinking 签名块)与 role 'tool'
 * 随 P3 工具流补齐(§6 草案、§10/§11)。
 */
export const ProviderMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({ role: z.literal('assistant'), content: z.string() }),
])
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>

/** usage 归一形状唯一权威 = 总设计 §18.3 / provider-adapter-spec §17.1 */
export const ProviderUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  estimatedCost: z.number().nonnegative().optional(),
  /** 缺帧降级为 'estimated'(§17.3);estimated 不参与缓存命中率分母 */
  source: z.enum(['reported', 'estimated']),
})
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>

/**
 * 归一流式事件(§8.1)。顺序不变量(PV7 契约测试断言):message_start 恰一次且
 * 最先;finish 恰一次且最后;usage 恰一次且在 finish 之前(PV3);error 后不得
 * 再有任何事件。
 */
export const ProviderStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start') }),
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  /**
   * PV8:reasoning 增量不丢弃。`signature` 为 Anthropic thinking 签名块的载体
   * (provider-adapter-spec §11:签名缓存于消息组装侧,工具循环原样回传,
   * 缺签名 = INVALID_REQUEST)——适配器以**空文本事件**紧随其 thinking 文本发出,
   * 保持"签名属于哪个思考块"的配对语义;P3 组装侧配对成 ContentBlock.thinking。
   */
  z.object({ type: z.literal('reasoning_delta'), text: z.string(), signature: z.string().optional() }),
  /** P3;按 index 聚合(§10),P0 不产出 */
  z.object({
    type: z.literal('tool_call_delta'),
    index: z.number().int().nonnegative(),
    id: z.string().optional(),
    name: z.string().optional(),
    argsFragment: z.string().optional(),
  }),
  z.object({ type: z.literal('usage'), usage: ProviderUsageSchema }),
  z.object({
    type: z.literal('finish'),
    reason: z.enum(['stop', 'length', 'tool_use', 'content_filter', 'error']),
  }),
  z.object({ type: z.literal('error'), error: ProviderErrorSchema }),
])
export type ProviderStreamEvent = z.infer<typeof ProviderStreamEventSchema>

/**
 * Chat 面请求体的 JSON-serializable 投影(§6 草案)。P0 无 CachePlan 标记
 * (R-P0-4,cachePlan 字段不设);tools 随 P3 补。
 */
export const ProviderChatRequestPayloadSchema = z.object({
  /** §5.5 不变量"请求必挂 snapshotId";S5 在 fake provider 调用入口埋断言 */
  snapshotId: z.string(),
  model: z.string(),
  messages: z.array(ProviderMessageSchema),
  sampling: z.object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxOutputTokens: z.number().int().positive(),
    stopSequences: z.array(z.string()).optional(),
    seed: z.number().int().optional(),
  }),
  /** P0 Chat 面恒为流式,非流式不设(§9) */
  stream: z.literal(true),
  /** 仅遥测用,绝不出网、不进模型可见前缀(PV5;§5.5 不变量 3) */
  metadata: z
    .object({ runId: z.string().optional(), requestId: z.string().optional() })
    .optional(),
})

/**
 * 完整请求 = JSON 投影 + IO 注入字段。signal 是本接口唯一的手写字段:
 * AbortSignal 不可序列化,属 IO 边界注入(shared-contracts §2 Serialization
 * Boundary 的合法例外),因此 Schema 不覆盖它。
 */
export interface ProviderChatRequest extends z.infer<typeof ProviderChatRequestPayloadSchema> {
  /** PV6:AbortSignal 贯穿全链路;取消 = partial + CANCELLED(§14) */
  signal?: AbortSignal
}

/**
 * Provider 能力声明 —— 总设计 §18.2 权威形状 + instruction-security §18 登记点
 * (WP0.5 S4'-a 定稿,implementation-plan 还账 #2;替代 P0 初版 {streaming} 占位)。
 * 降级链语义(能力缺失时的行为)见 provider-adapter-spec §15。
 */
export const ProviderCapabilitiesSchema = z.object({
  systemRole: z.boolean(),
  tools: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  streaming: z.boolean(),
  promptCaching: z.boolean(),
  /** automatic-prefix = OpenAI/DeepSeek/本地;explicit-breakpoint = Anthropic;context-cache = Gemini */
  cacheType: z.enum(['automatic-prefix', 'explicit-breakpoint', 'context-cache', 'none']),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  /** agent-runtime §82 降级链:json_schema → json_mode → 提示词约束 + repair */
  structuredOutput: z.enum(['none', 'json_mode', 'json_schema']),
  parallelToolCalls: z.boolean(),
  toolChoice: z.boolean(),
  /** instruction-security §18 登记点:P0 三家均 'flat';真实分层落地时同步总设计 §18.2 */
  instructionLayers: z.enum(['flat', 'system', 'system+developer']),
})
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>

/** 适配器契约(§7)。P0 唯一主路径 = stream();非流式不设(§9) */
export interface ProviderAdapter {
  readonly providerId: string
  capabilities(model: string): ProviderCapabilities
  stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent>
  /**
   * token 计数双模式的 native 侧钩子(compiler-spec §52):
   * Anthropic count_tokens / Gemini countTokens;P0 fake 不实现。
   */
  countTokensNative?(req: ProviderChatRequest): Promise<number>
  // listModels?()(§15 模型自动发现)随 ModelInfo 形状定稿时补入,不预造
}
