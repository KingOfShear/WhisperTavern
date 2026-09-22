import {
  activateWorldbook,
  type ActivationDescriptor,
  type ActivationRuntimeState,
  type ScanContext,
  type ScanMessage,
  type ScanParameters,
} from '@whispertavern/core'
import {
  type ChatId,
  type Diagnostic,
  type PromptContribution,
  type PromptRole,
  type PromptZoneName,
  type Timestamp,
  type WorldbookPosition,
  WORLDBOOK_SLOT_BY_ST_POSITION,
} from '@whispertavern/contracts'
import { eq, inArray } from 'drizzle-orm'
import {
  chatWorldbooks,
  worldbookActivations,
  worldbookEntries,
  worldbookRuntimeEntries,
  worldbooks,
} from '../db/schema'
import type { WhisperTavernDb } from '../db/database'
import { uuidv7 } from '../util/id'

/**
 * chat↔worldbook 激活接线(WP1.2 Activation Engine 有状态化;compiler-spec §23–§29)。
 *
 * 纯激活层(P1,R-P1-1):本模块只把"已绑定世界书的条目"经 activateWorldbook 算出激活集,
 * 转成 freshWB / injection 贡献,并把运行时态(sticky/cooldown/delay)与审计落库。
 * 缓存分区毕业/退休(stableWB/injection 物理序)归 P2 Cache Engine,本模块不碰。
 *
 * 设计边界:
 * - 激活判定是 core 的纯函数(activateWorldbook,注入 rng/seq 可复现);本模块只负责
 *   DB 读(绑定/条目/运行时态)、构造输入、写回结果。无新增抽象层(纪律 5)。
 * - matchScope auxiliary(personaDescription/charDescription…)留空:P1 不在 startRun
 *   拉取 character/persona 文本喂入,激活域退化为 Recent Messages(§23.1 默认域)。
 *   该域文本补齐归 S12/S13 资产注入时机。
 * - 条目 placement.depth 在 S10 落库时被折叠进 position 整数,DB 未单列 depth 列;
 *   'depth' 槽位退化为按 order 注入(placement 精修归 P2)。
 */

const VALID_ROLES = new Set<PromptRole>(['system', 'user', 'assistant', 'tool'])

export interface BuildWorldbookInput {
  store: WhisperTavernDb
  chatId: ChatId
  /** 本轮轮序(单调);sticky/cooldown/delay 以轮序判定(§27/§28),非 wall-clock */
  sequence: number
  /** Recent Messages(调用方已按 active chain 截取);本模块按 scanDepth 再截尾段 */
  messages: readonly ScanMessage[]
  runId: string
  now: Timestamp
  /** 概率掷骰注入(测试可固定 rng 保证可复现);缺省 Math.random */
  rng?: () => number
}

export interface BuildWorldbookResult {
  contributions: PromptContribution[]
  diagnostics: readonly Diagnostic[]
}

/** 注入型槽位(AN/depth)不参与 freshWB 分区,按作者本意进 injection 区(technical-plan §5.3) */
function slotToZone(position: WorldbookPosition): PromptZoneName {
  return position === 'anTop' || position === 'anBottom' || position === 'emTop' || position === 'emBottom' || position === 'depth'
    ? 'injection'
    : 'freshWB'
}

