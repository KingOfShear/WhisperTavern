// DesireGrimoire server 引导(S7):真实监听入口——数据目录、迁移、密钥库、SSE 总线。
// 开发:npx tsx src/main.ts(或 pnpm --filter @desiregrimoire/server dev);端口 DG_PORT(缺省 8787)。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import {
  createDatabase,
  createSecretStore,
  EventBus,
  createSqliteEventSink,
  SnapshotRegistry,
} from '@desiregrimoire/runtime'
import { createApp } from './server'

const dataDir = process.env.DG_DATA_DIR ?? join(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })
const secretsDir = join(dataDir, 'secrets')

const store = createDatabase(join(dataDir, 'chats.sqlite'))
const secretStore = createSecretStore(secretsDir)
const bus = new EventBus(createSqliteEventSink(store))

const logger = (level: 'error' | 'info', message: string, meta?: unknown): void => {
  if (level === 'error') console.error(`[server] ${message}`, meta ?? '')
  else console.info(`[server] ${message}`, meta ?? '')
}

const { app } = createApp({ store, bus, snapshots: new SnapshotRegistry(), secretStore, secretsDir, logger })

const port = Number.parseInt(process.env.DG_PORT ?? '8787', 10)
serve({ fetch: app.fetch, port }, (info) => {
  logger('info', `DesireGrimoire server listening on http://localhost:${info.port}`)
})
