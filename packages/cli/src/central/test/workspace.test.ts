import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createRepository } from '../index.js'
import { pluginFromFiles } from '../plugin.js'

const bytes = (text: string) => Buffer.from(text).toString('base64')
const skillText =
  '---\nname: review\ndescription: Review changes\n---\nLocal workflow\n'
test('migrates SQLite into editable Codex files with source bindings and native plugin payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentweave-migration-'))
  try {
    const plugin = pluginFromFiles(
      {
        '.cursor-plugin/plugin.json': bytes(
          '{"name":"bundle","skills":["./custom/review"]}',
        ),
        'custom/review/SKILL.md': bytes(skillText),
        'scripts/check.sh': bytes('echo check'),
      },
      { 'scripts/check.sh': 0o755 },
      'cursor',
      true,
    )!
    const data = {
      resources: [
        plugin,
        {
          kind: 'skill',
          id: 'review',
          name: 'review',
          files: { 'SKILL.md': bytes(skillText) },
        },
        {
          kind: 'mcp',
          id: 'server',
          name: 'server',
          config: { command: 'node' },
        },
        {
          kind: 'instructions',
          id: 'rules',
          name: 'Rules',
          text: 'Initial rules',
        },
      ],
      sources: [
        {
          id: 'source',
          url: 'https://github.com/example/resources',
          revision: 'abc',
          bindings: { one: 'skill:review' },
          excluded: [],
          watchAll: true,
        },
      ],
    }
    const legacy = join(root, 'repository.sqlite')
    const db = new DatabaseSync(legacy)
    db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
    db.prepare('INSERT INTO state VALUES (1,?)').run(JSON.stringify(data))
    db.close()
    const before = await readFile(legacy),
      repo = createRepository(root),
      dir = join(root, 'codex')
    expect(await repo.list()).toHaveLength(4)
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('Initial rules')
    expect(await readFile(join(dir, 'skills/review/SKILL.md'), 'utf8')).toBe(
      skillText,
    )
    expect(await readFile(join(dir, 'config.toml'), 'utf8')).toContain('node')
    expect(
      JSON.parse(
        await readFile(
          join(dir, 'plugins/bundle/.codex-plugin/plugin.json'),
          'utf8',
        ),
      ).skills,
    ).toEqual(['./custom/review'])
    expect(
      await readFile(join(dir, 'plugins/bundle/scripts/check.sh'), 'utf8'),
    ).toBe('echo check')
    await writeFile(join(dir, 'AGENTS.md'), 'Edited rules')
    await writeFile(
      join(dir, 'config.toml'),
      'model = "personal"\n[mcp_servers.server]\ncommand = "python"\n',
    )
    await writeFile(
      join(dir, 'plugins/bundle/custom/review/SKILL.md'),
      skillText + 'Edited\n',
    )
    await rm(join(dir, 'skills/review'), { recursive: true })
    await mkdir(join(dir, 'skills/another'), { recursive: true })
    await writeFile(
      join(dir, 'skills/another/SKILL.md'),
      skillText.replace('name: review', 'name: another'),
    )
    const current = await repo.list()
    expect(current.map((r) => r.id)).toEqual([
      'rules',
      'server',
      'bundle',
      'another',
    ])
    expect(current[0].text).toBe('Edited rules')
    expect(current[1].config?.command).toBe('python')
    expect(current[2].components?.[0].files?.['SKILL.md']).toBe(
      bytes(skillText + 'Edited\n'),
    )
    await repo.remove('mcp:server')
    expect(await readFile(join(dir, 'config.toml'), 'utf8')).toContain(
      'personal',
    )
    expect((await repo.listSources())[0].keys).toEqual(['skill:review'])
    expect(await readFile(legacy)).toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removes the actual edited MCP file when its new transport has a different canonical path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentweave-file-edit-'))
  try {
    const repo = createRepository(root)
    await repo.save({
      kind: 'mcp',
      id: 'remote',
      name: 'remote',
      config: { type: 'sse', url: 'https://example.org/sse' },
    })
    const file = join(root, 'codex/mcp/remote.json')
    await writeFile(file, JSON.stringify({ command: 'node' }))
    await repo.remove('mcp:remote')
    expect(await repo.list()).toEqual([])
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
