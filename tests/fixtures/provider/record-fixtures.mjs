// fixture 录制脚本(P0 = 合成字节流;真实 API 录制以后经 redact 中间件替换,
// PV5:密钥/Authorization/URL query key 一律不得出现在本目录任何文件)。
// 运行:node tests/fixtures/provider/record-fixtures.mjs(确定性,可重复生成)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const splitBytes = (text, at) => {
  const bytes = Buffer.from(text, 'utf8')
  return [bytes.subarray(0, at).toString('base64'), bytes.subarray(at).toString('base64')]
}

// —— 各家帧构造 ——
const oaiChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`
const oaiUsage = (usage) => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`
const anFrame = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
const anText = (text) => anFrame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
const gemFrame = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const gemText = (text, thought) => gemFrame({ candidates: [{ content: { parts: [{ text, ...(thought ? { thought: true } : {}) }], role: 'model' } }] })

const REQUEST = {
  model: '',
  messages: [
    { role: 'system', content: 'fixture system line' },
    { role: 'user', content: 'fixture user line' },
  ],
  maxOutputTokens: 256,
}

const fixtures = []

// ===== openai-compat =====
{
  const provider = 'openai-compat'
  const model = 'deepseek-chat'
  const req = { ...REQUEST, model }
  fixtures.push(
    {
      provider, case: 'T1-basic-stream', description: '纯文本流:PV1 逐字节 + §8.1 顺序 + include_usage 帧',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [oaiChunk('你好,'), oaiChunk('世界!'), oaiChunk(' The fox.'), oaiUsage({ prompt_tokens: 12, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 0 } })].map(b64) },
      expect: { kind: 'stream', text: '你好,世界! The fox.', finishReason: 'stop', usageSource: 'reported' },
    },
    {
      provider, case: 'T4-usage', description: 'usage 归一:DeepSeek prompt_cache_hit_tokens → cachedInputTokens',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [oaiChunk('x'), oaiUsage({ prompt_tokens: 100, completion_tokens: 3, prompt_cache_hit_tokens: 88 })].map(b64) },
      expect: { kind: 'stream', text: 'x', finishReason: 'stop', usageSource: 'reported' },
    },
    {
      provider, case: 'T6-cancel', description: '流中途取消:partial + CANCELLED,无 finish(PV6)',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [oaiChunk('部分内容')].map(b64) },
      abortAfterChunk: 1,
      expect: { kind: 'stream', text: '部分内容', lastError: 'CANCELLED' },
    },
    {
      provider, case: 'T10-fake-200', description: '伪造 200:text/html 拦截页 → PARSE_ERROR(R5)',
      request: req,
      response: { status: 200, contentType: 'text/html', chunksBase64: [b64('<html>gateway blocked</html>')] },
      expect: { kind: 'error', errorCode: 'PARSE_ERROR' },
    },
    {
      provider, case: 'T11-multibyte', description: '多字节 UTF-8 跨 chunk 切断 → 解码无损(R1)',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: splitBytes(oaiChunk('深度合并字节边界测'), Buffer.from(oaiChunk('深度合')).length) },
      expect: { kind: 'stream', text: '深度合并字节边界测', finishReason: 'stop', usageSource: 'estimated' },
    },
    {
      provider, case: 'T12-context-too-large', description: '400 context length → CONTEXT_TOO_LARGE,不自动重试(§12)',
      request: req,
      response: { status: 400, contentType: 'application/json', chunksBase64: [b64('{"error":{"message":"This model maximum context length is 65536 tokens"}}')] },
      expect: { kind: 'error', errorCode: 'CONTEXT_TOO_LARGE' },
    },
  )
}

