import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { paraglide } from '@inlang/paraglide-unplugin'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    tailwindcss(),
    paraglide.vite({
      project: './project.inlang',
      outdir: './src/paraglide',
    }),
    tanstackStart({
      prerender: {
        enabled: true,
        filter: ({ path: routePath }) =>
          ['/', '/privacy', '/terms', '/data-deletion'].includes(routePath),
      },
    }),
    nitro(),
    viteReact(),
  ],
})
