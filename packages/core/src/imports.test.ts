import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 零 IO 约束测试(p0-plan S3 验收:core 包零 IO)。
 *
 * 扫描 src 全部非测试源文件的 import 说明符:只允许相对导入、
 * @desiregrimoire/contracts(依赖方向 core → contracts)、@noble/hashes(纯 JS
 * 哈希库)。node:* 与其余一切包 = 红。本测试文件自身用 node:fs 属测试基建,
 * 不受约束(被排除)。
 */

const ALLOWED_EXTERNAL = /^(@desiregrimoire\/contracts|@noble\/hashes(\/[\w-]+)?)$/
const SOURCE_DIR = fileURLToPath(new URL('.', import.meta.url))

function listSourceFiles(dir: string): string[] {
  const entries: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      entries.push(...listSourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      entries.push(full)
    }
  }
  return entries
}

function importSpecifiers(source: string): string[] {
  // import ... from 'x' / export ... from 'x' / import 'x';动态 import() 一并拦截
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  const found = new Set<string>()
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1] ?? '')
    }
  }
  return [...found]
}

describe('core 零 IO 约束(总设计 §7 / p0-plan S3 验收)', () => {
  it('src 源文件只依赖 contracts 与 @noble/hashes,禁 node:* 与其他工作区包', () => {
    const violations: string[] = []
    for (const file of listSourceFiles(SOURCE_DIR)) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const allowed = specifier.startsWith('.') || ALLOWED_EXTERNAL.test(specifier)
        if (!allowed) {
          violations.push(`${file}: ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
