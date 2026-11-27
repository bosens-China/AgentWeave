import type { Resource } from '@agentweave/protocol'
import { errorCode, errorMessage } from '../errors.js'
import type { FileOperation, Tree } from './types.js'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
} from 'node:path'
import lockfile from 'proper-lockfile'

export const keyOf = (value: Pick<Resource, 'kind' | 'id'>) =>
  `${value.kind}:${value.id}`
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObject)
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedObject(value[key])]),
    )
  return value
}

export function fingerprint(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(sortedObject(value)) ?? '')
    .digest('hex')
}

export async function optional<T>(
  reader: (path: string) => Promise<T>,
  path: string,
) {
  try {
    return await reader(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      return null
    throw error
  }
}

export function validSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !['.', '..', '.git'].includes(value.toLowerCase()) &&
    !/[<>:"/\\|?*\x00-\x1f]/u.test(value) &&
    !/[. ]$/u.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  )
}

export function validResourceId(value: unknown): value is string {
  return validSegment(value) && !value.startsWith('.')
}

export function validFilePath(value: unknown): value is string {
  return typeof value === 'string' && value.split('/').every(validSegment)
}

export function checkName(name: unknown) {
  if (!validResourceId(name)) {
    throw new Error(`无效的资源名称：${name}`)
  }
  return name
}

function checkRelativePath(path: unknown) {
  if (!validFilePath(path)) {
    throw new Error(`资源内存在无效路径：${path}`)
  }
  return path
}

export async function readTree(
  directory: string,
  {
    maxBytes = Infinity,
    maxFiles = Infinity,
    ignoreDirectories = [] as string[],
  } = {},
): Promise<Tree> {
  const files: Tree['files'] = {}
  const modes: NonNullable<Tree['modes']> = {}
  let bytes = 0
  let count = 0
  async function read(path: string, prefix: string) {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.toLowerCase() === '.git' || entry.name === '.DS_Store')
        continue
      if (ignoreDirectories.includes(entry.name) && entry.isDirectory())
        continue
      const name = checkRelativePath(`${prefix}${entry.name}`)
      const absolute = join(path, entry.name)
      if (entry.isDirectory()) {
        await read(absolute, `${name}/`)
      } else if (entry.isFile()) {
        const metadata = await lstat(absolute)
        bytes += metadata.size
        count += 1
        if (count > maxFiles)
          throw new Error(
            `资源文件数量超过上限：最多 ${maxFiles} 个，已发现 ${count} 个`,
          )
        if (bytes > maxBytes) continue
        Object.defineProperty(files, name, {
          value: (await readFile(absolute)).toString('base64'),
          enumerable: true,
        })
        if (metadata.mode & 0o111)
          Object.defineProperty(modes, name, { value: 0o755, enumerable: true })
      } else {
        throw new Error(`资源内存在链接或特殊文件：${name}`)
      }
    }
  }
  await read(directory, '')
  if (bytes > maxBytes) {
    const display = (size: number) =>
      size >= 1024 * 1024
        ? `${(size / (1024 * 1024)).toFixed(2)} MiB（${size} 字节）`
        : `${size} 字节`
    throw new Error(
      `资源大小超过上限：最大 ${display(maxBytes)}，当前 ${display(bytes)}`,
    )
  }
  return Object.keys(modes).length ? { files, modes } : { files }
}

export async function writeTree(
  directory: string,
  files: Tree['files'],
  modes: NonNullable<Tree['modes']> = {},
) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const seen = new Set()
  for (const [name, data] of Object.entries(files)) {
    const safePath = checkRelativePath(name)
    const folded = safePath.toLowerCase()
    if (seen.has(folded))
      throw new Error(`资源中存在无法区分大小写的路径：${safePath}`)
    seen.add(folded)
    const output = join(directory, safePath)
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error(`资源文件内容无效：${safePath}`)
    }
    await writeFile(output, Buffer.from(data, 'base64'), {
      flag: 'wx',
      mode: modes[name] === 0o755 ? 0o755 : 0o644,
    })
  }
}

export async function assertParents(home: string, path: string) {
  const parent = dirname(path)
  const within = relative(home, parent)
  const boundary =
    within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)
      ? parse(parent).root
      : home
  let current = parent
  while (current !== boundary) {
    const info = await optional(lstat, current)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(
        `同步路径经过了符号链接或非目录，无法安全写入：${current}`,
      )
    }
    current = dirname(current)
  }
}

export async function pathState(path: string) {
  const info = await optional(lstat, path)
  return info
    ? [
        info.dev,
        info.ino,
        info.mode,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ].join(':')
    : null
}

export async function actualPath(path: string) {
  const missing = []
  let current = path
  while (true) {
    const existing = await optional((path) => realpath(path), current)
    if (existing) return join(existing, ...missing.reverse())
    missing.push(basename(current))
    const parent = dirname(current)
    if (parent === current) return path
    current = parent
  }
}

export async function applyFileOperations(
  home: string,
  operations: FileOperation[],
) {
  const stages: (FileOperation & {
    directory: string
    before: string
    after: string
    saved?: boolean
    moved?: boolean
  })[] = []
  let preserveRecovery = false
  try {
    for (const operation of operations) {
      const { path, expected } = operation
      await assertParents(home, path)
      if ((await pathState(path)) !== expected)
        throw new Error(`同步目标已变化，请重新预览：${path}`)
      await mkdir(dirname(path), { recursive: true })
      const directory = await mkdtemp(join(dirname(path), '.agentweave-sync-'))
      const stage = {
        ...operation,
        directory,
        before: join(directory, 'before'),
        after: join(directory, 'after'),
      }
      stages.push(stage)
      if (operation.files)
        await writeTree(stage.after, operation.files, operation.modes)
      if (typeof operation.text === 'string') {
        await writeFile(stage.after, operation.text, {
          mode: operation.mode ?? 0o600,
        })
      }
    }
    for (const stage of stages) {
      await assertParents(home, stage.path)
      if ((await pathState(stage.path)) !== stage.expected)
        throw new Error(`同步目标已变化，请重新预览：${stage.path}`)
      if (stage.verifyTree) {
        const { files, modes = {} } = await readTree(await realpath(stage.path))
        if (fingerprint({ files, modes }) !== stage.beforeFingerprint)
          throw new Error(`同步目标内容已变化，请重新预览：${stage.path}`)
      }
      if (stage.expected) {
        await rename(stage.path, stage.before)
        stage.saved = true
      }
      if (stage.files || typeof stage.text === 'string') {
        await rename(stage.after, stage.path)
        stage.moved = true
      }
    }
  } catch (error) {
    const errors = []
    for (const stage of [...stages].reverse()) {
      try {
        if (stage.moved)
          await rm(stage.path, { recursive: Boolean(stage.files), force: true })
        if (stage.saved) await rename(stage.before, stage.path)
      } catch {
        errors.push(stage.directory)
      }
    }
    if (errors.length) {
      preserveRecovery = true
      throw new Error(
        `${errorMessage(error)}。回退未完全成功，原始文件保留在：${errors.join('、')}`,
        { cause: error },
      )
    }
    throw error
  } finally {
    if (!preserveRecovery)
      await Promise.all(
        stages.map((stage) =>
          rm(stage.directory, { recursive: true, force: true }),
        ),
      )
  }
}

export async function underSyncLock<T>(
  home: string,
  callback: () => Promise<T>,
) {
  const lock = join(home, '.agentweave-sync.lock')
  const release = await lockfile.lock(home, {
    lockfilePath: lock,
    realpath: false,
    stale: 120000,
  })
  try {
    return await callback()
  } finally {
    await release()
  }
}
