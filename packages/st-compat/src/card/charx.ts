import { unzipSync } from 'fflate'
import { CardParseError } from './png'
import { StCardRootSchema, type StCardRoot } from './types'

/**
 * charx 解包 —— technical-plan §5.10:charx = ZIP(card.json + assets[] 清单,
 * 情绪贴图/图标按清单内 uri 关联)。解包返回卡 JSON + 全部条目
 * (资产文件按 .dgcard assets[].uri 由导入注册侧落盘)。
 */

export interface CharxContents {
  card: StCardRoot
  /** ZIP 内全部条目(path → 字节);card.json 除外 */
  files: Map<string, Uint8Array>
}

export function readCardFromCharx(bytes: Uint8Array): CharxContents {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (error) {
    throw new CardParseError(`charx ZIP 解包失败: ${String(error).slice(0, 120)}`)
  }
  const cardEntry = entries['card.json']
  if (cardEntry === undefined) {
    throw new CardParseError('charx 缺 card.json(§5.10 载体契约)')
  }
  let card: StCardRoot
  try {
    card = StCardRootSchema.parse(JSON.parse(Buffer.from(cardEntry).toString('utf8')))
  } catch (error) {
    throw new CardParseError(`charx card.json 解析失败: ${String(error).slice(0, 120)}`)
  }
  const files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(entries)) {
    if (path !== 'card.json') files.set(path, content)
  }
  return { card, files }
}
