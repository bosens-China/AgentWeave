import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { errorCode } from '../errors.js'

const commands: Record<string, string[]> = {
  cursor: ['cursor', 'cursor-agent'],
  antigravity: ['antigravity', 'agy'],
  kiro: ['kiro', 'kiro-cli'],
  'kimi-code': ['kimi', 'kimi-code'],
}
const apps: Record<string, string> = {
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  windsurf: 'Windsurf',
  kiro: 'Kiro',
  codex: 'Codex',
}

async function usable(path: string, execute = true) {
  try {
    if (execute) await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(
        String(errorCode(error)),
      )
    )
      return false
    throw error
  }
}

export async function agentExecutable(
  id: string,
  home: string,
  nativeOnly = false,
) {
  const currentUser = home === resolve(homedir())
  const paths = new Set(
    currentUser
      ? (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
      : [],
  )
  for (const bin of ['.local/bin', 'bin', '.bun/bin'])
    paths.add(join(home, bin))
  if (id === 'opencode') paths.add(join(home, '.opencode/bin'))
  if (process.platform === 'win32') paths.add(join(home, 'AppData/Roaming/npm'))
  if (process.platform === 'darwin' && id === 'codex') {
    paths.add(join(home, 'Applications/Codex.app/Contents/Resources'))
    if (currentUser) {
      paths.add('/Applications/Codex.app/Contents/Resources')
      paths.add(
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS',
      )
    }
  }
  // Windows command shims are enough for discovery. Native invocation needs an executable.
  const extensions =
    process.platform === 'win32'
      ? nativeOnly
        ? ['.exe']
        : ['.exe', '.cmd', '.bat']
      : ['']
  for (const path of paths) {
    for (const cmd of commands[id] ?? [id]) {
      for (const ext of extensions)
        if (await usable(join(path, cmd + ext))) return join(path, cmd + ext)
    }
  }
  return null
}

export async function installedTarget(id: string, home: string) {
  if (await agentExecutable(id, home)) return true
  const currentUser = home === resolve(homedir())
  const app = apps[id]
  if (app && process.platform === 'darwin') {
    for (const folder of [
      join(home, 'Applications'),
      ...(currentUser ? ['/Applications'] : []),
    ]) {
      if (await usable(join(folder, app + '.app/Contents/Info.plist'), false))
        return true
    }
  }
  if (
    app &&
    process.platform === 'win32' &&
    (await usable(join(home, 'AppData/Local/Programs', app, app + '.exe')))
  )
    return true
  if (id === 'cline') {
    for (const editor of [
      '.vscode',
      '.vscode-insiders',
      '.cursor',
      '.windsurf',
    ]) {
      const dir = join(home, editor, 'extensions')
      const entries = await readdir(dir).catch((error) => {
        if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(errorCode(error))))
          return []
        throw error
      })
      for (const entry of entries)
        if (
          /^saoudrizwan\.claude-dev-/i.test(entry) &&
          (await usable(join(dir, entry, 'package.json'), false))
        )
          return true
    }
  }
  return false
}
