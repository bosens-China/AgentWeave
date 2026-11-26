import type { Candidate, Resource } from '@agentweave/protocol'
import { lstat, realpath } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import {
  applyFileOperations,
  fingerprint,
  keyOf,
  object,
  optional,
  readTree,
  validFilePath,
} from '../adapters/files.js'
import { discoverResources } from './plugin.js'
import { sameContent, normalizeResource } from './resource.js'
import { utf8Text } from './validation.js'

const dependencies = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'bundleDependencies',
]

export async function readNpmBundle(from: string, root: string) {
  const directory = await realpath(resolve(from))
  const tree = await readTree(directory, {
    maxBytes: 32 * 1024 * 1024,
    ignoreDirectories: ['node_modules'],
  })
  const manifest = tree.files['package.json']
  const pkg: unknown = manifest
    ? JSON.parse(
        utf8Text(Buffer.from(manifest, 'base64')).replace(/^\uFEFF/, ''),
      )
    : null
  if (
    !object(pkg) ||
    typeof pkg.name !== 'string' ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(pkg.name) ||
    typeof pkg.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(
      pkg.version,
    )
  )
    throw new Error('npm 包需要有效的 package.json、name 和 version。')

  const { name, version } = pkg
  const signature = fingerprint(tree)
  const packageSlug = name.split('/').at(-1)!
  const bins =
    typeof pkg.bin === 'string'
      ? { [packageSlug]: pkg.bin }
      : object(pkg.bin)
        ? pkg.bin
        : {}
  const hasDependencies = dependencies.some((key) => {
    const value = pkg[key]
    return (
      (object(value) || Array.isArray(value)) && Object.keys(value).length > 0
    )
  })
  const warnings: string[] = []
  const resources = new Map<string, Resource>()
  const discovered = discoverResources(
    tree.files,
    tree.modes ?? {},
    packageSlug,
    undefined,
    warnings,
  )
  let runtime: string | undefined
  function adapt(resource: Resource) {
    const config = resource.config
    if (
      resource.kind !== 'mcp' ||
      typeof config?.command !== 'string' ||
      !Object.hasOwn(bins, config.command)
    )
      return resource
    const bin = bins[config.command]
    const path = typeof bin === 'string' && bin.replace(/^\.\//u, '')
    if (!validFilePath(path) || !Object.hasOwn(tree.files, path))
      throw new Error(
        `MCP ${resource.name} 的 npm bin 文件不存在：${String(bin)}`,
      )
    const nodeScript = /^(?:\uFEFF)?#![^\r\n]*\bnode(?:\s|$)/u.test(
      Buffer.from(tree.files[path], 'base64').subarray(0, 240).toString(),
    )
    if (!nodeScript && !['.js', '.cjs', '.mjs'].includes(extname(path)))
      throw new Error(`MCP ${resource.name} 的 npm bin 需要是 Node.js 脚本。`)
    if (hasDependencies && directory.split(sep).includes('_npx'))
      throw new Error(
        `MCP ${resource.name} 需要运行依赖。请先安装 ${name}@${version} 到持久目录，再传入安装路径。`,
      )
    const location = hasDependencies
      ? directory
      : (runtime ??= join(root, 'npm-runtimes', signature))
    return {
      ...resource,
      config: {
        ...config,
        command: process.execPath,
        args: [
          join(location, path),
          ...((config.args as string[] | undefined) ?? []),
        ],
      },
    }
  }
  for (const original of discovered.flatMap((resource) =>
    resource.kind === 'plugin' ? (resource.components ?? []) : [resource],
  )) {
    let resource: Resource
    try {
      resource = normalizeResource(adapt(original))
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
      continue
    }
    const key = keyOf(resource)
    const existing = resources.get(key)
    if (existing && !sameContent(existing, resource))
      throw new Error(`npm 包中有多份内容不同的 ${key}，请先整理包清单。`)
    resources.set(key, resource)
  }
  if (!resources.size)
    throw new Error(warnings.join('\n') || 'npm 包中没有可分发的资源。')

  const source = `npm:${name}@${version}`
  const candidates: Candidate[] = [...resources].map(([id, resource]) => ({
    id,
    targetId: source,
    resource,
  }))
  return {
    name,
    version,
    signature,
    candidates,
    warnings,
    async prepareRuntime() {
      if (!runtime) return
      const existing = await optional(lstat, runtime)
      if (existing) {
        if (
          !existing.isDirectory() ||
          fingerprint(await readTree(runtime)) !== signature
        )
          throw new Error(
            `已保存的 npm 运行目录内容发生变化：${relative(root, runtime)}`,
          )
        return
      }
      await applyFileOperations(root, [
        { path: runtime, expected: null, ...tree },
      ])
    },
  }
}
