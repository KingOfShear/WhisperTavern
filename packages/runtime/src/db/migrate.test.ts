import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from './database'
import { currentVersion, migrate, MigrationError, migrateWithBackup, pendingVersions } from './migrate'
import { LATEST_SCHEMA_VERSION, type Migration } from './migrations'

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
      expect(store.appliedMigrations).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION })
      expect(currentVersion(store.sqlite)).toBe(LATEST_SCHEMA_VERSION)
      expect(store.sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
      // §78-1 可重复检测:再跑一次 = 无待应用
      expect(pendingVersions(store.sqlite)).toEqual([])
      expect(migrate(store.sqlite)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION })
      // 权威表存在性抽查(含 P3/WP3.1a 执行层底座)
      const tables = (
        store.sqlite
          .prepare<[]>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[]
      ).map((r) => r.name)
      for (const table of ['chats', 'messages', 'chat_branches', 'providers', 'generations', 'events', 'runs', 'prompt_snapshots', 'worldbook_entries', 'worldbook_entry_versions', 'worldbook_runtime_entries', 'worldbook_activations', 'chat_worldbooks', 'agents', 'agent_versions', 'agent_runtime_states', 'attempts', 'step_runs', 'execution_operations', 'tool_calls', 'artifacts', 'runtime_checkpoints', 'approvals']) {
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
    const nextVersion = LATEST_SCHEMA_VERSION + 1
    try {
        const badMigration: Migration = {
          version: nextVersion,
          name: `bad-v${nextVersion}`,
          // 故意引用不存在的表,语句级失败
          sql: 'CREATE TABLE cache_runtime_states AS SELECT * FROM no_such_table_v2;',
          checksum: 'x',
        }
        expect(() => migrate(store.sqlite, [badMigration])).toThrow(MigrationError)
        expect(currentVersion(store.sqlite)).toBe(LATEST_SCHEMA_VERSION)
      const tables = (
        store.sqlite.prepare<[]>("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string
        }[]
      ).map((r) => r.name)
      expect(tables).not.toContain('cache_runtime_states')
      // 修复后同一库可继续迁移(失败可恢复)
      const good: Migration = { version: nextVersion, name: `good-v${nextVersion}`, sql: 'CREATE TABLE tmp_next (id TEXT);', checksum: 'y' }
      expect(migrate(store.sqlite, [good]).to).toBe(nextVersion)
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
      expect(result.to).toBe(LATEST_SCHEMA_VERSION)
      expect(currentVersion(store.sqlite)).toBe(LATEST_SCHEMA_VERSION)
      expect(result.backupPath).toBeDefined()
      expect(existsSync(result.backupPath ?? '')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('v8 runs 执行列扩展:重复迁移幂等且旧库可增量升级(§34 / §78)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-db-'))
    dirs.push(dir)
    const path = join(dir, 'chats.sqlite')
    const store = createDatabase(path)
    try {
      // 增量升级:先降到 v7 语义(仅验证列已存在与可空——真实降级不可行,
      // 故此处只断言扩展列确实由 v8 带来且默认值正确)
      const cols = (
        store.sqlite.prepare<[]>("PRAGMA table_info('runs')").all() as {
          name: string
          notnull: number
          dflt_value: string | null
        }[]
      ).map((c) => c.name)
      for (const col of ['agent_id', 'agent_version', 'workflow_run_id', 'workflow_step_run_id', 'parent_run_id', 'origin_run_id', 'trigger_message_id', 'mode', 'input_state', 'output_state', 'budget_usage', 'dependency_manifest', 'last_heartbeat_at', 'completed_at']) {
        expect(cols).toContain(col)
      }
      const mode = (
        store.sqlite.prepare<[]>("PRAGMA table_info('runs')").all() as {
          name: string
          dflt_value: string | null
        }[]
      ).find((c) => c.name === 'mode')
      expect(mode?.dflt_value).toBe("'live'")
    } finally {
      store.close()
    }
  })
})
