/**
 * packages/st-compat —— SillyTavern 生态兼容:character / worldbook / preset / chat。
 * P1 落地:卡导入(S9,card/)→ 世界书导入(S10)→ 预设映射(S12)→ 聊天记录(P5)。
 * 依赖方向:st-compat → contracts(+ zod/fflate);实施口径 technical-plan §5.9/§5.10。
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
  CARD_ROLE_ASSIGNMENTS,
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
