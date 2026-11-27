import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { installFixtureAgents } from './installed-fixture.js'

const cliEntry = resolve(fileURLToPath(new URL('../cli.ts', import.meta.url)))
const tsxBin = resolve(
  fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url)),
)

const fixtureDirectories: string[] = []

async function createCliFixture() {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-cli-'))
  fixtureDirectories.push(home)
  await installFixtureAgents(home, 'cursor', 'codex')
  const root = join(home, 'AgentWeave')

  function runCli(args: string[]) {
    return execFileSync(tsxBin, [cliEntry, '--root', root, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    })
  }

  return { home, root, runCli }
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('cli coverage commands', () => {
  test('supports init --skip and profile listing/updating', async () => {
    const { runCli } = await createCliFixture()
    expect(runCli(['init', '--skip'])).toContain('已跳过首次导入')

    const status = JSON.parse(runCli(['status', '--json']))
    expect(status.initialized).toBe(true)

    expect(runCli(['profile'])).toContain('当前未设置启动检查范围')
    expect(runCli(['profile', 'cursor', 'skill', 'mcp'])).toContain(
      '已保存启动检查设置',
    )
    const profiles = JSON.parse(runCli(['profile', '--json']))
    expect(profiles).toEqual([{ targetId: 'cursor', kinds: ['skill', 'mcp'] }])
    expect(runCli(['profile'])).toContain('cursor  skill、mcp')

    runCli(['profile', 'cursor'])
    expect(JSON.parse(runCli(['profile', '--json']))).toEqual([])
  })

  test('supports create with --tag, --env, --header and show/save roundtrip', async () => {
    const { home, runCli } = await createCliFixture()
    const bodyFile = join(home, 'review.md')
    await writeFile(bodyFile, '# Review\nCheck edge cases.\n')

    runCli([
      'create',
      'skill',
      'code-review',
      '--description',
      'Review code changes',
      '--file',
      bodyFile,
      '--tag',
      'team',
      '--tag',
      'qa',
    ])
    runCli([
      'create',
      'mcp',
      'local-tool',
      '--command',
      'node',
      '--arg',
      'server.js',
      '--env',
      'API_KEY=secret=1',
      '--tag',
      'local',
    ])
    runCli([
      'create',
      'mcp',
      'remote-docs',
      '--url',
      'https://example.com/mcp',
      '--header',
      'Authorization=Bearer token',
      '--tag',
      'remote',
    ])

    const skill = JSON.parse(runCli(['show', 'skill:code-review', '--json']))
    expect(skill.tags).toEqual(['qa', 'team'])
    expect(
      runCli(['show', 'skill:code-review', '--file', 'SKILL.md']),
    ).toContain('Check edge cases.')

    const localMcp = JSON.parse(runCli(['show', 'mcp:local-tool', '--json']))
    expect(localMcp.tags).toEqual(['local'])
    expect(localMcp.config.env).toEqual({ API_KEY: 'secret=1' })

    const remoteMcp = JSON.parse(runCli(['show', 'mcp:remote-docs', '--json']))
    expect(remoteMcp.tags).toEqual(['remote'])
    expect(remoteMcp.config.headers).toEqual({
      Authorization: 'Bearer token',
    })

    // Roundtrip: show --json -> modify -> save --overwrite --yes
    const exportedFile = join(home, 'exported.json')
    remoteMcp.tags = ['remote', 'edited']
    await writeFile(exportedFile, JSON.stringify(remoteMcp, null, 2))
    runCli(['save', exportedFile, '--overwrite', '--yes'])
    const updated = JSON.parse(runCli(['show', 'mcp:remote-docs', '--json']))
    expect(updated.tags).toEqual(['edited', 'remote'])
  })

  test('supports scan issues/missing output and source files/read/save', async () => {
    const { home, runCli } = await createCliFixture()
    const skillDir = join(home, '.cursor/skills/sample')
    await mkdir(skillDir, { recursive: true })
    const skillPath = join(skillDir, 'SKILL.md')
    await writeFile(
      skillPath,
      '---\nname: sample\ndescription: Initial\n---\nOriginal body\n',
    )

    const pluginDir = join(home, '.cursor/plugins/local/demo-kit')
    await mkdir(join(pluginDir, '.cursor-plugin'), { recursive: true })
    await writeFile(
      join(pluginDir, '.cursor-plugin/plugin.json'),
      JSON.stringify({ name: 'demo-kit' }),
    )
    await mkdir(join(pluginDir, 'skills/sub'), { recursive: true })
    await writeFile(
      join(pluginDir, 'skills/sub/SKILL.md'),
      '---\nname: sub\ndescription: Sub skill\n---\nSub body\n',
    )

    const scan = JSON.parse(runCli(['scan', 'cursor', '--json']))
    const skillCandidate = scan.candidates.find(
      (c: { resource: { kind: string; id: string } }) =>
        c.resource.kind === 'skill' && c.resource.id === 'sample',
    )
    const pluginCandidate = scan.candidates.find(
      (c: { resource: { kind: string; id: string } }) =>
        c.resource.kind === 'plugin' && c.resource.id === 'demo-kit',
    )
    expect(skillCandidate).toBeDefined()
    expect(pluginCandidate).toBeDefined()

    // source files for plugin
    const pluginFiles = JSON.parse(
      runCli(['source', 'files', pluginCandidate.id, '--json']),
    )
    expect(pluginFiles.files).toContain('.cursor-plugin/plugin.json')
    expect(pluginFiles.files).toContain('skills/sub/SKILL.md')

    // source read & save for skill
    const readResult = JSON.parse(
      runCli(['source', 'read', skillCandidate.id, '--json']),
    )
    expect(readResult.content).toContain('Original body')

    const editedFile = join(home, 'edited-skill.md')
    await writeFile(
      editedFile,
      readResult.content.replace('Original body', 'Updated body'),
    )
    const saveResult = JSON.parse(
      runCli([
        'source',
        'save',
        skillCandidate.id,
        '--file',
        editedFile,
        '--revision',
        readResult.revision,
        '--yes',
        '--json',
      ]),
    )
    expect(saveResult.updatedId).toBeDefined()
    expect(await readFile(skillPath, 'utf8')).toContain('Updated body')

    // Import then remove local file to verify missing appears in scan text output
    runCli(['import', saveResult.updatedId])
    await rm(skillDir, { recursive: true, force: true })
    const scanText = runCli(['scan', 'cursor'])
    expect(scanText).toContain('已移除')
    expect(scanText).toContain('skill:sample')
  })

  test('supports github list when empty', async () => {
    const { runCli } = await createCliFixture()
    expect(runCli(['github', 'list'])).toContain('还没有添加 GitHub 来源')
    expect(JSON.parse(runCli(['github', 'list', '--json']))).toEqual([])
  })
})
