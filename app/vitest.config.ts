import { defineConfig } from 'vitest/config'
import viteReact from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
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
