import { type ChatId, type Diagnostic, type PromptContribution } from '@whispertavern/contracts'
import { loadChat } from '../tree/messages'
import { characters } from '../db/schema'
import type { WhisperTavernDb } from '../db/database'
import { eq } from 'drizzle-orm'

/**
 * chat↔角色卡 贡献接线（P4 §26 群聊命名空间的前置；compiler-spec §10 character 行）。
 *
 * 为什么必须存在：契约里的 `SegmentSourceSchema` 从 P0 起就声明了
 * `{ type: 'character', assetId, field }`，`core/serializer/diff.ts` 也早就把它
 * 映射成 `CHARACTER_CHANGED` 缓存破裂因——但**全仓没有任何生产者**，
 * `characters.description/personality/scenario` 三列同样零消费者。
 * 结果：每个角色产出的 header 逐字节相同，per-(chat, character) 缓存命名空间
 * 即便建起来也是空转（§26 要求的"多角色各自前缀"根本不存在）。
 * 本模块补齐这个生产者。
 *
 * 分工（与 persona.ts 同构的一层）：S33a 只做**单聊单值绑定**——读
 * `chats.character_id` 一行。群聊多成员（`chat_members`）归 S33b；届时
 * `buildCharacterContributions` 的输入会从"chat 的单值绑定"换成"chat 的成员集"，
 * 但段身份口径（稳定 ID / source.field / header 区）不变。
 *
 * 缓存纪律：角色卡是会话内静态资产，进 header 区（§19 Header 允许 Character
 * Description，要求 stability >= session）。本模块不声明 stability，按区默认推导
 * （与 S11 worldbook builder / persona builder 一致）。
 */

export interface BuildCharacterInput {
  store: WhisperTavernDb
  chatId: ChatId
}

export interface BuildCharacterResult {
  contributions: PromptContribution[]
  diagnostics: readonly Diagnostic[]
}

/**
 * header 区顺序。取值与 persona builder 相同（0）：二者的相对次序由 run.ts 的
 * **提交序**（character 在 persona 之前）+ 稳定 ID tiebreak 决定，不靠 order 抢位；
 * 这样预设段自己的 prompt_order 仍是同一区内的主要排序键。
 */
const CHARACTER_HEADER_ORDER = 0

/**
 * 角色卡 → 槽位内容。键 = ST 预设标记 identifier（`StPresetMarker` 的语义槽，
 * 见 st-compat `ST_MARKER_TO_SLOT`），值 = 该槽应从角色卡取哪个字段渲染。
 *
 * 只登记**本模块能负责的**槽：worldInfoBefore/After 归世界书 builder、
 * chatHistory 归消息链、personaDescription 归 persona builder——它们各有
 * 自己的贡献生产者，在此重复填充会双注入（见 fillCharacterSlots 的 why 注释）。
 */
const CHARACTER_SLOT_FIELDS: Readonly<Record<string, keyof CharacterFieldRow>> = {
  charDescription: 'description',
  charPersonality: 'personality',
}

/** 角色卡里可供槽位取值的列（只列本模块消费的，避免把整表形状漏进类型面） */
interface CharacterFieldRow {
  description: string
  personality: string
  scenario: string
}

/** 角色卡字段的固定渲染序：契约 `{ type:'character', assetId, field }` 的 field 取值集 */
const CHARACTER_FIELDS: readonly (keyof CharacterFieldRow)[] = ['description', 'personality']

function safeColumn(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 读取 chat 绑定角色卡的字段。未绑定（或行已删）→ null，调用方必须走"零贡献"路径，
 * 以保未绑定 chat 的 header 与 S33a 之前逐字节一致（金样基线 + P2 缓存门禁的前提）。
 */
function loadBoundCharacter(
  store: WhisperTavernDb,
  chatId: ChatId,
): { characterId: string; fields: CharacterFieldRow } | null {
  const chat = loadChat(store, chatId)
  if (!chat.ok) return null
  const characterId = chat.value.characterId
  if (characterId === undefined) return null
  const row = store.db.select().from(characters).where(eq(characters.id, characterId)).get()
  if (row === undefined) return null
  return {
    characterId,
    fields: {
      description: safeColumn(row.description),
      personality: safeColumn(row.personality),
      scenario: safeColumn(row.scenario),
    },
  }
}

/**
 * 角色卡槽位填充（compiler-spec §10 / st-compat report 承诺的"编译时由子系统填充"）。
 *
 * 为什么填在预设段**原地**而不是另发一条贡献：ST 语义里标记段的 **prompt_order
 * 位置**决定内容落在哪儿；另发贡献就丢了作者在预设里排的序（§81 "顺序即语义序"）。
 * 因此这里返回 `段 id → 填充文本`，由 preset builder 在解析时替换该段内容。
 *
 * 空值语义：字段为空串 → **不登记**，段保持原样（未绑定 chat 的 marker 段本就是
 * 空串，于是逐字节不变——这是零基线漂移的关键）。
 */
export function characterSlotContents(input: BuildCharacterInput): ReadonlyMap<string, string> {
  const bound = loadBoundCharacter(input.store, input.chatId)
  const filled = new Map<string, string>()
  if (bound === null) return filled
  for (const [slot, field] of Object.entries(CHARACTER_SLOT_FIELDS)) {
    const value = bound.fields[field]
    if (value.trim() === '') continue
    filled.set(slot, value)
  }
  return filled
}

/**
 * 角色卡 → header 贡献。
 *
 * 何时产出空集（都不算异常，调用方无须分支）：
 * - chat 未绑定角色 / 角色行已删；
 * - 三个字段全为空白（空卡）。
 *
 * 段 ID 用 `character:<characterId>:<field>`（§9 稳定 ID = assetId + logicalPath，
 * 禁 randomUUID）：换角色换 ID、换字段换 ID，于是 diff/SegmentDiff 能把
 * "角色卡变了"精确归因到一条段，而不是笼统的预设段变更。
 */
export function buildCharacterContributions(input: BuildCharacterInput): BuildCharacterResult {
  const bound = loadBoundCharacter(input.store, input.chatId)
  if (bound === null) return { contributions: [], diagnostics: [] }

  const contributions: PromptContribution[] = []
  for (const field of CHARACTER_FIELDS) {
    const content = bound.fields[field]
    if (content.trim() === '') continue
    contributions.push({
      id: `character:${bound.characterId}:${field}`,
      source: { type: 'character', assetId: bound.characterId, field },
      segment: { role: 'system', content, zone: 'header' },
      priority: 0,
      semanticPlacement: { type: 'header', order: CHARACTER_HEADER_ORDER },
    })
  }
  return { contributions, diagnostics: [] }
}
