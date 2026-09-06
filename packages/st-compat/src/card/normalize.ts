import { z } from 'zod'
import { CardParseError } from './png'
import { readCardFromCharx } from './charx'
import { readCardFromPng } from './png'
import { CARD_ROLE_ASSIGNMENTS, type CardImportResult, type ImportReport, type SourceFormat } from './report'
import {
  StCardDataSchema,
  StCardRootSchema,
  StEmbeddedBookSchema,
  type DgCard,
  type StCardRoot,
} from './types'

/**
 * ST 卡归一 → 原生 .dgcard(technical-plan §5.10)。
 *
 * 三载体入口:JSON 明文(V1 平铺 / V2 / V3,按 spec 字段判代)、PNG tEXt
 * (chara+ccv3 双内嵌,优先 ccv3)、charx(ZIP)。归一规则:
 * - 双层冗余归一:V2/V3 以 data{} 为准,顶层旧字段仅在 data 缺失时兜底;
 * - 运行态剥离:avatar/chat/talkativeness/fav 不进卡文件(§5.10 分离原则);
 * - 内嵌书抽取:character_book → 独立 ExtractedWorldbook(双向引用由注册侧落库);
 * - 未建模字段 → compat(路径化键,导出回写);
 * - 档位:roleAssignments 仅按来源(character/world),I1——内容自述无效。
 */

const RUNTIME_STATE_FIELDS = ['avatar', 'chat', 'talkativeness', 'fav'] as const

function detectSpec(card: StCardRoot): 'st-v1' | 'st-v2' | 'st-v3' {
  if (card.spec === 'chara_card_v3') return 'st-v3'
  if (card.spec === 'chara_card_v2') return 'st-v2'
  return 'st-v1'
}

/** data{} 与顶层旧字段的冗余归一:data 优先,顶层兜底(V2/V3);V1 仅顶层 */
function pickLayer(card: StCardRoot): { data: ReturnType<typeof StCardDataSchema.parse>; spec: 'st-v1' | 'st-v2' | 'st-v3' } {
  const spec = detectSpec(card)
  if (spec === 'st-v1') {
    return { data: StCardDataSchema.parse(card), spec }
  }
  // V2/V3:data 层为准,顶层旧字段仅兜底(双层冗余归一,§5.10)
  const data = (card as { data?: Record<string, unknown> }).data ?? {}
  return { data: StCardDataSchema.parse({ ...card, ...data }), spec }
}

function normalize(
  card: StCardRoot,
  sourceFormat: SourceFormat,
  assetFiles: Map<string, Uint8Array>,
): CardImportResult {
  const { data, spec } = pickLayer(card)
  const warnings: string[] = []
  const compatFields: string[] = []

  // —— 运行态剥离(§5.10:定义与运行态分离)——
  const droppedRuntimeState = RUNTIME_STATE_FIELDS.filter((field) => card[field] !== undefined)
  if (droppedRuntimeState.includes('chat')) warnings.push('卡内嵌 chat 运行态已剥离(会话属 DB,不入卡文件)')

  // —— 资产清单:V3 assets[];charx 的 zip 文件按 uri 对上 ——
  const rawAssets = (data as { assets?: unknown }).assets
  const assets: DgCard['assets'] = []
  if (Array.isArray(rawAssets)) {
    let index = 0
    for (const entry of rawAssets) {
      const parsed = z
        .looseObject({ type: z.string().optional(), uri: z.string().optional(), emotion: z.string().optional() })
        .safeParse(entry)
      if (!parsed.success || typeof parsed.data.uri !== 'string') {
        warnings.push(`assets[${index}] 缺 uri,整条进 compat`)
        compatFields.push(`assets[${index}]`)
        index += 1
        continue
      }
      const type = parsed.data.type === 'icon' || parsed.data.type === 'emotion' || parsed.data.type === 'background' ? parsed.data.type : 'avatar'
      assets.push({ id: `a${index}`, type, uri: parsed.data.uri, emotion: parsed.data.emotion })
      index += 1
    }
  } else if (typeof card.avatar === 'string') {
    // 无 assets 清单的卡:外置 avatar 文件名记入 compat(文件本体不在卡内)
    compatFields.push('avatar')
    warnings.push(`avatar 为外置文件引用(${String(card.avatar)}),P0 不随导入复制`)
  }

  // —— 内嵌书抽取(§5.10:导入即抽取为独立 .dgworld 双向引用)——
  let extractedWorldbook: CardImportResult['extractedWorldbook']
  const rawBook = (data as { character_book?: unknown }).character_book
  if (rawBook !== undefined && rawBook !== null) {
    const book = StEmbeddedBookSchema.parse(rawBook)
    extractedWorldbook = {
      ref: `wb-${Date.now().toString(36)}`,
      suggestedName: book.name ?? `${data.name ?? 'card'} 内嵌书`,
      raw: rawBook,
    }
  }

  const dgCard: DgCard = {
    schemaVersion: 1,
    meta: {
      name: data.name ?? '(未命名卡)',
      creator: data.creator,
      characterVersion: data.character_version,
      tags: data.tags ?? [],
    },
    persona: {
      description: data.description ?? '',
      personality: data.personality ?? '',
      scenario: data.scenario ?? '',
      mesExample: data.mes_example ?? '',
    },
    greetings: {
      first: data.first_mes ?? '',
      alternates: data.alternate_greetings ?? [],
      groupOnly: data.group_only_greetings ?? [],
    },
    prompts: {
      system: data.system_prompt ?? '',
      postHistory: data.post_history_instructions ?? '',
    },
    assets,
    worldbookRef: extractedWorldbook?.ref,
    compat: collectCompat(card, [...compatFields]),
  }

  if (dgCard.meta.name === '(未命名卡)') warnings.push('卡未提供 name 字段')
  if (spec === 'st-v1') warnings.push('V1 旧格式:无 spec/data 分层,建议导出时升级原生格式')

  const report: ImportReport = {
    asset: { kind: 'card', sourceFormat, name: dgCard.meta.name },
    fieldMap: [
      { from: 'data.name', to: 'meta.name' },
      { from: 'data.description', to: 'persona.description' },
      { from: 'data.first_mes', to: 'greetings.first' },
      { from: 'data.alternate_greetings', to: 'greetings.alternates' },
      { from: 'data.system_prompt', to: 'prompts.system' },
      { from: 'data.character_book', to: 'worldbookRef(抽取为独立 .dgworld)' },
      { from: 'data.assets[]', to: 'assets[]' },
    ],
    compatFields: [...new Set([...compatFields, ...Object.keys(dgCard.compat)])],
    droppedRuntimeState,
    roleAssignments: [...CARD_ROLE_ASSIGNMENTS],
    warnings,
  }
  return { card: dgCard, report, extractedWorldbook, assetFiles }
}

