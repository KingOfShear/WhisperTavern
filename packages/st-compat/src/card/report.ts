import type { DgCard, ExtractedWorldbook } from './types'

/**
 * Import Compatibility Report v1(p1-plan R-P1-6 出场要件)。
 * 隐私边界:报告只含**字段路径与档位结论**,不含卡内容值(内容属用户资产,
 * 随 .dgcard 落盘,不随报告外泄)。
 */

export interface ImportReport {
  asset: { kind: 'card'; sourceFormat: SourceFormat; name: string }
  /** 关键字段映射(主干;未列出者要么直通要么进 compat) */
  fieldMap: { from: string; to: string }[]
  /** 未建模字段路径(值在 .dgcard compat,导出回写) */
  compatFields: string[]
  /** 运行态混入字段(定义与运行态分离原则,§5.10:剥离入 DB,不进卡文件) */
  droppedRuntimeState: string[]
  warnings: string[]
}

export type SourceFormat = 'st-v1' | 'st-v2' | 'st-v3' | 'charx' | 'png-v2' | 'png-v3'

export interface CardImportResult {
  card: DgCard
  report: ImportReport
  /** 内嵌书抽取(无内嵌书 = undefined);落盘与 worldbooks 注册由调用侧执行 */
  extractedWorldbook?: ExtractedWorldbook
  /** charx/卡片附带资产文件(uri 相对 .dgcard 目录 → 字节) */
  assetFiles: Map<string, Uint8Array>
}
