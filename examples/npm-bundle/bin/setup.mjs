#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const testedVersion = '0.1.0'
const feature = 'distribute-npm-bundle'
const bundle = fileURLToPath(new URL('../', import.meta.url))
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    agentweave: { type: 'string' },
    'with-npx': { type: 'boolean' },
    apply: { type: 'boolean' },
    yes: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  },
})

function invoke(candidate, args, inherit = false) {
  return spawnSync(candidate[0], [...candidate.slice(1), ...args], {
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  })
}

function compatible(candidate) {
  const result = invoke(candidate, ['capabilities', '--json'])
  if (result.status !== 0) return false
  try {
    const found = JSON.parse(result.stdout)
    return found.apiVersions.includes(1) && found.features.includes(feature)
  } catch {
    return false
  }
}

function localInstallation() {
  try {
    const require = createRequire(join(process.cwd(), 'package.json'))
    const pkg = require.resolve('agentweave-cli/package.json')
    return [process.execPath, join(dirname(pkg), 'dist/cli.mjs')]
  } catch {
    return undefined
  }
}

function findAgentWeave() {
  if (values.agentweave) {
    const path = resolve(values.agentweave)
    const command = /\.[cm]?js$/u.test(path) ? [process.execPath, path] : [path]
    if (!compatible(command))
      throw new Error('指定的 AgentWeave 不支持 npm 包分发接口 v1。')
    return command
  }
  const candidates = [localInstallation()]
  for (const path of (process.env.PATH ?? '')
    .split(delimiter)
    .filter(isAbsolute)) {
    const command =
      process.platform === 'win32'
        ? [
            process.execPath,
            join(path, 'node_modules', 'agentweave-cli', 'dist', 'cli.mjs'),
          ]
        : [join(path, 'agentweave')]
    if (existsSync(command.at(-1))) candidates.push(command)
  }
  const installed = candidates.find(
    (candidate) => candidate && compatible(candidate),
  )
  if (installed) return installed
  if (!values['with-npx'])
    throw new Error(
      `未找到兼容的 AgentWeave。可安装 agentweave-cli@${testedVersion} 后重试，或加 --with-npx 允许 npm 下载这个版本。`,
    )
  const npm =
    basename(process.env.npm_execpath ?? '') === 'npm-cli.js'
      ? process.env.npm_execpath
      : undefined
  const command = npm ? [process.execPath, npm, 'exec'] : ['npx']
  const fallback = [
    ...command,
    '--yes',
    `--package=agentweave-cli@${testedVersion}`,
    '--',
    'agentweave',
  ]
  if (!compatible(fallback))
    throw new Error(
      `agentweave-cli@${testedVersion} 无法运行或未通过兼容性检查。`,
    )
  return fallback
}

try {
  if (values.help || positionals.length === 0) {
    console.log(
      'agentweave-example-bundle setup --agent AGENT [--apply] [--yes] [--with-npx]',
    )
  } else {
    if (positionals.length !== 1 || positionals[0] !== 'setup' || !values.agent)
      throw new Error('用法为 setup --agent AGENT。')
    const agentweave = findAgentWeave()
    const args = ['distribute', '--from', bundle, '--target', values.agent]
    for (const flag of ['apply', 'yes', 'json'])
      if (values[flag]) args.push(`--${flag}`)
    const result = invoke(agentweave, args, true)
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
