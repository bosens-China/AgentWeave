import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
if (existsSync(new URL('../.git', import.meta.url))) {
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const existing = git('config', '--local', '--get', 'core.hooksPath')
  if (existing.status === 1) {
    const result = git('config', '--local', 'core.hooksPath', '.githooks')
    if (result.status !== 0)
      throw new Error(result.stderr || '无法启用工作区预提交检查。')
  }
}
