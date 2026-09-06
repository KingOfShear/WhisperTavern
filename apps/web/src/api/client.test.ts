import { describe, expect, it } from 'vitest'
import { ApiClientError, apiRequest } from './client'
import { validateSequence } from './sse'

/** SSE 序列校验(api-spec §27)与信封解包(§6/§7)的纯逻辑锁定 */

describe('validateSequence(§27)', () => {
  it('首条接受;单调递增接受', () => {
    expect(validateSequence(0, 1)).toBe('accept')
    expect(validateSequence(1, 2)).toBe('accept')
    expect(validateSequence(37, 38)).toBe('accept')
  })

  it('重复/回退 = duplicate(重连重放语义,客户端丢弃)', () => {
    expect(validateSequence(5, 5)).toBe('duplicate')
    expect(validateSequence(5, 3)).toBe('duplicate')
  })

  it('缺口 = gap(§27:客户端可检测 1,2,3,5 缺 4;告警不中断)', () => {
    expect(validateSequence(3, 5)).toBe('gap')
    expect(validateSequence(1, 10)).toBe('gap')
  })
})

describe('apiRequest 信封解包(§6/§7)', () => {
  it('成功信封解包 data(§6)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { id: 'chat_1' }, requestId: 'req_1' }), { status: 200 })) as typeof fetch
    const data = await apiRequest<{ id: string }>('/x', undefined, fetchImpl)
    expect(data.id).toBe('chat_1')
  })

  it('错误信封抛 ApiClientError,携带 code/retryable/requestId(§7)', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'chat 不存在', retryable: false, requestId: 'req_2' },
        }),
        { status: 404 },
      )) as typeof fetch
    await expect(apiRequest('/x', undefined, fetchImpl)).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NOT_FOUND',
      retryable: false,
      requestId: 'req_2',
    })
  })

  it('ApiClientError 是 Error 子类,message 即服务器 message', async () => {
    const error = new ApiClientError({ code: 'VALIDATION_ERROR', message: 'role 非法', retryable: false, requestId: 'r' })
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('role 非法')
  })
})
