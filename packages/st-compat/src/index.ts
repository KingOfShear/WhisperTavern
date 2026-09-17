/**
 * packages/st-compat —— SillyTavern 生态兼容:character / worldbook / preset / chat。
 * P1 落地:卡导入(S9,card/)→ 世界书导入(S10,worldbook/)→ 预设映射(S12)→ 聊天记录(P5)。
 * 依赖方向:st-compat → contracts(+ zod/fflate);实施口径 technical-plan §5.3/§5.9/§5.10。
 */
export type {
  DgCard,
  ExtractedWorldbook,
  StCardData,
  StCardRoot,
  StEmbeddedBook,
} from './card/types'
export { readCardFromCharx, type CharxContents } from './card/charx'
export {
  type CardImportResult,
  type ImportReport,
  type SourceFormat,
} from './card/report'
export {
  importCard,
  importCardFromCharx,
  importCardFromJson,
  importCardFromPng,
  isCardParseError,
} from './card/normalize'
export { CardParseError } from './card/png'

// ===== 世界书导入(S10 / WP1.1b;technical-plan §5.3)=====
export type {
  DgWorldbook,
  DgWorldbookEntry,
  DgWorldbookScan,
  StEntryDialect,
  StWorldbookEntry,
  StWorldbookRoot,
} from './worldbook/types'
export {
  EMBEDDED_DIALECT,
  LEGACY_LOREBOOK_DIALECT,
  LOREBOOK_DIALECT,
  SLOT_TO_ST_POSITION,
  ST_MATCH_SCOPE_FIELDS,
  ST_POSITION_TO_SLOT,
  ST_SELECTIVE_LOGIC,
} from './worldbook/types'
export {
  WORLDBOOK_FIELD_MAP,
  type EntryContainer,
  type WorldbookImportReport,
  type WorldbookImportResult,
  type WorldbookSourceFormat,
} from './worldbook/report'
export {
  DEFAULT_SCAN,
  WorldbookParseError,
  importWorldbook,
  importWorldbookFromJson,
  isWorldbookParseError,
  toStEntry,
  type ImportWorldbookOptions,
} from './worldbook/normalize'

// ===== 预设映射(S12 / WP1.3;technical-plan §5.5 + compiler-spec §80–§81)=====
export type {
  DgPreset,
  DgPresetSegment,
  DgPresetSlot,
  DgPresetPlacement,
  StPresetRoot,
  StPresetSegment,
} from './preset/types'
export { ST_MARKER_TO_SLOT } from './preset/types'
export {
  PRESET_FIELD_MAP,
  type PresetImportReport,
  type PresetImportResult,
  type PresetSourceFormat,
} from './preset/report'
export {
  PresetParseError,
  importPreset,
  importPresetFromJson,
  isPresetParseError,
  toStPreset,
  type ImportPresetOptions,
} from './preset/normalize'
