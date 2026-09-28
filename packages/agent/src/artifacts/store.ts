/**
 * Artifact 主数据结构与冻结语义(agent-runtime-spec §71/§72 + compiler-spec §87,S26/WP3.4)。
 *
 * 三条铁律:
 * 1. **冻结 = 显式 API,绝不自动**(§72 "frozen = true 表示内容不会继续变化"——
 *    自动冻结等于替用户说"这内容定了",违反 compiler-spec §87 冻结/提升=显式确认)。
 * 2. **冻结产物一律 injection / tail,不进稳定前缀**(§72 裁决 C2:原文"提升到更稳定的
 *    Context Zone"已否决——在稳定前缀插入内容使其后全部字节位移 = 一次未声明的
 *    Cache Break;与 prompt-compiler-spec §83 @D 不能进稳定前缀同构)。本模块把这条
 *    钉在 `artifactContributions` 的 zone 映射上:frozen → `injection`,working → `tail`。
 * 3. `promoteFrozenArtifacts`(§22)只影响**引用形态**(贡献是否携带全文 vs 引用占位),
 *    不改变 zone——C2 的"ArtifactRef 引用而非复制全文"是 Compiler 侧优化,P3 落
 *    全文 + 挂账(compiler ArtifactRef 物化归 Compiler 会话)。
 */
import { eq } from 'drizzle-orm'
import type { PromptContribution, Timestamp } from '@whispertavern/contracts'
import {
  artifacts as artifactsTable,
  sha256Hex,
  uuidv7,
  type EventBus,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import type { ArtifactPolicy } from '../context/policy'

/** §71 Artifact(spec 形状逐字收编;frozen/冻结时间落 metadata JSON) */
export interface Artifact {
  id: string
  type: string
  name?: string
  content?: string
  data?: unknown
  contentHash?: string
  sourceRunId?: string
  createdAt: string
  frozen: boolean
  chatId?: string
}

export interface CreateArtifactInput {
  chatId?: string
  runId?: string
  type: string
  name?: string
  content?: string
  data?: unknown
  now: Timestamp
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(`ARTIFACT_ERROR: ${message}`)
    this.name = 'ArtifactError'
  }
}

interface ArtifactRow {
  id: string
  chatId: string | null
  runId: string | null
  type: string
  name: string | null
  content: string | null
  data: string | null
  contentHash: string | null
  frozen: boolean
  metadata: string
  createdAt: string
}

function rowToArtifact(row: ArtifactRow): Artifact {
  const metadata = JSON.parse(row.metadata) as { frozenAt?: string }
  return {
    id: row.id,
    type: row.type,
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.content !== null ? { content: row.content } : {}),
    ...(row.data !== null ? { data: JSON.parse(row.data) } : {}),
    ...(row.contentHash !== null ? { contentHash: row.contentHash } : {}),
    ...(row.runId !== null ? { sourceRunId: row.runId } : {}),
    createdAt: row.createdAt,
    frozen: row.frozen,
    ...(row.chatId !== null ? { chatId: row.chatId } : {}),
    ...(metadata.frozenAt !== undefined ? { frozenAt: metadata.frozenAt } : {}),
  } as Artifact & { frozenAt?: string }
}

/** 建 Artifact:contentHash = 内容 SHA-256(§71 contentHash 字段;frozen 恒 false) */
export function createArtifact(
  store: WhisperTavernDb,
  bus: EventBus,
  input: CreateArtifactInput,
): Artifact {
  const id = uuidv7()
  const contentHash = input.content !== undefined ? sha256Hex(input.content) : undefined
  store.db
    .insert(artifactsTable)
    .values({
      id,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      type: input.type,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.data !== undefined ? { data: JSON.stringify(input.data) } : {}),
      ...(contentHash !== undefined ? { contentHash } : {}),
      frozen: false,
      metadata: '{}',
      createdAt: input.now,
    })
    .run()
  bus.publish({
    type: 'artifact.created',
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    aggregateType: 'artifact',
    aggregateId: id,
    timestamp: input.now,
    payload: { artifactId: id, type: input.type, contentHash },
  })
  return loadArtifact(store, id)
}