export function buildWorldbookContributions(input: BuildWorldbookInput): BuildWorldbookResult {
  const { store, chatId, sequence, messages, runId, now } = input
  const rng = input.rng ?? Math.random

  // —— 1. 加载 chat 绑定的 worldbook(§18 chat_worldbooks)——
  const bindings = store.db
    .select()
    .from(chatWorldbooks)
    .where(eq(chatWorldbooks.chatId, chatId))
    .orderBy(chatWorldbooks.orderIndex)
    .all()
  if (bindings.length === 0) return { contributions: [], diagnostics: [] }

  const worldbookIds = bindings.map((b) => b.worldbookId)
  const bookRows = store.db
    .select()
    .from(worldbooks)
    .where(inArray(worldbooks.id, worldbookIds))
    .all()
  const bookById = new Map(bookRows.map((b) => [b.id, b]))
  const bindingByBook = new Map(bindings.map((b) => [b.worldbookId, b]))

  // —— 2. 加载条目(worldbook_entries)——
  const entryRows = store.db
    .select()
    .from(worldbookEntries)
    .where(inArray(worldbookEntries.worldbookId, worldbookIds))
    .all()

  // —— 3. 加载既有运行时态(worldbook_runtime_entries)——
  const runtimeRows = store.db
    .select()
    .from(worldbookRuntimeEntries)
    .where(eq(worldbookRuntimeEntries.chatId, chatId))
    .all()
  const runtimeById = new Map(runtimeRows.map((r) => [r.worldbookEntryId, r]))

  // —— 4. 构造激活输入 ——
  const descriptors: ActivationDescriptor[] = []
  const scanByBook = new Map<string, ScanParameters>()
  for (const row of entryRows) {
    const slot = WORLDBOOK_SLOT_BY_ST_POSITION[row.position] ?? 'before'
    descriptors.push({
      id: row.id,
      enabled: row.enabled,
      mode: (row.activationMode as ActivationDescriptor['mode']) ?? 'selective',
      keys: parseJsonArray(row.keywordsPrimary),
      secondaryKeys: parseJsonArray(row.keywordsSecondary),
      logic: (row.keywordLogic as ActivationDescriptor['logic']) ?? 'andAny',
      chance: row.probability,
      matchScope: parseJsonArray(row.matchScope),
      scanDepthOverride: row.scanDepth,
      caseSensitiveOverride: row.caseSensitive,
      wholeWordOverride: row.wholeWord,
      stickyRounds: row.stickyRounds,
      cooldown: row.cooldown,
      delay: row.delay,
      recursion: {
        excluded: row.excludeRecursion,
        prevent: row.preventRecursion,
        delayedUntil: row.delayUntilRecursion,
      },
      group: {
        id: row.groupId,
        override: row.groupOverride,
        weight: row.groupWeight ?? 100,
        scoring: row.useGroupScoring,
      },
      triggers: parseJsonArray(row.triggers),
      characterFilter: safeParse(row.characterFilter),
      slot,
      order: row.insertionOrder,
    })
  }
  for (const bookId of worldbookIds) {
    const book = bookById.get(bookId)
    const binding = bindingByBook.get(bookId)
    scanByBook.set(bookId, {
      scanDepth: binding?.scanDepthOverride ?? book?.scanDepth ?? null,
      caseSensitive: null,
      wholeWord: null,
      recursive: binding?.recursiveOverride ?? book?.recursive ?? false,
    })
  }

  // 全局扫描窗口必须是所有绑定的超集,否则 depth 大的书会漏掉旧消息里的关键词——
  // 故取绑定中的最大值(scanDepth 越大扫得越宽)。递归任一为真即递归。
  const globalScan: ScanParameters = {
    scanDepth: maxDefined([...scanByBook.values()].map((s) => s.scanDepth)),
    caseSensitive: null,
    wholeWord: null,
    recursive: [...scanByBook.values()].some((s) => s.recursive),
  }
  const scanDepth = globalScan.scanDepth
  // scanDepth===0 在 ST 语义下表示"不限制/扫全部"(与 null 同义);仅正整数才按窗口切片。
  const scanMessages =
    scanDepth !== null && scanDepth > 0 ? messages.slice(Math.max(0, messages.length - scanDepth)) : messages

  const runtimeState: Record<string, ActivationRuntimeState> = {}
  for (const r of runtimeRows) {
    runtimeState[r.worldbookEntryId] = {
      stickyUntilSeq: r.stickyUntilSeq,
      cooldownUntilSeq: r.cooldownUntilSeq,
      delayUntilSeq: r.delayUntilSeq,
    }
  }

  const context: ScanContext = { sequence, messages: scanMessages, auxiliary: {}, character: undefined }

  // —— 5. 激活(纯函数)——
  const { decisions, diagnostics } = activateWorldbook({
    entries: descriptors,
    runtimeState,
    scan: globalScan,
    context,
    rng,
  })

  // —— 6. 激活条目 → 贡献 + 落库 ——
  const contributions: PromptContribution[] = []
  for (const row of entryRows) {
    const decision = decisions[row.id]!
    const slot = WORLDBOOK_SLOT_BY_ST_POSITION[row.position] ?? 'before'

    if (decision.activated) {
      const role = VALID_ROLES.has(row.role as PromptRole) ? (row.role as PromptRole) : 'system'
      contributions.push({
        id: `worldbook:${row.id}`,
        source: { type: 'worldbook', worldbookId: row.worldbookId, entryId: row.id },
        segment: { role, content: row.content, zone: slotToZone(slot) },
        priority: 0,
        semanticPlacement: { type: 'worldbook', position: slot, order: row.insertionOrder },
      })
    }

    persistRuntimeEntry({
      store,
      chatId,
      entryId: row.id,
      decision,
      existing: runtimeById.get(row.id),
      sequence,
      now,
    })
    store.db
      .insert(worldbookActivations)
      .values({
        id: uuidv7(),
        chatId,
        runId,
        worldbookEntryId: row.id,
        activated: decision.activated,
        reason: decision.reason,
        matchedKeywords: JSON.stringify(decision.matchedKeywords),
        sourceMessageIds: JSON.stringify(decision.sourceMessageIds),
        score: decision.score,
        activationSeq: sequence,
        createdAt: now,
      })
      .run()
  }

  return { contributions, diagnostics }
}

