import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: ['**/example*.ts'],
      include: ['src/**'],
      provider: 'v8',
    },
    passWithNoTests: true,
  },
})
