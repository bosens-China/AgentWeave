import type { Resource } from '@agentweave/protocol'
import { errorMessage } from '../errors.js'
import type {
  FileOperation,
  NativeTarget,
  ResourceEntry,
  SectionPlan,
  Tree,
} from './types.js'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { discoverResources } from '../central/plugin.js'
import {
  checkName,
  fingerprint,
  keyOf,
  object,
  optional,
  pathState,
  readTree,
} from './files.js'

type PiEntry = ResourceEntry & {
  source: string
  index: number
  managed: boolean
}

const manifestFile = 'package.json'
const packageFolder = 'agentweave-packages'
const ownershipFile = '.agentweave-package.json'

function sourceOf(declaration: unknown) {
  return typeof declaration === 'string'
    ? declaration
    : object(declaration)
      ? declaration.source
      : undefined
}

function json(contents: string, label: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(contents.replace(/^\uFEFF/u, ''))
    if (object(data)) return data
  } catch {
    // Pi settings and manifests are JSON objects.
  }
  throw new Error(`${label} 不是有效的 JSON 对象`)
}

function includesSkill(path: string, pattern: unknown) {
  if (typeof pattern !== 'string') return false
  const directory = posix.dirname(path)
  const location = pattern.replace(/^\.\//u, '').replace(/\/$/u, '')
  return (
    path === location ||
    directory === location ||
    path.startsWith(`${location}/`) ||
    posix.matchesGlob(path, location) ||
    posix.matchesGlob(directory, location)
  )
}

function detectSkills(
  files: Tree['files'],
  modes: Tree['modes'],
  manifest: Record<string, unknown>,
) {
  const skills: Resource[] = []
  const filter = (object(manifest.pi) ? manifest.pi.skills : undefined) ?? [
    'skills',
  ]
  if (!Array.isArray(filter))
    throw new Error('Pi 包的 skills 配置必须是路径列表')
  const allow = filter.filter(
    (value) => typeof value === 'string' && !value.startsWith('!'),
  )
  const deny = filter
    .filter((value) => typeof value === 'string' && value.startsWith('!'))
    .map((value) => value.slice(1))
  for (const path of Object.keys(files)) {
    if (
      !(path === 'SKILL.md' || path.endsWith('/SKILL.md')) ||
      !allow.some((pattern) => includesSkill(path, pattern)) ||
      deny.some((pattern) => includesSkill(path, pattern))
    )
      continue
    const directory = posix.dirname(path)
    const prefix = directory === '.' ? '' : `${directory}/`
    const contents = Object.fromEntries(
      Object.entries(files)
        .filter(([file]) => file.startsWith(prefix))
        .map(([file, data]) => [file.slice(prefix.length), data]),
    )
    const permissions = Object.fromEntries(
      Object.entries(modes ?? {})
        .filter(([file]) => file.startsWith(prefix))
        .map(([file, mode]) => [file.slice(prefix.length), mode]),
    )
    const name =
      directory === '.'
        ? (typeof manifest.name === 'string' ? manifest.name : 'skill')
            .replace(/^@/u, '')
            .replaceAll('/', '--')
        : posix.basename(directory)
    skills.push(
      ...discoverResources(contents, permissions, name, 'skill').map(
        ({ sourcePath, ...skill }) => skill,
      ),
    )
  }
  return skills
}

function piResource(payload: Tree, path: string, managedRoot: string) {
  const manifest = payload.files[manifestFile]
    ? json(
        Buffer.from(payload.files[manifestFile], 'base64').toString('utf8'),
        'Pi 包清单',
      )
    : {}
  const marker =
    dirname(path) === managedRoot && payload.files[ownershipFile]
      ? json(
          Buffer.from(payload.files[ownershipFile], 'base64').toString('utf8'),
          'AgentWeave 包记录',
        )
      : {}
  const managedId = marker.id
  const manifestName =
    typeof manifest.name === 'string' ? manifest.name : basename(path)
  const id = checkName(
    managedId ?? manifestName.replace(/^@/u, '').replaceAll('/', '--'),
  )
  const name = typeof marker.name === 'string' && managedId ? marker.name : id
  const pi = object(manifest.pi) ? manifest.pi : {}
  const unsupported = ['extensions', 'prompts', 'themes'].filter(
    (kind) =>
      (Array.isArray(pi[kind]) && pi[kind].length > 0) ||
      Object.keys(payload.files).some((file) => file.startsWith(`${kind}/`)),
  )
  if (
    Object.keys(object(manifest.dependencies) ? manifest.dependencies : {})
      .length
  )
    unsupported.push('dependencies')
  const resource: Resource = {
    kind: 'plugin',
    id,
    name,
    format: 'pi',
    ...payload,
    components: detectSkills(payload.files, payload.modes, manifest),
    unsupported,
  }
  const managed =
    Boolean(managedId) &&
    basename(path) ===
      `${id}-${fingerprint({ files: payload.files, modes: payload.modes ?? {} }).slice(0, 16)}`
  return { resource, managed }
}

export async function readPiPlugins(target: Pick<NativeTarget, 'plugin'>) {
  if (!target.plugin) throw new Error('缺少 Pi 插件配置目录')
  const root = target.plugin.root
  const settingsPath = join(root, 'settings.json')
  const expected = await pathState(settingsPath)
  const info = await optional(lstat, settingsPath)
  if (info && !info.isFile()) throw new Error('Pi 的全局设置无法读取')
  const raw = await optional(readFile, settingsPath)
  const settings = raw ? json(raw.toString('utf8'), 'Pi 全局设置') : {}
  const packages = settings.packages ?? []
  if (!Array.isArray(packages)) throw new Error('Pi 的 packages 配置必须是列表')
  const managedRoot = join(root, packageFolder)
  const entries: PiEntry[] = []
  const warnings: string[] = []
  for (const [index, declaration] of packages.entries()) {
    const source = sourceOf(declaration)
    if (
      typeof source !== 'string' ||
      !source ||
      (!isAbsolute(source) && /^[a-z][a-z+.-]*:|^github\.com\//iu.test(source))
    ) {
      warnings.push(
        'Pi 的 npm、Git 或未知包声明由 Pi 维护，本次只对齐可读的本地包',
      )
      continue
    }
    const path = resolve(root, source)
    try {
      const info = await optional(lstat, path)
      if (!info?.isDirectory()) throw new Error('本地来源无法作为目录读取')
      entries.push({
        path,
        expected: await pathState(path),
        index,
        source,
        ...piResource(await readTree(path), path, managedRoot),
      })
    } catch (error) {
      warnings.push(`Pi 的本地包 ${basename(path)}：${errorMessage(error)}`)
    }
  }
  if ((await pathState(settingsPath)) !== expected)
    throw new Error('Pi 的全局设置已变化，请重新扫描')
  return { entries, warnings, packages, settings, settingsPath, expected }
}

function convert(resource: Resource, warnings: string[]): Tree {
  if (resource.format === 'pi') {
    if (resource.unsupported?.includes('extensions'))
      warnings.push(`${resource.name} 含有 Pi 扩展，启用后会由 Pi 加载`)
    return { files: resource.files ?? {}, modes: resource.modes ?? {} }
  }
  const files: Tree['files'] = {}
  const modes: Record<string, number> = {}
  const unsupported = new Set(resource.unsupported ?? [])
  for (const item of resource.components ?? []) {
    if (
      item.kind !== 'skill' ||
      !item.files ||
      !Object.hasOwn(item.files, 'SKILL.md')
    ) {
      unsupported.add(
        item.kind === 'instructions' ? 'AGENTS.md' : item.kind.toUpperCase(),
      )
      continue
    }
    const prefix = `skills/${checkName(item.id)}/`
    for (const [path, bytes] of Object.entries(item.files))
      files[`${prefix}${path}`] = bytes
    for (const [path, mode] of Object.entries(item.modes ?? {}))
      modes[`${prefix}${path}`] = mode
  }
  if (unsupported.size)
    warnings.push(
      `${resource.name} → Pi：无法随插件转换 ${[...unsupported].join('、')}`,
    )
  if (!Object.keys(files).length)
    throw new Error('插件中没有可随 Pi 包加载的 Skills')
  files[manifestFile] = Buffer.from(
    `${JSON.stringify(
      {
        name: `agentweave-${resource.id.toLowerCase()}`,
        version: '1.0.0',
        keywords: ['pi-package'],
        pi: { skills: ['./skills'] },
      },
      null,
      2,
    )}\n`,
  ).toString('base64')
  return { files, modes }
}

function withoutOwnership(payload: Partial<Tree>) {
  const files = { ...payload.files }
  const modes = { ...payload.modes }
  delete files[ownershipFile]
  delete modes[ownershipFile]
  return { files, modes }
}

export async function planPiPlugins(
  target: Pick<NativeTarget, 'plugin'>,
  snapshot: Awaited<ReturnType<typeof readPiPlugins>>,
  desired: Map<string, Resource>,
  selective: boolean,
  warnings: string[],
): Promise<SectionPlan> {
  if (!target.plugin) throw new Error('缺少 Pi 插件配置目录')
  const additions: FileOperation[] = []
  const cleanup = new Map<string, FileOperation>()
  const changes: SectionPlan['changes'] = []
  const packages = [...snapshot.packages]
  const manifestOf = (resource: Partial<Tree>) => ({
    files: resource.files,
    modes: resource.modes ?? {},
  })
  const desiredIds = new Set([...desired.keys()].map((id) => id.toLowerCase()))
  function discard(current: PiEntry) {
    if (current.managed)
      cleanup.set(current.path, {
        path: current.path,
        expected: current.expected,
        beforeFingerprint: fingerprint(manifestOf(current.resource)),
      })
  }
  for (const resource of desired.values()) {
    const found = snapshot.entries.filter(
      (entry) => entry.resource.id.toLowerCase() === resource.id.toLowerCase(),
    )
    if (found.length > 1) {
      warnings.push(`Pi 中有多个 ${resource.id} 包，请先在 Pi 中处理重名`)
      continue
    }
    const current = found[0]
    try {
      const converted = withoutOwnership(convert(resource, warnings))
      if (
        current &&
        fingerprint(withoutOwnership(current.resource)) ===
          fingerprint(converted)
      )
        continue
      const payload = {
        files: {
          ...converted.files,
          [ownershipFile]: Buffer.from(
            `${JSON.stringify({ id: resource.id, name: resource.name })}\n`,
          ).toString('base64'),
        },
        modes: converted.modes,
      }
      const signature = fingerprint(payload)
      const path = join(
        target.plugin.root,
        packageFolder,
        `${checkName(resource.id)}-${signature.slice(0, 16)}`,
      )
      const expected = await pathState(path)
      if (expected) {
        const status = await lstat(path)
        if (
          !status.isDirectory() ||
          fingerprint(manifestOf(await readTree(path))) !== signature
        )
          throw new Error(`包目录包含其他内容：${path}`)
      } else additions.push({ path, expected, ...payload })
      if (current) {
        const declaration = packages[current.index]
        packages[current.index] = object(declaration)
          ? { ...declaration, source: path }
          : path
        discard(current)
      } else packages.push(path)
      changes.push({
        action: current ? 'overwrite' : 'add',
        key: keyOf(resource),
        name: resource.name,
        kind: 'plugin',
        path,
      })
    } catch (error) {
      warnings.push(`${resource.name} → Pi：${errorMessage(error)}`)
    }
  }
  if (!selective)
    for (const current of snapshot.entries) {
      if (desiredIds.has(current.resource.id.toLowerCase())) continue
      packages[current.index] = undefined
      discard(current)
      changes.push({
        action: 'delete',
        key: keyOf(current.resource),
        name: current.resource.name,
        kind: 'plugin',
        path: snapshot.settingsPath,
      })
    }
  const operations = [...additions]
  if (changes.length)
    operations.push({
      path: snapshot.settingsPath,
      expected: snapshot.expected,
      text: `${JSON.stringify({ ...snapshot.settings, packages: packages.filter((value) => value !== undefined) }, null, 2)}\n`,
      beforeFingerprint: fingerprint(snapshot.settings),
    })
  operations.push(...cleanup.values())
  return { changes, operations, pluginOperations: [] }
}