/** 未建模字段收集:顶层/数据层不属于原生模型的键,路径化进 compat(值原样) */
function collectCompat(card: StCardRoot, extraPaths: string[]): Record<string, unknown> {
  const compat: Record<string, unknown> = {}
  const modeled = new Set([
    'spec', 'spec_version', 'name', 'description', 'personality', 'scenario', 'first_mes',
    'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions',
    'alternate_greetings', 'group_only_greetings', 'character_book', 'tags', 'creator',
    'character_version', 'data', ...RUNTIME_STATE_FIELDS.filter((f) => f !== 'avatar'),
  ])
  // avatar 是外置文件引用而非纯运行态:保留进 compat 供往返(仅不进原生模型)
  if (typeof card.avatar === 'string') compat['avatar'] = card.avatar
  for (const [key, value] of Object.entries(card)) {
    if (!modeled.has(key)) compat[`top.${key}`] = value
  }
  const data = (card as { data?: Record<string, unknown> }).data
  if (data !== undefined) {
    for (const [key, value] of Object.entries(data)) {
      if (!modeled.has(key)) compat[`data.${key}`] = value
    }
  }
  for (const path of extraPaths) {
    compat[path] = null // 无 uri 的残缺资产条目:路径登记,值不复制
  }
  return compat
}

/** JSON 明文入口(V1 平铺 / V2 / V3,按 spec 字段判代) */
export function importCardFromJson(json: unknown): CardImportResult {
  const card = StCardRootSchema.parse(json)
  const spec = detectSpec(card)
  const sourceFormat: SourceFormat = spec === 'st-v3' ? 'st-v3' : spec === 'st-v2' ? 'st-v2' : 'st-v1'
  return normalize(card, sourceFormat, new Map())
}

/** PNG 入口(tEXt chara+ccv3,优先 ccv3) */
export function importCardFromPng(bytes: Uint8Array): CardImportResult {
  const { card, sourceFormat } = readCardFromPng(bytes)
  return normalize(card, sourceFormat, new Map())
}

/** charx 入口(ZIP:card.json + assets) */
export function importCardFromCharx(bytes: Uint8Array): CardImportResult {
  const { card, files } = readCardFromCharx(bytes)
  return normalize(card, 'charx', files)
}

/** 自动判别入口:PNG 签名 → PNG;ZIP 签名(PK) → charx;其余按 JSON */
export function importCard(bytes: Uint8Array): CardImportResult {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return importCardFromPng(bytes)
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return importCardFromCharx(bytes)
  try {
    return importCardFromJson(JSON.parse(Buffer.from(bytes).toString('utf8')))
  } catch {
    throw new CardParseError('无法识别卡载体:非 PNG/ZIP/JSON')
  }
}

/** 载体判别导出(报告/测试用) */
export { CardParseError }
export function isCardParseError(error: unknown): error is InstanceType<typeof CardParseError> {
  return (error as { name?: string }).name === 'CardParseError'
}
