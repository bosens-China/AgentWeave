import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function installFixtureAgents(home: string, ...agents: string[]) {
  const bin = join(home, '.local/bin')
  await mkdir(bin, { recursive: true })
  for (const agent of agents) {
    await writeFile(
      join(bin, agent + (process.platform === 'win32' ? '.cmd' : '')),
      '',
      { mode: 0o700 },
    )
  }
}
