import type { PluginFormat, Resource, ResourceKind } from '@agentweave/protocol'
import type { Tree } from '../adapters/types.js'
import { errorCode, errorMessage } from '../errors.js'
import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { readTree, validFilePath, validResourceId } from '../adapters/files.js'
import { decodeServer } from '../adapters/mcp-format.js'
import { skillName, utf8Text, validateImport } from './validation.js'

const nativeManifests = {
  codex: ['.codex-plugin/plugin.json'],
  claude: ['.claude-plugin/plugin.json'],
  cursor: ['.cursor-plugin/plugin.json'],
  antigravity: [
    '.antigravity-plugin/plugin.json',
    '.gemini-plugin/plugin.json',
  ],
}
const nativeManifestPaths = Object.values(nativeManifests).flat()
const portableSchema =
  /^https:\/\/agent-plugins\.org\/schemas\/[^/]+\/plugin\.schema\.json$/
const maxPackageBytes = 32 * 1024 * 1024

function toText(content: string) {
  return Buffer.from(content, 'base64')
    .toString('utf8')
    .replace(/^\uFEFF/, '')
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonAt(files: Tree['files'], path: string) {
  if (!Object.hasOwn(files, path)) return null
  try {
    const value: unknown = JSON.parse(
      utf8Text(Buffer.from(files[path], 'base64')).replace(/^\uFEFF/, ''),
    )
    if (!objectRecord(value)) throw new Error()
    return value
  } catch {
    throw new Error(`${path} 必须是有效的 UTF-8 JSON 对象`)
  }
}

function subtree<T>(
  entries: Record<string, T> | undefined,
  directory: string,
): Record<string, T> {
  const prefix = directory ? `${directory}/` : ''
  return Object.fromEntries(
    Object.entries(entries ?? {})
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => [path.slice(prefix.length), content]),
  )
}

function portablePath(path: unknown) {
  if (typeof path !== 'string') throw new Error('插件路径必须是相对路径')
  const normalized = path.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (!validFilePath(normalized))
    throw new Error(`插件路径必须位于包内：${path}`)
  return normalized
}

function skillFromFiles(
  files: Tree['files'],
  modes: Record<string, number>,
  id: string,
): Resource | null {
  if (!Object.hasOwn(files, 'SKILL.md')) return null
  if (!validResourceId(id)) throw new Error(`无效的 Skill 目录名：${id}`)
  const name = skillName(toText(files['SKILL.md']), id)
  const skill: Resource = { kind: 'skill', id, name, files }
  if (Object.keys(modes).length) skill.modes = modes
  return skill
}

function findSkills(
  files: Tree['files'],
  modes: Record<string, number>,
  directory: string,
) {
  const found: { directory: string; resource: Resource }[] = []
  const prefix = directory ? `${directory}/` : ''
  const paths = Object.keys(files).sort(
    (left, right) => left.split('/').length - right.split('/').length,
  )
  for (const path of paths) {
    if (!path.startsWith(prefix) || !path.endsWith('/SKILL.md')) continue
    const parent = posix.dirname(path)
    if (found.some(({ directory }) => parent.startsWith(`${directory}/`)))
      continue
    const resource = skillFromFiles(
      subtree(files, parent),
      subtree(modes, parent),
      posix.basename(parent),
    )
    if (resource) found.push({ directory: parent, resource })
  }
  return found
}

export function mcpResources(
  document: Record<string, unknown>,
  format?: PluginFormat,
  onInvalid?: (message: string) => void,
): Resource[] {
  const servers = Object.hasOwn(document, 'mcpServers')
    ? document.mcpServers
    : Object.hasOwn(document, 'mcp_servers')
      ? document.mcp_servers
      : document
  if (!objectRecord(servers)) throw new Error('MCP 配置必须包含服务器对象')
  const resources: Resource[] = []
  for (const [id, value] of Object.entries(servers)) {
    try {
      if (!validResourceId(id) || !objectRecord(value))
        throw new Error('需要有效的名称和配置对象')
      const config = decodeServer(value, {
        id: format === 'portable' ? '' : (format ?? ''),
        name: 'MCP',
        mcp: { variant: format ?? 'portable' },
      })
      resources.push({ kind: 'mcp', id, name: id, config })
    } catch (error) {
      onInvalid?.(`MCP「${id}」：${errorMessage(error)}`)
    }
  }
  return resources
}

