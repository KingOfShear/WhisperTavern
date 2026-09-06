import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'contracts',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
