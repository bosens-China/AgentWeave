import { defineConfig } from '@rspress/core'

export default defineConfig({
  root: 'docs',
  outDir: 'dist',
  lang: 'zh',
  title: 'AgentWeave',
  description: '管理本机 Agent 的 Skills、MCP、全局指令和插件。',
  markdown: { link: { checkDeadLinks: true, checkAnchors: true } },
  themeConfig: {
    nav: [
      {
        text: '使用指南',
        link: '/guide/getting-started',
        activeMatch: '^/guide/',
      },
      { text: '参考', link: '/reference/cli', activeMatch: '^/reference/' },
      { text: '开发', link: '/development' },
    ],
    sidebar: {
      '/': [
        {
          text: '使用指南',
          items: [
            { text: '快速上手', link: '/guide/getting-started' },
            { text: '同步资源', link: '/guide/sync' },
            { text: 'GitHub 来源', link: '/guide/github' },
            { text: 'npm 包接入', link: '/guide/npm-bundle' },
          ],
        },
        {
          text: '参考',
          items: [
            { text: 'CLI 命令', link: '/reference/cli' },
            { text: '支持的 Agent', link: '/reference/agents' },
          ],
        },
        {
          text: '开发',
          items: [{ text: '开发说明', link: '/development' }],
        },
      ],
    },
    footer: { message: 'MIT License · © 2026 yliu' },
  },
})
