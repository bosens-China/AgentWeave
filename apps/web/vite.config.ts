import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'
import { presetWind3 } from 'unocss'

export default defineConfig({
  plugins: [react(), UnoCSS({ presets: [presetWind3()] })],
  build: { outDir: '../../packages/cli/dist/ui', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:10107', changeOrigin: true } },
  },
})
