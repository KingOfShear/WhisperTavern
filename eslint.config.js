// @ts-check
// WhisperTavern ESLint flat config(根唯一,子包经向上解析共用)。
// 代码风格底线 = AGENTS.md 纪律 6:显式类型(禁 any 出口)、小函数、单向依赖;
// 机械执行交给本配置 + tsc --strict(technical-plan §7)。
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 非代码目录:外部参照(只读)、用户资产、文档、运行态、测试金样一律不 lint
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'reference/**',
      '酒馆参考文件/**',
      'docs/**',
      'data/**',
      '.workbuddy/**',
      'tests/fixtures/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // shared-contracts-spec §2 Unknown Boundary:禁 any,unknown 由调用侧 narrowing
      '@typescript-eslint/no-explicit-any': 'error',
      // `_` 前缀 = 有意不使用(如接口方法未用到的参数),不算疏漏
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // 依赖方向约束(shared-contracts-spec §1 / S2 验收):contracts 是 DAG 最底层,
    // 零 IO、零工作区依赖;违规导入在 lint 门禁直接红。
    files: ['packages/contracts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'node', 'fs', 'path', 'crypto', 'http', 'https', 'net', 'stream', 'os'],
              message: 'contracts 零 IO:禁止 Node 内建模块(shared-contracts-spec §1 依赖方向)',
            },
            {
              group: ['@whispertavern/*'],
              message: 'contracts 不引用任何工作区包(依赖方向最底层)',
            },
          ],
        },
      ],
    },
  },
  {
    // core 零 IO(p0-plan S3 验收):生产源码禁 Node 内建;测试基建(*.test.ts)
    // 需 fs/path/url 做 import 约束扫描,豁免。
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'node', 'fs', 'path', 'crypto', 'http', 'https', 'net', 'stream', 'os'],
              message: 'core 纯 TS 无 IO(总设计 §7):禁止 Node 内建模块',
            },
            {
              group: ['@whispertavern/runtime', '@whispertavern/agent', '@whispertavern/adapters', '@whispertavern/api-types', '@whispertavern/st-compat'],
              message: 'core → contracts 单向依赖,禁引用其余工作区包(provider-adapter-spec §4)',
            },
          ],
        },
      ],
    },
  },
)
