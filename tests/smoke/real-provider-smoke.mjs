// 真实四链路冒烟(p0-plan S8 任务 2;DoD 第 1 条)——密钥经环境变量注入,
// **绝不写入本文件、绝不入库、绝不出现在日志**(PV5/R-P0-6)。
//
// 用法(在仓库根,server 已起:DG_PORT=8787 pnpm --filter @desiregrimoire/server dev):
//   DG_SMOKE_OPENAI_BASE=https://api.deepseek.com/v1 DG_SMOKE_OPENAI_KEY=sk-xxx \
//   DG_SMOKE_OPENAI_MODEL=deepseek-chat \
//   DG_SMOKE_ANTHROPIC_KEY=sk-ant-xxx DG_SMOKE_ANTHROPIC_MODEL=claude-sonnet-4 \
//   DG_SMOKE_GEMINI_KEY=xxx DG_SMOKE_GEMINI_MODEL=gemini-2.5-flash \
//   node tests/smoke/real-provider-smoke.mjs
//
// 每个配置的家族跑一条链路:建会话 → 发消息 → generate → SSE 收流到终态 →
// 校验 delta 非空 / usage 事件 / 终态 completed;输出 PASS/FAIL 汇总。
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.env.DG_SMOKE_BASE_URL ?? 'http://localhost:8787'
const CHAIN = []

if (process.env.DG_SMOKE_OPENAI_KEY !== undefined) {
  CHAIN.push({
    name: 'openai-compat',
    type: 'openai-compat',
    baseUrl: process.env.DG_SMOKE_OPENAI_BASE,
    apiKey: process.env.DG_SMOKE_OPENAI_KEY,
    model: process.env.DG_SMOKE_OPENAI_MODEL ?? 'deepseek-chat',
  })
}
if (process.env.DG_SMOKE_ANTHROPIC_KEY !== undefined) {
  CHAIN.push({ name: 'anthropic', type: 'anthropic', apiKey: process.env.DG_SMOKE_ANTHROPIC_KEY, model: process.env.DG_SMOKE_ANTHROPIC_MODEL ?? 'claude-sonnet-4' })
}
if (process.env.DG_SMOKE_GEMINI_KEY !== undefined) {
  CHAIN.push({ name: 'gemini', type: 'gemini', apiKey: process.env.DG_SMOKE_GEMINI_KEY, model: process.env.DG_SMOKE_GEMINI_MODEL ?? 'gemini-2.5-flash' })
}
if (process.env.DG_SMOKE_OLLAMA_BASE !== undefined) {
  CHAIN.push({ name: 'local-ollama', type: 'openai-compat', baseUrl: process.env.DG_SMOKE_OLLAMA_BASE, apiKey: undefined, model: process.env.DG_SMOKE_OLLAMA_MODEL ?? 'qwen2.5' })
}

if (CHAIN.length === 0) {
  console.error('未提供任何真实链路配置(环境变量见文件头注释)。什么也不做。')
  process.exit(0)
}

async function api(path, init) {
  const res = await fetch(BASE + path, { headers: { 'content-type': 'application/json' }, ...init })
  const body = await res.json()
  if (body.error !== undefined) throw new Error(`${body.error.code}: ${body.error.message}`)
  return body.data
}

let failures = 0
for (const chain of CHAIN) {
  const label = `${chain.name}(${chain.model})`
  try {
    const chat = await api('/api/v2/chats', { method: 'POST', body: JSON.stringify({ title: `冒烟-${chain.name}`, systemPrompt: '你是冒烟测试助手,回答保持一句话。' }) })
    await api(`/api/v2/chats/${chat.id}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: '用一句话回答:1+1 等于几?' }) })
    const provider = await api('/api/v2/providers', {
      method: 'POST',
      body: JSON.stringify({ name: `smoke-${chain.name}`, type: chain.type, baseUrl: chain.baseUrl, apiKey: chain.apiKey, models: [chain.model] }),
    })
    const started = await api(`/api/v2/chats/${chat.id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ providerId: provider.id, model: chain.model, sampling: { maxOutputTokens: 256 } }),
    })

    // SSE 收流(手写解析;浏览器/客户端由 EventSource 承担)
    const res = await fetch(`${BASE}/api/v2/runs/${started.runId}/events`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let deltas = 0
    let usageSeen = false
    let terminal = null
    const deadline = Date.now() + 60_000
    while (terminal === null && Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        const eventLine = frame.split('\n').find((l) => l.startsWith('event: '))
        if (dataLine !== undefined && eventLine !== undefined) {
          const type = eventLine.slice(7)
          const envelope = JSON.parse(dataLine.slice(6))
          if (type === 'generation.delta') deltas += 1
          if (type === 'usage.recorded') usageSeen = true
          if (type === 'generation.completed' || type === 'generation.failed') terminal = { type, envelope }
          if (type === 'message.created') terminal = terminal ?? null // 回复入树
        }
        boundary = buffer.indexOf('\n\n')
      }
      if (terminal === null) await sleep(20)
    }

    if (terminal === null) throw new Error('60s 内未收到终态事件')
    if (terminal.type !== 'generation.completed') throw new Error(`终态异常: ${terminal.type} ${JSON.stringify(terminal.envelope.data)}`)
    if (deltas === 0) throw new Error('未收到任何 generation.delta')
    console.log(`PASS ${label}: delta×${deltas}, usage=${usageSeen ? 'reported/estimated' : '未收到(以 completed 帧为准)'}, seq=${terminal.envelope.sequence}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}: ${String(error)}`)
  }
}

console.log(failures === 0 ? `全部 ${CHAIN.length} 条链路 PASS` : `${failures}/${CHAIN.length} 条链路 FAIL`)
process.exit(failures === 0 ? 0 : 1)
