/**
 * 架构守卫测试（architecture fitness function）
 *
 * 把 AGENTS.md §3 编码纪律里**可机器验证**的部分从散文变成会变红的断言。
 * 存在理由（2026-09-08 可维护性体检结论）：AI 会话不遵守散文纪律，只遵守能拦截它的测试——
 * 实测注释密度要求 1:10 而实际 1:34.7，正是因为那条纪律从落笔起就没有卡点。
 *
 * 三条设计约束：
 * 1. **纯 fs + 正则解析，零 import** —— 守卫取外部视角，不受包解析顺序 / 构建产物影响；
 *    也因此不复制 spec 内容，只做双向一致性比对：spec 改了代码没跟（或反之）就红。
 * 2. **今天必须全绿** —— 新增门禁当下就红 = 没人会维护它，等于没有。
 * 3. **只守"能一句话说清"的约束** —— 说不清的交给 review，不硬塞进测试。
 *
 * 覆盖范围：A 事件名权威域 / B 依赖方向 / C 代码风格底线 / D 测试门禁完整性 / E Capability 权威域。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8')
}

/** 收集 workspace 内源码文件（跳过 node_modules / dist / coverage / 测试文件） */
function collectSourceFiles(): string[] {
  const roots = ['packages', 'apps']
  const out: string[] = []
  const SKIP = new Set(['node_modules', 'dist', 'coverage'])
  for (const root of roots) {
    const abs = join(REPO_ROOT, root)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) {
            if (!SKIP.has(e.name)) walk(p)
          } else if (/\.tsx?$/.test(e.name) && !e.name.includes('.test.')) {
            out.push(relative(REPO_ROOT, p).replace(/\\/g, '/'))
          }
        }
      }
      walk(join(abs, entry.name))
    }
  }
  return out
}

const SOURCE_FILES = collectSourceFiles()

/** §5.4 权威事件表 → Map<事件名, 分档> */
function parseSpecEventCatalog(): Map<string, string> {
  const md = readText('docs/technical-design.md')
  const start = md.indexOf('### 5.4 Event Bus')
  const end = md.indexOf('### 5.5', start)
  if (start < 0 || end < 0) throw new Error('定位失败：technical-design §5.4（Event Bus）章节缺失')
  const section = md.slice(start, end)
  const fence = section.indexOf('```text')
  if (fence < 0) throw new Error('定位失败：§5.4 事件清单代码块缺失')
  const body = section.slice(fence + 7, section.indexOf('```', fence + 7))

  const out = new Map<string, string>()
  let tier = ''
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const head = /^──\s*(durable|deferred-durable|live)/.exec(line)
    if (head) {
      tier = head[1]
      continue
    }
    // 权威表同一行可含多个事件名（`/` 分隔）并带全角括号行内注释，故只取前缀而非整段匹配
    for (const part of line.split('/')) {
      const m = /^([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)/.exec(part.trim())
      if (m) out.set(m[1], tier)
    }
  }
  if (out.size === 0) throw new Error('解析失败：§5.4 事件清单为空（格式变了？）')
  return out
}

/** catalog.ts 源码常量 → Map<事件名, 分档> */
function parseCodeEventCatalog(): Map<string, string> {
  const src = readText('packages/runtime/src/events/catalog.ts')
  const re = /'([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)':\s*'(durable|deferred-durable|live)'/g
  const out = new Map<string, string>()
  for (const m of src.matchAll(re)) out.set(m[1], m[2])
  if (out.size === 0) throw new Error('解析失败：EVENT_CATALOG 为空（packages/runtime/src/events/catalog.ts）')
  return out
}

interface WorkspacePackage {
  name: string
  dir: string
  /** 仅 dependencies——devDependencies 的互相引用是测试工装，不构成运行时依赖方向 */
  internalDeps: string[]
}

function loadWorkspacePackages(): WorkspacePackage[] {
  const out: WorkspacePackage[] = []
  for (const root of ['packages', 'apps']) {
    const abs = join(REPO_ROOT, root)
    if (!existsSync(abs)) continue
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const manifest = join(abs, e.name, 'package.json')
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string
        dependencies?: Record<string, string>
      }
      if (typeof pkg.name !== 'string') continue
      out.push({
        name: pkg.name,
        dir: `${root}/${e.name}`,
        internalDeps: Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@whispertavern/')),
      })
    }
  }
  return out
}

describe('A 事件名权威域（technical-design §5.4 Event Bus）', () => {
  const spec = parseSpecEventCatalog()
  const code = parseCodeEventCatalog()

  it('A1 源码目录内不得出现权威表之外的事件名', () => {
    const strays = [...code.keys()].filter((n) => !spec.has(n))
    expect(strays, `未登记于 §5.4 的事件名：${strays.join(', ')}`).toEqual([])
  })

  it('A2 分档必须与权威表逐字一致（分档错 = 落表撑爆 或 重启后执行树断）', () => {
    const mismatched = [...code.entries()]
      .filter(([name, tier]) => spec.has(name) && spec.get(name) !== tier)
      .map(([name, tier]) => `${name}: 代码 ${tier} vs spec ${spec.get(name) ?? '?'}`)
    expect(mismatched).toEqual([])
  })

  it('A3 权威表登记过的域，其事件必须注册进源码目录（防 P1 激活层自造名）', () => {
    const specDomains = new Set([...spec.keys()].map((n) => n.split('.')[0]))
    const re = /type:\s*'([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)'/g
    const unknown: string[] = []
    for (const file of SOURCE_FILES) {
      const text = readText(file)
      for (const m of text.matchAll(re)) {
        const name = m[1]
        if (!specDomains.has(name.split('.')[0])) continue
        if (!code.has(name)) unknown.push(`${name}（${file}）`)
      }
    }
    expect(unknown, `硬编码了权威域下未注册的事件名：${unknown.join(', ')}`).toEqual([])
  })

  it('A4 SSE 投影必须是权威目录的子集（api-types 不得另立事件名）', () => {
    const src = readText('packages/api-types/src/index.ts')
    const block = /SSE_EVENT_TYPES = \[([\s\S]*?)\] as const/.exec(src)
    expect(block, '未找到 SSE_EVENT_TYPES').not.toBeNull()
    const names = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(0)
    const strays = names.filter((n) => !code.has(n))
    expect(strays, `SSE 投影越权：${strays.join(', ')}`).toEqual([])
  })
})

