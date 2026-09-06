import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDatabase,
  createSecretStore,
  createSqliteEventSink,
  EventBus,
  SnapshotRegistry,
  type WhisperTavernDb,
} from '@whispertavern/runtime'
import { createApp, type CreatedApp } from './server'

/**
 * server 测试共享 harness(e2e / import 契约测试):同一临时根目录上可**多次重开**
 * 同一库文件(重启恢复测试的关键能力);afterEach 统一清理。
 */

const dirs: string[] = []
const opened: WhisperTavernDb[] = []

export interface E2eHarness {
  root: string
  dbPath: string
  assetsDir: string
  open: () => CreatedApp & { store: WhisperTavernDb }
}

export function makeE2eHarness(): E2eHarness {
  const root = mkdtempSync(join(tmpdir(), 'dg-e2e-'))
  dirs.push(root)
  const dbPath = join(root, 'chats.sqlite')
  const open = (): CreatedApp & { store: WhisperTavernDb } => {
    const store = createDatabase(dbPath)
    opened.push(store)
    const bus = new EventBus(createSqliteEventSink(store))
    const created = createApp({
      store,
      bus,
      snapshots: new SnapshotRegistry(),
      secretStore: createSecretStore(join(root, 'secrets')),
      secretsDir: join(root, 'secrets'),
      assetsDir: root,
    })
    return { ...created, store }
  }
  return { root, dbPath, assetsDir: root, open }
}

export function cleanupHarnesses(): void {
  for (const store of opened.splice(0)) {
    try {
      store.close()
    } catch {
      // 已关闭
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄延迟释放:目录留待系统清理,不影响断言
    }
  }
}
