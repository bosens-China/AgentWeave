import { errorCode } from '../errors.js'
import type { ResourceKind } from '@agentweave/protocol'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { validFilePath, validSegment } from '../adapters/files.js'
import { discoverResources } from './plugin.js'

export type GithubSnapshot = ReturnType<typeof resolveGithubRevision>

const maxBytes = 32 * 1024 * 1024
const maxSelectedBytes = 64 * 1024 * 1024
const maxSelectedFiles = 4000
const commitPattern = /^[0-9a-f]{40}$/u

export function parseGithubUrl(value: string) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('请输入有效的 GitHub HTTPS 地址')
  }
  if (
    url.protocol !== 'https:' ||
    !['github.com', 'www.github.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('请输入有效的 GitHub HTTPS 地址')
  const parts = url.pathname.replace(/^\//u, '').replace(/\/$/u, '').split('/')
  try {
    const owner = decodeURIComponent(parts[0] ?? '').toLowerCase()
    const repo = decodeURIComponent(parts[1] ?? '')
      .replace(/\.git$/iu, '')
      .toLowerCase()
    const mode = parts[2]
    const selector = parts.slice(3).map(decodeURIComponent).join('/')
    if (
      /^[a-z\d-]+$/u.test(owner) &&
      /^[a-z\d_.-]+$/u.test(repo) &&
      validSegment(repo) &&
      (parts.length === 2 ||
        (['tree', 'blob'].includes(mode) &&
          selector &&
          validFilePath(selector)))
    ) {
      const base = `https://github.com/${owner}/${repo}`
      const canonical = mode
        ? `${base}/${mode}/${selector.split('/').map(encodeURIComponent).join('/')}`
        : base
      return {
        id: createHash('sha256').update(canonical).digest('hex').slice(0, 24),
        url: canonical,
        remote: `${base}.git`,
        repo,
        mode,
        selector,
      }
    }
  } catch {
    // GitHub links contain URL-encoded path segments.
  }
  throw new Error('GitHub 地址应指向仓库、分支目录或受支持的资源文件')
}

function git(
  args: string[],
  {
    cwd = tmpdir(),
    input,
    limit = maxBytes,
  }: { cwd?: string; input?: string; limit?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toUpperCase().startsWith('GIT_'),
      ),
    )
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CEILING_DIRECTORIES: cwd,
    })
    const options = [
      '-c',
      'credential.helper=',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'http.followRedirects=false',
    ]
    const child = spawn('git', [...options, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let size = 0
    let failure: string | undefined
    const timer = setTimeout(() => {
      failure = 'GitHub 请求超时，请稍后重试'
      child.kill()
    }, 30_000)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
      else {
        failure = 'GitHub 资源超过大小限制，请指定更小的目录'
        child.kill()
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(
        errorCode(error) === 'ENOENT'
          ? new Error('GitHub 同步需要在 PATH 中安装 Git')
          : error,
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || failure)
        reject(
          new Error(
            failure ??
              `无法从 GitHub ${args[0] === 'ls-remote' ? '读取分支信息' : '读取资源'}，请检查地址和网络`,
          ),
        )
      else resolve(Buffer.concat(chunks))
    })
  })
}

export function resolveGithubRevision(
  source: ReturnType<typeof parseGithubUrl>,
  refs: Map<string, string>,
) {
  if (!source.mode) {
    const revision = refs.get('HEAD')
    if (revision) return { ...source, revision, path: '' }
    throw new Error('GitHub 仓库没有可读取的默认分支')
  }
  const chunks = source.selector.split('/')
  for (let size = chunks.length; size > 0; size -= 1) {
    const ref = chunks.slice(0, size).join('/')
    const revision =
      refs.get(`refs/heads/${ref}`) ??
      refs.get(`refs/tags/${ref}^{}`) ??
      refs.get(`refs/tags/${ref}`) ??
      (commitPattern.test(ref) ? ref : undefined)
    if (revision) {
      const path = chunks.slice(size).join('/')
      if (source.mode === 'blob' && !path) break
      return { ...source, revision, path }
    }
  }
  throw new Error('GitHub 地址中的分支、标签或提交不可读取')
}

export async function inspectGithub(url: string) {
  const source = parseGithubUrl(url)
  const output = await git(
    ['ls-remote', '--', source.remote, ...(source.mode ? [] : ['HEAD'])],
    { limit: 4 * 1024 * 1024 },
  )
  const refs = new Map<string, string>()
  for (const line of output.toString('utf8').trim().split('\n')) {
    const [revision, ref] = line.split('\t')
    if (commitPattern.test(revision) && ref) refs.set(ref, revision)
  }
  return resolveGithubRevision(source, refs)
}

