import {
  type DgPreset,
  type DgPresetPlacement,
  type DgPresetSegment,
  type StPresetRoot,
  type StPresetSegment,
  ST_MARKER_TO_SLOT,
  StPresetRootSchema,
} from './types'
import { PRESET_FIELD_MAP, type PresetImportReport, type PresetImportResult, type PresetSourceFormat } from './report'

/** 解析失败统一异常(镜像 WorldbookParseError;服务端据此映射 VALIDATION_ERROR) */
export class PresetParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresetParseError'
  }
}

export function isPresetParseError(error: unknown): error is InstanceType<typeof PresetParseError> {
  return (error as { name?: string }).name === 'PresetParseError'
}

/** 已知 ST 顶层采样参数键(方言并集);其余顶层键进 preset.compat */
const KNOWN_PARAM_KEYS = new Set([
  'temperature',
  'max_context',
  'maxContext',
  'max_tokens',
  'maxTokens',
  'top_p',
  'topP',
  'top_k',
  'topK',
  'stream',
])

/** 段内已建模键(用于反向剥离 compat) */
const KNOWN_SEGMENT_KEYS = new Set([
  'identifier',
  'name',
  'role',
  'content',
  'enabled',
  'injection_position',
  'injection_depth',
  'order',
])

/** ST 角名 → 原生 PromptRole(未知/缺省 → system) */
function mapRole(role: string | undefined): 'system' | 'user' | 'assistant' | 'tool' {
  if (role === 'user') return 'user'
  if (role === 'assistant' || role === 'model') return 'assistant'
  if (role === 'tool') return 'tool'
  return 'system'
}

/** 从 prompt_order 条目解析稳定 identifier(兼容字符串与对象两种形态) */
function orderEntryIdentifier(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>
    const id = obj.identifier ?? obj.name ?? obj.id
    if (typeof id === 'string') return id
  }
  return undefined
}

export interface ImportPresetOptions {
  name?: string
}

/**
 * ST JSON → 原生 .dgpreset(prompt_order + prompts → segments;§80–§81 映射)。
 * 字节入口见 importPreset;本函数吃已解析对象。
 */
export function importPresetFromJson(json: unknown, options: ImportPresetOptions = {}): PresetImportResult {
  const parsed = StPresetRootSchema.safeParse(json)
  if (!parsed.success) throw new PresetParseError('预设 JSON 解析失败:根节点必须是对象')
  const root = parsed.data as StPresetRoot

  const prompts = (root.prompts ?? []) as StPresetSegment[]
  const byIdentifier = new Map<string, StPresetSegment>()
  for (const seg of prompts) {
    const id = typeof seg.identifier === 'string' ? seg.identifier : undefined
    if (id !== undefined) byIdentifier.set(id, seg)
  }

  const orderList = (root.prompt_order ?? []) as unknown[]
  const warnings: string[] = []
  const compatFields = new Set<string>()
  const segments: DgPresetSegment[] = []
  const seenIdentifiers = new Set<string>()

  orderList.forEach((entry, index) => {
    const id = orderEntryIdentifier(entry)
    if (id === undefined) {
      warnings.push(`prompt_order[${index}] 无法解析 identifier,跳过`)
      return
    }
    const seg = byIdentifier.get(id)
    if (seg === undefined) {
      warnings.push(`prompt_order 引用了 prompts 中不存在的段:${id},跳过`)
      return
    }
    if (seenIdentifiers.has(id)) return
    seenIdentifiers.add(id)

    // compat:剥离已建模键后的剩余字段
    const segCompat: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(seg)) {
      if (!KNOWN_SEGMENT_KEYS.has(key)) segCompat[key] = value
    }

    const isInjection = seg.injection_position === 1
    const placement: DgPresetPlacement = isInjection
      ? { kind: 'injection', depth: typeof seg.injection_depth === 'number' ? seg.injection_depth : 0, order: index }
      : { kind: 'header', order: index }

    const slot = ST_MARKER_TO_SLOT[id] ?? null
    segments.push({
      id,
      name: typeof seg.name === 'string' && seg.name !== '' ? seg.name : id,
      role: mapRole(typeof seg.role === 'string' ? seg.role : undefined),
      content: typeof seg.content === 'string' ? seg.content : '',
      enabled: seg.enabled !== false,
      slot,
      placement,
      compat: segCompat,
    })
  })

  // 顶层 compat(采样参数外未建模键)
  for (const key of Object.keys(root)) {
    if (KNOWN_PARAM_KEYS.has(key)) continue
    if (key === 'name' || key === 'prompts' || key === 'prompt_order') continue
    compatFields.add(key)
  }

  const params = normalizeParams(root)
  const preset: DgPreset = {
    schemaVersion: 1,
    meta: { name: options.name ?? root.name ?? 'imported-preset', tags: [] },
    segments,
    params,
    bindings: {},
    compat: Object.fromEntries([...compatFields].map((k) => [k, (root as Record<string, unknown>)[k]])),
  }

  const report: PresetImportReport = {
    asset: {
      kind: 'preset',
      sourceFormat: 'st-prompt-manager' as PresetSourceFormat,
      name: preset.meta.name,
      segmentCount: segments.length,
      injectedCount: segments.filter((s) => s.placement.kind === 'injection').length,
    },
    fieldMap: [...PRESET_FIELD_MAP],
    compatFields: [...compatFields],
    warnings,
  }
  return { preset, report }
}

