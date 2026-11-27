import { defineConfig } from 'vite'
import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'
import { presetWind3 } from 'unocss'

const line = 'var(--ant-color-border-secondary)'
const muted = 'var(--ant-color-text-secondary)'

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    UnoCSS({
      presets: [presetWind3()],
      // 只做 antd 没有现成组件的少量布局；颜色全部走 antd 的 CSS 变量。
      shortcuts: {
        'text-muted': `text-[${muted}]`,
        'wrap-anywhere': '[overflow-wrap:anywhere]',
        'field-label': 'block mb-2',
        'editor-text': 'font-mono',
        'selection-list': `max-h-[45vh] overflow-auto border border-solid border-[${line}] rounded-lg`,
        'selection-row': 'flex items-center gap-3 px-4 py-3',
        'candidate-entry': `border-t border-t-solid border-t-[${line}] first:border-t-0`,
        'candidate-content': 'pb-2 pl-17 pr-3',
        'import-browser':
          'grid grid-cols-1 lg:grid-cols-[minmax(0,60%)_minmax(0,1fr)] gap-4 min-w-0 items-start',
        'import-group-empty': 'm-0 px-3 py-2.5 text-sm text-muted',
        'import-row-active': '[&>td]:bg-[var(--ant-color-primary-bg)]!',
        'import-row-in-repo':
          '[&>td]:bg-[var(--ant-color-success-bg)]! text-[var(--ant-color-text-secondary)]',
        'import-row-conflict': '[&>td]:bg-[var(--ant-color-warning-bg)]!',
        'import-editor': 'min-w-0 flex flex-col gap-2.5',
        'import-detail': 'min-w-0',
        'import-detail-plugin':
          'grid grid-cols-[minmax(130px,35%)_minmax(0,1fr)] gap-3',
        'plugin-files': `min-w-0 max-h-[55vh] overflow-auto pt-4 border-r border-r-solid border-r-[${line}]`,
        'plugin-files-title': 'px-2 pb-2 font-semibold',
        'import-editor-heading': 'flex items-center justify-between gap-2',
        'import-editor-text':
          'min-h-[320px]! h-[calc(100vh-200px)]! resize-none',
      },
    }),
  ],
  build: { outDir: '../../packages/cli/dist/ui', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:10107', changeOrigin: true } },
  },
})
