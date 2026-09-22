import {
  EMBEDDED_DIALECT,
  LOREBOOK_DIALECT,
  ST_MATCH_SCOPE_FIELDS,
  ST_POSITION_TO_SLOT,
  ST_SELECTIVE_LOGIC,
  StWorldbookEntrySchema,
  StWorldbookRootSchema,
  type DgWorldbook,
  type DgWorldbookEntry,
  type DgWorldbookScan,
  type StEntryDialect,
} from './types'
import {
  WORLDBOOK_FIELD_MAP,
  type EntryContainer,
  type WorldbookImportReport,
  type WorldbookImportResult,
  type WorldbookSourceFormat,
} from './report'

export type { StEntryDialect }
export { EMBEDDED_DIALECT, LOREBOOK_DIALECT }

/**
 * ST 世界书归一 → 原生 .dgworld(technical-plan §5.3)。
 *
 * 吃进三种容器形态(数组 / uid 键对象 / 裸 uid 键对象)与两代字段集
 * (老 8 字段 ↔ 现代 42 字段平铺),产出**语义不变、结构重组**的原生条目。
 * 三条不变量:
 * - **往返无损**:uid 原样保留 + 未建模字段进 compat,导出按方言回写(见 toStEntry);
 * - **零魔数**:position/selectiveLogic/disable 一律转枚举或反转极性;
 * - **极性差异归一**:lorebook 的 `disable` 与 V3 character_book 的 `enabled`
 *   是同一语义的两种写法,归一为 `enabled`,方言只影响回写拼写(ST_DIALECTS)。
 */

export class WorldbookParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldbookParseError'
  }
}

export function isWorldbookParseError(error: unknown): error is InstanceType<typeof WorldbookParseError> {
  return (error as { name?: string }).name === 'WorldbookParseError'
}

/** 现代字段标记:出现任一即判为现代书(决定报告 sourceFormat 与缺省补齐口径) */
const MODERN_MARKERS = [
  'sticky', 'cooldown', 'delay', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion',
  'group', 'groupWeight', 'useGroupScoring', 'triggers', 'matchPersonaDescription',
  'characterFilter', 'probability', 'outletName', 'selectiveLogic', 'scanDepth',
] as const

/** 已建模字段集:不在其中的键一律进 compat(往返靠 compat 兜底) */
const MODELED_ENTRY_FIELDS = new Set(Object.keys(StWorldbookEntrySchema.shape))

/** 书级默认扫描配置(§5.3 样例:null = 跟随会话配置;预算 25% 对齐酒馆默认) */
export const DEFAULT_SCAN: DgWorldbookScan = {
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  recursive: true,
  budget: { percent: 25, cap: null },
}

// ===== 容器与代际判别 =====

interface RawEntry {
  /** 容器键(uid 键对象的键或数组下标) */
  containerKey: string
  raw: Record<string, unknown>
}

function parseEntries(root: Record<string, unknown>): { entries: RawEntry[]; container: EntryContainer } {
  const entries = root['entries']
  if (Array.isArray(entries)) {
    return {
      entries: entries.map((raw, index) => ({ containerKey: String(index), raw: raw as Record<string, unknown> })),
      container: 'array',
    }
  }
  if (typeof entries === 'object' && entries !== null) {
    return { entries: mapToEntries(entries as Record<string, Record<string, unknown>>), container: 'uidMap' }
  }
  // 裸 uid 键对象(老 lorebook 导出:整个文件就是条目表)
  return { entries: mapToEntries(root as Record<string, Record<string, unknown>>), container: 'uidMap' }
}