/** 采样参数方言归一(下划线 ↔ 驼峰) */
function normalizeParams(root: StPresetRoot): DgPreset['params'] {
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = (root as Record<string, unknown>)[k]
      if (typeof v === 'number') return v
    }
    return undefined
  }
  const bool = (...keys: string[]): boolean | undefined => {
    for (const k of keys) {
      const v = (root as Record<string, unknown>)[k]
      if (typeof v === 'boolean') return v
    }
    return undefined
  }
  const params: DgPreset['params'] = {}
  const temperature = num('temperature')
  const maxContext = num('max_context', 'maxContext')
  const maxTokens = num('max_tokens', 'maxTokens')
  const topP = num('top_p', 'topP')
  const topK = num('top_k', 'topK')
  const stream = bool('stream')
  if (temperature !== undefined) params.temperature = temperature
  if (maxContext !== undefined) params.maxContext = maxContext
  if (maxTokens !== undefined) params.maxTokens = maxTokens
  if (topP !== undefined) params.topP = topP
  if (topK !== undefined) params.topK = topK
  if (stream !== undefined) params.stream = stream
  return params
}

/** 字节入口(自动 UTF-8 JSON;非法 JSON → PresetParseError) */
export function importPreset(bytes: Uint8Array, options: ImportPresetOptions = {}): PresetImportResult {
  let text: string
  try {
    text = new TextDecoder().decode(bytes)
  } catch {
    throw new PresetParseError('预设文件不是合法 UTF-8')
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new PresetParseError('预设文件不是合法 JSON')
  }
  return importPresetFromJson(json, options)
}

/**
 * 原生 .dgpreset → ST 形状(往返回写;§5.5:提示词层双向无损,机制层单向)。
 * header → injection_position 0;injection → injection_position 1 + depth;tail → 1/depth0 近似。
 */
export function toStPreset(preset: DgPreset): Record<string, unknown> {
  const prompts = preset.segments.map((seg) => {
    const st: Record<string, unknown> = {
      identifier: seg.id,
      name: seg.name,
      role: seg.role,
      content: seg.content,
      enabled: seg.enabled,
    }
    if (seg.placement.kind === 'injection') {
      st.injection_position = 1
      st.injection_depth = seg.placement.depth
    } else {
      st.injection_position = 0
      st.injection_depth = 0
    }
    return { ...st, ...seg.compat }
  })
  const promptOrder = preset.segments.map((seg) => ({
    identifier: seg.id,
    order: seg.placement.order,
    enabled: seg.enabled,
  }))
  const st: Record<string, unknown> = {
    name: preset.meta.name,
    prompts,
    prompt_order: promptOrder,
  }
  if (preset.params.temperature !== undefined) st.temperature = preset.params.temperature
  if (preset.params.maxContext !== undefined) st.max_context = preset.params.maxContext
  if (preset.params.maxTokens !== undefined) st.max_tokens = preset.params.maxTokens
  if (preset.params.topP !== undefined) st.top_p = preset.params.topP
  if (preset.params.topK !== undefined) st.top_k = preset.params.topK
  if (preset.params.stream !== undefined) st.stream = preset.params.stream
  return { ...st, ...preset.compat }
}
