import {
  activateWorldbook,
  expandWithAnalysis,
  seededRng,
  type ActivationDescriptor,
  type ActivationRuntimeState,
  type RuntimeVariables,
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
  chats,
  chatWorldbooks,
  worldbookActivations,
  worldbookEntries,
  worldbookRuntimeEntries,
  worldbooks,
} from '../db/schema'
import type { WhisperTavernDb } from '../db/database'
import { uuidv7 } from '../util/id'
import {
  computeContentHash,
  zoneWorldbook,
  type CacheRowView,
  type WorldbookZoning,
  type ZoningCandidate,
} from './worldbook-cache'

/**
 * chat↔worldbook 激活接线(WP1.2 Activation Engine 有状态化 + WP2.2 缓存分区)。
 *
 * P1 纯激活层:activateWorldbook 算出激活集;P2(S17)在激活之上接缓存分区——
 * 宏安全条目按 chatCache 分区进 stableWB/freshWB(§2.1),含 volatile 宏的条目
 * 跳过分区直接 freshWB(pipeline normal 档自然移 tail,R-P2-4)。运行时态
 * (sticky/cooldown/delay)与缓存字段(cacheState/physicalOrder/contentHash/firstSeenMsg)
 * 一起落库。
 *
 * 设计边界:
 * - 激活判定是 core 的纯函数;分区是 worldbook-cache.ts 纯函数层;本模块只做
 *   DB 读、宏展开(预检)、装配、写回。无新增抽象层(纪律 5)。
 * - "两处展开"不变量:参与分区判定的条目必先过 volatile 预检(宏均为 static/
 *   session,不消耗 rng、不依赖 now/message),故本模块算出的哈希对象与 pipeline
 *   展开逐字节一致(R-P2-3);预检诊断吞掉(避免与 pipeline 诊断重复)。
 * - matchScope auxiliary 留空:P1 不在 startRun 拉取 character/persona 文本喂入,
 *   激活域退化为 Recent Messages(§23.1 默认域)。
 */

const VALID_ROLES = new Set<PromptRole>(['system', 'user', 'assistant', 'tool'])

export type WorldbookMode = 'performance' | 'compatibility'

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
  /** S16 宏展开变量(volatile 预检与哈希计算用) */
  variables?: RuntimeVariables
  /** §11 双模式:缺省 'performance'(缓存优化);'compatibility' 回退酒馆语义 */
  mode?: WorldbookMode
}

export interface BuildWorldbookResult {
  contributions: PromptContribution[]
  diagnostics: readonly Diagnostic[]
  /** S17:分区中间产物(供 Inspector/S18 CachePlan 消费);未分区时 undefined */
  zoning?: WorldbookZoning
}