function mapToEntries(map: Record<string, Record<string, unknown>>): RawEntry[] {
  return Object.entries(map).map(([containerKey, raw]) => ({ containerKey, raw }))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detectGeneration(entries: RawEntry[]): Extract<WorldbookSourceFormat, 'st-lorebook-legacy' | 'st-lorebook-modern'> {
  const modern = entries.some(({ raw }) => MODERN_MARKERS.some((marker) => marker in raw))
  return modern ? 'st-lorebook-modern' : 'st-lorebook-legacy'
}

/** 方言按"出现即采纳"投票(混合方言记 warning,导出按书级方言回写) */
function detectDialect(entries: RawEntry[]): { dialect: StEntryDialect; mixed: boolean } {
  const has = (field: string): boolean => entries.some(({ raw }) => field in raw)
  const dialect: StEntryDialect = {
    keyField: has('keys') ? 'keys' : 'key',
    secondaryField: has('secondary_keys') ? 'secondary_keys' : 'keysecondary',
    orderField: has('insertion_order') && !has('order') ? 'insertion_order' : 'order',
    enabledField: has('enabled') ? 'enabled' : 'disable',
  }
  const mixed =
    (has('keys') && has('key')) ||
    (has('secondary_keys') && has('keysecondary')) ||
    (has('insertion_order') && has('order')) ||
    (has('enabled') && has('disable'))
  return { dialect, mixed }
}

// ===== 条目归一 =====

function toKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') {
    // 酒馆 UI 允许"逗号分隔"输入,落盘偶见未 split 的整串
    return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
  }
  return []
}

function toRole(value: unknown): 'system' | 'user' | 'assistant' {
  // ST role 魔数:0=system,1=user,2=assistant(酒馆 semantics),亦兼容直接字符串
  if (value === 'user' || value === 'assistant') return value
  if (value === 1) return 'user'
  if (value === 2) return 'assistant'
  return 'system'
}

function toInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/** ST position 方言归一:number 原样;string 纯数字串("0".."7")转 number;其余 undefined */
function toPositionInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10)
  return undefined
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeEntry(
  { containerKey, raw }: RawEntry,
  index: number,
  warnings: string[],
): DgWorldbookEntry {
  const entry = StWorldbookEntrySchema.parse(raw)
  const label = `条目 #${index}(uid=${entry.uid ?? containerKey})`

  // —— 极性归一:lorebook disable(反转)/ V3 enabled(正向)二选一 ——
  let enabled = true
  if (typeof entry.disable === 'boolean') enabled = !entry.disable
  else if (typeof entry.enabled === 'boolean') enabled = entry.enabled

  // —— 放置:position 0-7 魔数 → slot 枚举(ST 生态两种方言:number 现代导出 / string 数字串,归一后查表)——
  const position = toPositionInt(entry.position)
  const mappedSlot = position !== undefined && Number.isInteger(position) ? ST_POSITION_TO_SLOT[position] : undefined
  const slot: DgWorldbookEntry['placement']['slot'] = mappedSlot ?? 'before'
  if (mappedSlot === undefined && entry.position !== undefined) {
    warnings.push(`${label}: position=${String(entry.position)} 越界或非整数 → 回落 before`)
  }

  const triggers = (entry.triggers ?? []).filter((item): item is string => typeof item === 'string')
  if (triggers.length !== (entry.triggers ?? []).length) {
    warnings.push(`${label}: triggers 含非字符串元素,已丢弃非字符串项`)
  }

  const uid = typeof entry.uid === 'number' ? Math.trunc(entry.uid) : undefined
  const id = uid !== undefined ? `e-${uid}` : `e-${index}`

  return {
    id,
    uid,
    title: entry.comment ?? '',
    content: entry.content ?? '',
    enabled,
    activation: {
      mode: entry.constant === true ? 'constant' : entry.vectorized === true ? 'vectorized' : 'selective',
      keys: toKeys(entry.key ?? entry.keys),
      secondaryKeys: toKeys(entry.keysecondary ?? entry.secondary_keys),
      logic: ST_SELECTIVE_LOGIC[entry.selectiveLogic ?? 0] ?? 'andAny',
      chance: entry.probability ?? entry.chance ?? 100,
      matchScope: ST_MATCH_SCOPE_FIELDS.filter(([field]) => raw[field] === true).map(([, scope]) => scope),
      triggers,
      characterFilter: isPlainObject(entry.characterFilter) ? entry.characterFilter : {},
      scanDepth: typeof entry.scanDepth === 'number' ? Math.trunc(entry.scanDepth) : null,
      caseSensitive: typeof entry.caseSensitive === 'boolean' ? entry.caseSensitive : null,
      matchWholeWords: typeof entry.matchWholeWords === 'boolean' ? entry.matchWholeWords : null,
    },
    lifecycle: {
      sticky: toInt(entry.sticky, 0),
      cooldown: toInt(entry.cooldown, 0),
      delay: toInt(entry.delay, 0),
    },
    recursion: {
      excluded: toBool(entry.excludeRecursion, false),
      prevent: toBool(entry.preventRecursion, false),
      delayedUntil: toBool(entry.delayUntilRecursion, false),
    },
    placement: {
      slot,
      order: toInt(entry.order ?? entry.insertion_order, 0),
      depth: toInt(entry.depth, 4),
      role: toRole(entry.role),
      outletName: typeof entry.outletName === 'string' ? entry.outletName : null,
    },
    budget: { ignore: toBool(entry.ignoreBudget, false) },
    group: {
      id: typeof entry.group === 'string' && entry.group !== '' ? entry.group : null,
      override: toBool(entry.groupOverride, false),
      weight: entry.groupWeight ?? 100,
      scoring: toBool(entry.useGroupScoring, true),
    },
    // 分区策略无 ST 来源:P1 一律默认,退休/钉住由 P2 Cache Engine 消费(§5.3 zoning)
    zoning: { retirement: 'auto', pin: false },
    compat: collectCompat(raw),
  }
}

