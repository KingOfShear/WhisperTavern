import type { DgWorldbook, StEntryDialect } from './types'

/**
 * Worldbook Import Compatibility Report(p1-plan R-P1-6 出场要件)。
 * 与卡报告同源纪律:**只含字段路径与档位结论,不含条目内容**(内容属用户资产,
 * 随 .dgworld 落盘,不随报告外泄)。
 */

export type WorldbookSourceFormat = 'st-lorebook-legacy' | 'st-lorebook-modern' | 'st-embedded'

/** 条目容器形态(与代际无关:ST 自身两种都写) */
export type EntryContainer = 'array' | 'uidMap'

export interface WorldbookImportReport {
  asset: {
    kind: 'worldbook'
    sourceFormat: WorldbookSourceFormat
    name: string
    entryCount: number
    entryContainer: EntryContainer
  }
  /** 字段映射主干(ST 字段 → 原生路径);未列出者要么直通要么进 compat */
  fieldMap: { from: string; to: string }[]
  /** 未建模字段路径(值在 entry.compat,导出回写) */
  compatFields: string[]
  warnings: string[]
}

export interface WorldbookImportResult {
  worldbook: DgWorldbook
  report: WorldbookImportReport
  /**
   * 探测到的书级字段方言(回写拼写用,非语义)。未落进 .dgworld 文件——
   * 它是导入侧探测结果,P5 导出链按目标方言选择(默认 lorebook)。
   */
  dialect: StEntryDialect
}

/**
 * ST 字段 → 原生路径映射表(报告主干 + 往返覆盖清单的唯一来源)。
 * 一条没进这张表 = 要么进 compat(往返靠 compat 兜),要么是真的丢了。
 */
export const WORLDBOOK_FIELD_MAP: readonly { from: string; to: string }[] = [
  { from: 'uid', to: 'uid(原样保留:往返映射键)' },
  { from: 'key/keys', to: 'activation.keys' },
  { from: 'keysecondary/secondary_keys', to: 'activation.secondaryKeys' },
  { from: 'comment', to: 'title(语义正名:它就是条目标题)' },
  { from: 'content', to: 'content' },
  { from: 'constant/selective/vectorized', to: 'activation.mode' },
  { from: 'selectiveLogic', to: 'activation.logic(0-3 → andAny/andAll/notAny/notAll)' },
  { from: 'order|insertion_order', to: 'placement.order(老字段名归一)' },
  { from: 'position', to: 'placement.slot(0-7 魔数 → 枚举)' },
  { from: 'disable', to: 'enabled(极性反转)' },
  { from: 'ignoreBudget', to: 'budget.ignore' },
  { from: 'excludeRecursion/preventRecursion/delayUntilRecursion', to: 'recursion.*' },
  { from: 'scanDepth/caseSensitive/matchWholeWords', to: 'activation.*(条目级覆盖,null = 跟随书级)' },
  { from: 'sticky/cooldown/delay', to: 'lifecycle.*' },
  { from: 'group/groupOverride/groupWeight/useGroupScoring', to: 'group.*' },
  { from: 'probability|chance', to: 'activation.chance' },
  { from: 'triggers', to: 'activation.triggers' },
  { from: 'match*×6', to: 'activation.matchScope(合并为范围名数组)' },
  { from: 'characterFilter', to: 'activation.characterFilter' },
  { from: 'outletName', to: 'placement.outletName' },
  { from: 'depth', to: 'placement.depth' },
  { from: 'role', to: 'placement.role' },
]
