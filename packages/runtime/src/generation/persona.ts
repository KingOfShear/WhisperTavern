import { type ChatId, type Diagnostic, type PromptContribution } from '@whispertavern/contracts'
import { loadChat } from '../tree/messages'
import { personas } from '../db/schema'
import type { WhisperTavernDb } from '../db/database'
import { eq } from 'drizzle-orm'

/**
 * chat↔Persona 贡献接线(WP1.3 Persona 库;compiler-spec §10 persona 行)。
 *
 * Persona 是单值 chat 绑定(不像世界书是多对多),故无独立绑定表——直接读
 * chats.persona_id。本模块把 persona 的档案(name + description + metadata)
 * 渲染为一条 user 档注入 header 区的贡献(source.type='persona')。
 *
 * 与 S11 worldbook builder 一致:只读 DB,不依赖 st-compat(架构纪律)。
 * 段稳定性按区默认(header→session),本模块不声明 stability。
 */

export interface BuildPersonaInput {
  store: WhisperTavernDb
  chatId: ChatId
}

export interface BuildPersonaResult {
  contributions: PromptContribution[]
  diagnostics: readonly Diagnostic[]
}

/** header 区顺序:置于 chat 系统提示之后,预设段之前(提交序 + 稳定 ID 决定最终次序) */
const PERSONA_HEADER_ORDER = 0

function safeJsonRecord(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 渲染用户档案:姓名行 + 描述正文 + 结构化 metadata(跳过与 name/description 重复的键) */
function renderProfile(name: string, description: string, metadata: Record<string, unknown>): string {
  const lines: string[] = []
  if (name !== '') lines.push(`用户：${name}`)
  if (description !== '') lines.push(description)
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'name' || key === 'description') continue
    if (value === undefined || value === null) continue
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    if (rendered === '') continue
    lines.push(`${key}：${rendered}`)
  }
  return lines.join('\n')
}

export function buildPersonaContributions(input: BuildPersonaInput): BuildPersonaResult {
  const { store, chatId } = input
  const chat = loadChat(store, chatId)
  if (!chat.ok) return { contributions: [], diagnostics: [] }
  const personaId = chat.value.personaId
  if (personaId === undefined) return { contributions: [], diagnostics: [] }

  const row = store.db.select().from(personas).where(eq(personas.id, personaId)).get()
  if (row === undefined) return { contributions: [], diagnostics: [] }

  const name = typeof row.name === 'string' ? row.name : ''
  const description = typeof row.description === 'string' ? row.description : ''
  const content = renderProfile(name, description, safeJsonRecord(row.metadata))
  if (content.trim() === '') return { contributions: [], diagnostics: [] }

  const contributions: PromptContribution[] = [
    {
      id: `persona:${personaId}`,
      source: { type: 'persona', assetId: personaId },
      segment: { role: 'system', content, zone: 'header' },
      priority: 0,
      semanticPlacement: { type: 'header', order: PERSONA_HEADER_ORDER },
    },
  ]
  return { contributions, diagnostics: [] }
}
