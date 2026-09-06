import { defineConfig } from 'vitest/config'

// Vitest workspace 根配置:projects 聚合各包/应用的配置(vitest 3.2+ projects 语义)。
// 各包测试互不串扰(独立 name / include);根命令 `vitest run` / `pnpm coverage` 由此入口。
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
})
