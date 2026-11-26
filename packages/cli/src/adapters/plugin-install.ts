import { agentExecutable } from './installed.js'
import { errorMessage } from '../errors.js'
import type { NativeTarget, PluginOperation, Tree } from './types.js'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  applyFileOperations,
  assertParents,
  checkName,
  fingerprint,
  object,
  optional,
  pathState,
  readTree,
} from './files.js'

const exec = promisify(execFile)
const jsonFile = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString('base64')
export const marketPath = {
  codex: '.agents/plugins/marketplace.json',
  claude: '.claude-plugin/marketplace.json',
}

async function snapshot(path: string) {
  const { files, modes = {} } = await readTree(path)
  return { files, modes }
}

export function nativeName(value: unknown) {
  const name = checkName(value)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(name))
    throw new Error(`无法识别原生插件名称：${value}`)
  return name
}

export function safeNativeId(value: string) {
  const [id, market, ...rest] = value.split('@')
  if (rest.length || !market) throw new Error('无法识别原生插件标识')
  return [nativeName(id), nativeName(market)]
}

export async function executable(target: NativeTarget) {
  return target.plugin
    ? agentExecutable(target.plugin.kind, target.home, true)
    : null
}

async function runNative(target: NativeTarget, binary: string, args: string[]) {
  if (!target.plugin) throw new Error(`${target.name} 不支持完整插件`)
  const cwd = target.home
  const location =
    target.plugin.kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const env = {
    ...process.env,
    HOME: cwd,
    USERPROFILE: cwd,
    [location]: target.plugin.root,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    CI: '1',
  }
  try {
    return (
      await exec(binary, ['plugin', ...args], {
        cwd,
        env,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
    ).stdout
  } catch (error) {
    const useful =
      object(error) && typeof error.stderr === 'string'
        ? error.stderr.trim().split('\n').at(-1)
        : undefined
    throw new Error(
      `${target.name} 的插件命令 ${args.slice(0, 2).join(' ')} 失败${useful ? `：${useful}` : ''}`,
      { cause: error },
    )
  }
}

function marketName(id: string, payload: Tree) {
  return `agentweave-${id.toLowerCase().slice(0, 36)}-${fingerprint(payload).slice(0, 24)}`
}

function marketplaceFiles(
  kind: keyof typeof marketPath,
  market: string,
  id: string,
  payload: Tree,
): Tree {
  const source = `./plugins/${id}`
  const manifest =
    kind === 'codex'
      ? {
          name: market,
          interface: { displayName: `AgentWeave · ${id}` },
          plugins: [
            {
              name: id,
              source: { source: 'local', path: source },
              policy: {
                installation: 'AVAILABLE',
                authentication: 'ON_INSTALL',
              },
              category: 'Productivity',
            },
          ],
        }
      : {
          name: market,
          owner: { name: 'AgentWeave' },
          plugins: [{ name: id, source }],
        }
  const files = Object.fromEntries(
    Object.entries(payload.files).map(([path, value]) => [
      `plugins/${id}/${path}`,
      value,
    ]),
  )
  const modes = Object.fromEntries(
    Object.entries(payload.modes ?? {}).map(([path, value]) => [
      `plugins/${id}/${path}`,
      value,
    ]),
  )
  files[marketPath[kind]] = jsonFile(manifest)
  return { files, modes }
}

async function assertNativeRoot(target: NativeTarget) {
  if (!target.plugin) throw new Error(`${target.name} 不支持完整插件`)
  const paths =
    target.plugin.kind === 'codex'
      ? ['config.toml', 'plugins/cache/.agentweave-check']
      : [
          'settings.json',
          'plugins/installed_plugins.json',
          'plugins/known_marketplaces.json',
          'plugins/cache/.agentweave-check',
        ]
  for (const name of paths) {
    const path = join(target.plugin.root, name)
    await assertParents(target.home, path)
    const info = await optional(lstat, path)
    if (info && !info.isFile())
      throw new Error(`${target.name} 的配置路径不可安全写入：${path}`)
  }
  await mkdir(target.plugin.root, { recursive: true, mode: 0o700 })
}

export async function applyPluginOperations(
  target: NativeTarget,
  operations: PluginOperation[],
) {
  if (!operations.length) return
  const plugin = target.plugin
  if (!plugin || (plugin.kind !== 'codex' && plugin.kind !== 'claude'))
    throw new Error('目标不支持原生插件命令')
  const kind = plugin.kind
  const codex = kind === 'codex'
  const binary = await executable(target)
  if (!binary) throw new Error(`找不到 ${target.name} 的命令行程序`)
  await assertNativeRoot(target)
  const run = (args: string[]) => runNative(target, binary, args)
  const install = (nativeId: string) =>
    run(
      codex
        ? ['add', nativeId, '--json']
        : ['install', nativeId, '--scope', 'user'],
    )
  const uninstall = (nativeId: string) =>
    run(
      codex
        ? ['remove', nativeId, '--json']
        : ['uninstall', nativeId, '--scope', 'user'],
    )
  const root = join(plugin.root, 'plugins/agentweave-marketplaces')
  let completed = 0
  try {
    for (const operation of operations) {
      await applyOne(operation)
      completed += 1
    }
  } catch (error) {
    if (!completed) throw error
    throw new Error(
      `已同步 ${completed} 个插件。${errorMessage(error)}。请重新预览当前差异`,
      { cause: error },
    )
  }
  async function applyOne(operation: PluginOperation) {
    const { id, payload, current } = operation
    const previous = current?.nativeId
    if (!payload) {
      if (!previous) throw new Error('缺少原生插件标识')
      await uninstall(previous)
      await cleanMarketplace(previous)
      return
    }
    const market = marketName(id, payload)
    const nativeId = `${id}@${market}`
    const directory = join(root, market)
    const state = await pathState(directory)
    const bundle = marketplaceFiles(kind, market, id, payload)
    // Create a new immutable source so a failed version update can leave the old installation intact.
    if (!state)
      await applyFileOperations(target.home, [
        { path: directory, expected: null, ...bundle },
      ])
    await assertParents(target.home, directory)
    const original = await lstat(directory)
    if (
      !original.isDirectory() ||
      fingerprint(await snapshot(directory)) !== fingerprint(bundle)
    ) {
      throw new Error(`插件的本地安装来源已变化：${directory}`)
    }
    let registered = false
    let installed = false
    try {
      await run(['marketplace', 'add', directory, ...(codex ? ['--json'] : [])])
      registered = true
      await install(nativeId)
      installed = true
      if (previous && previous !== nativeId) await uninstall(previous)
    } catch (error) {
      if (installed) await uninstall(nativeId).catch(() => {})
      if (registered) await cleanMarketplace(nativeId).catch(() => {})
      throw error
    }
    if (previous && previous !== nativeId) await cleanMarketplace(previous)
  }
  async function cleanMarketplace(nativeId: string) {
    const [, market] = safeNativeId(nativeId)
    if (!/^agentweave-[a-z0-9._-]+-[a-f0-9]{24}$/.test(market)) return
    const directory = join(root, market)
    if (!(await pathState(directory))) return
    await assertParents(target.home, directory)
    await run(['marketplace', 'remove', market, ...(codex ? ['--json'] : [])])
    await rm(directory, { recursive: true, force: true })
  }
}
