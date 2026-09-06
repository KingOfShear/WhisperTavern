import { StCardRootSchema, type StCardRoot } from './types'

/**
 * PNG tEXt 块读取 —— technical-plan §5.10:酒馆 PNG 在 tEXt 里同时写
 * `chara`(V2)与 `ccv3`(V3)两份 base64 JSON,**导入优先 ccv3**。
 * PNG 结构:8 字节签名 + [4B 长度][4B 类型][data][4B CRC] × N;tEXt = keyword\0text。
 * 只做块遍历,不引图像库(不碰 IDAT,零解码)。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class CardParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardParseError'
  }
}

/** 从 PNG 字节提取卡 JSON(优先 ccv3);非 PNG/无卡块抛 CardParseError */
export function readCardFromPng(bytes: Uint8Array): { card: StCardRoot; sourceFormat: 'png-v3' | 'png-v2' } {
  const signature = Buffer.from(bytes.slice(0, 8))
  if (!signature.equals(PNG_SIGNATURE)) {
    throw new CardParseError('非 PNG 文件(签名不符)')
  }

  let chara: string | undefined
  let ccv3: string | undefined
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset + offset, 8)
    const length = view.readUInt32BE(0)
    const type = view.toString('ascii', 4, 8)
    const dataStart = offset + 8
    if (type === 'IEND') break
    if (type === 'tEXt' && dataStart + length <= bytes.length) {
      const chunk = Buffer.from(bytes.slice(dataStart, dataStart + length))
      const nul = chunk.indexOf(0)
      if (nul > 0) {
        const keyword = chunk.toString('latin1', 0, nul)
        const text = chunk.toString('latin1', nul + 1)
        if (keyword === 'chara') chara = text
        if (keyword === 'ccv3') ccv3 = text
      }
    }
    offset = dataStart + length + 4 // 跳过 CRC
  }

  const pick = (b64: string | undefined): StCardRoot | undefined => {
    if (b64 === undefined) return undefined
    try {
      return StCardRootSchema.parse(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')))
    } catch (error) {
      throw new CardParseError(`PNG 内嵌卡 JSON 解析失败: ${String(error).slice(0, 120)}`)
    }
  }

  const v3 = pick(ccv3)
  if (v3 !== undefined) return { card: v3, sourceFormat: 'png-v3' }
  const v2 = pick(chara)
  if (v2 !== undefined) return { card: v2, sourceFormat: 'png-v2' }
  throw new CardParseError('PNG 无 tEXt 卡块(缺 chara/ccv3)——可能只是普通图片')
}
