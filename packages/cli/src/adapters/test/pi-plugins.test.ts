import type { Resource } from '@agentweave/protocol'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applyFileOperations } from '../files.js'
import { planPiPlugins, readPiPlugins } from '../pi-plugins.js'

it('converts selected portable content and removes only AgentWeave-owned snapshots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-pi-'))
  try {
    const root = join(home, '.pi', 'agent')
    const project = join(home, 'my-local-package')
    const target = { home, plugin: { kind: 'pi' as const, root } }
    await mkdir(root, { recursive: true })
    await mkdir(join(project, 'extras', 'review'), { recursive: true })
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ name: '@my/local', pi: { skills: ['./extras/*'] } }),
    )
    await writeFile(
      join(project, 'extras', 'review', 'SKILL.md'),
      '---\nname: review\n---\nExisting skill.',
    )
    const settingsPath = join(root, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        packages: ['npm:existing', { source: project, themes: [] }],
      }),
    )
    const before = await readPiPlugins(target)
    expect(before.entries.map(({ resource }) => resource)).toMatchObject([
      { id: 'my--local', components: [{ id: 'review' }] },
    ])

    const plugin: Resource = {
      kind: 'plugin',
      id: 'writer',
      name: 'Writer',
      format: 'codex',
      components: [
        {
          kind: 'skill',
          id: 'draft',
          name: 'draft',
          files: {
            'SKILL.md': Buffer.from('Create a draft.').toString('base64'),
          },
        },
        {
          kind: 'mcp',
          id: 'doc',
          name: 'doc',
          config: { url: 'https://example.test/mcp' },
        },
      ],
    }
    const desired = new Map([[plugin.id, plugin]])
    const warnings: string[] = []
    const plan = await planPiPlugins(target, before, desired, true, warnings)
    expect(plan.changes).toMatchObject([{ action: 'add', kind: 'plugin' }])
    expect(warnings[0]).toContain('MCP')
    await applyFileOperations(home, plan.operations)

    const after = await readPiPlugins(target)
    expect(after.entries).toMatchObject([
      { managed: false },
      { managed: true, resource: { id: 'writer', name: 'Writer' } },
    ])
    expect(after.settings).toMatchObject({
      theme: 'dark',
      packages: [
        'npm:existing',
        { source: project, themes: [] },
        expect.any(String),
      ],
    })
    expect(
      (await planPiPlugins(target, after, desired, true, [])).changes,
    ).toEqual([])

    const removal = await planPiPlugins(target, after, new Map(), false, [])
    expect(removal.changes).toHaveLength(2)
    await applyFileOperations(home, removal.operations)
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      packages: ['npm:existing'],
    })
    await expect(
      readFile(join(after.entries[1].path, 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(project, 'package.json'), 'utf8')).toContain(
      '@my/local',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
