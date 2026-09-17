import { describe, expect, it } from 'vitest'
import {
  importPreset,
  importPresetFromJson,
  isPresetParseError,
  toStPreset,
} from './normalize'
import { DgPresetSchema, type StPresetRoot } from './types'

/** 代表性 ST 预设(三段式:顶层采样参数 + prompts[] + prompt_order[]) */
const ST_PRESET: StPresetRoot = {
  name: '喵特调 V2', temperature: 1, max_context: 128000, max_tokens: 8192, top_p: 0.88, top_k: 40, stream: true,
  prompts: [
    { identifier: 'main', role: 'system', content: '你是酒馆的猫娘服务生。', enabled: true },
    { identifier: 'worldInfoBefore', role: 'system', content: '世界观设定前置。', enabled: true, injection_position: 0 },
    { identifier: 'chatHistory', role: 'system', content: '历史锚点内容。', enabled: true, injection_position: 1, injection_depth: 4 },
    { identifier: 'hidden', role: 'system', content: '未在 prompt_order 中,应被丢弃。', enabled: true },
    { identifier: 'tailNote', role: 'user', content: '结尾附言。', enabled: true },
  ],
  prompt_order: [
    { identifier: 'main', order: 0, enabled: true },
    { identifier: 'worldInfoBefore', order: 1, enabled: true },
    { identifier: 'chatHistory', order: 2, enabled: true },
    { identifier: 'tailNote', order: 3, enabled: true },
  ],
} as StPresetRoot

describe('S12 st-compat 预设导入(§80–§81)', () => {
  it('prompts + prompt_order → segments,顺序即 prompt_order 索引', () => {
    const { preset, report } = importPresetFromJson(ST_PRESET, { name: '喵特调 V2' })
    expect(preset.schemaVersion).toBe(1)
    // 仅 prompt_order 中的 4 段活跃;hidden 被丢弃
    expect(preset.segments).toHaveLength(4)
    expect(preset.segments.map((s) => s.id)).toEqual(['main', 'worldInfoBefore', 'chatHistory', 'tailNote'])
    // header 顺序 = prompt_order 索引
    expect(preset.segments[0]!.placement).toEqual({ kind: 'header', order: 0 })
    expect(preset.segments[1]!.placement).toEqual({ kind: 'header', order: 1 })
    // injection_position=1 → injection 区(§82/§83)
    expect(preset.segments[2]!.placement).toEqual({ kind: 'injection', depth: 4, order: 2 })
    // 末段(无 injection_position)→ header
    expect(preset.segments[3]!.placement).toEqual({ kind: 'header', order: 3 })
    expect(report.asset.segmentCount).toBe(4)
    expect(report.asset.injectedCount).toBe(1)
  })

  it('marker identifier → slot(§80:未建模字段进 compat 或语义标记)', () => {
    const { preset } = importPresetFromJson(ST_PRESET)
    const worldInfo = preset.segments.find((s) => s.id === 'worldInfoBefore')
    const chatHistory = preset.segments.find((s) => s.id === 'chatHistory')
    expect(worldInfo?.slot).toBe('worldInfoBefore')
    expect(chatHistory?.slot).toBe('chatHistory')
    const main = preset.segments.find((s) => s.id === 'main')
    expect(main?.slot).toBeNull()
  })

  it('采样参数方言归一(下划线 ↔ 驼峰)', () => {
    const { preset } = importPresetFromJson(ST_PRESET)
    expect(preset.params).toMatchObject({ temperature: 1, maxContext: 128000, maxTokens: 8192, topP: 0.88, topK: 40, stream: true })
  })

  it('role 映射:model → assistant,缺省 → system', () => {
    const { preset } = importPresetFromJson({
      prompts: [{ identifier: 'a', role: 'model', content: 'x' }],
      prompt_order: ['a'],
    } as StPresetRoot)
    expect(preset.segments[0]!.role).toBe('assistant')
  })

  it('往返:toStPreset 重建 prompts/prompt_order(提示词层无损)', () => {
    const { preset } = importPresetFromJson(ST_PRESET)
    const st = toStPreset(preset) as Record<string, unknown>
    const prompts = st.prompts as Record<string, unknown>[]
    const order = st.prompt_order as Record<string, unknown>[]
    expect(prompts).toHaveLength(4)
    // 注入段回写为 injection_position=1
    const chatHistory = prompts.find((p) => p.identifier === 'chatHistory')
    expect(chatHistory?.injection_position).toBe(1)
    expect(chatHistory?.injection_depth).toBe(4)
    // prompt_order 含全部 4 段且顺序一致
    expect(order.map((o) => o.identifier)).toEqual(['main', 'worldInfoBefore', 'chatHistory', 'tailNote'])
    expect(st.max_context).toBe(128000)
    expect(st.temperature).toBe(1)
  })

  it('native .dgpreset 通过 schema 校验', () => {
    const { preset } = importPresetFromJson(ST_PRESET)
    expect(() => DgPresetSchema.parse(preset)).not.toThrow()
  })

  it('非法 JSON 字节 → PresetParseError', () => {
    const bad = new TextEncoder().encode('{ not json')
    expect(() => importPreset(bad)).toThrow()
    try {
      importPreset(bad)
    } catch (e) {
      expect(isPresetParseError(e)).toBe(true)
    }
  })
})
