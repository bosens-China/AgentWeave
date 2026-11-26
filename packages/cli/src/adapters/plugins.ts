import type { Resource, SyncChange } from '@agentweave/protocol'
import type { ParseError } from 'jsonc-parser'
import { errorMessage } from '../errors.js'
import type {
  NativePluginKind,
  NativeTarget,
  PluginEntry,
  PluginOperation,
  SectionPlan,
  Tree,
} from './types.js'
import { readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import { pluginFromFiles, readPlugin } from '../central/plugin.js'
import {
  checkName,
  fingerprint,
  keyOf,
  object,
  optional,
  pathState,
} from './files.js'
import { encodeServer } from './mcp-format.js'
import { executable, nativeName, safeNativeId } from './plugin-install.js'
import { planPiPlugins, readPiPlugins } from './pi-plugins.js'

type InventoryRecord = {
  path: string
  enabled: boolean
  nativeId?: string
  accountManaged?: boolean
}

const base64 = (text: string) => Buffer.from(text).toString('base64')
const jsonFile = (value: unknown) =>
  base64(`${JSON.stringify(value, null, 2)}\n`)
const sorted = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true })
const manifestPath = {
  codex: 'plugin.json',
  claude: '.claude-plugin/plugin.json',
  cursor: '.cursor-plugin/plugin.json',
  antigravity: '.antigravity-plugin/plugin.json',
}

async function readInventory(target: NativeTarget) {
  if (!target.plugin) throw new Error(`${target.name} 不支持完整插件`)
  const { kind, root } = target.plugin
  const records: InventoryRecord[] = []
  const warnings: string[] = []
  if (kind === 'codex') {
    const contents = await optional(readFile, join(root, 'config.toml'))
    const parsed = contents ? parseToml(contents.toString()) : {}
    const installed = object(parsed.plugins) ? parsed.plugins : {}
    for (const [nativeId, data] of Object.entries(installed)) {
      try {
        const [id, market] = safeNativeId(nativeId)
        const cache = join(root, 'plugins/cache', market, id)
        const versions = await optional(
          (path) => readdir(path, { withFileTypes: true }),
          cache,
        )
        const latest = versions
          ?.filter((item) => item.isDirectory() && !item.name.startsWith('.'))
          .map((item) => item.name)
          .sort(sorted)
          .at(-1)
        if (!latest) throw new Error('插件缺少本机缓存，无法读取已安装内容')
        records.push({
          nativeId,
          path: join(cache, latest),
          enabled: !object(data) || data.enabled !== false,
        })
      } catch (error) {
        warnings.push(
          `${target.name} 的插件 ${nativeId}：${errorMessage(error)}`,
        )
      }
    }
  } else if (kind === 'claude') {
    const contents = await optional(
      readFile,
      join(root, 'plugins/installed_plugins.json'),
    )
    const registry: unknown = contents ? JSON.parse(contents.toString()) : {}
    if (!object(registry)) throw new Error('Claude Code 插件清单格式无效')
    const settingsContents = await optional(
      readFile,
      join(root, 'settings.json'),
    )
    const settingsErrors: ParseError[] = []
    const settings = settingsContents
      ? parseJsonc(settingsContents.toString(), settingsErrors, {
          allowTrailingComma: true,
        })
      : {}
    if (!object(settings) || settingsErrors.length)
      throw new Error('Claude Code 的全局设置格式无效')
    if (registry.plugins !== undefined && !object(registry.plugins))
      throw new Error('Claude Code 插件清单格式无效')
    for (const [nativeId, versions] of Object.entries(registry.plugins ?? {})) {
      try {
        const [, market] = safeNativeId(nativeId)
        if (!Array.isArray(versions)) throw new Error('插件安装记录格式无效')
        const user = versions.find(
          (item: unknown): item is Record<string, unknown> =>
            object(item) && item.scope === 'user',
        )
        if (!user) continue
        if (
          typeof user.installPath !== 'string' ||
          !isAbsolute(user.installPath)
        )
          throw new Error('插件缓存路径无效')
        records.push({
          nativeId,
          path: user.installPath,
          enabled:
            !object(settings.enabledPlugins) ||
            settings.enabledPlugins[nativeId] !== false,
          accountManaged: market === 'synced',
        })
      } catch (error) {
        warnings.push(
          `${target.name} 的插件 ${nativeId}：${errorMessage(error)}`,
        )
      }
    }
  } else {
    const directory = await optional(
      (path) => readdir(path, { withFileTypes: true }),
      root,
    )
    for (const entry of directory ?? []) {
      if (!entry.name.startsWith('.') && entry.isDirectory())
        records.push({ path: join(root, entry.name), enabled: true })
    }
  }
  return { records, warnings }
}

