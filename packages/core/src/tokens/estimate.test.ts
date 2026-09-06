import { describe, expect, it } from 'vitest'
import { createTokenCounter, estimateTokens } from './estimate'

describe('core/tokens(双模式与本地估算器,compiler-spec §52)', () => {
  it('确定性:同输入恒同输出', () => {
    const text = '混合内容 mixed content 123'
    expect(estimateTokens(text)).toBe(estimateTokens(text))
  })

  it('已知文本误差基线(记录在案——WP0.5 定 tiktoken 后复核)', () => {
    // 启发式口径:CJK ≈ 1 token/字符;其余 ≈ 4 字符/token。
    // 参考基线(cl100k_base 量级):英文 ~4 字符/token;常见汉字 1–2 token/字。
    expect(estimateTokens('')).toBe(0)
    // 纯 ASCII:"hello world" = 11 字符(含空格)→ ceil(11/4) = 3(cl100k 实际 2,误差 +1)
    expect(estimateTokens('hello world')).toBe(3)
    // 纯 CJK:"你好世界" 4 字 → 4(cl100k 实际 ~4–6,量级一致)
    expect(estimateTokens('你好世界')).toBe(4)
    // 混合:3 窄字符("ab!") + 2 宽字("中文") → 2 + ceil(3/4) = 3
    expect(estimateTokens('中文ab!')).toBe(3)
    // emoji(代理对)按 1 码点计:→ ceil(2/4) = 1
    expect(estimateTokens('🙂!')).toBe(1)
  })

  it('双模式:无 native 钩子恒 estimated;有则 exact 且结果来自钩子', async () => {
    const estimated = createTokenCounter()
    expect(estimated.mode).toBe('estimated')
    await expect(estimated.count('你好')).resolves.toEqual({ tokens: 2, mode: 'estimated' })

    const exact = createTokenCounter(async () => 7)
    expect(exact.mode).toBe('exact')
    await expect(exact.count('你好')).resolves.toEqual({ tokens: 7, mode: 'exact' })
  })
})