/** §72 冻结:显式 API。已冻结再冻结 = 幂等成功;内容从此不可变(更新直接拒) */
export function freezeArtifact(store: WhisperTavernDb, bus: EventBus, artifactId: string, now: Timestamp): Artifact {
  const row = mustLoad(store, artifactId)
  if (!row.frozen) {
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>
    store.db
      .update(artifactsTable)
      .set({ frozen: true, metadata: JSON.stringify({ ...metadata, frozenAt: now }) })
      .where(eq(artifactsTable.id, artifactId))
      .run()
    bus.publish({
      type: 'artifact.updated',
      aggregateType: 'artifact',
      aggregateId: artifactId,
      timestamp: now,
      payload: { artifactId, change: 'frozen' },
    })
  }
  return loadArtifact(store, artifactId)
}

/** 更新内容:冻结后禁止(§72 "内容不会继续变化"是硬承诺) */
export function updateArtifactContent(
  store: WhisperTavernDb,
  bus: EventBus,
  artifactId: string,
  content: string,
  now: Timestamp,
): Artifact {
  const row = mustLoad(store, artifactId)
  if (row.frozen) throw new ArtifactError(`Artifact ${artifactId} 已冻结,内容不可变(§72)`)
  const contentHash = sha256Hex(content)
  store.db
    .update(artifactsTable)
    .set({ content, contentHash })
    .where(eq(artifactsTable.id, artifactId))
    .run()
  bus.publish({
    type: 'artifact.updated',
    aggregateType: 'artifact',
    aggregateId: artifactId,
    timestamp: now,
    payload: { artifactId, change: 'content', contentHash },
  })
  return loadArtifact(store, artifactId)
}

export function loadArtifact(store: WhisperTavernDb, artifactId: string): Artifact {
  return rowToArtifact(mustLoad(store, artifactId))
}

export function listChatArtifacts(store: WhisperTavernDb, chatId: string): Artifact[] {
  const rows = store.db.select().from(artifactsTable).where(eq(artifactsTable.chatId, chatId)).all() as unknown as ArtifactRow[]
  return rows.map(rowToArtifact)
}

function mustLoad(store: WhisperTavernDb, artifactId: string): ArtifactRow {
  const row = store.db.select().from(artifactsTable).where(eq(artifactsTable.id, artifactId)).get() as ArtifactRow | undefined
  if (row === undefined) throw new ArtifactError(`Artifact 不存在: ${artifactId}`)
  return row
}

/**
 * §22 ArtifactPolicy + §72 C2:Artifact → PromptContribution 投影。
 *
 * - **frozen → zone 'injection'**(C2:冻结产物一律 injection/tail,不进稳定前缀;
 *   "提升到 stable zone"已被否决,见模块头铁律 2);
 * - working → zone 'tail'(§72 "默认进入 tail");
 * - `promoteFrozenArtifacts=true` 时 frozen 产物携带全文(P3 形态;ArtifactRef 引用
 *   物化归 Compiler,挂账);`allowedTypes` 白名单在此执行(贡献上可见类型)。
 */
export function artifactContributions(
  artifacts: readonly Artifact[],
  policy: ArtifactPolicy,
): { contributions: PromptContribution[]; skipped: { id: string; reason: string }[] } {
  if (!policy.enabled) return { contributions: [], skipped: artifacts.map((a) => ({ id: a.id, reason: 'artifacts.enabled=false' })) }
  const skipped: { id: string; reason: string }[] = []
  const selected = artifacts.filter((a) => {
    if (policy.allowedTypes !== undefined && !policy.allowedTypes.includes(a.type)) {
      skipped.push({ id: a.id, reason: `type ${a.type} 不在 allowedTypes 白名单` })
      return false
    }
    return true
  })
  const capped = policy.maxItems !== undefined ? selected.slice(0, policy.maxItems) : selected
  for (const a of selected.slice(policy.maxItems ?? selected.length)) {
    skipped.push({ id: a.id, reason: 'maxItems 裁决' })
  }
  const contributions = capped.map(
    (a): PromptContribution => ({
      id: `artifact:${a.id}`,
      source: { type: 'artifact', artifactId: a.id, ...(a.sourceRunId !== undefined ? { runId: a.sourceRunId } : {}) },
      segment: {
        role: 'user',
        // C2:frozen 一律 injection(tail 也可,这里取更早的 injection);working → tail。
        // **永不 zone 'header' / 'history'**——那是稳定前缀,插入即未声明 Cache Break。
        content: a.content ?? JSON.stringify(a.data ?? ''),
        zone: a.frozen ? 'injection' : 'tail',
      },
      priority: 0,
      semanticPlacement: a.frozen ? { type: 'injection', depth: 0, order: 0 } : { type: 'tail', order: 0 },
    }),
  )
  void policy.promoteFrozenArtifacts // P3 全文形态;引用物化归 Compiler(挂账)
  return { contributions, skipped }
}