function pluginMcp(
  files: Tree['files'],
  declaration: unknown,
  format: PluginFormat,
  validate: boolean,
  required: boolean,
) {
  const entries = Array.isArray(declaration) ? declaration : [declaration]
  return entries.flatMap((entry) => {
    const path = typeof entry === 'string' ? portablePath(entry) : undefined
    const document = path ? jsonAt(files, path) : entry
    if (!objectRecord(document)) {
      if (validate && required)
        throw new Error(
          path
            ? `找不到插件声明的 MCP 文件 ${path}`
            : '插件 mcpServers 必须是 JSON 对象或相对路径',
        )
      return []
    }
    return mcpResources(
      document,
      format,
      validate
        ? (message) => {
            throw new Error(path ? `${path}：${message}` : message)
          }
        : undefined,
    )
  })
}

function readManifest(
  files: Tree['files'],
  preferredFormat?: PluginFormat,
): { manifest: Record<string, unknown>; format: PluginFormat } | null {
  const root = jsonAt(files, 'plugin.json')
  if (typeof root?.$schema === 'string' && portableSchema.test(root.$schema))
    return { manifest: root, format: 'portable' }
  const formats = preferredFormat
    ? [preferredFormat]
    : (Object.keys(nativeManifests) as (keyof typeof nativeManifests)[])
  for (const format of formats) {
    if (format === 'pi' || format === 'portable') continue
    for (const path of nativeManifests[format]) {
      const manifest = jsonAt(files, path)
      if (manifest) return { manifest, format }
    }
  }
  if (preferredFormat === 'antigravity' && root && validResourceId(root.name))
    return { manifest: root, format: 'antigravity' }
  return null
}

function unsupportedComponents(
  files: Tree['files'],
  manifest: Record<string, unknown>,
  extension: Record<string, unknown>,
) {
  const paths = Object.keys(files)
  const kinds = [
    'hooks',
    'apps',
    'agents',
    'commands',
    'lspServers',
    'outputStyles',
    'monitors',
  ]
  const defaults: Record<string, string> = {
    apps: '.app.json',
    lspServers: '.lsp.json',
  }
  return kinds.filter(
    (kind) =>
      manifest[kind] ||
      extension[kind] ||
      paths.some(
        (path) => path === defaults[kind] || path.startsWith(`${kind}/`),
      ),
  )
}

export function pluginFromFiles(
  files: Tree['files'],
  modes: Record<string, number> = {},
  expectedFormat?: PluginFormat,
  validate = false,
): Resource | null {
  const result = readManifest(files, expectedFormat)
  if (!result) return null
  const { manifest, format } = result
  if (!validResourceId(manifest.name))
    throw new Error('插件清单需要有效的 name')
  const extension =
    format === 'portable'
      ? objectRecord(manifest.extensions) &&
        objectRecord(manifest.extensions['com.openai'])
        ? manifest.extensions['com.openai']
        : (jsonAt(files, nativeManifests.codex[0]) ?? {})
      : manifest
  const declarations =
    format === 'portable' || manifest.skills === undefined
      ? ['skills']
      : manifest.skills
  const skillPaths = Array.isArray(declarations) ? declarations : [declarations]
  const components = new Map<string, Resource>()
  for (const value of skillPaths) {
    const path = portablePath(value)
    const scoped = subtree(files, path)
    const scopedModes = subtree(modes, path)
    const single = skillFromFiles(scoped, scopedModes, posix.basename(path))
    const skills = single
      ? [{ directory: '', resource: single }]
      : findSkills(scoped, scopedModes, '')
    if (
      validate &&
      Object.hasOwn(manifest, 'skills') &&
      format !== 'portable' &&
      !skills.length
    )
      throw new Error(`插件声明的 Skills 路径 ${path} 下未找到 SKILL.md`)
    for (const { directory, resource } of skills) {
      components.set(
        `skill:${resource.id}`,
        validate
          ? { ...resource, sourcePath: posix.join(path, directory, 'SKILL.md') }
          : resource,
      )
    }
  }
  const mcp =
    format === 'portable'
      ? 'mcp.json'
      : manifest.mcpServers === undefined
        ? '.mcp.json'
        : manifest.mcpServers
  for (const server of pluginMcp(
    files,
    mcp,
    format,
    validate,
    format !== 'portable' && Object.hasOwn(manifest, 'mcpServers'),
  ))
    components.set(`mcp:${server.id}`, server)
  if (Object.hasOwn(files, 'AGENTS.md')) {
    components.set('instructions:agents', {
      kind: 'instructions',
      id: 'agents',
      name: 'AGENTS.md',
      text: validate
        ? utf8Text(Buffer.from(files['AGENTS.md'], 'base64'))
        : toText(files['AGENTS.md']),
      ...(validate && { sourcePath: 'AGENTS.md' }),
    })
  }
  const plugin: Resource = {
    kind: 'plugin',
    id: manifest.name,
    name: manifest.name,
    format,
    files,
    components: [...components.values()],
    unsupported: unsupportedComponents(files, manifest, extension),
  }
  if (Object.keys(modes).length) plugin.modes = modes
  return plugin
}

