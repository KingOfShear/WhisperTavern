import type { DgPreset } from './types'

/**
 * Preset Import Compatibility Report(p1-plan R-P1-6 出场要件;镜像 worldbook 报告)。
 * **只含字段路径与档位结论,不含段内容**(内容随 .dgpreset 落盘,不随报告外泄)。
 */

export type PresetSourceFormat = 'st-prompt-manager'

export interface PresetImportReport {
  asset: {
    kind: 'preset'
    sourceFormat: PresetSourceFormat
    name: string
    segmentCount: number
    injectedCount: number
  }
  /** ST 字段 → 原生路径映射主干 */
  fieldMap: { from: string; to: string }[]
  /** 未建模字段路径(进 .dgpreset compat,导出回写) */
  compatFields: string[]
  warnings: string[]
}

export interface PresetImportResult {
  preset: DgPreset
  report: PresetImportReport
}

/**
 * ST 字段 → 原生路径映射表(报告主干 + 往返覆盖清单的唯一来源)。
 * 未进此表者 = 要么进 compat(往返靠 compat 兜),要么真丢了。
 */
export const PRESET_FIELD_MAP: readonly { from: string; to: string }[] = [
  { from: 'identifier', to: 'id(原样保留:稳定映射键)' },
  { from: 'name', to: 'name' },
  { from: 'role', to: 'role' },
  { from: 'content', to: 'content' },
  { from: 'enabled', to: 'enabled' },
  { from: 'injection_position=0', to: 'placement.header(§81:PromptOrder → Semantic→Cache,不直接 stableWB)' },
  { from: 'injection_position=1 + injection_depth', to: 'placement.injection.depth(§82/§83:深度注入 → injection 区)' },
  { from: 'prompt_order 索引', to: 'placement.*.order(§81:顺序即语义序)' },
  { from: 'marker identifier(charDescription/worldInfoBefore/…)', to: 'slot(语义标记,编译时由子系统填充)' },
  { from: 'temperature/max_context/maxContext/max_tokens/maxTokens/top_p/topP/top_k/topK/stream', to: 'params.*(归一驼峰)' },
]