describe('B 依赖方向（AGENTS §3 纪律 6 单向依赖）', () => {
  const pkgs = loadWorkspacePackages()
  const byName = new Map(pkgs.map((p) => [p.name, p]))

  it('B1 workspace 内部依赖图无环', () => {
    const state = new Map<string, 0 | 1 | 2>()
    const visit = (name: string, trail: string[]): string[] | null => {
      const s = state.get(name) ?? 0
      if (s === 1) return [...trail, name]
      if (s === 2) return null
      state.set(name, 1)
      for (const dep of byName.get(name)?.internalDeps ?? []) {
        const found = visit(dep, [...trail, name])
        if (found) return found
      }
      state.set(name, 2)
      return null
    }
    for (const p of pkgs) {
      const cycle = visit(p.name, [])
      if (cycle) throw new Error(`依赖环：${cycle.join(' → ')}`)
    }
    expect(pkgs.length).toBeGreaterThan(0)
  })

  it('B2 contracts 不得依赖任何内部包（它是依赖图的根）', () => {
    const contracts = byName.get('@whispertavern/contracts')
    expect(contracts).toBeDefined()
    expect(contracts?.internalDeps).toEqual([])
  })

  it('B3 packages 不得反向依赖 apps（应用层是终点）', () => {
    const violations = pkgs
      .filter((p) => p.dir.startsWith('packages/'))
      .flatMap((p) => p.internalDeps.filter((d) => byName.get(d)?.dir.startsWith('apps/')).map((d) => `${p.name} → ${d}`))
    expect(violations).toEqual([])
  })
})

describe('C 代码风格底线（AGENTS §3 纪律 6：显式类型，禁 any 出口）', () => {
  it('C1 非测试源码不得出现 any', () => {
    const hits: string[] = []
    for (const file of SOURCE_FILES) {
      readText(file)
        .split('\n')
        .forEach((line, i) => {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
          // 只查代码部分：行内注释里的 "any" 是说明文字，不是类型逃逸
          const codePart = line.split('//')[0]
          if (/\bany\b/.test(codePart)) hits.push(`${file}:${i + 1} ${trimmed.slice(0, 60)}`)
        })
    }
    expect(hits).toEqual([])
  })
})

describe('D 测试门禁完整性（防新包漏接 CI）', () => {
  it('D1 每个含源码的包/应用都必须有 vitest 配置', () => {
    const dirs = new Set(SOURCE_FILES.map((f) => f.split('/').slice(0, 2).join('/')))
    const missing = [...dirs].filter((d) => !existsSync(join(REPO_ROOT, d, 'vitest.config.ts')))
    expect(missing, `未接入 vitest projects（其测试永不运行）：${missing.join(', ')}`).toEqual([])
  })

  it('D2 根配置必须聚合全部 workspace 包', () => {
    const root = readText('vitest.config.ts')
    expect(root).toContain("'packages/*/vitest.config.ts'")
    expect(root).toContain("'apps/*/vitest.config.ts'")
  })
})

describe('E Capability 权威域（technical-design §18.2 Capabilities）', () => {
  /** spec 代码块字段：形如 `  systemRole: boolean` */
  function parseSpecCapabilities(): string[] {
    const md = readText('docs/technical-design.md')
    const start = md.indexOf('### 18.2 Capabilities')
    if (start < 0) throw new Error('定位失败：technical-design §18.2（Capabilities）章节缺失')
    const body = md.slice(start, start + 1200)
    const fence = body.indexOf('```ts')
    const block = body.slice(fence + 5, body.indexOf('```', fence + 5))
    const fields = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
    if (fields.length === 0) throw new Error('解析失败：§18.2 字段清单为空')
    return fields
  }

  function parseCodeCapabilities(): string[] {
    const src = readText('packages/contracts/src/provider.ts')
    const block = /ProviderCapabilitiesSchema = z\.object\(\{([\s\S]*?)\n\}\)/.exec(src)
    expect(block, '未找到 ProviderCapabilitiesSchema').not.toBeNull()
    // 字段值形态无关(S19:cacheType 引用 CacheTypeSchema 而非内联 z.enum),只取字段名
    return [...(block?.[1] ?? '').matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
  }

  it('E1 权威表与 contracts 字段集必须逐字段相等', () => {
    const spec = parseSpecCapabilities()
    const code = parseCodeCapabilities()
    expect(new Set(spec)).toEqual(new Set(code))
    expect(
      spec.filter((f) => !code.includes(f)),
      '§18.2 有而 contracts 缺',
    ).toEqual([])
    expect(
      code.filter((f) => !spec.includes(f)),
      'contracts 有而 §18.2 未登记（同步 spec 后再来）',
    ).toEqual([])
  })
})