/** 注入型槽位(AN/depth/outlet)不参与 freshWB 分区,按作者本意进 injection 区(technical-plan §5.3) */
function slotToZone(position: WorldbookPosition): PromptZoneName {
  return position === 'anTop' || position === 'anBottom' || position === 'emTop' || position === 'emBottom' || position === 'depth' || position === 'outlet'
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

  // —— 6. 分区(S17 WP2.2):宏安全条目 → zoneWorldbook;injection 槽位照旧 ——
  const cacheRows: CacheRowView[] = runtimeRows.map((r) => ({
    entryId: r.worldbookEntryId,
    contentHash: r.contentHash,
    cacheState: (r.cacheState ?? 'unseen') as CacheRowView['cacheState'],
    physicalOrder: r.physicalOrder,
    lastActivationSeq: r.lastActivationSeq,
    firstSeenMsg: r.firstSeenMsg,
  }))
  const cacheById = new Map(cacheRows.map((r) => [r.entryId, r]))
  const mode = input.mode ?? 'performance'
  const macroContext =
    input.variables !== undefined
      ? {
          variables: input.variables,
          now: new Date(now),
          mode: 'preview' as const,
          // §45/§40 种子:now|chatId(与 pipeline 构造规则一致)
          rng: seededRng(`${now}|${chatId}`),
        }
      : undefined

  /** volatile 预检:宏稳定性 ∈ {static, session} 才参与分区(哈希对象 = pipeline 展开字节) */
  const analyzeForHash = (row: typeof worldbookEntries.$inferSelect): { content: string; safe: boolean } => {
    if (macroContext === undefined) return { content: row.content, safe: false }
    const { content, analysis } = expandWithAnalysis(row.content, macroContext)
    // 宏安全 = 最不稳宏不超过 session(static/session 不消耗 rng、不依赖 now/message,
    // 保证"两处展开"逐字节一致);volatile/request/message 级 → 跳过分区
    return { content, safe: analysis.stability === 'static' || analysis.stability === 'session' }
  }

  const candidates: ZoningCandidate[] = []
  const volatileDirect: PromptContribution[] = []
  for (const row of entryRows) {
    const decision = decisions[row.id]
    if (decision === undefined || !decision.activated) continue
    const slot = WORLDBOOK_SLOT_BY_ST_POSITION[row.position] ?? 'before'
    const role = VALID_ROLES.has(row.role as PromptRole) ? (row.role as PromptRole) : 'system'
    const isInjection = slotToZone(slot) === 'injection'

    // injection 槽位(@D/AN/outlet)不参与分区,按作者本意直接进 injection(§3.6)
    if (isInjection) {
      volatileDirect.push({
        id: `worldbook:${row.id}`,
        source: { type: 'worldbook', worldbookId: row.worldbookId, entryId: row.id },
        segment: { role, content: row.content, zone: 'injection' },
        priority: 0,
        semanticPlacement: { type: 'worldbook', position: slot, order: row.insertionOrder },
      })
      continue
    }

    const { content: rendered, safe } = analyzeForHash(row)
    if (!safe) {
      // volatile 宏条目:跳过分区,直接 freshWB(pipeline normal 档自然移 tail,R-P2-4);
      // 不写缓存字段(每轮重新激活判定)
      volatileDirect.push({
        id: `worldbook:${row.id}`,
        source: { type: 'worldbook', worldbookId: row.worldbookId, entryId: row.id },
        segment: { role, content: row.content, zone: 'freshWB' },
        priority: 0,
        semanticPlacement: { type: 'worldbook', position: slot, order: row.insertionOrder },
      })
      continue
    }
    candidates.push({
      entryId: row.id,
      contentHash: computeContentHash(rendered),
      activated: true,
      sequence,
      priority: row.priority ?? 0,
    })
  }

  // Compatibility Mode(§11/§30):跳过 chatCache 分区,缓存字段不动;失活 stable 即时移除
  const compatibilityDiagnostics: Diagnostic[] = []
  if (mode === 'compatibility') {
    for (const row of cacheRows) {
      if (row.cacheState !== 'fresh' && row.cacheState !== 'stable') continue
      const activated = candidates.some((c) => c.entryId === row.entryId)
      if (!activated) {
        compatibilityDiagnostics.push({
          level: 'info',
          code: 'WORLD_BOOK_DEACTIVATED',
          message: 'Compatibility 模式:stable 条目本轮未激活,即时移除(compiler-spec §30)',
          details: { entryId: row.entryId },
        })
      }
    }
  }

  const zoning =
    mode === 'performance' && macroContext !== undefined
      ? zoneWorldbook({
          candidates,
          cache: cacheById,
          retirement: readRetirementConfig(store, chatId),
        })
      : undefined

  // —— 7. 装配贡献 ——
  const contributions: PromptContribution[] = []
  const rowById = new Map(entryRows.map((r) => [r.id, r]))
  const pushZoned = (items: readonly { entryId: string; physicalOrder: number }[], zone: PromptZoneName): void => {
    for (const item of items) {
      const row = rowById.get(item.entryId)
      if (row === undefined) continue
      const slot = WORLDBOOK_SLOT_BY_ST_POSITION[row.position] ?? 'before'
      const role = VALID_ROLES.has(row.role as PromptRole) ? (row.role as PromptRole) : 'system'
      contributions.push({
        id: `worldbook:${row.id}`,
        source: { type: 'worldbook', worldbookId: row.worldbookId, entryId: row.id },
        segment: { role, content: row.content, zone },
        priority: 0,
        // 决策 C:稳定区排序键 = physicalOrder(append-only 字节原位);position 槽位保留
        semanticPlacement: { type: 'worldbook', position: slot, order: item.physicalOrder },
      })
    }
  }
  if (zoning !== undefined) {
    pushZoned(zoning.stableWB, 'stableWB')
    pushZoned(zoning.freshWB, 'freshWB')
  } else {
    // performance 但无宏上下文 / compatibility:激活条目直接发送(缓存字段不动)
    for (const c of candidates) {
      const row = rowById.get(c.entryId)
      if (row === undefined) continue
      const slot = WORLDBOOK_SLOT_BY_ST_POSITION[row.position] ?? 'before'
      const role = VALID_ROLES.has(row.role as PromptRole) ? (row.role as PromptRole) : 'system'
      contributions.push({
        id: `worldbook:${row.id}`,
        source: { type: 'worldbook', worldbookId: row.worldbookId, entryId: row.id },
        segment: { role, content: row.content, zone: 'freshWB' },
        priority: 0,
        semanticPlacement: { type: 'worldbook', position: slot, order: row.insertionOrder },
      })
    }
  }
  contributions.push(...volatileDirect)

  // —— 8. 落库:运行时态 + 缓存写回 ——
  const cacheDelta = zoning?.nextCache ?? []
  const cacheDeltaById = new Map(cacheDelta.map((r) => [r.entryId, r]))
  for (const row of entryRows) {
    const decision = decisions[row.id]
    if (decision === undefined) continue
    const existing = runtimeById.get(row.id)
    const cacheUpdate = cacheDeltaById.get(row.id)
    persistRuntimeEntry({
      store,
      chatId,
      entryId: row.id,
      decision,
      existing,
      sequence,
      now,
      // 缓存字段写回(仅分区时更新;compatibility/无宏上下文不动)
      cacheState: (cacheUpdate?.cacheState ?? (existing?.cacheState as CacheRowView['cacheState'] | undefined) ?? 'unseen'),
      contentHash: cacheUpdate?.contentHash ?? existing?.contentHash ?? null,
      physicalOrder: cacheUpdate?.physicalOrder ?? existing?.physicalOrder ?? null,
      firstSeenMsg: cacheUpdate?.firstSeenMsg ?? existing?.firstSeenMsg ?? null,
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

  return {
    contributions,
    diagnostics: [...diagnostics, ...compatibilityDiagnostics],
    ...(zoning !== undefined ? { zoning } : {}),
  }
}

/** 读 chats.runtime_state.worldbookRetirement 配置(缺省关闭,§7/§31) */
function readRetirementConfig(store: WhisperTavernDb, chatId: ChatId): { enabled: boolean; inactiveRoundsThreshold: number; priorityThreshold: number } {
  const row = store.db.select().from(chats).where(eq(chats.id, chatId)).get()
  if (row === undefined) return { enabled: false, inactiveRoundsThreshold: 10, priorityThreshold: 0 }
  const state = safeParse(row.runtimeState) as { worldbookRetirement?: { enabled?: boolean; inactiveRoundsThreshold?: number; priorityThreshold?: number } }
  const cfg = state.worldbookRetirement
  return {
    enabled: cfg?.enabled ?? false,
    inactiveRoundsThreshold: cfg?.inactiveRoundsThreshold ?? 10,
    priorityThreshold: cfg?.priorityThreshold ?? 0,
  }
}

interface PersistInput {
  store: WhisperTavernDb
  chatId: ChatId
  entryId: string
  decision: ReturnType<typeof activateWorldbook>['decisions'][string]
  existing?: typeof worldbookRuntimeEntries.$inferSelect
  sequence: number
  now: Timestamp
  /** WP2.2 缓存字段(分区写回;未分区时取既有值保持不动) */
  cacheState: CacheRowView['cacheState']
  contentHash: string | null
  physicalOrder: number | null
  firstSeenMsg: number | null
}

function persistRuntimeEntry(input: PersistInput): void {
  const { store, chatId, entryId, decision, existing, sequence, now, cacheState, contentHash, physicalOrder, firstSeenMsg } = input
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
      cacheState,
      physicalOrder,
      contentHash,
      firstSeenMsg,
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
        cacheState,
        physicalOrder,
        contentHash,
        firstSeenMsg,
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
