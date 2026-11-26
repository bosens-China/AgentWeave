import { installFixtureAgents } from './installed-fixture.js'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import * as adapters from '../adapters/index.js'
import { createService } from '../service.js'

test('lists plugin files and edits only a selected text file safely', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-plugin-files-'))
  try {
    await installFixtureAgents(home, 'cursor')
    const plugin = join(home, '.cursor/plugins/local/example')
    await mkdir(join(plugin, '.cursor-plugin'), { recursive: true })
    await mkdir(join(plugin, 'docs'), { recursive: true })
    await writeFile(
      join(plugin, '.cursor-plugin/plugin.json'),
      JSON.stringify({ name: 'example' }),
    )
    await writeFile(join(plugin, 'docs/readme.md'), 'Original\n')
    await writeFile(join(plugin, 'image.bin'), Buffer.from([0, 1, 255]))
    const service = createService({ home, root: join(home, 'repo') })
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const candidate = scan.candidates.find(
      (item) => item.resource.id === 'example',
    )!
    const scanCalls = vi.spyOn(adapters, 'scanTargets')
    const list = await service.run('list-scan-files', { id: candidate.id })
    expect(list.files).toEqual(
      expect.arrayContaining([
        '.cursor-plugin/plugin.json',
        'docs/readme.md',
        'image.bin',
      ]),
    )
    await expect(
      service.run('read-scan-source', { id: candidate.id, path: '../outside' }),
    ).rejects.toThrow('有效文件')
    await expect(
      service.run('read-scan-source', {
        id: candidate.id,
        path: 'not-in-plugin',
      }),
    ).rejects.toThrow('有效文件')
    const binary = await service.run('read-scan-source', {
      id: candidate.id,
      path: 'image.bin',
    })
    expect(binary.binary).toBe(true)
    expect(scanCalls).not.toHaveBeenCalled()
    await expect(
      service.run('save-scan-source', {
        id: candidate.id,
        path: 'image.bin',
        revision: binary.revision,
        content: 'replace',
      }),
    ).rejects.toThrow('二进制')
    const source = await service.run('read-scan-source', {
      id: candidate.id,
      path: 'docs/readme.md',
    })
    expect(source.content).toBe('Original\n')
    const updated = await service.run('save-scan-source', {
      id: candidate.id,
      path: 'docs/readme.md',
      revision: source.revision,
      content: 'Updated\n',
    })
    expect(await readFile(join(plugin, 'docs/readme.md'), 'utf8')).toBe(
      'Updated\n',
    )
    expect(
      await readFile(join(plugin, '.cursor-plugin/plugin.json'), 'utf8'),
    ).toBe(JSON.stringify({ name: 'example' }))
    const next = updated.candidates.find(
      (item) => item.resource.id === 'example',
    )!
    const fresh = await service.run('read-scan-source', {
      id: next.id,
      path: 'docs/readme.md',
    })
    await writeFile(join(plugin, 'docs/readme.md'), 'External\n')
    await expect(
      service.run('save-scan-source', {
        id: next.id,
        path: 'docs/readme.md',
        revision: fresh.revision,
        content: 'Overwrite\n',
      }),
    ).rejects.toThrow()
    expect(await readFile(join(plugin, 'docs/readme.md'), 'utf8')).toBe(
      'External\n',
    )
    await symlink(join(home, 'repo'), join(plugin, 'docs/link'))
    await expect(
      service.run('read-scan-source', { id: next.id, path: 'docs/link' }),
    ).rejects.toThrow()
  } finally {
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  }
})

test('exposes a file tree when the plugin manifest is invalid', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-plugin-invalid-'))
  try {
    await installFixtureAgents(home, 'cursor')
    const plugin = join(home, '.cursor/plugins/local/broken')
    await mkdir(join(plugin, '.cursor-plugin'), { recursive: true })
    await writeFile(join(plugin, '.cursor-plugin/plugin.json'), '{invalid')
    await writeFile(join(plugin, 'README.md'), 'Notes')
    const service = createService({ home, root: join(home, 'repo') })
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const issue = scan.issues.find((item) => item.name === 'broken')!
    expect(issue.editable).toBe(true)
    const files = await service.run('list-scan-files', { id: issue.id })
    expect(files.files).toEqual(
      expect.arrayContaining(['.cursor-plugin/plugin.json', 'README.md']),
    )
    const source = await service.run('read-scan-source', {
      id: issue.id,
      path: '.cursor-plugin/plugin.json',
    })
    const result = await service.run('save-scan-source', {
      id: issue.id,
      path: '.cursor-plugin/plugin.json',
      revision: source.revision,
      content: '{"name":"broken"}',
    })
    expect(
      result.candidates.some((candidate) => candidate.resource.id === 'broken'),
    ).toBe(true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
