import { defineConfig } from 'vitest/config'

// Vitest workspace 根配置:projects 聚合各包/应用的配置(vitest 3.2+ projects 语义)。
// 各包测试互不串扰(独立 name / include);根命令 `vitest run` / `pnpm coverage` 由此入口。
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      // 架构守卫(AGENTS §3 纪律的机器卡点):仓库级,不归属任何包,故 inline 挂在此处。
      // 它读写 docs/ 与 package.json,放在包内会破坏包的单向依赖边界。
      {
        extends: true,
        test: {
          name: 'architecture',
          root: '.',
          include: ['tests/**/*.test.ts'],
        },
      },
    ],
  },
})