export async function readPlugins(
  target: NativeTarget,
  { validate = false } = {},
) {
  if (!target.plugin) throw new Error(`${target.name} 不支持完整插件`)
  const { kind } = target.plugin
  if (kind === 'pi')
    return { ...(await readPiPlugins(target)), kind: 'pi' as const }
  const { records, warnings } = await readInventory(target)
  const entries: PluginEntry[] = []
  const unavailable = new Set<string>()
  for (const record of records.sort((a, b) => sorted(a.path, b.path))) {
    try {
      const resource = await readPlugin(record.path, { format: kind, validate })
      if (resource) {
        checkName(resource.id)
        entries.push({
          ...record,
          expected: await pathState(record.path),
          resource,
        })
      } else if (record.nativeId) throw new Error('无法识别插件清单')
    } catch (error) {
      if (record.nativeId)
        unavailable.add(record.nativeId.split('@')[0].toLowerCase())
      warnings.push(
        `${target.name} 的插件 ${record.nativeId ?? basename(record.path)}（${record.path}）：${errorMessage(error)}`,
      )
    }
  }
  for (const message of warnings) {
    // A stale or disabled native installation still owns its registry identity.
    const token = message.match(/插件 ([a-zA-Z0-9_.-]+)@/)?.[1]
    if (token) unavailable.add(token.toLowerCase())
  }
  return { entries, warnings, unavailable, kind: 'native' as const }
}

function packagePayload(resource: Resource): Tree {
  return { files: resource.files ?? {}, modes: resource.modes ?? {} }
}

function readPackageDescription(resource: Resource) {
  const format = resource.format
  const path =
    format && format !== 'pi' && format !== 'portable'
      ? manifestPath[format]
      : 'plugin.json'
  const manifest = resource.files?.[path]
  if (!manifest) return resource.name
  try {
    const { description } = JSON.parse(
      Buffer.from(manifest, 'base64').toString(),
    )
    return typeof description === 'string' && description.trim()
      ? description
      : resource.name
  } catch {
    return resource.name
  }
}

export function convertPlugin(
  resource: Resource,
  target: Pick<NativeTarget, 'id' | 'name'> & {
    plugin?: { kind: NativePluginKind }
  },
  warnings: string[],
): Tree {
  if (!target.plugin || target.plugin.kind === 'pi')
    throw new Error(`${target.name} 不支持此插件格式`)
  const format = target.plugin.kind
  if (
    resource.format === format ||
    (format === 'codex' && resource.format === 'portable')
  ) {
    if (
      !resource.files ||
      !pluginFromFiles(resource.files, resource.modes, format)
    )
      throw new Error('原始插件清单无效')
    if (resource.unsupported?.includes('hooks'))
      warnings.push(
        `${resource.name} 含有原生 hooks，启用后会由 ${target.name} 执行`,
      )
    return packagePayload(resource)
  }
  const files: Tree['files'] = {}
  const modes: Record<string, number> = {}
  const servers: [string, Record<string, unknown>][] = []
  const unsupported = new Set(resource.unsupported ?? [])
  for (const item of resource.components ?? []) {
    if (
      item.kind === 'skill' &&
      item.files &&
      Object.hasOwn(item.files, 'SKILL.md')
    ) {
      const prefix = `skills/${checkName(item.id)}/`
      for (const [path, data] of Object.entries(item.files))
        files[`${prefix}${path}`] = data
      for (const [path, mode] of Object.entries(item.modes ?? {}))
        modes[`${prefix}${path}`] = mode
    } else if (item.kind === 'mcp') {
      try {
        const variant = ['claude', 'antigravity'].includes(format)
          ? format
          : 'standard'
        const portable = format === 'codex'
        const config = encodeServer(
          item,
          { ...target, mcp: { variant } },
          {},
          warnings,
        )
        if (portable) {
          if (item.config?.type === 'sse')
            throw new Error('便携插件格式无法表达 SSE')
          config.type = item.config?.url ? 'streamable-http' : 'stdio'
        }
        servers.push([checkName(item.id), config])
      } catch (error) {
        warnings.push(
          `${resource.name} / MCP ${item.name} → ${target.name}：${errorMessage(error)}`,
        )
      }
    } else {
      unsupported.add(item.kind === 'instructions' ? 'AGENTS.md' : item.kind)
    }
  }
  if (unsupported.size)
    warnings.push(
      `${resource.name} → ${target.name}：无法随插件转换 ${[...unsupported].join('、')}`,
    )
  if (!Object.keys(files).length && !servers.length)
    throw new Error('插件中没有目标可用的组件')
  const manifest: {
    name: string
    version: string
    description: string
    $schema?: string
  } = {
    name: checkName(resource.id),
    version: '1.0.0',
    description: readPackageDescription(resource),
  }
  if (format === 'codex')
    manifest.$schema =
      'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
  if (servers.length) {
    const config: { mcpServers: Record<string, unknown>; $schema?: string } = {
      mcpServers: Object.fromEntries(servers),
    }
    if (format === 'codex')
      config.$schema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
    files[format === 'codex' ? 'mcp.json' : '.mcp.json'] = jsonFile(config)
  }
  files[manifestPath[format]] = jsonFile(manifest)
  return { files, modes }
}