interface PersistInput {
  store: WhisperTavernDb
  chatId: ChatId
  entryId: string
  decision: ReturnType<typeof activateWorldbook>['decisions'][string]
  existing?: typeof worldbookRuntimeEntries.$inferSelect
  sequence: number
  now: Timestamp
}

function persistRuntimeEntry(input: PersistInput): void {
  const { store, chatId, entryId, decision, existing, sequence, now } = input
  const delta = decision.stateDelta
  const stickyUntilSeq = delta.stickyUntilSeq === undefined ? existing?.stickyUntilSeq ?? null : delta.stickyUntilSeq
  const cooldownUntilSeq = delta.cooldownUntilSeq === undefined ? existing?.cooldownUntilSeq ?? null : delta.cooldownUntilSeq
  const delayUntilSeq = delta.delayUntilSeq === undefined ? existing?.delayUntilSeq ?? null : delta.delayUntilSeq
  const rowId = `${chatId}:${entryId}`
  const wasActivated = existing?.activationCount ?? 0

  store.db
    .insert(worldbookRuntimeEntries)
    .values({
      id: rowId,
      chatId,
      worldbookEntryId: entryId,
      cacheState: 'unseen',
      lastActivatedAt: decision.activated ? now : existing?.lastActivatedAt,
      lastActivationSeq: decision.activated ? sequence : existing?.lastActivationSeq,
      stickyUntilSeq,
      cooldownUntilSeq,
      delayUntilSeq,
      activationCount: wasActivated + (decision.activated ? 1 : 0),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [worldbookRuntimeEntries.chatId, worldbookRuntimeEntries.worldbookEntryId],
      set: {
        lastActivatedAt: decision.activated ? now : existing?.lastActivatedAt,
        lastActivationSeq: decision.activated ? sequence : existing?.lastActivationSeq,
        stickyUntilSeq,
        cooldownUntilSeq,
        delayUntilSeq,
        activationCount: wasActivated + (decision.activated ? 1 : 0),
        updatedAt: now,
      },
    })
    .run()
}

function parseJsonArray(value: string | null): string[] {
  if (value === null) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function safeParse(value: string | null): unknown {
  if (value === null) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function maxDefined(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null && v !== undefined)
  return defined.length === 0 ? null : Math.max(...defined)
}
