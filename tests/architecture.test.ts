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

/** 收集测试文件(packages/apps/tests 三处的 *.test.ts)——D 组的扫描面 */
function collectTestFiles(): string[] {
  const out: string[] = []
  const SKIP = new Set(['node_modules', 'dist', 'coverage'])
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(p)
      } else if (e.name.endsWith('.test.ts')) {
        out.push(relative(REPO_ROOT, p).replace(/\\/g, '/'))
      }
    }
  }
  for (const root of ['packages', 'apps', 'tests']) {
    const abs = join(REPO_ROOT, root)
    if (existsSync(abs)) walk(abs)
  }
  return out
}

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

  /**
   * B4 编排层是终点（§38 决策 45,方案 A）。
   *
   * 这条是 B3 的镜像:B3 防"包反向依赖应用",B4 防"Agent 逻辑被塞回下层"和
   * "下层反向引用编排层"。没有它,`packages/agent` 会慢慢退化成"多加一个依赖而已",
   * 而分层一旦破口就再也回不去——所以必须在它还是空壳时就焊死。
   */
  it('B4 编排层是终点:contracts / core / runtime 不得依赖 agent,且 agent 的依赖白名单固定', () => {
    const ORCHESTRATOR = '@whispertavern/agent'
    const LOWER_LAYERS = ['@whispertavern/contracts', '@whispertavern/core', '@whispertavern/runtime']
    const backRefs = LOWER_LAYERS.flatMap((name) => {
      const pkg = byName.get(name)
      if (pkg === undefined) return [`${name} 不在 workspace（包名改了？）`]
      return pkg.internalDeps.includes(ORCHESTRATOR) ? [`${name} → ${ORCHESTRATOR}`] : []
    })
    expect(backRefs, `下层反向依赖编排层：${backRefs.join(', ')}`).toEqual([])

    const agent = byName.get(ORCHESTRATOR)
    expect(agent, '未找到 packages/agent（依赖方向裁决的前提）').toBeDefined()
    const allowed = new Set(LOWER_LAYERS)
    const strays = (agent?.internalDeps ?? []).filter((d) => !allowed.has(d))
    expect(strays, `agent 依赖越出编排层许可集（新增需先改决策 45）：${strays.join(', ')}`).toEqual([])
    // 决策 45 第 4 条:骨架必须真的声明 contracts / core / runtime,否则 S23+ 无法在包内落码
    const missing = LOWER_LAYERS.filter((d) => !(agent?.internalDeps ?? []).includes(d))
    expect(missing, `agent 未声明依赖：${missing.join(', ')}`).toEqual([])
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
          let codePart = line.split('//')[0]
          // S25 精化:①字符串字面量里的 "any"(受限 DSL 的 all/any/not 组合器)不是类型;
          // ②属性访问 .any 与对象键 any: 同理。剩余位置的裸 any 才是类型逃逸。
          codePart = codePart.replace(/'[^']*'|"[^"]*"/g, "''")
          codePart = codePart.replace(/\.\s*any\b/g, '.member')
          codePart = codePart.replace(/\bany\s*:/g, 'key:')
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

  /**
   * S21(WP2.6):两道缓存硬门禁是 P2 出场的机器凭证——文件被删/被掏空/千轮窗口被悄悄缩小,
   * 都必须在 CI 里变红(它们本身没有"被谁 import"的引用关系,只有这条能拦住删除)。
   */
  it('D3 缓存稳定性门禁必须存在且未被掏空(千轮窗口不许缩)', () => {
    const gates = ['packages/core/src/compiler/cache-scenarios.test.ts', 'apps/server/src/cache-stability.test.ts']
    const missing = gates.filter((f) => !existsSync(join(REPO_ROOT, f)))
    expect(missing, `缓存门禁文件缺失: ${missing.join(', ')}`).toEqual([])
    for (const f of gates) {
      expect(readText(f).includes('expect('), `${f} 无任何断言,门禁形同虚设`).toBe(true)
    }
    expect(readText('packages/core/src/compiler/cache-scenarios.test.ts')).toContain('rounds: 1000')
  })

  /**
   * D4 迁移版本号不得硬编码(2026-09-26,S22 加 v8 时被同一类假失败咬了两次)。
   *
   * 版本是可派生的(`LATEST_SCHEMA_VERSION`),写死就是纪律 6 说的 magic number;
   * 而"加一条迁移 → 另一个文件莫名变红"是最没有信息量的失败,还会掩盖真问题。
   */
  it('D4 断言"已应用到最新"时必须派生版本号,不得写死', () => {
    const testFiles = collectTestFiles()
    expect(testFiles.length).toBeGreaterThan(0)
    const offenders: string[] = []
    // 命中形态:`currentVersion(...)).toBe(8)` / `appliedMigrations...toEqual({ from: 0, to: 8 })`
    const re = /(currentVersion|appliedMigrations)[^\n]*?(\.toBe\(\s*\d|to:\s*\d)/
    for (const file of testFiles) {
      readText(file)
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line.split('//')[0] ?? '')) offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 80)}`)
        })
    }
    expect(
      offenders,
      `硬编码迁移版本号(改用 LATEST_SCHEMA_VERSION):\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  /**
   * D5 S28(WP3.6):恢复/重放确定性门禁(agent-runtime-spec §173 Replay/Recovery 组的机器凭证)。
   *
   * 与 D3 同构——`s27-recovery.test.ts` 是 P3 出场的三条硬凭证(Test 5 Resume / Test 6
   * Crash Recovery / Test 10 Deterministic Replay)所在;文件被删/被掏空,CI 必须红。
   * 锚点:
   * - 崩溃恢复断言(§97:Zombie 清零 + planRecovery);
   * - X14 逐字节一致(Replay 轮 serialized.parts 与源 Run 逐字节);
   * - Replay 模式不写新 tool_calls(§146 安全性)。
   * 若门禁被拆分到多文件,更新本哨兵的文件清单与锚点即可(不新造平行门禁)。
   */
  it('D5 P3 恢复/重放确定性门禁必须存在且未被掏空(X14 逐字节 + §97 恢复)', () => {
    const GATE = 'packages/agent/src/runtime/s27-recovery.test.ts'
    expect(existsSync(join(REPO_ROOT, GATE)), `P3 确定性门禁文件缺失: ${GATE}`).toBe(true)
    const src = readText(GATE)
    expect(src.includes('expect('), `${GATE} 无任何断言,门禁形同虚设`).toBe(true)
    expect(src, `${GATE} 缺 X14 逐字节一致断言`).toContain('JSON.stringify(partsReplay)')
    expect(src, `${GATE} 缺崩溃恢复(Zombie 清零)断言`).toContain('zombie.n')
    expect(src, `${GATE} 缺 Replay 不写新 tool_calls(§146)`).toContain('replayToolRows.n')
    // 门禁必须挂在 vitest projects(packages/agent 是其归属包)——防它被移到不被跑的位置
    expect(readText('packages/agent/vitest.config.ts')).toContain("'src/**/*.test.ts'")
  })

  /**
   * D6 S32(WP4.3):自动批准器的**只读白名单**不得越出 §33 权限目录。
   *
   * 自由裁量的地方最需要卡点。`createAutoApprover` 是"无人值守默认放行"——它一旦
   * 放行写类权限,审批管线就退化成摆设,而这件事**没有任何编译错误会提示**。
   * 两条断言各自能一句话说清:
   * - 只读集合 ⊆ §33 目录(防写入 spec 里不存在的权限名,那种拼写错会静默失效);
   * - 只读集合不含写类/提权类(`.write` / `provider.call`),即"只读"名副其实。
   * 检查手段是**跨文件双向比对**(types.ts 的目录 vs approval.ts 的集合),
   * 与 A/E 两组同构:任一侧单独改都不会红,两侧不一致才红。
   */
  it('D6 自动批准只读白名单必须是 §33 权限目录的真子集,且不含写类/提权类权限', () => {
    /** 从 `... = [ 'a', 'b' ]` 形态的代码块里抽出字符串字面量 */
    const quotedStringsIn = (src: string, startMarker: string, endMarker: string): string[] => {
      const start = src.indexOf(startMarker)
      expect(start, `定位失败:${startMarker} 缺失(格式变了?)`).toBeGreaterThanOrEqual(0)
      const end = src.indexOf(endMarker, start)
      expect(end, `定位失败:${startMarker} 之后的 ${endMarker} 缺失(格式变了?)`).toBeGreaterThan(start)
      return [...src.slice(start, end).matchAll(/'([a-z][a-z0-9._]*)'/g)].map((m) => m[1] as string)
    }

    const declared = quotedStringsIn(readText('packages/agent/src/tools/types.ts'), 'TOOL_PERMISSIONS = [', '] as const')
    expect(declared.length, '§33 权限目录解析为空').toBeGreaterThan(0)

    const readOnly = quotedStringsIn(readText('packages/agent/src/tools/approval.ts'), 'READ_ONLY_TOOL_PERMISSIONS = new Set([', '])')
    expect(readOnly.length, '只读白名单解析为空(自动批准器没了安全边界)').toBeGreaterThan(0)

    const unknown = readOnly.filter((p) => !declared.includes(p))
    expect(unknown, `只读白名单含 §33 目录外的权限名(拼写错会静默失效): ${unknown.join(', ')}`).toEqual([])

    const privileged = readOnly.filter((p) => p.endsWith('.write') || p === 'provider.call')
    expect(
      privileged,
      `只读白名单混进写类/提权类权限——自动批准会因此变成无条件放行: ${privileged.join(', ')}`,
    ).toEqual([])
  })

  /**
   * D7 S32(WP4.3):组合根必须**三件同批**装配审批门。
   *
   * 单独看每行都无害,漏掉任意一行却各自有不同后果——注册了工具但没 `requireApproval`
   * 就是审批被跳过;没有默认回答者就是搜索永远被拒。这类"少了一行"的问题在
   * 类型检查与单测里都是静默的(单测自己会装齐),只有组合根被直证才拦得住。
   */
  it('D7 组合根注册 web.search 时必须同批装好静态审批门与自动批准默认回答者', () => {
    const src = readText('apps/server/src/server.ts')
    expect(src, '组合根未注册 web.search 工具').toContain('createWebSearchToolDefinition(')
    expect(src, "组合根缺静态审批门(requireApproval)——工具会被静默跳过审批").toContain(
      'tools.requireApproval(WEB_SEARCH_TOOL_NAME)',
    )
    expect(src, '组合根缺默认回答者——无 UI 时 web.search 会被一律拒绝').toContain(
      'tools.approvals.setDefaultResponder(createAutoApprover(APPROVAL_GATED_TOOLS))',
    )
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