function collectCompat(raw: Record<string, unknown>): Record<string, unknown> {
  const compat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!MODELED_ENTRY_FIELDS.has(key)) compat[key] = value
  }
  return compat
}

// ===== 导入入口 =====

export interface ImportWorldbookOptions {
  /** 覆盖书名(无 name 字段的裸 uid 键对象用) */
  name?: string
  /** 卡内嵌书走 st-embedded 档;缺省由字段集自动判代 */
  sourceFormat?: WorldbookSourceFormat
}

function normalize(
  json: unknown,
  sourceFormat: WorldbookSourceFormat | undefined,
  options: ImportWorldbookOptions,
): WorldbookImportResult {
  const parsed = StWorldbookRootSchema.safeParse(json)
  if (!parsed.success) throw new WorldbookParseError('世界书 JSON 解析失败:根节点必须是对象')
  const root = parsed.data as Record<string, unknown>

  const { entries: rawEntries, container } = parseEntries(root)
  const warnings: string[] = []
  const { dialect, mixed } = detectDialect(rawEntries)
  if (mixed) warnings.push('条目混用两种字段方言(keys/key、enabled/disable 等),导出按书级方言回写')

  const entries = rawEntries.map((raw, index) => normalizeEntry(raw, index, warnings))
  const generation = detectGeneration(rawEntries)
  const format = sourceFormat ?? generation

  const compatFields = [...new Set(entries.flatMap((entry) => Object.keys(entry.compat)))]
  const bookCompat = collectBookCompat(root)
  if (Object.keys(bookCompat).length > 0) {
    warnings.push('书级未建模字段已进 worldbook.compat(导出回写)')
  }

  const nameFromRoot = typeof root['name'] === 'string' && root['name'] !== '' ? root['name'] : undefined
  const name = options.name ?? nameFromRoot ?? '未命名世界书'
  if (options.name === undefined && nameFromRoot === undefined) {
    warnings.push('书未提供 name 字段,已按"未命名世界书"归档')
  }

  const worldbook: DgWorldbook = {
    schemaVersion: 1,
    meta: { name, description: typeof root['description'] === 'string' ? root['description'] : undefined, tags: [] },
    scan: { ...DEFAULT_SCAN },
    entries,
    compat: bookCompat,
  }

  const report: WorldbookImportReport = {
    asset: {
      kind: 'worldbook',
      sourceFormat: format,
      name: worldbook.meta.name,
      entryCount: entries.length,
      entryContainer: container,
    },
    fieldMap: [...WORLDBOOK_FIELD_MAP],
    compatFields,
    warnings,
  }
  return { worldbook, report, dialect }
}

