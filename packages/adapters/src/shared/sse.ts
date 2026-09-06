/**
 * SSE 流解析 —— provider-adapter-spec §8.3 纪律(R1–R3),三家 adapter 共用。
 *
 * R1 多字节 UTF-8 缓冲:网络分块可能切断多字节字符,必须 TextDecoder 增量解码,
 *    禁止按 chunk 直接 toString。
 * R2 SSE 帧解析:多行 data: 拼接、CRLF/LF 兼容、注释行(:)忽略、event: 字段
 *    各家基本不用(按 data JSON 内字段判型)。
 * R3 [DONE] 哨兵(OpenAI 系):不产出事件,仅标记流尾。
 *
 * R4(半开连接:分层超时)与 R5(伪造 200)在 http.ts / adapter 层处理。
 */

/** 把字节流解析为 SSE `data:` 载荷序列;遇 [DONE] 结束迭代 */
export async function* parseSseData(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = findFrameBoundary(buffer)
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + frameSeparatorLength(buffer, boundary))
      const data = extractData(frame)
      if (data === DONE_SENTINEL) return
      if (data !== null) yield data
      boundary = findFrameBoundary(buffer)
    }
  }

  // 流尾 flush(半帧容错:未以空行结尾的尾帧照常解析)
  buffer += decoder.decode()
  const data = extractData(buffer)
  if (data !== null && data !== DONE_SENTINEL) yield data
}

const DONE_SENTINEL = '[DONE]'

function findFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function frameSeparatorLength(buffer: string, boundary: number): number {
  return buffer.startsWith('\r\n\r\n', boundary) ? 4 : 2
}

/** 单帧 → data 载荷;无 data 行(注释/空帧)返回 null(§8.3 R2) */
function extractData(frame: string): string | null {
  const lines = frame.split(/\r?\n/)
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue // 注释行
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    // event:/id:/retry: 字段忽略(按 data JSON 内字段判型,§8.3 R2)
  }
  if (dataLines.length === 0) return null
  return dataLines.join('\n')
}
