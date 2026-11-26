import type { Resource } from '@agentweave/protocol'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { parse, stringify } from 'smol-toml'
import lockfile from 'proper-lockfile'
import {
  checkName,
  fingerprint,
  object,
  optional,
  readTree,
} from '../adapters/files.js'
import type { Tree } from '../adapters/types.js'
import { decodeServer, encodeServer } from '../adapters/mcp-format.js'
import { piPackageResource } from '../adapters/pi-plugins.js'
import { pluginFromFiles } from './plugin.js'
import { normalizeResource, resourceKey } from './resource.js'
import { skillName, utf8Text } from './validation.js'

type Entry = Omit<Resource, 'files' | 'modes' | 'text'> & {
  signature?: string
  generatedManifest?: string
}
type Catalog<S> = {
  version: 1
  entries: Entry[]
  primary?: string
  sources: S[]
}
type State<S> = { resources: Resource[]; sources: S[] }
const codexManifest = '.codex-plugin/plugin.json'
const indexFile = '.agentweave-index.json'
const codex = { id: 'codex', name: 'Codex', mcp: { variant: 'codex' } }
const encode = (s: string) => Buffer.from(s).toString('base64')
const decode = (s: string) => utf8Text(Buffer.from(s, 'base64'))
const emptyTree = (): Tree => ({
  files: Object.create(null),
  modes: Object.create(null),
})

function readWorkspace<S>(tree: Tree, index: Catalog<S>): State<S> {
  const entries = new Map(
    index.entries.map((entry) => [resourceKey(entry), entry]),
  )
  const resources: Resource[] = []
  const ids = new Set<string>()
  const add = (resource: Resource) => {
    const clean = normalizeResource(resource)
    const key = resourceKey(clean).normalize('NFC').toLowerCase()
    if (ids.has(key))
      throw new Error(`中央目录中资源重名：${resourceKey(clean)}`)
    ids.add(key)
    resources.push(clean)
  }
  const packages = new Map<string, Tree>()
  for (const [path, bytes] of Object.entries(tree.files)) {
    const match = /^(skills|plugins)\/([^/]+)\/(.+)$/.exec(path)
    if (!match) continue
    const [, type, id, file] = match,
      folder = type + '/' + id
    const payload = packages.get(folder) ?? emptyTree()
    payload.files[file] = bytes
    if (tree.modes?.[path]) payload.modes![file] = tree.modes[path]
    packages.set(folder, payload)
  }
  for (const [folder, payload] of packages) {
    const [type, id] = folder.split('/')
    const kind = type === 'skills' ? 'skill' : 'plugin'
    const meta = entries.get(kind + ':' + id)
    if (kind === 'skill') {
      if (!Object.hasOwn(payload.files, 'SKILL.md')) {
        if (meta) throw new Error(`${folder}/SKILL.md 缺失`)
        continue
      }
      add({
        ...meta,
        id,
        kind,
        name: skillName(decode(payload.files['SKILL.md']), meta?.name ?? id),
        ...payload,
      })
    } else {
      if (
        meta?.generatedManifest &&
        payload.files[codexManifest] === meta.generatedManifest
      )
        delete payload.files[codexManifest]
      const signature = fingerprint(payload)
      if (meta?.signature === signature) add({ ...meta, ...payload })
      else {
        const parsed =
          meta?.format === 'pi' ||
          (!meta &&
            payload.files['package.json'] &&
            !pluginFromFiles(payload.files, payload.modes))
            ? piPackageResource(payload, id)
            : pluginFromFiles(payload.files, payload.modes, meta?.format, true)
        if (!parsed) throw new Error(`${folder} 缺少可识别的插件清单`)
        add({ ...parsed, id, tags: meta?.tags })
      }
    }
  }
  function instruction(id: string, raw: string) {
    const meta = entries.get('instructions:' + id)
    add({
      kind: 'instructions',
      id,
      name: meta?.name ?? 'AGENTS.md',
      tags: meta?.tags,
      text: decode(raw),
    })
  }
  if (Object.hasOwn(tree.files, 'AGENTS.md'))
    instruction(index.primary ?? 'agents', tree.files['AGENTS.md'])
  for (const [path, raw] of Object.entries(tree.files)) {
    const extra = /^instructions\/([^/]+)\.md$/.exec(path)
    if (extra) instruction(extra[1], raw)
    const fallback = /^mcp\/([^/]+)\.json$/.exec(path)
    if (fallback) {
      const id = fallback[1],
        meta = entries.get('mcp:' + id)
      add({
        kind: 'mcp',
        id,
        name: meta?.name ?? id,
        tags: meta?.tags,
        config: JSON.parse(decode(raw)),
      })
    }
  }
  const document = tree.files['config.toml']
    ? parse(decode(tree.files['config.toml']))
    : {}
  if (document.mcp_servers !== undefined && !object(document.mcp_servers))
    throw new Error('config.toml 的 mcp_servers 必须是表')
  for (const [id, raw] of Object.entries(document.mcp_servers ?? {})) {
    const meta = entries.get('mcp:' + id)
    let config = decodeServer(raw, codex)
    if (meta?.signature === fingerprint(raw) && meta.config)
      config = meta.config
    else if (object(meta?.config?.options)) {
      const options = { ...meta.config.options }
      delete options.codex
      Object.assign(options, config.options)
      if (Object.keys(options).length) config.options = options
    }
    add({ kind: 'mcp', id, name: meta?.name ?? id, tags: meta?.tags, config })
  }
  return { resources, sources: index.sources }
}

