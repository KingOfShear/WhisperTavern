import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FetchLike, ProviderHttpResponse } from '../shared/http'

/**
 * fixture 录制回放基建 —— provider-adapter-spec §20(P0 必测 T1/T4/T6/T10/T11/T12/T14)。
 *
 * fixture 文件位于仓库根 `tests/fixtures/provider/<provider>/<case>.json`(只读,
 * 见该目录 README:真实资产红线 + 脱敏规范)。P0 为**合成**字节流(无真实密钥、
 * 合成文本);真实 API 录制以后经 redact 中间件替换本目录内容。
 *
 * 字节保真:chunks 以 base64 存储(不经文本转码),R1 多字节切断、R2 帧边界
 * 原样保留;回放 = 同字节 → 同归一事件序列(PV7,T14 硬门禁)。
 */

export interface ProviderFixture {
  provider: string
  case: string
  description: string
  request: {
    model: string
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
    maxOutputTokens?: number
  }
  response: {
    status: number
    contentType: string
    retryAfter?: string
    /** base64(Uint8Array);回放按序 yield,R1/R2 断点原样保留 */
    chunksBase64: string[]
  }
  /** T6:yield 前 N 个 chunk 后抛 AbortError(模拟真实传输被取消断流);缺省 null = 全量 */
  abortAfterChunk?: number
  expect: {
    kind: 'stream' | 'error'
    /** text_delta 拼接期望(缺省不断言) */
    text?: string
    finishReason?: string
    usageSource?: 'reported' | 'estimated'
    /** kind=stream:末事件为 error 时断言其码(如 CANCELLED) */
    lastError?: string
    /** kind=error:stream() reject 的错误码 */
    errorCode?: string
  }
}

const FIXTURE_ROOT = fileURLToPath(new URL('../../../../tests/fixtures/provider/', import.meta.url))

export function loadFixture(provider: string, caseName: string): ProviderFixture {
  const path = join(FIXTURE_ROOT, provider, `${caseName}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as ProviderFixture
}

/** 回放传输:按 fixture 字节序列 yield;abortAfterChunk 处抛 AbortError(确定性 T6) */
export function fixtureTransport(fixture: ProviderFixture): { fetchImpl: FetchLike } {
  const chunks = fixture.response.chunksBase64.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')))
  const fetchImpl: FetchLike = async () => {
    const body = (async function* () {
      const limit = fixture.abortAfterChunk ?? chunks.length
      for (let i = 0; i < limit; i += 1) {
        const chunk = chunks[i]
        if (chunk === undefined) throw new Error(`INVARIANT_VIOLATION: fixture chunk ${i} 缺失`)
        yield chunk
      }
      if (fixture.abortAfterChunk !== undefined) {
        throw new Error('The operation was aborted')
      }
    })()
    const response: ProviderHttpResponse = {
      ok: fixture.response.status >= 200 && fixture.response.status < 300,
      status: fixture.response.status,
      headers: {
        get: (name: string) => {
          if (name.toLowerCase() === 'content-type') return fixture.response.contentType
          if (name.toLowerCase() === 'retry-after') return fixture.response.retryAfter ?? null
          return null
        },
      },
      body,
      text: async () =>
        Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
    }
    return response
  }
  return { fetchImpl }
}

/** 由 fixture.request 构造契约请求(脱敏样例;snapshotId 固定保确定性) */
export function fixtureRequest(fixture: ProviderFixture): import('@desiregrimoire/contracts').ProviderChatRequest {
  return {
    snapshotId: `snap_fixture_${fixture.provider}_${fixture.case}`,
    model: fixture.request.model,
    messages: fixture.request.messages,
    sampling: { maxOutputTokens: fixture.request.maxOutputTokens ?? 256 },
    stream: true,
  }
}
