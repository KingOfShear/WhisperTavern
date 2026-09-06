import { useState, type ReactElement } from 'react'
import { useChatStore } from '../stores/chat'

/** 设置页(p0-plan S7 任务 5):provider/模型/密钥表单——密钥只写不读回(PV5/R-P0-6) */
export function ProviderSettings(): ReactElement {
  const createProvider = useChatStore((s) => s.createProvider)
  const setSettingsOpen = useChatStore((s) => s.setSettingsOpen)
  const providers = useChatStore((s) => s.providers)
  const [name, setName] = useState('')
  const [type, setType] = useState('openai-compat')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('')
  const [proxy, setProxy] = useState('')
  const [saved, setSaved] = useState(false)

  const submit = async (): Promise<void> => {
    await createProvider({
      name,
      type,
      baseUrl: baseUrl === '' ? undefined : baseUrl,
      apiKey: apiKey === '' ? undefined : apiKey,
      models: models === '' ? [] : models.split(',').map((m) => m.trim()).filter((m) => m !== ''),
    })
    setSaved(true)
    setApiKey('') // 只写不读回:表单即刻清空,界面无任何密钥状态
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="absolute right-0 top-0 z-10 h-full w-96 overflow-y-auto border-l border-[var(--border)] bg-[var(--background)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Provider 设置</h2>
        <button type="button" onClick={() => setSettingsOpen(false)} className="text-[var(--muted-foreground)]">
          ✕
        </button>
      </div>
      <div className="space-y-3 text-sm">
        <Field label="名称" value={name} onChange={setName} placeholder="DeepSeek" />
        <div>
          <label className="mb-1 block text-xs text-[var(--muted-foreground)]">类型</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--muted)] px-2 py-1.5"
          >
            <option value="openai-compat">openai-compat(OpenAI/DeepSeek/GLM/本地…)</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
            <option value="fake">fake(测试)</option>
          </select>
        </div>
        <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.deepseek.com/v1" />
        <Field label="API Key(只写,保存后清空且不可读回)" value={apiKey} onChange={setApiKey} placeholder="sk-…" type="password" />
        <Field label="模型列表(逗号分隔)" value={models} onChange={setModels} placeholder="deepseek-chat, deepseek-reasoner" />
        <Field label="代理(P0 仅存配置,管道随 P1)" value={proxy} onChange={setProxy} placeholder="http://127.0.0.1:7890" />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={name === ''}
          className="w-full rounded bg-[var(--primary)] px-3 py-2 text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
        >
          {saved ? '已保存 ✓' : '保存 Provider'}
        </button>
        <div className="pt-2">
          <h3 className="mb-1 text-xs text-[var(--muted-foreground)]">已配置({providers.length})</h3>
          {providers.map((p) => (
            <div key={p.id} className="flex justify-between rounded px-2 py-1 text-xs hover:bg-[var(--muted)]">
              <span>{p.name}</span>
              <span className="text-[var(--muted-foreground)]">
                {p.type} · {p.config.models.length} 模型
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}): ReactElement {
  return (
    <div>
      <label className="mb-1 block text-xs text-[var(--muted-foreground)]">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-[var(--border)] bg-[var(--muted)] px-2 py-1.5 outline-none focus:border-[var(--primary)]"
      />
    </div>
  )
}
