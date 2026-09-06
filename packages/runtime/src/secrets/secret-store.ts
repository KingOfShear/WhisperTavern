import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * SecretStore —— R-P0-6 定案(总设计 §38 决策 34):密钥明文永不落盘、永不入库。
 *
 * 双实现,createSecretStore 按平台/可用性选择:
 * - DpapiSecretStore(Windows 优先):DPAPI protect/unprotect(@primno/dpapi 可选
 *   依赖,未安装自动跳过),每条密钥一个受保护 blob 文件;
 * - EncryptedFileSecretStore(兜底):AES-256-GCM,master key 落 `<dir>/.master.key`
 *   (0600)。诚实边界:兜底方案防误分享/误提交(数据目录全 gitignore),**不防
 *   本机攻击者**;P5 Tauri 换 OS keychain 强绑定。
 *
 * providers 表只存 secretRef(`secret://<name>`,database-schema §37),响应永不回显。
 */

export interface SecretStore {
  set(name: string, secret: string): void
  get(name: string): string | undefined
  delete(name: string): boolean
  list(): string[]
}

export function createSecretStore(dir: string): SecretStore {
  mkdirSync(dir, { recursive: true })
  const dpapi = tryLoadDpapi()
  if (dpapi !== undefined) return new DpapiSecretStore(dir, dpapi)
  return new EncryptedFileSecretStore(dir)
}

// —— DPAPI(Windows,@primno/dpapi 可选依赖)——

interface DpapiBinding {
  protectSync(plaintext: Buffer): Buffer
  unprotectSync(ciphertext: Buffer): Buffer
}

function tryLoadDpapi(): DpapiBinding | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    // 可选依赖:未安装/加载失败 → 加密文件兜底(决策 34)
    const nodeRequire = createRequire(import.meta.url)
    const dpapi = nodeRequire('@primno/dpapi') as DpapiBinding
    return typeof dpapi.protectSync === 'function' ? dpapi : undefined
  } catch {
    return undefined
  }
}

class DpapiSecretStore implements SecretStore {
  constructor(
    private readonly dir: string,
    private readonly dpapi: DpapiBinding,
  ) {}

  set(name: string, secret: string): void {
    const blob = this.dpapi.protectSync(Buffer.from(secret, 'utf8'))
    writeFileSync(this.path(name), blob.toString('base64'))
    lockPermissions(this.path(name))
  }

  get(name: string): string | undefined {
    const path = this.path(name)
    if (!existsSync(path)) return undefined
    const blob = Buffer.from(readFileSync(path, 'utf8'), 'base64')
    return this.dpapi.unprotectSync(blob).toString('utf8')
  }

  delete(name: string): boolean {
    const path = this.path(name)
    if (!existsSync(path)) return false
    unlinkSync(path)
    return true
  }

  list(): string[] {
    return entriesIn(this.dir, '.dpapi')
  }

  private path(name: string): string {
    return join(this.dir, `${safeName(name)}.dpapi`)
  }
}

// —— 加密文件兜底(AES-256-GCM)——

class EncryptedFileSecretStore implements SecretStore {
  private readonly masterKey: Buffer

  constructor(private readonly dir: string) {
    this.masterKey = loadOrCreateMasterKey(dir)
  }

  set(name: string, secret: string): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv)
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    writeFileSync(this.path(name), JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: encrypted.toString('base64') }))
    lockPermissions(this.path(name))
  }

  get(name: string): string | undefined {
    const path = this.path(name)
    if (!existsSync(path)) return undefined
    const record = JSON.parse(readFileSync(path, 'utf8')) as { iv: string; tag: string; data: string }
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(record.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8')
  }

  delete(name: string): boolean {
    const path = this.path(name)
    if (!existsSync(path)) return false
    unlinkSync(path)
    return true
  }

  list(): string[] {
    return entriesIn(this.dir, '.enc')
  }

  private path(name: string): string {
    return join(this.dir, `${safeName(name)}.enc`)
  }
}

function loadOrCreateMasterKey(dir: string): Buffer {
  const keyPath = join(dir, '.master.key')
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, 'utf8'), 'hex')
  const key = randomBytes(32)
  writeFileSync(keyPath, key.toString('hex'))
  lockPermissions(keyPath)
  return key
}

function safeName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`VALIDATION_ERROR: secret 名称只允许 [A-Za-z0-9._-]: ${name}`)
  return name
}

function lockPermissions(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows chmod 语义有限;忽略
  }
}

function entriesIn(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length))
}