// Reference the original files so editing a bundled Skill also edits its Codex view.
function codexPluginManifest(resource: Resource) {
  const files = resource.files ?? {}
  if (
    !resource.format ||
    ['portable', 'codex'].includes(resource.format) ||
    files[codexManifest]
  )
    return
  const skills = new Set<string>()
  const discovered =
    resource.format === 'pi'
      ? resource
      : pluginFromFiles(files, resource.modes, resource.format, true)
  for (const skill of discovered?.components ?? []) {
    if (skill.kind !== 'skill') continue
    const marker =
      skill.sourcePath ??
      Object.keys(files).find(
        (p) =>
          p.endsWith('/SKILL.md') &&
          files[p] === skill.files?.['SKILL.md'] &&
          dirname(p).split('/').at(-1) === skill.id,
      )
    if (marker && dirname(marker) !== '.') skills.add('./' + dirname(marker))
  }
  const manifestFile = [
    '.claude-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.antigravity-plugin/plugin.json',
    '.gemini-plugin/plugin.json',
    'plugin.json',
  ].find((p) => files[p])
  const source = manifestFile
    ? JSON.parse(decode(files[manifestFile]).replace(/^\uFEFF/, ''))
    : {}
  const mcpServers =
    source.mcpServers ?? (files['.mcp.json'] ? './.mcp.json' : undefined)
  return encode(
    JSON.stringify(
      {
        name: resource.id,
        description: source.description,
        skills: [...skills],
        mcpServers,
      },
      null,
      2,
    ) + '\n',
  )
}

