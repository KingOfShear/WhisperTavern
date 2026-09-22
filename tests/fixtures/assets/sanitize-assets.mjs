/**
 * tests/fixtures/assets —— 真实资产脱敏金样(生成脚本)
 *
 * S15 (WP1.6 金样测试体系) / R-P1-4:
 *   真实资产(酒馆参考文件/,只读) → tests/fixtures/assets/ 结构等价脱敏副本。
 *   协议形状与字节结构保持;密钥/NSFW/私人长文本 → 合成替换。
 *
 * 输入:酒馆参考文件/ 下 *.json 与 *.png(角色卡)。
 * 输出(全部脱敏,minified JSON):
 *   card/    <slug>-v2.json / <slug>-v3.json / <slug>.png / <slug>.charx ——
 *     PNG 提取 chara(V2)/ccv3(V3) base64 → 脱敏 → 三载体重建
 *     (PNG=占位图像字节+tEXt 双内嵌,不保留原 NSFW 图;charx=STORE ZIP(card.json))
 *   preset/  <slug>.json  预设(prompt_order 形状,含狐神抚 217 条 prompts 数组)
 *   worldbook/ <slug>.json 世界书(地点=老代 / Table=现代 42 字段)
 *   table/   <slug>.json  表格预设(tableStructure)
 *   manifest.json  来源→产物 映射(Import Compatibility Report 基线)
 *
 * 纪律(fixtures/README.md):只读输入;重跑字节确定(固定种子 PRNG);
 *   密钥零泄漏(PV5):api_key/token/authorization/secret/password/Bearer/sk- → [redacted]。
 *
 * 用法: node tests/fixtures/assets/sanitize-assets.mjs
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = resolve(HERE, '../../../酒馆参考文件')
const OUT_DIR = HERE

// ===== 确定性 PRNG(固定种子 → 重跑字节相同)=====
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ===== 脱敏文本:保持行数/句数节奏,正文合成中性占位 =====
const PLACEHOLDER_POOL = [
  '细雨落在青石板上,远处传来模糊的脚步声。',
  '窗外的光线斜斜地洒进来,尘埃在光柱里浮动。',
  '她垂下眼帘,指尖轻轻划过杯沿,没有立刻回答。',
  '风穿过空荡的走廊,吹动半掩的帘子,带来一阵凉意。',
  '他翻开泛黄的笔记本,墨迹已经晕开,字迹难以辨认。',
]
const seedFor = (s) => Number.parseInt(createHash('sha1').update(s).digest('hex').slice(0, 8), 16)

/** 保持行数与大致长度:每行按原行长度填合成句子(循环词库,长度不足截断/超出拼接) */
function syntheticText(original, seed) {
  const lines = original.split('\n')
  const rand = mulberry32(seed)
  return lines
    .map((line) => {
      const target = line.length
      if (target === 0) return ''
      let out = ''
      while (out.length < target) {
        const s = PLACEHOLDER_POOL[Math.floor(rand() * PLACEHOLDER_POOL.length)]
        out += (out ? ' ' : '') + s
      }
      return out.slice(0, target)
    })
    .join('\n')
}

// ===== 密钥检测(PV5)=====
const SECRET_KEY_RE = /^(api[_-]?key|apikey|authorization|auth|token|secret|password|passwd|client[_-]?secret)$/i
const SECRET_VALUE_RE = /^(Bearer\s+)?(sk-|pk-|AIza|ghp_|xox[baprs]-)/i

