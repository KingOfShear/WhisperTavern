/**
 * token 计数双模式 —— compiler-spec §52(p0-plan S3 任务 3)。
 *
 * 生产环境必须用 Provider/Model tokenizer('exact');不可用时降级估算
 * ('estimated')且**必须记录口径**。P0 只有本地估算器;tiktoken 选型是
 * provider-adapter §23 开放点 2,随 WP0.5 定案(implementation-plan 还账 #2)——
 * 本模块先立接口形状与估算基线,避免 S4 阻塞。
 */

export type TokenCountMode = 'exact' | 'estimated'

export interface TokenCount {
  tokens: number
  mode: TokenCountMode
}

/**
 * 原生钩子接口(§52 双模式的 'exact' 侧)。实装 = ProviderAdapter.countTokensNative
 * (contracts;Anthropic count_tokens / Gemini countTokens),由 WP0.5 adapter 提供;
 * openai 系 tiktoken 逼近的选型与协调见 provider-adapter §23 开放点 2。
 */
export type NativeTokenCounter = (text: string) => Promise<number>

export interface TokenCounter {
  /** 恒定反映本计数器的口径(§52 必须记录) */
  readonly mode: TokenCountMode
  count(text: string): Promise<TokenCount>
}

/**
 * 本地估算器(P0 唯一实现;确定性纯函数)。
 *
 * 启发式:CJK 全角字符(统一表意/假名/谚文/全角形式/CJK 标点)≈ 1 token/字符;
 * 其余字符 ≈ 4 字符/token(GPT 系 tokenizer 逼近,p0-plan S3"openai 系 tiktoken
 * 逼近,其余启发式"的 P0 替身)。误差基线在 tokens 测试中记录在案。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let wide = 0
  let narrow = 0
  // 按码点迭代:代理对(如 emoji)计 1 字符
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (isWideCodePoint(code)) {
      wide += 1
    } else {
      narrow += 1
    }
  }
  return wide + Math.ceil(narrow / 4)
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
    (code >= 0xac00 && code <= 0xd7af) || // 谚文音节
    (code >= 0xff00 && code <= 0xff60) // 全角形式
  )
}

/** 双模式入口:有 native 钩子走 'exact',否则 'estimated' */
export function createTokenCounter(native?: NativeTokenCounter): TokenCounter {
  if (!native) {
    return {
      mode: 'estimated',
      count: async (text) => ({ tokens: estimateTokens(text), mode: 'estimated' }),
    }
  }
  return {
    mode: 'exact',
    count: async (text) => ({ tokens: await native(text), mode: 'exact' }),
  }
}
