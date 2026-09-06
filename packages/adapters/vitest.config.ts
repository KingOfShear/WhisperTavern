import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'adapters',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