// ===== 敏感长文本字段名(正文替换点)=====
const CONTENT_FIELDS = new Set([
  // 卡
  'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
  'system_prompt', 'post_history_instructions', 'alternate_greetings', 'group_only_greetings',
  // 预设
  'impersonation_prompt', 'continue_nudge_prompt', 'continue_postfix', 'continue_prefill',
  'jailbreak', 'story_string', 'new_chat_prompt', 'new_example_chat_prompt',
  'new_group_chat_prompt', 'assistant_prefill', 'assistant_impersonation',
  // 预设 prompts[] 注入模板
  'content', 'marker',
  // 世界书
  'comment',
  // LSR 表格预设
  'to_chat_container',
])
const SKIP_STRUCTURE_KEYS = new Set([
  // 结构/元数据键:原样保留
  'uid', 'key', 'keysecondary', 'position', 'insertion_order', 'order', 'depth', 'probability',
  'constant', 'enabled', 'disable', 'role', 'group', 'groupOverride', 'groupWeight', 'scanDepth',
  'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'selective', 'selectiveLogic',
  'automationId', 'addMemo', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion',
  'sticky', 'cooldown', 'delay', 'vectorized', 'useProbability', 'matchScenario',
  'matchCreatorNotes', 'matchPersonaDescription', 'matchCharacterDescription',
  'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'displayIndex', 'triggers',
  'injection_position', 'injection_depth', 'injection_order', 'forbid_overrides', 'identifier',
  'name', 'enabled', 'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k',
  'top_a', 'min_p', 'repetition_penalty', 'max_context_unlocked', 'max_tokens', 'n', 'seed',
  'stream', 'use_sysprompt', 'squash_system_messages', 'wi_format', 'show_thoughts',
  'reasoning_effort', 'verbosity', 'function_calling', 'tool_call_recurse_limit',
  'tool_reasoning_mode', 'request_images', 'request_image_resolution', 'request_image_aspect_ratio',
  'inline_image_quality', 'media_inlining', 'enable_web_search', 'send_if_empty', 'personality_format',
  'scenario_format', 'names_behavior', 'openai_max_context', 'openai_max_tokens',
  'chat_completion_source', 'openai_model', 'claude_model', 'windowai_model', 'openrouter_model',
  'genamt', 'max_length', 'isAiReadTable', 'isAiWriteTable', 'injection_mode', 'deep',
  'message_template', 'confirm_before_execution', 'use_main_prompt', 'prompt_order',
  'group_nudge_prompt', 'bias_preset_selected', 'spec', 'spec_version', 'character_version',
  'creator', 'fav', 'talkativeness', 'avatar', 'tags', 'assets', 'extensions', 'schemaVersion',
  'meta', 'scan', 'compat', 'tableStructure', 'entries',
])

// ===== 深度脱敏:递归,返回 [新值, 脱敏计数] =====
function sanitizeValue(value, key, path, counter) {
  // 1) 密钥键 → 一律 redact(任何值)
  if (SECRET_KEY_RE.test(key)) {
    counter.n++
    return '[redacted]'
  }
  if (typeof value === 'string') {
    // 2) 密钥形态值(PV5 兜底:整串匹配)
    if (SECRET_VALUE_RE.test(value.trim())) {
      counter.n++
      return '[redacted]'
    }
    // 3) 长文本内容字段 → 合成替换
    if (CONTENT_FIELDS.has(key) && value.length > 24) {
      counter.n++
      return syntheticText(value, seedFor(path + ':' + key))
    }
    // 4) 其余字符串:若非结构键且超长(防漏网),也合成替换
    if (!SKIP_STRUCTURE_KEYS.has(key) && value.length > 200) {
      counter.n++
      return syntheticText(value, seedFor(path + ':' + key))
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => sanitizeValue(v, key, `${path}[${i}]`, counter))
  }
  if (typeof value === 'object' && value !== null) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeValue(v, k, `${path}.${k}`, counter)
    }
    return out
  }
  return value
}

// ===== 类型判定(供 manifest 与金样分组)=====
function classifyAsset(root) {
  const keys = Object.keys(root)
  if (keys.includes('entries') && !keys.includes('prompt_order') && !keys.includes('temperature')) {
    return 'worldbook'
  }
  if (keys.includes('isAiReadTable') || keys.includes('tableStructure')) return 'table'
  return 'preset'
}

function slugify(name) {
  return name
    .replace(/\.(png|json|charx)$/i, '')
    .replace(/[【】\[\]~·、.!！？?（）()]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
}

// ===== 最小 PNG 重建(占位图像 + 脱敏 tEXt 双内嵌)=====
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** 1×1 透明像素的 zlib 流(占位图像字节;解析器不碰 IDAT) */
const MINI_IDAT = Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])

// CRC32(PNG 块校验)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function tEXtChunk(keyword, text) {
  return pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]))
}

/** 从 PNG 字节提取 chara/ccv3 base64(内联解析,不经 st-compat) */
function extractPngCards(bytes) {
  let chara
  let ccv3
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
    offset = dataStart + length + 4
  }
  return { chara, ccv3 }
}

/** 重建最小 PNG:签名 + 占位 IDAT + 脱敏 tEXt(chara+ccv3) + IEND */
function rebuildPng(sanitizedV2, sanitizedV3) {
  const parts = [PNG_SIG]
  parts.push(pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])))
  parts.push(pngChunk('IDAT', MINI_IDAT))
  if (sanitizedV2 !== undefined) parts.push(tEXtChunk('chara', sanitizedV2))
  if (sanitizedV3 !== undefined) parts.push(tEXtChunk('ccv3', sanitizedV3))
  parts.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

// ===== 最小 STORE ZIP(charx 载体)=====
/** 手写 STORE(zlib 无压缩)ZIP:card.json + 其余条目(不引 fflate,确定性输出) */
function zipStore(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const DOS_TIME = 0 // 00:00:00
  const DOS_DATE = ((0 << 9) | (1 << 5) | 1) // 1980-01-01(确定性)
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 name flag
    local.writeUInt16LE(0, 8) // STORE
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const localBlock = Buffer.concat([local, nameBuf, data])
    localParts.push(localBlock)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(Buffer.concat([central, nameBuf]))
    offset += localBlock.length
  }
  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDir, eocd])
}

