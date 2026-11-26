import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { suggestedLocalSelections } from '../../../../apps/web/src/import-selection.js'
import { createService } from '../service.js'
import { previewSync } from '../adapters/index.js'
import { installFixtureAgents } from './installed-fixture.js'

let home: string,
  codex: string,
  bundle: string,
  service: ReturnType<typeof createService>
const skill =
  '---\nname: review\ndescription: Review a change\n---\nReview it.\n'
const manifest = '.codex-plugin/plugin.json'
const browserManifest = JSON.stringify({
  name: 'browser',
  version: '1',
  skills: './skills/',
})
async function file(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}
async function registry(source = bundle) {
  const entries = ['browser@openai-bundled', 'notes@openai-curated-remote']
  await file(
    join(codex, 'config.toml'),
    `[marketplaces.openai-bundled]\nsource_type="local"\nsource=${JSON.stringify(source)}\n` +
      entries.map((id) => `[plugins."${id}"]\nenabled=true\n`).join(''),
  )
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentweave-builtin-'))
  await installFixtureAgents(home, 'codex', 'claude', 'cursor')
  if (process.platform === 'win32')
    for (const id of ['codex', 'claude'])
      await file(join(home, '.local/bin', id + '.exe'), '')
  codex = join(home, '.codex')
  bundle = join(codex, '.tmp/bundled-marketplaces/openai-bundled')
  await file(
    join(bundle, '.agents/plugins/marketplace.json'),
    JSON.stringify({
      name: 'openai-bundled',
      plugins: [
        {
          name: 'browser',
          source: { source: 'local', path: './plugins/browser' },
        },
      ],
    }),
  )
  await file(join(bundle, 'plugins/browser', manifest), browserManifest)
  await file(join(bundle, 'plugins/browser/skills/review/SKILL.md'), skill)
  await file(
    join(codex, 'plugins/cache/openai-bundled/browser/1', manifest),
    browserManifest,
  )
  await file(
    join(codex, 'plugins/cache/openai-curated-remote/notes/1', manifest),
    '{"name":"notes"}',
  )
  await registry()
  service = createService({ home, root: join(home, 'central') })
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

test('offers a verified builtin as an explicit read-only import and protects its native installation', async () => {
  const scan = await service.run('scan')
  expect(scan.issues).toEqual([])
  const builtin = scan.candidates.find((c) => c.resource.id === 'browser')!
  const personal = scan.candidates.find((c) => c.resource.id === 'notes')!
  expect(builtin.builtin).toBe(true)
  expect(personal.builtin).toBeUndefined()
  expect(suggestedLocalSelections(scan.candidates)).toEqual([
    { id: personal.id },
  ])
  const path = 'skills/review/SKILL.md'
  const read = await service.run('read-scan-source', { id: builtin.id, path })
  expect(read).toMatchObject({ readOnly: true, content: skill })
  await expect(
    service.run('save-scan-source', {
      id: builtin.id,
      path,
      revision: read.revision,
      content: 'changed',
    }),
  ).rejects.toThrow('只供查看')
  const mirror = await previewSync({
    home,
    targetId: 'codex',
    kinds: ['plugin'],
    resources: [],
  })
  expect(mirror.changes.map((c) => [c.key, c.action])).toEqual([
    ['plugin:notes', 'delete'],
  ])
  await service.run('import', { selections: [{ id: builtin.id }] })
  const [copy] = (await service.run('overview')).resources
  expect(copy.tags).toContain('内置')
  expect(
    await readFile(join(home, 'central/codex/plugins/browser', path), 'utf8'),
  ).toBe(skill)
  const modified = { ...copy, files: { ...copy.files, 'README.md': 'YQ==' } }
  const plan = await previewSync({
    home,
    targetId: 'codex',
    kinds: ['plugin'],
    keys: ['plugin:browser'],
    resources: [modified],
  })
  expect(plan.changes).toEqual([])
  expect(plan.warnings.join(' ')).toContain('内置')
  const other = await previewSync({
    home,
    targetId: 'cursor',
    kinds: ['plugin'],
    resources: [modified],
  })
  expect(other.changes.map((c) => c.action)).toEqual(['add'])
})

test('does not classify a user marketplace with the bundled name as built in', async () => {
  await registry(join(home, 'my-marketplace'))
  await file(
    join(
      codex,
      'plugins/cache/openai-bundled/browser/1/skills/review/SKILL.md',
    ),
    skill,
  )
  const scan = await service.run('scan')
  expect(scan.candidates.filter((c) => c.builtin)).toEqual([])
  const plan = await previewSync({
    home,
    targetId: 'codex',
    kinds: ['plugin'],
    resources: [],
  })
  expect(plan.changes.map((c) => c.key)).toContain('plugin:browser')
})

test('preserves unverified installs and refuses to substitute a different shipped version', async () => {
  await file(
    join(bundle, 'plugins/browser', manifest),
    browserManifest.replace('"1"', '"2"'),
  )
  const scan = await service.run('scan')
  const issue = scan.issues.find((i) => i.builtin)!
  expect(issue.reason).toContain('SKILL.md')
  expect(
    (await service.run('read-scan-source', { id: issue.id, path: manifest }))
      .readOnly,
  ).toBe(true)
  await rm(join(bundle, '.agents/plugins/marketplace.json'))
  const plan = await previewSync({
    home,
    targetId: 'codex',
    kinds: ['plugin'],
    resources: [],
  })
  expect(plan.changes.map((c) => c.key)).not.toContain('plugin:browser')
  expect(plan.warnings.join(' ')).toContain('无法核实')
})

test('recognizes Claude builtin IDs only in actual local install records', async () => {
  const root = join(home, '.claude')
  const plugins = Object.fromEntries(
    ['guard@builtin', 'helper@claude-plugins-official'].map((id) => [
      id,
      [{ scope: 'user', installPath: join(root, 'plugins/cache', id) }],
    ]),
  )
  for (const [id, [record]] of Object.entries(plugins))
    await file(
      join(record.installPath, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: id.split('@')[0] }),
    )
  await file(
    join(root, 'plugins/installed_plugins.json'),
    JSON.stringify({ plugins }),
  )
  const { candidates } = await service.run('scan', { targetIds: ['claude'] })
  expect(candidates.filter((c) => c.builtin).map((c) => c.resource.id)).toEqual(
    ['guard'],
  )
  const plan = await previewSync({
    home,
    targetId: 'claude',
    kinds: ['plugin'],
    resources: [],
  })
  expect(plan.changes.map((c) => c.key)).toEqual(['plugin:helper'])
})