function collectBookCompat(root: Record<string, unknown>): Record<string, unknown> {
  const modeled = new Set(['name', 'description', 'entries'])
  const compat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(root)) {
    if (!modeled.has(key)) compat[key] = value
  }
  return compat
}

/** JSON 明文入口(lorebook 导出 / 卡内嵌 character_book) */
export function importWorldbookFromJson(json: unknown, options: ImportWorldbookOptions = {}): WorldbookImportResult {
  return normalize(json, options.sourceFormat, options)
}

/** 字节入口(自动 UTF-8 JSON;非法 JSON → WorldbookParseError) */
export function importWorldbook(bytes: Uint8Array, options: ImportWorldbookOptions = {}): WorldbookImportResult {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new WorldbookParseError('世界书文件不是合法 UTF-8 JSON')
  }
  return normalize(json, options.sourceFormat, options)
}

// ===== 往返回写(原生 → ST 条目) =====

/**
 * 原生条目 → ST 条目(往返验证用;正式导出链 P5 接线)。
 *
 * 无损性不靠"恰好建模了全部字段":建模字段按方言回写,未建模字段从 compat 原样铺回,
 * 故 `toStEntry(import(x).entries[i], dialect)` 对 x 的每个键都回得来(见 worldbook.test.ts)。
 */
export function toStEntry(entry: DgWorldbookEntry, dialect: StEntryDialect = LOREBOOK_DIALECT): Record<string, unknown> {
  const { activation, lifecycle, recursion, placement, budget, group } = entry
  const enabledValue = dialect.enabledField === 'disable' ? !entry.enabled : entry.enabled
  const st: Record<string, unknown> = {
    [dialect.keyField]: activation.keys,
    [dialect.secondaryField]: activation.secondaryKeys,
    comment: entry.title,
    content: entry.content,
    constant: activation.mode === 'constant',
    selective: activation.mode === 'selective',
    vectorized: activation.mode === 'vectorized',
    selectiveLogic: ST_SELECTIVE_LOGIC.indexOf(activation.logic),
    [dialect.orderField]: placement.order,
    position: ST_POSITION_TO_SLOT.indexOf(placement.slot),
    [dialect.enabledField]: enabledValue,
    ignoreBudget: budget.ignore,
    excludeRecursion: recursion.excluded,
    preventRecursion: recursion.prevent,
    delayUntilRecursion: recursion.delayedUntil,
    sticky: lifecycle.sticky,
    cooldown: lifecycle.cooldown,
    delay: lifecycle.delay,
    group: group.id ?? '',
    groupOverride: group.override,
    groupWeight: group.weight,
    useGroupScoring: group.scoring,
    probability: activation.chance,
    triggers: activation.triggers,
    role: placement.role,
    depth: placement.depth,
    ...entry.compat,
  }
  // 条目级可空覆盖:null 表示"跟随书级",回写时省略(与源书缺省形态一致)
  if (activation.scanDepth !== null) st['scanDepth'] = activation.scanDepth
  if (activation.caseSensitive !== null) st['caseSensitive'] = activation.caseSensitive
  if (activation.matchWholeWords !== null) st['matchWholeWords'] = activation.matchWholeWords
  for (const [field, scope] of ST_MATCH_SCOPE_FIELDS) {
    st[field] = activation.matchScope.includes(scope)
  }
  if (Object.keys(activation.characterFilter).length > 0) st['characterFilter'] = activation.characterFilter
  if (placement.outletName !== null) st['outletName'] = placement.outletName
  if (entry.uid !== undefined) st['uid'] = entry.uid
  return st
}