// ===== 主流程 =====
function main() {
  let sourceEntries
  try {
    sourceEntries = readdirSync(SOURCE_DIR)
  } catch {
    console.error(`来源目录不存在: ${SOURCE_DIR}`)
    process.exit(1)
  }
  const files = sourceEntries.filter((f) => /\.(json|png)$/i.test(f))
  if (files.length === 0) {
    console.error(`来源目录无 JSON/PNG: ${SOURCE_DIR}`)
    process.exit(1)
  }
  const manifest = []

  for (const file of files) {
    const raw = readFileSync(join(SOURCE_DIR, file))
    const isPng = /\.png$/i.test(file)
    const slug = slugify(file)

    if (isPng) {
      // —— PNG 卡:提取 → 脱敏 → 三载体重建 ——
      const { chara, ccv3 } = extractPngCards(raw)
      if (chara === undefined && ccv3 === undefined) {
        console.warn(`⚠ ${file}:无 chara/ccv3 tEXt 卡块,跳过(可能只是普通图片)`)
        continue
      }
      const dec = (b64) => (b64 === undefined ? undefined : JSON.parse(Buffer.from(b64, 'base64').toString('utf8')))
      const enc = (json) => Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
      const v2 = dec(chara)
      const v3 = dec(ccv3)
      const c2 = { n: 0 }
      const c3 = { n: 0 }
      const sv2 = v2 === undefined ? undefined : sanitizeValue(v2, '', '$:v2', c2)
      const sv3 = v3 === undefined ? undefined : sanitizeValue(v3, '', '$:v3', c3)
      const outCard = join(OUT_DIR, 'card')
      mkdirSync(outCard, { recursive: true })
      let wrote = 0
      if (sv2 !== undefined) {
        writeFileSync(join(outCard, `${slug}-v2.json`), JSON.stringify(sv2) + '\n', 'utf8')
        wrote++
      }
      if (sv3 !== undefined) {
        writeFileSync(join(outCard, `${slug}-v3.json`), JSON.stringify(sv3) + '\n', 'utf8')
        wrote++
      }
      const png = rebuildPng(sv2 === undefined ? undefined : enc(sv2), sv3 === undefined ? undefined : enc(sv3))
      writeFileSync(join(outCard, `${slug}.png`), png)
      // charx:card.json = V3 优先,V2 兜底(与导入优先序一致)
      const charxCard = sv3 ?? sv2
      if (charxCard !== undefined) {
        const zip = zipStore([['card.json', Buffer.from(JSON.stringify(charxCard), 'utf8')]])
        writeFileSync(join(outCard, `${slug}.charx`), zip)
        manifest.push({
          source: file,
          output: `card/${slug}.charx`,
          type: 'card',
          carrier: 'charx',
          sanitizedFields: (sv3 === undefined ? c2 : c3).n,
        })
      }
      manifest.push(
        ...(sv2 !== undefined
          ? [{ source: file, output: `card/${slug}-v2.json`, type: 'card', carrier: 'json-v2', sanitizedFields: c2.n }]
          : []),
        ...(sv3 !== undefined
          ? [{ source: file, output: `card/${slug}-v3.json`, type: 'card', carrier: 'json-v3', sanitizedFields: c3.n }]
          : []),
        { source: file, output: `card/${slug}.png`, type: 'card', carrier: 'png', sanitizedFields: c2.n + c3.n },
      )
      console.log(`✓ ${file} → card/${slug}.(v2|v3|png|charx) 脱敏 ${c2.n + c3.n} 处`)
      continue
    }

    // —— JSON:解析 → 脱敏 → 单载体写出 ——
    let root
    try {
      root = JSON.parse(raw.toString('utf8'))
    } catch (e) {
      console.error(`跳过(JSON 解析失败): ${file} — ${e.message}`)
      continue
    }
    const type = classifyAsset(root)
    const counter = { n: 0 }
    const sanitized = sanitizeValue(root, '', '$', counter)
    const outDir = join(OUT_DIR, type)
    mkdirSync(outDir, { recursive: true })
    const outFile = join(outDir, `${slug}.json`)
    writeFileSync(outFile, JSON.stringify(sanitized) + '\n', 'utf8')
    manifest.push({ source: file, output: `${type}/${slug}.json`, type, sanitizedFields: counter.n })
    console.log(`✓ ${file} → ${type}/${slug}.json (脱敏 ${counter.n} 处)`)
  }

  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`manifest.json 已生成(${manifest.length} 产物)`)
}

main()