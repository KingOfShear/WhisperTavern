import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'st-compat',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
