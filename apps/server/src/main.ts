// WhisperTavern server 引导(S7):真实监听入口——数据目录、迁移、密钥库、SSE 总线。
// 开发:npx tsx src/main.ts(或 pnpm --filter @whispertavern/server dev);端口 DG_PORT(缺省 8787)。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import {
  createDatabase,
  createSecretStore,
  EventBus,
  createSqliteEventSink,
  SnapshotRegistry,
} from '@whispertavern/runtime'
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

/**
 * S32(WP4.3)网络搜索后端配置:端点 + 可选凭据。
 *
 * **未配置 DG_WEB_SEARCH_ENDPOINT 时工具会 fail-closed**(执行确定性失败)。
 * 刻意不在引导层"没配就不注册":注册面必须与部署环境无关(见 ServerDeps.webSearch 注)。
 */
const webSearchEndpoint = process.env.DG_WEB_SEARCH_ENDPOINT
const webSearchApiKey = process.env.DG_WEB_SEARCH_API_KEY

const { app } = createApp({
  store,
  bus,
  snapshots: new SnapshotRegistry(),
  secretStore,
  secretsDir,
  assetsDir: dataDir,
  logger,
  webSearch: {
    ...(webSearchEndpoint === undefined || webSearchEndpoint === '' ? {} : { endpoint: webSearchEndpoint }),
    ...(webSearchApiKey === undefined || webSearchApiKey === '' ? {} : { apiKey: webSearchApiKey }),
  },
})

const port = Number.parseInt(process.env.DG_PORT ?? '8787', 10)
serve({ fetch: app.fetch, port }, (info) => {
  logger('info', `WhisperTavern server listening on http://localhost:${info.port}`)
})