function layout<S>(state: State<S>, preferred?: string) {
  const tree = emptyTree()
  const entries: Entry[] = []
  const instructions = state.resources.filter((r) => r.kind === 'instructions')
  const primary =
    instructions.find((r) => r.id === preferred)?.id ??
    instructions.find((r) => r.id === 'agents')?.id ??
    instructions[0]?.id
  const servers: Record<string, unknown> = Object.create(null)
  for (const r of state.resources) {
    const { files, modes, text, ...meta } = r
    checkName(r.id)
    const entry: Entry = { ...meta }
    if (r.kind === 'skill' || r.kind === 'plugin') {
      const prefix =
        (r.kind === 'skill' ? 'skills' : 'plugins') + '/' + r.id + '/'
      for (const [p, bytes] of Object.entries(files ?? {}))
        tree.files[prefix + p] = bytes
      for (const [p, mode] of Object.entries(modes ?? {}))
        tree.modes![prefix + p] = mode
      if (r.kind === 'plugin') {
        entry.signature = fingerprint({ files, modes: modes ?? {} })
        const generated = codexPluginManifest(r)
        if (generated) {
          entry.generatedManifest = generated
          tree.files[prefix + codexManifest] = generated
        }
      }
    } else if (r.kind === 'instructions') {
      tree.files[
        r.id === primary ? 'AGENTS.md' : 'instructions/' + r.id + '.md'
      ] = encode(text!)
    } else {
      try {
        servers[r.id] = encodeServer(r, codex)
        entry.signature = fingerprint(servers[r.id])
      } catch {
        tree.files['mcp/' + r.id + '.json'] = encode(
          JSON.stringify(r.config, null, 2) + '\n',
        )
      }
    }
    entries.push(entry)
  }
  if (Object.keys(servers).length)
    tree.files['config.toml'] = encode(stringify({ mcp_servers: servers }))
  const catalog: Catalog<S> = {
    version: 1,
    primary,
    entries,
    sources: state.sources,
  }
  tree.files[indexFile] = encode(JSON.stringify(catalog) + '\n')
  return tree
}

function legacy<S>(root: string): State<S> {
  const db = new DatabaseSync(join(root, 'repository.sqlite'), {
    readOnly: true,
  })
  try {
    const row = db.prepare('SELECT data FROM state WHERE id = 1').get()
    return row && typeof row.data === 'string'
      ? JSON.parse(row.data)
      : { resources: [], sources: [] }
  } finally {
    db.close()
  }
}

