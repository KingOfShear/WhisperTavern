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
 *
 * S33a 补:`slot` 标记段填充(st-compat report 承诺的"编译时由子系统填充")。
 * ST 的 charDescription/charPersonality 等 identifier 在预设里是**空壳标记**——
 * 它只声明"内容放这个位置",正文由对应子系统提供。此前本模块把空壳原样透传,
 * 于是角色卡从未进 prompt(见 character.ts 模块头)。现在:槽位内容由
 * `slotContents` 注入,命中则**原地替换该段内容**以保留作者排的 prompt_order 位置。
 */

export interface BuildPresetInput {
  store: WhisperTavernDb
  chatId: ChatId
  /**
   * 槽位 → 填充文本(标记 identifier → 正文)。缺省/空 Map = 全部标记段保持原样,
   * 即未绑定角色时的历史行为(零基线漂移)。由 character.ts 等子系统提供——
   * 本模块不自己查资产表,保持"只读预设读模型"的单一职责。
   */
  slotContents?: ReadonlyMap<string, string>
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
  /**
   * ST 语义槽标记(compiler-spec §10 / st-compat ST_MARKER_TO_SLOT 已归一的
   * `DgPresetSlot`)。非标记段为 null。只做非空字符串校验——槽位的**语义**
   * 归各自子系统,本模块不复制槽枚举(避 C4 同义类型)。
   */
  slot: string | null
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
    const slot = typeof seg.slot === 'string' && seg.slot !== '' ? seg.slot : null
    segments.push({ id: seg.id, role, content, enabled, placement, slot })
  }
  return { segments, valid: true }
}

export function buildPresetContributions(input: BuildPresetInput): BuildPresetResult {
  const { store, chatId, slotContents } = input
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
    // §81 槽位填充:命中则原地替换内容,段的 placement / id 不动——顺序是作者
    // 在 prompt_order 里排的语义序,不能因为"内容来自角色卡"就被挪位。
    // source 保持 preset(本段确实是预设声明的段);角色卡自身的溯源由
    // character.ts 的独立贡献承载(source.type='character')。
    const filled = seg.slot === null ? undefined : slotContents?.get(seg.slot)
    const content = filled ?? seg.content
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
      segment: { role: seg.role, content, zone },
      priority: 0,
      semanticPlacement,
    })
  }
  return { contributions, diagnostics: [] }
}
