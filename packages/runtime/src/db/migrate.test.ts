import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from './database'
import { currentVersion, migrate, MigrationError, migrateWithBackup, pendingVersions } from './migrate'
import type { Migration } from './migrations'

const dirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dg-db-'))
  dirs.push(dir)
  return join(dir, 'chats.sqlite')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('迁移器(database-schema §77/§78)', () => {
  it('全新库:开发期自动应用 → schema_version 到位、integrity ok、可重复执行为空', () => {
    const store = createDatabase(tempDbPath())
    try {
      expect(store.appliedMigrations).toEqual({ from: 0, to: 3 })
      expect(currentVersion(store.sqlite)).toBe(3)
      expect(store.sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
      // §78-1 可重复检测:再跑一次 = 无待应用
      expect(pendingVersions(store.sqlite)).toEqual([])
      expect(migrate(store.sqlite)).toEqual({ from: 3, to: 3 })
      // 权威表存在性抽查
      const tables = (
        store.sqlite
          .prepare<[]>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[]
      ).map((r) => r.name)
      for (const table of ['chats', 'messages', 'chat_branches', 'providers', 'generations', 'events', 'runs', 'prompt_snapshots']) {
        expect(tables).toContain(table)
      }
    } finally {
      store.close()
    }
  })

  it('checksum 校验:库中记录被篡改 → 阻止启动(§78-1/§78-5)', () => {
    const store = createDatabase(tempDbPath())
    try {
      store.sqlite
        .prepare("UPDATE migrations SET checksum = 'deadbeef' WHERE version = 1")
        .run()
      expect(() => migrate(store.sqlite)).toThrow(MigrationError)
    } finally {
      store.close()
    }
  })

  it('失败迁移:回滚后版本不变、无半成品表,错误阻止启动(§78-4)', () => {
    const store = createDatabase(tempDbPath())
    try {
      const badMigration: Migration = {
        version: 4,
        name: 'bad-v4',
        // 故意引用不存在的表,语句级失败
        sql: 'CREATE TABLE cache_runtime_states AS SELECT * FROM no_such_table_v2;',
        checksum: 'x',
      }
      expect(() => migrate(store.sqlite, [badMigration])).toThrow(MigrationError)
      expect(currentVersion(store.sqlite)).toBe(3)
      const tables = (
        store.sqlite.prepare<[]>("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string
        }[]
      ).map((r) => r.name)
      expect(tables).not.toContain('cache_runtime_states')
      // 修复后同一库可继续迁移(失败可恢复)
      const good: Migration = { version: 3, name: 'good-v4', sql: 'CREATE TABLE tmp_v4 (id TEXT);', checksum: 'y' }
      expect(migrate(store.sqlite, [good]).to).toBe(3)
    } finally {
      store.close()
    }
  })

  it('用户侧流程:迁移前自动备份 .pre-migration.bak(§78 失败可恢复)', () => {
    const path = tempDbPath()
    writeFileSync(path, '') // 空库文件 = 版本 0 的旧库
    const store = createDatabase(path, { autoMigrate: false })
    try {
      const result = migrateWithBackup(store.sqlite, path)
      expect(result.to).toBe(3)
      expect(currentVersion(store.sqlite)).toBe(3)
      expect(result.backupPath).toBeDefined()
      expect(existsSync(result.backupPath ?? '')).toBe(true)
    } finally {
      store.close()
    }
  })
})