export async function planPlugins(
  target: NativeTarget,
  snapshot: Awaited<ReturnType<typeof readPlugins>>,
  desired: Map<string, Resource>,
  selective: boolean,
  warnings: string[],
): Promise<SectionPlan> {
  if (!target.plugin) throw new Error(`${target.name} 不支持完整插件`)
  const { kind, root } = target.plugin
  if (snapshot.kind === 'pi')
    return planPiPlugins(target, snapshot, desired, selective, warnings)
  const native = kind === 'codex' || kind === 'claude'
  const changes: SectionPlan['changes'] = []
  const operations: SectionPlan['operations'] = []
  const pluginOperations: PluginOperation[] = []
  const installed = new Map<string, PluginEntry[]>()
  for (const entry of snapshot.entries) {
    const id = entry.resource.id.toLowerCase()
    installed.set(id, [...(installed.get(id) ?? []), entry])
  }
  const desiredNames = new Set()
  for (const resource of desired.values()) {
    const id = checkName(resource.id).toLowerCase()
    if (desiredNames.has(id))
      throw new Error(`中央仓库中存在大小写冲突的插件：${id}`)
    desiredNames.add(id)
    const entries = installed.get(id) ?? []
    if (entries.length > 1 || snapshot.unavailable.has(id)) {
      warnings.push(
        `${target.name} 的插件 ${resource.id} 存在多份安装或无法读取原版本，本次保留`,
      )
      continue
    }
    try {
      const current = entries[0]
      const payload = convertPlugin(resource, target, warnings)
      const beforeFingerprint = fingerprint(
        current ? packagePayload(current.resource) : null,
      )
      if (current && beforeFingerprint === fingerprint(payload)) continue
      if (current?.accountManaged) {
        warnings.push(
          `${resource.name} 由 Claude 账号同步，请在 Claude Code 中管理`,
        )
        continue
      }
      const path =
        current?.path ??
        (native ? join(root, 'plugins') : join(root, resource.id))
      if (!native && !current && (await pathState(path)))
        throw new Error(`目标已有无法识别的内容：${path}`)
      const change: SyncChange = {
        action: current ? 'overwrite' : 'add',
        key: keyOf(resource),
        name: resource.name,
        kind: 'plugin',
        path,
      }
      if (native) {
        nativeName(resource.id)
        if (current?.enabled === false)
          warnings.push(`${resource.name} 当前已停用，覆盖安装后会启用`)
        pluginOperations.push({
          id: resource.id,
          payload,
          current,
          beforeFingerprint,
        })
      } else
        operations.push({
          path,
          expected: current?.expected ?? null,
          beforeFingerprint,
          verifyTree: Boolean(current),
          ...payload,
        })
      changes.push(change)
    } catch (error) {
      warnings.push(`${resource.name} → ${target.name}：${errorMessage(error)}`)
    }
  }
  if (!selective)
    for (const [id, entries] of installed) {
      if (desiredNames.has(id)) continue
      for (const current of entries) {
        if (current.accountManaged) {
          warnings.push(
            `${current.resource.name} 由 Claude 账号同步，请在 Claude Code 中管理`,
          )
          continue
        }
        const beforeFingerprint = fingerprint(packagePayload(current.resource))
        const change: SyncChange = {
          action: 'delete',
          key: keyOf(current.resource),
          name: current.resource.name,
          kind: 'plugin',
          path: current.path,
        }
        if (native)
          pluginOperations.push({
            id: current.resource.id,
            current,
            beforeFingerprint,
          })
        else
          operations.push({
            path: current.path,
            expected: current.expected,
            beforeFingerprint,
            verifyTree: true,
          })
        changes.push(change)
      }
    }
  if (pluginOperations.length && !(await executable(target))) {
    warnings.push(`缺少 ${target.name} 的命令行程序，当前只可扫描已安装插件`)
    return { changes: [], operations: [], pluginOperations: [] }
  }
  return { changes, operations, pluginOperations }
}

export { applyPluginOperations } from './plugin-install.js'