function selectedScope(snapshot: GithubSnapshot): {
  directory: string
  name: string
  only?: ResourceKind
  exact?: string
} {
  if (snapshot.mode !== 'blob')
    return {
      directory: snapshot.path,
      name: posix.basename(snapshot.path || snapshot.repo),
    }
  let directory = posix.dirname(snapshot.path)
  const name = posix.basename(snapshot.path)
  let only: ResourceKind | undefined
  let exact
  if (name === 'SKILL.md') only = 'skill'
  else if (name === 'plugin.json') {
    only = 'plugin'
    if (
      [
        '.codex-plugin',
        '.claude-plugin',
        '.cursor-plugin',
        '.antigravity-plugin',
        '.gemini-plugin',
      ].includes(posix.basename(directory))
    )
      directory = posix.dirname(directory)
  } else if (['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(name)) {
    only = 'instructions'
    exact = snapshot.path
  } else if (['mcp.json', '.mcp.json'].includes(name)) {
    only = 'mcp'
    exact = snapshot.path
  } else
    throw new Error('此 GitHub 文件不是受支持的 Skill、插件、MCP 或全局指令')
  if (directory === '.') directory = ''
  return {
    directory,
    name: posix.basename(directory || snapshot.repo),
    only,
    exact,
  }
}

export function selectedEntries(
  tree: Buffer,
  scope: ReturnType<typeof selectedScope>,
) {
  const prefix = scope.directory ? `${scope.directory}/` : ''
  const entries = []
  const unsupported = []
  let total = 0
  for (const line of tree.toString('utf8').split('\0')) {
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const original = line.slice(tab + 1)
    if (
      !original.startsWith(prefix) ||
      (scope.exact && original !== scope.exact)
    )
      continue
    const path = original.slice(prefix.length)
    const [mode, kind, oid, bytes] = line.slice(0, tab).split(/\s+/u)
    if (
      !validFilePath(path) ||
      path.includes('\uFFFD') ||
      kind !== 'blob' ||
      !['100644', '100755'].includes(mode)
    ) {
      unsupported.push(path)
      continue
    }
    const size = Number(bytes)
    total += size
    if (total > maxSelectedBytes || entries.length >= maxSelectedFiles)
      throw new Error('GitHub 选区超过 64 MiB 或 4000 个文件，请指定更小的目录')
    entries.push({ path, mode, oid, size })
  }
  return { entries, unsupported }
}

function extractFiles(
  batch: Buffer,
  entries: ReturnType<typeof selectedEntries>['entries'],
) {
  const files: Record<string, string> = Object.create(null)
  const modes: Record<string, number> = Object.create(null)
  let cursor = 0
  for (const { path, mode, oid, size } of entries) {
    const newline = batch.indexOf(10, cursor)
    if (
      newline === -1 ||
      batch.toString('utf8', cursor, newline) !== `${oid} blob ${size}` ||
      batch[newline + size + 1] !== 10
    )
      throw new Error(`GitHub 返回了不完整的资源：${path}`)
    files[path] = batch.toString('base64', newline + 1, newline + size + 1)
    if (mode === '100755') modes[path] = 0o755
    cursor = newline + size + 2
  }
  return { files, modes }
}

export async function readGithub(snapshot: GithubSnapshot) {
  const directory = await mkdtemp(join(tmpdir(), 'agentweave-github-'))
  try {
    await git(['init', '--bare', '--template='], { cwd: directory })
    await git(
      [
        'fetch',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-auto-gc',
        '--',
        snapshot.remote,
        snapshot.revision,
      ],
      { cwd: directory },
    )
    const scope = selectedScope(snapshot)
    const path = scope.exact ?? scope.directory
    const tree = await git(
      [
        '--literal-pathspecs',
        'ls-tree',
        '--full-tree',
        '-rlz',
        'FETCH_HEAD',
        '--',
        ...(path ? [path] : []),
      ],
      {
        cwd: directory,
        limit: 8 * 1024 * 1024,
      },
    )
    const { entries, unsupported } = selectedEntries(tree, scope)
    const unsupportedDefinition = unsupported.find((path) =>
      [
        'SKILL.md',
        'plugin.json',
        'mcp.json',
        '.mcp.json',
        'AGENTS.md',
      ].includes(posix.basename(path)),
    )
    if (unsupportedDefinition)
      throw new Error(`GitHub 资源定义无法复制：${unsupportedDefinition}`)
    const batch = await git(['cat-file', '--batch'], {
      cwd: directory,
      input: entries.map(({ oid }) => `${oid}\n`).join(''),
      limit: maxSelectedBytes + 512 * 1024, // Allow for git cat-file record headers.
    })
    const { files, modes } = extractFiles(batch, entries)
    const warnings: string[] = []
    const resources = discoverResources(
      files,
      modes,
      scope.name,
      scope.only,
      warnings,
    )
    for (const resource of resources) {
      const path = unsupported.find(
        (entry) =>
          ['skill', 'plugin'].includes(resource.kind) &&
          (!resource.sourcePath || entry.startsWith(`${resource.sourcePath}/`)),
      )
      if (path)
        throw new Error(
          `GitHub 资源「${resource.name}」含有无法复制的路径：${path}`,
        )
    }
    if (scope.exact && unsupported.length)
      throw new Error(`GitHub 资源含有无法复制的路径：${unsupported[0]}`)
    return { resources, warnings }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
