import {
  type ChatId,
  type Diagnostic,
  type PromptContribution,
} from '@whispertavern/contracts'
import { loadChat } from '../tree/messages'
import { presets } from '../db/schema'
import type { WhisperTavernDb } from '../db/database'
import { eq } from 'drizzle-orm'

/**
 * chat↔预设 贡献接线(WP1.3 ST Prompt Mapping;compiler-spec §80–§81)。
 *
 * 纯"读模型"层:本模块只把 chat 绑定的预设(.dgpreset 存于 presets.config,
 * 由 server 导入落库)解析为 PromptContribution。不依赖 st-compat(架构纪律:
 * runtime → contracts + core;st-compat 单向依赖 contracts,server 负责导入归一),
 * 故 .dgpreset 形状在此以局部最小解析器收口(读模型,非源格式)。
 *
 * 映射口径(§81):ST prompts[] + prompt_order[] → 段列表;prompt_order 索引即段
 * 语义序;injection_position 0/1 → header/injection 分区(零魔数)。段稳定性由
 * 编译器按区默认推导(§16,header→session / injection→request / tail→volatile),
 * 本模块不声明 stability(与 S11 worldbook builder 一致)。
 */

export interface BuildPresetInput {
  store: WhisperTavernDb
  chatId: ChatId
}

export interface BuildPresetResult {
  contributions: PromptContribution[]
  diagnostics: readonly Diagnostic[]
}

type ResolvedRole = 'system' | 'user' | 'assistant' | 'tool'
type ResolvedPlacement =
  | { kind: 'header'; order: number }
  | { kind: 'tail'; order: number }
  | { kind: 'injection'; depth: number; order: number }

interface ResolvedPresetSegment {
  id: string
  role: ResolvedRole
  content: string
  enabled: boolean
  placement: ResolvedPlacement
}

function safeJsonRecord(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function parsePlacement(raw: unknown): ResolvedPlacement | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  const order = typeof p.order === 'number' && Number.isFinite(p.order) ? p.order : 0
  if (p.kind === 'injection') {
    const depth = typeof p.depth === 'number' && p.depth >= 0 ? p.depth : 0
    return { kind: 'injection', depth, order }
  }
  if (p.kind === 'tail') return { kind: 'tail', order }
  if (p.kind === 'header') return { kind: 'header', order }
  return null
}

/** 局部最小解析:仅收口 builder 需要的段字段,容错且零 st-compat 依赖 */
function parsePresetConfig(raw: string): { segments: ResolvedPresetSegment[]; valid: boolean } {
  const obj = safeJsonRecord(raw)
  const segRaw = obj.segments
  const segments: ResolvedPresetSegment[] = []
  if (!Array.isArray(segRaw)) return { segments, valid: false }
  for (const s of segRaw) {
    if (typeof s !== 'object' || s === null) continue
    const seg = s as Record<string, unknown>
    if (typeof seg.id !== 'string' || seg.id === '') continue
    const role: ResolvedRole =
      seg.role === 'user' || seg.role === 'assistant' || seg.role === 'tool' ? seg.role : 'system'
    const content = typeof seg.content === 'string' ? seg.content : ''
    const enabled = seg.enabled !== false
    const placement = parsePlacement(seg.placement)
    if (placement === null) continue
    segments.push({ id: seg.id, role, content, enabled, placement })
  }
  return { segments, valid: true }
}

export function buildPresetContributions(input: BuildPresetInput): BuildPresetResult {
  const { store, chatId } = input
  const chat = loadChat(store, chatId)
  if (!chat.ok) return { contributions: [], diagnostics: [] }
  const presetId = chat.value.presetId
  if (presetId === undefined) return { contributions: [], diagnostics: [] }

  const row = store.db.select().from(presets).where(eq(presets.id, presetId)).get()
  if (row === undefined) return { contributions: [], diagnostics: [] }

  const { segments, valid } = parsePresetConfig(row.config)
  if (!valid) {
    return {
      contributions: [],
      diagnostics: [
        {
          level: 'warning',
          code: 'PRESET_CONFIG_INVALID',
          message: `预设 ${presetId} 的 config 不是合法的 .dgpreset(segments 缺失或非数组)`,
          segmentId: `preset:${presetId}`,
        },
      ],
    }
  }

  const contributions: PromptContribution[] = []
  for (const seg of segments) {
    if (!seg.enabled) continue
    const zone = seg.placement.kind
    const semanticPlacement =
      seg.placement.kind === 'injection'
        ? ({ type: 'injection', depth: seg.placement.depth, order: seg.placement.order } as const)
        : seg.placement.kind === 'tail'
          ? ({ type: 'tail', order: seg.placement.order } as const)
          : ({ type: 'header', order: seg.placement.order } as const)
    contributions.push({
      id: `preset:${presetId}:${seg.id}`,
      source: { type: 'preset', presetId, segmentId: seg.id },
      segment: { role: seg.role, content: seg.content, zone },
      priority: 0,
      semanticPlacement,
    })
  }
  return { contributions, diagnostics: [] }
}
