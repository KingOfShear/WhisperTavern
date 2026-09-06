import { copyFileSync, existsSync } from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS, type Migration } from './migrations'
import { sha256Hex } from '../util/id'

/**
 * 迁移执行器 —— database-schema §77/§78 + implementation-plan WP0.6:
 * 开发期自动应用;用户侧流程 = 检测版本 → 备份 → 迁移(原子)→ integrity check
 * → 失败回滚并**阻止启动**。
 */

export class MigrationError extends Error {
  constructor(message: string) {
    super(`MIGRATION_FAILED: ${message}`)
    this.name = 'MigrationError'
  }
}

/** 当前已应用版本;未初始化的库 = 0(§77:不能假设已是最新 schema) */
export function currentVersion(db: BetterSqlite3.Database): number {
  const row = db
    .prepare<[string]>('SELECT value FROM schema_metadata WHERE key = ?')
    .get('schema_version') as { value: string } | undefined
  return row === undefined ? 0 : Number.parseInt(row.value, 10)
}

/**
 * 应用全部待迁移。每个迁移独立事务(§78 原子执行);失败 ROLLBACK 后抛出,
 * 由调用方阻止启动。应用后执行 PRAGMA integrity_check(必须 'ok')。
 */
export function migrate(
  db: BetterSqlite3.Database,
  extra: readonly Migration[] = [],
): { from: number; to: number } {
  ensureMigrationTables(db)
  verifyAppliedChecksums(db)

  const from = currentVersion(db)
  const pending = [...MIGRATIONS, ...extra].filter((m) => m.version > from)

  for (const migration of pending) {
    applyOne(db, migration)
  }

  const to = currentVersion(db)
  const integrity = (db.pragma('integrity_check', { simple: true }) as string | undefined) ?? 'unknown'
  if (integrity !== 'ok') {
    throw new MigrationError(`迁移后 integrity_check 未通过: ${integrity}`)
  }
  return { from, to }
}

/**
 * 用户侧迁移入口:迁移前自动备份文件(§78 失败可恢复;data/.gitignore 已排除 *.bak)。
 * 内存库(:memory:)无文件可备份,跳过。
 */
export function migrateWithBackup(
  db: BetterSqlite3.Database,
  dbPath: string,
  extra: readonly Migration[] = [],
): { from: number; to: number; backupPath?: string } {
  let backupPath: string | undefined
  const pending = pendingVersions(db)
  if (dbPath !== ':memory:' && pending.length > 0 && existsSync(dbPath)) {
    backupPath = `${dbPath}.pre-migration.bak`
    copyFileSync(dbPath, backupPath)
  }
  const result = migrate(db, extra)
  return { ...result, backupPath }
}

export function pendingVersions(db: BetterSqlite3.Database): readonly number[] {
  ensureMigrationTables(db)
  const from = currentVersion(db)
  return [...MIGRATIONS].filter((m) => m.version > from).map((m) => m.version)
}

function ensureMigrationTables(db: BetterSqlite3.Database): void {
  // 引导表先行(§77/§78 自身机制;不在版本化迁移内,保证迁移器可运行)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
        key     TEXT PRIMARY KEY,
        value   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  TEXT NOT NULL
    );
  `)
}

/** 可重复检测(§78-1):已应用迁移的 checksum 与当前源不一致 = 库与代码漂移,阻止启动 */
function verifyAppliedChecksums(db: BetterSqlite3.Database): void {
  const rows = db
    .prepare<[]>('SELECT version, name, checksum FROM migrations ORDER BY version')
    .all() as { version: number; name: string; checksum: string }[]
  for (const row of rows) {
    const source = MIGRATIONS.find((m) => m.version === row.version)
    if (source === undefined) {
      throw new MigrationError(`migrations 表含未知版本 ${row.version}(代码回退?阻止启动)`)
    }
    if (source.checksum !== row.checksum) {
      throw new MigrationError(`迁移 ${row.version}(${row.name})checksum 不匹配:库已漂移`)
    }
    // 防御:源文件 checksum 字段与实际 SQL 自洽(防止手改 SQL 忘更 checksum)
    if (sha256Hex(source.sql) !== source.checksum) {
      throw new MigrationError(`迁移 ${row.version} 源 checksum 与 SQL 不一致(开发错误)`)
    }
  }
}

function applyOne(db: BetterSqlite3.Database, migration: Migration): void {
  const apply = db.transaction(() => {
    db.exec(migration.sql)
    db.prepare('INSERT INTO migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
      migration.version,
      migration.name,
      migration.checksum,
      new Date().toISOString(),
    )
    upsertSchemaVersion(db, migration.version)
  })
  try {
    apply()
  } catch (error) {
    // §78-4:事务已回滚;显式包装并上抛,调用方(应用启动)必须中止
    throw new MigrationError(`迁移 ${migration.version}(${migration.name})失败已回滚: ${String(error)}`)
  }
}

function upsertSchemaVersion(db: BetterSqlite3.Database, version: number): void {
  db.prepare(
    'INSERT INTO schema_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', String(version))
}
