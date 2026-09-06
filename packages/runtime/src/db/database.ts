import BetterSqlite3 from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { migrate } from './migrate'

/**
 * 数据库入口(S5):打开 SQLite(唯一目标库,总设计 §6)+ Drizzle + 自动迁移。
 * 开发期 auto-migrate = true;打包分发后由 S6 server 启动流程走 migrateWithBackup。
 */

export type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface WhisperTavernDb {
  /** 原生句柄(事务/pragma 用) */
  sqlite: BetterSqlite3.Database
  /** Drizzle 查询层 */
  db: DrizzleDb
  appliedMigrations: { from: number; to: number }
  close(): void
}

export function createDatabase(path: string, options: { autoMigrate?: boolean } = {}): WhisperTavernDb {
  const sqlite = new BetterSqlite3(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  const appliedMigrations = options.autoMigrate === false ? { from: 0, to: 0 } : migrate(sqlite)
  return {
    sqlite,
    db,
    appliedMigrations,
    close: () => {
      sqlite.close()
    },
  }
}

export { schema }