export function discoverResources(
  files: Tree['files'],
  modes: Record<string, number>,
  name: string,
  only?: ResourceKind,
  warnings?: string[],
): Resource[] {
  const resources: Resource[] = []
  const pluginFolders = new Set<string>()
  function inspect<T>(path: string, parse: () => T): T | undefined {
    try {
      return parse()
    } catch (error) {
      if (!warnings) throw error
      warnings.push(`${path}：${errorMessage(error)}`)
    }
  }
  function collect(resource: Resource, sourcePath: string, path = sourcePath) {
    const validated = inspect(path, () =>
      warnings ? validateImport(resource) : resource,
    )
    if (validated) resources.push({ ...validated, sourcePath })
  }
  if (!only || only === 'plugin') {
    const manifestPaths = Object.keys(files).sort((a, b) => a.length - b.length)
    for (const path of manifestPaths) {
      if (posix.basename(path) !== 'plugin.json') continue
      let directory = posix.dirname(path)
      if (
        nativeManifestPaths.includes(`${posix.basename(directory)}/plugin.json`)
      )
        directory = posix.dirname(directory)
      if (directory === '.') directory = ''
      if (only && directory) continue
      if (
        [...pluginFolders].some(
          (folder) =>
            !folder ||
            folder === directory ||
            directory.startsWith(`${folder}/`),
        )
      )
        continue
      const plugin = inspect(path, () => {
        try {
          return pluginFromFiles(
            subtree(files, directory),
            subtree(modes, directory),
            undefined,
            !!warnings,
          )
        } catch (error) {
          if (
            nativeManifestPaths.some(
              (manifest) => path === manifest || path.endsWith(`/${manifest}`),
            )
          )
            pluginFolders.add(directory)
          throw error
        }
      })
      if (!plugin) continue
      pluginFolders.add(directory)
      collect(plugin, directory, path)
    }
  }
  if ((!only || only === 'skill') && !pluginFolders.has('')) {
    const topSkill = inspect('SKILL.md', () =>
      skillFromFiles(files, modes, name),
    )
    if (topSkill) collect(topSkill, '', 'SKILL.md')
    else if (!only)
      for (const { directory, resource } of findSkills(files, modes, '')) {
        if (
          [...pluginFolders].some(
            (folder) =>
              directory === folder || directory.startsWith(`${folder}/`),
          )
        )
          continue
        collect(resource, directory, `${directory}/SKILL.md`)
      }
  }
  if (!pluginFolders.has('') && (!only || only === 'instructions')) {
    for (const path of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      if (!Object.hasOwn(files, path) || (!only && path !== 'AGENTS.md'))
        continue
      const text = inspect(path, () =>
        warnings
          ? utf8Text(Buffer.from(files[path], 'base64'))
          : toText(files[path]),
      )
      if (text !== undefined)
        collect(
          { kind: 'instructions', id: 'agents', name: 'AGENTS.md', text },
          path,
        )
    }
  }
  if (!pluginFolders.has('') && (!only || only === 'mcp'))
    for (const path of ['mcp.json', '.mcp.json']) {
      inspect(path, () => {
        const document = jsonAt(files, path)
        if (!document) return
        for (const resource of mcpResources(
          document,
          undefined,
          warnings && ((message) => warnings.push(`${path}：${message}`)),
        ))
          resources.push({ ...resource, sourcePath: path })
      })
    }
  return resources
}

async function optionalFile(path: string) {
  try {
    const status = await stat(path)
    return status.isFile()
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    return false
  }
}

export async function readPlugin(
  directory: string,
  {
    format,
    validate = false,
  }: { format?: PluginFormat; validate?: boolean } = {},
) {
  const paths = [
    'plugin.json',
    ...(format
      ? format === 'portable' || format === 'pi'
        ? []
        : nativeManifests[format]
      : nativeManifestPaths),
  ]
  if (
    !(
      await Promise.all(
        paths.map((path) => optionalFile(join(directory, path))),
      )
    ).some(Boolean)
  )
    return null
  const { files, modes } = await readTree(directory, {
    maxBytes: maxPackageBytes,
    maxFiles: Infinity,
  })
  return pluginFromFiles(files, modes, format, validate)
}