// The staged directory contains both editable files and their source bindings.
// An interrupted swap leaves either the complete new directory or a recoverable old one.
async function publish(
  root: string,
  dir: string,
  before: Tree,
  after: Tree,
  exists: boolean,
  backup: string,
) {
  const stage = await mkdtemp(join(root, '.agentweave-stage-'))
  try {
    if (exists)
      await cp(dir, stage, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      })
    const removed = Object.keys(before.files).filter(
      (p) => !Object.hasOwn(after.files, p),
    )
    const parents = new Set<string>()
    for (const p of removed) {
      await rm(join(stage, p))
      for (let parent = dirname(p); parent !== '.'; parent = dirname(parent))
        parents.add(parent)
    }
    for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
      if (!(await readdir(join(stage, parent))).length)
        await rmdir(join(stage, parent))
    }
    for (const [p, bytes] of Object.entries(after.files)) {
      if (before.files[p] === bytes && before.modes?.[p] === after.modes?.[p])
        continue
      const path = join(stage, p)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      if (Object.hasOwn(before.files, p)) await rm(path)
      await writeFile(path, Buffer.from(bytes, 'base64'), {
        flag: 'wx',
        mode: after.modes?.[p] ? 0o700 : 0o600,
      })
    }
    const journal = join(root, '.agentweave-swap')
    await writeFile(journal, 'codex-directory-swap-v1', {
      flag: 'wx',
      mode: 0o600,
    })
    if (exists) {
      const current = await readTree(dir)
      if (
        !isDeepStrictEqual(current.files, before.files) ||
        !isDeepStrictEqual(current.modes, before.modes)
      )
        throw new Error('中央文件已被修改，请刷新后重试')
      await rename(dir, backup)
    }
    try {
      await rename(stage, dir)
    } catch (error) {
      if (exists) await rename(backup, dir)
      throw error
    }
    if (exists) await rm(backup, { recursive: true })
    await rm(journal)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export async function workspaceState<S, T>(
  root: string,
  callback: (data: State<S>) => T,
  writing = false,
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(root, {
    realpath: false,
    lockfilePath: join(root, '.workspace.lock'),
    stale: 120000,
    retries: { retries: 50, minTimeout: 20, maxTimeout: 200 },
  })
  try {
    const dir = join(root, 'codex'),
      backup = join(root, '.agentweave-previous')
    const journal = join(root, '.agentweave-swap')
    if (await optional(lstat, journal)) {
      if ((await readFile(journal, 'utf8')) !== 'codex-directory-swap-v1')
        throw new Error('中央仓库的恢复记录无法识别')
      if (await optional(lstat, backup)) {
        if (await optional(lstat, dir)) await rm(backup, { recursive: true })
        else await rename(backup, dir)
      }
      await rm(journal)
    } else if (await optional(lstat, backup))
      throw new Error(`仓库暂存位置已被占用：${backup}`)
    const info = await optional(lstat, dir)
    if (info && !info.isDirectory())
      throw new Error('中央 codex 路径必须是普通目录')
    const disk = info ? await readTree(dir) : emptyTree()
    const raw = disk.files[indexFile]
    const index: Catalog<S> = raw
      ? JSON.parse(decode(raw))
      : { version: 1, entries: [], sources: [] }
    if (index.version !== 1) throw new Error('不支持的中央目录版本')
    const data = readWorkspace(disk, index)
    const folders = new Set(
      data.resources
        .filter((r) => r.kind === 'skill' || r.kind === 'plugin')
        .map((r) => (r.kind === 'skill' ? 'skills/' : 'plugins/') + r.id),
    )
    const managedPaths = Object.keys(disk.files).filter(
      (path) =>
        path === indexFile ||
        path === 'config.toml' ||
        path === 'AGENTS.md' ||
        /^instructions\/[^/]+\.md$/.test(path) ||
        /^mcp\/[^/]+\.json$/.test(path) ||
        folders.has(path.split('/').slice(0, 2).join('/')),
    )

    if (!raw && (await optional(lstat, join(root, 'repository.sqlite')))) {
      const previous = legacy<S>(root)
      if (data.resources.length && previous.resources.length)
        throw new Error('中央目录和旧数据库均有资源，请先整理目录以免覆盖')
      if (previous.resources.length)
        data.resources = previous.resources.map(normalizeResource)
      data.sources = previous.sources
    }
    const migrated = !raw && !writing ? layout(data, index.primary) : undefined
    const result = callback(data)
    if (writing || !raw) {
      const next = migrated ?? layout(data, index.primary)
      const after: Tree = { files: { ...disk.files }, modes: { ...disk.modes } }
      const managed = new Set(managedPaths)
      for (const p of new Set([...managed, ...Object.keys(next.files)])) {
        if (
          disk.files[p] === next.files[p] &&
          disk.modes?.[p] === next.modes?.[p]
        )
          continue
        if (!managed.has(p) && Object.hasOwn(disk.files, p))
          throw new Error(`中央目录已有同路径文件：${p}`)
        if (p === 'config.toml' && disk.files[p]) {
          const doc = parse(decode(disk.files[p]))
          const servers =
            next.files[p] && parse(decode(next.files[p])).mcp_servers
          if (
            fingerprint(doc.mcp_servers) === fingerprint(servers || undefined)
          )
            continue
          if (servers) doc.mcp_servers = servers
          else delete doc.mcp_servers
          if (Object.keys(doc).length) {
            after.files[p] = encode(stringify(doc))
            continue
          }
        }
        if (Object.hasOwn(next.files, p)) after.files[p] = next.files[p]
        else delete after.files[p]
        if (next.modes?.[p]) after.modes![p] = next.modes[p]
        else delete after.modes![p]
      }
      if (
        !raw ||
        !isDeepStrictEqual(after.files, disk.files) ||
        !isDeepStrictEqual(after.modes, disk.modes ?? {})
      )
        await publish(root, dir, disk, after, !!info, backup)
    }
    return result
  } finally {
    await release()
  }
}
