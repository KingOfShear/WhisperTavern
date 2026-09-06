import { createHash, randomBytes } from 'node:crypto'

/**
 * UUIDv7(database-schema §3:全局唯一、时间有序、适合索引、离线可创建)。
 * 运行态在本地进程生成,不依赖数据库自增。
 */
export function uuidv7(now: Date = new Date()): string {
  const ts = now.getTime()
  const bytes = randomBytes(16)
  // 48bit ms 时间戳 + ver7 + rand_a(12bit) + variant + rand_b(62bit),RFC 9562
  bytes[0] = (ts / 2 ** 40) & 0xff
  bytes[1] = (ts / 2 ** 32) & 0xff
  bytes[2] = (ts / 2 ** 24) & 0xff
  bytes[3] = (ts / 2 ** 16) & 0xff
  bytes[4] = (ts / 2 ** 8) & 0xff
  bytes[5] = ts & 0xff
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** §78:迁移文件校验和(SHA-256),用于可重复检测与篡改发现 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
