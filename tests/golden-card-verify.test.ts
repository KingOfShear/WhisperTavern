import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// 相对路径直引源码:tests/ 不归属任何包,无 workspace 包名别名可用(architecture project 零依赖设计)
import { importCardFromJson } from '../packages/st-compat/src/index'
import { readCardFromPng } from '../packages/st-compat/src/card/png'
import { readCardFromCharx } from '../packages/st-compat/src/card/charx'

/**
 * S15(WP1.6)金样卡载体验证(committed):fixtures/assets/card/ 下脱敏载体
 * 能被 st-compat 反向读通 + 载体四态 1:1:1:1 完整 + 脱敏断言(密钥/NSFW 内容
 * 已结构等价替换,technical-plan §8.2 / R-P1-4)。只引用脱敏金样,不碰原始资产(AGENTS X3)。
 */
const ASSETS = 'tests/fixtures/assets'

describe('S15 金样:卡载体反向可读性与完整性', () => {
  const cardDir = join(ASSETS, 'card')
  const pngs = readdirSync(cardDir).filter((f) => f.endsWith('.png'))
  const charxs = readdirSync(cardDir).filter((f) => f.endsWith('.charx'))
  const v2s = readdirSync(cardDir).filter((f) => f.endsWith('-v2.json'))
  const v3s = readdirSync(cardDir).filter((f) => f.endsWith('-v3.json'))

  it('载体文件完整(1:1:1:1)', () => {
    expect(pngs.length).toBe(charxs.length)
    expect(pngs.length).toBe(v3s.length)
    expect(v2s.length).toBe(pngs.length)
  })

  it('V3 JSON 载体可导入,name/meta 完整 + 脱敏(无 NSFW 痕迹)', () => {
    for (const f of v3s) {
      const j = JSON.parse(readFileSync(join(cardDir, f), 'utf8'))
      const { card } = importCardFromJson(j)
      expect(card.meta.name.length).toBeGreaterThan(0)
      const persona = card.persona
      const blob = `${persona.description}\n${persona.personality}\n${persona.scenario}\n${persona.mesExample}`
      expect(blob.includes('性欲处理')).toBe(false)
      expect(blob.includes('催眠')).toBe(false)
    }
  })

  it('PNG 载体可读取 chara+ccv3 双内嵌', () => {
    for (const f of pngs) {
      const bytes = new Uint8Array(readFileSync(join(cardDir, f)))
      const { card, sourceFormat } = readCardFromPng(bytes)
      expect(sourceFormat).toMatch(/png-v[23]/)
      // readCardFromPng 返回原始 ST 卡(StCardRoot):name 在 data 层或顶层
      const raw = card as Record<string, unknown>
      const data = raw.data as Record<string, unknown> | undefined
      const name = typeof data?.name === 'string' ? data.name : raw.name
      expect(typeof name).toBe('string')
    }
  })

  it('charx 载体可读取(card.json + 文件清单)', () => {
    for (const f of charxs) {
      const bytes = new Uint8Array(readFileSync(join(cardDir, f)))
      const { card, files } = readCardFromCharx(bytes)
      const raw = card as Record<string, unknown>
      const data = raw.data as Record<string, unknown> | undefined
      const name = typeof data?.name === 'string' ? data.name : raw.name
      expect(typeof name).toBe('string')
      expect(files instanceof Map).toBe(true)
    }
  })
})