// ===== anthropic =====
{
  const provider = 'anthropic'
  const model = 'claude-sonnet-4'
  const req = { ...REQUEST, model }
  const start = (usage) => anFrame('message_start', { message: { usage } })
  const delta = (stop, usage) => anFrame('message_delta', { delta: { stop_reason: stop }, usage })
  fixtures.push(
    {
      provider, case: 'T1-basic-stream', description: '纯文本流:PV1 + 双帧 usage 合成 + end_turn 映射',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [start({ input_tokens: 25 }), anText('你好,'), anText('世界!'), delta('end_turn', { output_tokens: 9 }), anFrame('message_stop', {})].map(b64) },
      expect: { kind: 'stream', text: '你好,世界!', finishReason: 'stop', usageSource: 'reported' },
    },
    {
      provider, case: 'T4-usage', description: '双帧合成:input@message_start + output@message_delta;cache_read 归一',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [start({ input_tokens: 100, cache_read_input_tokens: 64 }), anText('x'), delta('end_turn', { output_tokens: 7 })].map(b64) },
      expect: { kind: 'stream', text: 'x', finishReason: 'stop', usageSource: 'reported' },
    },
    {
      provider, case: 'T6-cancel', description: '流中途取消:partial + CANCELLED(PV6)',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [start({ input_tokens: 25 }), anText('部分内容')].map(b64) },
      abortAfterChunk: 2,
      expect: { kind: 'stream', text: '部分内容', lastError: 'CANCELLED' },
    },
    {
      provider, case: 'T10-fake-200', description: '伪造 200:text/html → PARSE_ERROR(R5)',
      request: req,
      response: { status: 200, contentType: 'text/html', chunksBase64: [b64('<html>blocked</html>')] },
      expect: { kind: 'error', errorCode: 'PARSE_ERROR' },
    },
    {
      provider, case: 'T11-multibyte', description: '多字节 UTF-8 跨 chunk 切断(R1)',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: splitBytes(anText('深度合并字节边界测'), Buffer.from(anText('深度合')).length) },
      expect: { kind: 'stream', text: '深度合并字节边界测', finishReason: 'stop', usageSource: 'estimated' },
    },
    {
      provider, case: 'T12-context-too-large', description: '400 "prompt is too long" → CONTEXT_TOO_LARGE(Anthropic 表述)',
      request: req,
      response: { status: 400, contentType: 'application/json', chunksBase64: [b64('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200000 tokens > 190000 maximum"}}')] },
      expect: { kind: 'error', errorCode: 'CONTEXT_TOO_LARGE' },
    },
  )
}

// ===== gemini =====
{
  const provider = 'gemini'
  const model = 'gemini-2.5-flash'
  const req = { ...REQUEST, model }
  const meta = (extra) => ({ promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 21, ...extra })
  fixtures.push(
    {
      provider, case: 'T1-basic-stream', description: '纯文本流:usageMetadata 累积末帧定稿 + STOP 映射',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [gemText('你好,'), gemFrame({ candidates: [{ content: { parts: [{ text: '世界!' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: meta({}) })].map(b64) },
      expect: { kind: 'stream', text: '你好,世界!', finishReason: 'stop', usageSource: 'reported' },
    },
    {
      provider, case: 'T4-usage', description: 'usage 归一:cachedContentTokenCount + thoughtsTokenCount(thought part → reasoning_delta)',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [gemText('先推理', true), gemFrame({ candidates: [{ content: { parts: [{ text: 'x' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: meta({ cachedContentTokenCount: 64, thoughtsTokenCount: 5 }) })].map(b64) },
      expect: { kind: 'stream', text: 'x', finishReason: 'stop', usageSource: 'reported' },
    },
    {
      provider, case: 'T6-cancel', description: '流中途取消:partial + CANCELLED(PV6)',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: [gemText('部分内容')].map(b64) },
      abortAfterChunk: 1,
      expect: { kind: 'stream', text: '部分内容', lastError: 'CANCELLED' },
    },
    {
      provider, case: 'T10-fake-200', description: '伪造 200:text/html → PARSE_ERROR(R5)',
      request: req,
      response: { status: 200, contentType: 'text/html', chunksBase64: [b64('<html>blocked</html>')] },
      expect: { kind: 'error', errorCode: 'PARSE_ERROR' },
    },
    {
      provider, case: 'T11-multibyte', description: '多字节 UTF-8 跨 chunk 切断(R1)',
      request: req,
      response: { status: 200, contentType: 'text/event-stream', chunksBase64: splitBytes(gemText('深度合并字节边界测'), Buffer.from(gemText('深度合')).length) },
      expect: { kind: 'stream', text: '深度合并字节边界测', finishReason: 'stop', usageSource: 'estimated' },
    },
    {
      provider, case: 'T12-context-too-large', description: '400 INVALID_ARGUMENT(超上限)→ CONTEXT_TOO_LARGE',
      request: req,
      response: { status: 400, contentType: 'application/json', chunksBase64: [b64('{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed","status":"INVALID_ARGUMENT"}}')] },
      expect: { kind: 'error', errorCode: 'CONTEXT_TOO_LARGE' },
    },
  )
}

// ===== 落盘(只增不覆盖语义;变更 = 改本脚本重跑) =====
for (const fixture of fixtures) {
  const dir = join(ROOT, fixture.provider)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${fixture.case}.json`)
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n')
  console.log('wrote', path)
}
console.log(`done: ${fixtures.length} fixtures`)
