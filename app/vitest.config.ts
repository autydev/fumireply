import { defineConfig } from 'vitest/config'
import viteReact from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
    // Deduplicate shared packages to ensure integration tests that import
    // from sibling packages (webhook/, ai-worker/) use the same module instance
    // as the test file itself, so vi.mock() intercepts correctly.
    dedupe: [
      '@anthropic-ai/sdk',
      '@aws-sdk/client-sqs',
      '@aws-sdk/client-ssm',
      'drizzle-orm',
      'postgres',
      'zod',
    ],
  },
  plugins: [viteReact()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: [
      'src/**/*.test.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
    ],
  },
})
