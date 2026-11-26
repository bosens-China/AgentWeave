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
import { basename, isAbsolute, join, relative } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import {
  MissingPluginSkillsError,
  pluginFromFiles,
  readPlugin,
} from '../central/plugin.js'
import {
  assertParents,
  checkName,
  fingerprint,
  keyOf,
  object,
  optional,
  pathState,
  validFilePath,
} from './files.js'
import { encodeServer } from './mcp-format.js'
import { executable, nativeName, safeNativeId } from './plugin-install.js'
import { planPiPlugins, readPiPlugins } from './pi-plugins.js'

type InventoryRecord = Pick<PluginEntry, 'path' | 'nativeId' | 'managedBy'> & {
  enabled: boolean
  bundledPath?: string
}

const bundledMarket = 'openai-bundled'
const managedReason = {
  builtin: '是平台内置插件，本次保留',
  'unverified-bundle': '的随附清单无法核实，本次保留',
  account: '由 Claude 账号同步，请在 Claude Code 中管理',
} as const

// Codex materializes its desktop marketplace under CODEX_HOME. A user marketplace
// with the same name but a different configured source is a regular marketplace.
async function codexBundledPackages(
  root: string,
  home: string,
  marketplaces: unknown,
): Promise<Map<string, string> | null> {
  let directory = join(root, '.tmp', 'bundled-marketplaces', bundledMarket)
  const registration = object(marketplaces)
    ? marketplaces[bundledMarket]
    : undefined
  if (registration !== undefined) {
    if (!object(registration) || typeof registration.source !== 'string')
      return null
    if (
      registration.source_type !== 'local' ||
      !isAbsolute(registration.source)
    )
      return new Map()
    const trusted = [directory]
    if (process.platform === 'darwin') {
      for (const parent of ['/Applications', join(home, 'Applications')]) {
        for (const app of ['ChatGPT.app', 'Codex.app'])
          trusted.push(
            join(parent, app, 'Contents/Resources/plugins', bundledMarket),
          )
      }
    }
    const source = registration.source
    const match = trusted.find((path) => relative(source, path) === '')
    if (!match) return new Map()
    directory = match
  }
  const catalogPath = join(directory, '.agents', 'plugins', 'marketplace.json')
  try {
    const catalog: unknown = JSON.parse(await readFile(catalogPath, 'utf8'))
    if (
      !object(catalog) ||
      catalog.name !== bundledMarket ||
      !Array.isArray(catalog.plugins)
    )
      return null
    const packages = new Map<string, string>()
    for (const entry of catalog.plugins) {
      if (!object(entry) || typeof entry.name !== 'string') return null
      if (
        object(entry.source) &&
        entry.source.source === 'local' &&
        typeof entry.source.path === 'string'
      ) {
        const path = entry.source.path.replace(/^\.\//, '')
        if (!validFilePath(path)) return null
        packages.set(entry.name, join(directory, path))
      }
    }
    return packages
  } catch {
    return null
  }
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
    const bundled = Object.keys(installed).some((id) =>
      id.endsWith('@' + bundledMarket),
    )
      ? await codexBundledPackages(root, target.home, parsed.marketplaces)
      : new Map<string, string>()
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
        let managedBy: InventoryRecord['managedBy']
        let bundledPath: string | undefined
        if (market === bundledMarket) {
          bundledPath = bundled?.get(id)
          if (bundledPath) managedBy = 'builtin'
          else if (!bundled) managedBy = 'unverified-bundle'
        }
        records.push({
          nativeId,
          managedBy,
          bundledPath,
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
          managedBy:
            market === 'builtin'
              ? 'builtin'
              : market === 'synced'
                ? 'account'
                : undefined,
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

// Some built-in install caches omit the Skills shipped in the desktop bundle.
async function readInstalledPlugin(
  home: string,
  record: InventoryRecord,
  kind: Exclude<NativePluginKind, 'pi'>,
  validate: boolean,
) {
  const options = { format: kind, validate }
  try {
    return {
      path: record.path,
      resource: await readPlugin(record.path, options),
    }
  } catch (error) {
    if (!(error instanceof MissingPluginSkillsError) || !record.bundledPath)
      throw error
    await assertParents(home, join(record.bundledPath, 'plugin.json'))
    let versioned = false
    for (const file of ['plugin.json', '.codex-plugin/plugin.json']) {
      const readManifest = (directory: string) =>
        optional((path) => readFile(path), join(directory, file))
      const [installed, shipped] = await Promise.all([
        readManifest(record.path),
        readManifest(record.bundledPath),
      ])
      if (!installed && !shipped) continue
      if (!installed || !shipped || !installed.equals(shipped)) throw error
      const manifest: unknown = JSON.parse(
        installed.toString('utf8').replace(/^\uFEFF/, ''),
      )
      if (
        object(manifest) &&
        typeof manifest.version === 'string' &&
        manifest.version &&
        manifest.name === record.nativeId?.split('@')[0]
      )
        versioned = true
    }
    if (!versioned) throw error
    return {
      path: record.bundledPath,
      resource: await readPlugin(record.bundledPath, options),
    }
  }
}

type PluginWarningSource = {
  warning: string
  pluginRoot: string
  builtin?: boolean
}

export async function readPlugins(
  target: NativeTarget,
  { validate = false } = {},
) {
  if (!target.plugin) throw new Error(`${target.name} 不支持完整插件`)
  const { kind } = target.plugin
  if (kind === 'pi')
    return {
      ...(await readPiPlugins(target)),
      kind: 'pi' as const,
      warningSources: [] as PluginWarningSource[],
    }
  const { records, warnings } = await readInventory(target)
  const warningSources: PluginWarningSource[] = []
  const entries: PluginEntry[] = []
  const unavailable = new Set<string>()
  for (const record of records.sort((a, b) => sorted(a.path, b.path))) {
    try {
      const { resource, path } = await readInstalledPlugin(
        target.home,
        record,
        kind,
        validate,
      )
      if (resource) {
        checkName(resource.id)
        entries.push({
          ...record,
          path,
          expected: await pathState(path),
          resource,
        })
      } else if (record.nativeId) throw new Error('无法识别插件清单')
    } catch (error) {
      if (record.nativeId)
        unavailable.add(record.nativeId.split('@')[0].toLowerCase())
      const warning = `${target.name} 的插件 ${record.nativeId ?? basename(record.path)}（${record.path}）：${errorMessage(error)}`
      warnings.push(warning)
      if (validate)
        warningSources.push({
          warning,
          pluginRoot: record.path,
          builtin: record.managedBy === 'builtin',
        })
    }
  }
  for (const message of warnings) {
    // A stale or disabled native installation still owns its registry identity.
    const token = message.match(/插件 ([a-zA-Z0-9_.-]+)@/)?.[1]
    if (token) unavailable.add(token.toLowerCase())
  }
  return {
    entries,
    warnings,
    warningSources,
    unavailable,
    kind: 'native' as const,
  }
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
    (format === 'codex' &&
      (resource.format === 'portable' ||
        !!resource.files?.['.codex-plugin/plugin.json']))
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
  const provided: Resource[] = []
  const existingProvided: Resource[] = []
  const installed = new Map<string, PluginEntry[]>()
  for (const entry of snapshot.entries) {
    if (entry.managedBy && entry.enabled)
      existingProvided.push(...(entry.resource.components ?? []))
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
      if (current?.managedBy) {
        warnings.push(`${resource.name} ${managedReason[current.managedBy]}`)
        continue
      }
      const payload = convertPlugin(resource, target, warnings)
      const beforeFingerprint = fingerprint(
        current ? packagePayload(current.resource) : null,
      )
      const delivered = pluginFromFiles(payload.files, payload.modes, kind)
      const keys = new Set(delivered?.components?.map(keyOf))
      const components = (resource.components ?? []).filter((c) =>
        keys.has(keyOf(c)),
      )
      if (current && beforeFingerprint === fingerprint(payload)) {
        if (current.enabled) existingProvided.push(...components)
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
      provided.push(...components)
    } catch (error) {
      warnings.push(`${resource.name} → ${target.name}：${errorMessage(error)}`)
    }
  }
  if (!selective)
    for (const [id, entries] of installed) {
      if (desiredNames.has(id)) continue
      for (const current of entries) {
        if (current.managedBy) {
          warnings.push(
            `${current.resource.name} ${managedReason[current.managedBy]}`,
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
    return {
      changes: [],
      operations: [],
      pluginOperations: [],
      provided: existingProvided,
    }
  }
  return {
    changes,
    operations,
    pluginOperations,
    provided: [...existingProvided, ...provided],
  }
}

export { applyPluginOperations } from './plugin-install.js'
