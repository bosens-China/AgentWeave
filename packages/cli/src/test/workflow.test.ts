import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { pluginFromFiles } from '../central/plugin.js'
import { previewSync } from '../adapters/index.js'
import { startServer } from '../server.js'
import { createService } from '../service.js'

const fixtureDirectories: string[] = []

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-workflow-'))
  fixtureDirectories.push(home)
  return {
    home,
    service: createService({ home, root: join(home, 'AgentWeave') }),
  }
}

async function writeSkill(
  home: string,
  directory: string,
  id: string,
  body: string,
) {
  const path = join(home, directory, id)
  await mkdir(path, { recursive: true })
  const file = join(path, 'SKILL.md')
  await writeFile(
    file,
    `---\nname: ${id}\ndescription: Fixture skill\n---\n${body}\n`,
  )
  return file
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('the local workflow', () => {
  test('reports malformed local files and offers only validated import candidates', async () => {
    const { home, service } = await fixture()
    await writeSkill(home, '.cursor/skills', 'valid-skill', 'Valid skill')
    const badDir = join(home, '.cursor/skills/invalid-skill')
    const plugin = join(home, '.cursor/plugins/local/broken/.cursor-plugin')
    await Promise.all(
      [badDir, plugin, join(home, '.claude')].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    )
    await Promise.all([
      writeFile(
        join(badDir, 'SKILL.md'),
        '---\nname: invalid-skill\n---\nNo description',
      ),
      writeFile(
        join(plugin, 'plugin.json'),
        JSON.stringify({ name: 'broken', mcpServers: './absent.json' }),
      ),
      writeFile(join(home, '.claude/CLAUDE.md'), Buffer.from([0xff])),
      writeFile(
        join(home, '.cursor/mcp.json'),
        JSON.stringify({
          mcpServers: {
            broken: { url: 'ftp://example.test' },
            good: { url: 'https://example.test/mcp' },
          },
        }),
      ),
    ])
    const targetIds = ['cursor', 'claude']
    const { candidates, warnings } = await service.run('scan', { targetIds })
    expect(candidates.map(({ resource }) => resource.id)).toEqual([
      'good',
      'valid-skill',
    ])
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/invalid-skill.*description/),
        expect.stringMatching(/broken.*HTTP\(S\)/),
        expect.stringMatching(/broken.*absent\.json/),
        expect.stringMatching(/CLAUDE\.md.*UTF-8/),
      ]),
    )
    const imported = await service.run('import', {
      targetIds,
      selections: candidates.map(({ id }) => ({ id })),
    })
    expect(imported).toHaveLength(2)
  })

  test('lists plugins first and folds only identical standalone resources', async () => {
    const { home, service } = await fixture()
    const plugin = '.cursor/plugins/local/sample'
    await mkdir(join(home, plugin, '.cursor-plugin'), { recursive: true })
    await writeFile(
      join(home, plugin, '.cursor-plugin/plugin.json'),
      JSON.stringify({ name: 'sample' }),
    )
    await writeSkill(home, `${plugin}/skills`, 'review', 'Bundled content')
    await writeSkill(home, '.cursor/skills', 'review', 'Bundled content')
    await writeSkill(
      home,
      '.config/opencode/skills',
      'review',
      'Different content',
    )
    await writeFile(
      join(home, '.config/opencode/AGENTS.md'),
      '# Global guidance\n',
    )
    const { candidates, warnings } = await service.run('scan', {
      targetIds: ['opencode', 'cursor'],
    })
    expect(warnings).toEqual([])
    expect(
      candidates.map(({ targetId, resource }) => [
        targetId,
        resource.kind,
        resource.id,
      ]),
    ).toEqual([
      ['cursor', 'plugin', 'sample'],
      ['opencode', 'instructions', 'agents'],
      ['opencode', 'skill', 'review'],
    ])
  })

  test('previews and distributes only the npm bundle and keeps a durable runtime', async () => {
    const { home, service } = await fixture()
    const from = join(
      home,
      '_npx/fixture/node_modules/agentweave-example-bundle',
    )
    await cp(
      new URL('../../../../examples/npm-bundle/', import.meta.url),
      from,
      { recursive: true },
    )
    const unrelated = await writeSkill(
      home,
      '.claude/skills',
      'existing',
      'Unrelated content',
    )
    const scope = { from, targetId: 'claude' }
    expect(await service.run('capabilities')).toMatchObject({
      apiVersions: [1],
      features: ['distribute-npm-bundle'],
    })
    const first = await service.run('preview-bundle', scope)
    expect(first).toMatchObject({
      packageName: 'agentweave-example-bundle',
      packageVersion: '0.1.0',
      resourceCount: 2,
    })
    expect(first.changes).toHaveLength(2)
    expect((await service.run('overview')).resources).toEqual([])
    await writeFile(join(from, 'revision.txt'), 'New contents')
    await expect(
      service.run('apply-bundle', { ...scope, revision: first.revision }),
    ).rejects.toThrow('重新预览')
    const second = await service.run('preview-bundle', scope)
    await service.run('apply-bundle', { ...scope, revision: second.revision })
    expect(await readFile(unrelated, 'utf8')).toContain('Unrelated')
    expect(
      (await service.run('overview')).resources.every(({ tags }) =>
        tags?.includes('npm:agentweave-example-bundle@0.1.0'),
      ),
    ).toBe(true)
    expect((await service.run('preview-bundle', scope)).changes).toEqual([])
    const config = JSON.parse(
      await readFile(join(home, '.claude.json'), 'utf8'),
    ).mcpServers['agentweave-example-echo']
    expect(config.args[0]).toContain(join('AgentWeave', 'npm-runtimes'))
    await rm(from, { recursive: true })
    const echo = execFileSync(config.command, config.args, {
      input:
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: { text: 'hello' } },
        }) + '\n',
      encoding: 'utf8',
    })
    expect(JSON.parse(echo).result.content[0].text).toBe('hello')
  })

  test('consents to import, distributes a copy, and previews explicit deletion', async () => {
    const { home, service } = await fixture()
    await mkdir(join(home, '.codex'))
    const original = await writeSkill(
      home,
      '.agents/skills',
      'review',
      'Central version',
    )
    const extra = await writeSkill(
      home,
      '.claude/skills',
      'private',
      'Locally installed',
    )

    const before = await service.run('overview')
    expect(before.targets).toHaveLength(13)
    expect(before.initialized).toBe(false)
    expect(before.resources).toEqual([])

    const { candidates } = await service.run('scan', { targetIds: ['codex'] })
    expect(candidates).toHaveLength(1)
    await service.run('import', {
      targetIds: ['codex'],
      selections: [{ id: candidates[0].id }],
    })
    await service.run('set-profile', { targetId: 'claude', kinds: ['skill'] })

    const individual = {
      targetId: 'claude',
      kinds: ['skill'],
      keys: ['skill:review'],
    }
    const itemPlan = await service.run('preview-sync', individual)
    expect(itemPlan.changes.map(({ action, key }) => [action, key])).toEqual([
      ['add', 'skill:review'],
    ])
    await service.run('apply-sync', {
      ...individual,
      revision: itemPlan.revision,
    })
    const distributed = join(home, '.claude/skills/review/SKILL.md')
    expect(await readFile(distributed, 'utf8')).toBe(
      await readFile(original, 'utf8'),
    )

    await service.run('delete-resource', { key: 'skill:review' })
    expect(await readFile(distributed, 'utf8')).toContain('Central version')
    const after = await service.run('overview')
    expect(after.initialized).toBe(true)
    expect(
      after.drift[0].changes.map(({ action, key }) => [action, key]).sort(),
    ).toEqual([
      ['delete', 'skill:private'],
      ['delete', 'skill:review'],
    ])
    const scope = { targetId: 'claude', kinds: ['skill'] }
    await writeFile(extra, 'Edited after preview\n')
    await expect(
      service.run('apply-sync', {
        ...scope,
        revision: after.drift[0].revision,
      }),
    ).rejects.toThrow()
    expect(await readFile(extra, 'utf8')).toContain('Edited after preview')
    const fresh = await service.run('preview-sync', scope)
    await service.run('apply-sync', { ...scope, revision: fresh.revision })
    await expect(readFile(distributed)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(original, 'utf8')).toContain('Central version')
  })

  test('serves the JSON API only for local UI requests', async () => {
    const { service } = await fixture()
    const { server, url } = await startServer(service, { port: 0 })
    try {
      const command = (
        origin?: string,
        contentType = 'application/json',
        options: RequestInit & { duplex?: 'half' } = {},
      ) =>
        fetch(`${url}/api/import`, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            ...(origin && { Origin: origin }),
          },
          body: '{"selections":[]}',
          ...options,
        })
      expect((await command('https://example.com')).status).toBe(403)
      expect((await command(undefined)).status).toBe(403)
      expect((await command(url, 'text/plain')).status).toBe(415)
      const invalid = await command(url, 'application/json', { body: '{' })
      expect(invalid.status).toBe(400)
      expect(invalid.headers.get('cache-control')).toBe('no-store')
      expect(await invalid.json()).toEqual({ error: '请求的 JSON 格式有误。' })
      expect((await fetch(`${url}/api/import`)).status).toBe(405)
      expect((await service.run('overview')).initialized).toBe(false)
      const streamed = await command(url, 'application/json', {
        duplex: 'half',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('{"selections":'))
            controller.enqueue(Buffer.from('[]}'))
            controller.close()
          },
        }),
      })
      expect(streamed.status).toBe(200)
      expect((await service.run('overview')).initialized).toBe(true)

      const fileImport = {
        fromFile: true,
        resource: {
          kind: 'skill',
          id: 'broken',
          name: 'broken',
          files: {
            'SKILL.md': Buffer.from('---\nname: broken\n---\n').toString(
              'base64',
            ),
          },
        },
      }
      await expect(service.run('save-resource', fileImport)).rejects.toThrow(
        'description',
      )
      const rejected = await fetch(`${url}/api/save-resource`, {
        method: 'POST',
        headers: { Origin: url, 'Content-Type': 'application/json' },
        body: JSON.stringify(fileImport),
      })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({
        error: expect.stringContaining('description'),
      })
      expect((await service.run('overview')).resources).toEqual([])
    } finally {
      await new Promise((done) => server.close(done))
    }
  })

  test('detects and syncs Skills through all thirteen user-level adapters', async () => {
    const { home, service } = await fixture()
    const paths = {
      codex: '.agents/skills',
      claude: '.claude/skills',
      pi: '.pi/agent/skills',
      opencode: '.config/opencode/skills',
      cursor: '.cursor/skills',
      antigravity: '.gemini/config/skills',
      cline: '.cline/skills',
      windsurf: '.codeium/windsurf/skills',
      qwen: '.qwen/skills',
      openclaw: '.openclaw/skills',
      kiro: '.kiro/skills',
      copilot: '.copilot/skills',
      'kimi-code': '.kimi-code/skills',
    }
    await mkdir(join(home, '.codex'))
    const skillText =
      '---\nname: common\ndescription: Shared fixture\n---\nVerify this result.\n'
    await service.run('save-resource', {
      resource: {
        kind: 'skill',
        id: 'common',
        name: 'common',
        files: { 'SKILL.md': Buffer.from(skillText).toString('base64') },
      },
    })
    for (const [targetId, directory] of Object.entries(paths)) {
      await writeSkill(home, directory, 'first-scan', 'Source version')
      const scan = await service.run('scan', { targetIds: [targetId] })
      expect(
        scan.candidates.some(
          ({ resource }) =>
            resource.id === 'first-scan' && resource.kind === 'skill',
        ),
        targetId,
      ).toBe(true)
      const selection = { targetId, kinds: ['skill'], keys: ['skill:common'] }
      const plan = await service.run('preview-sync', selection)
      expect(plan.changes, targetId).toHaveLength(1)
      await service.run('apply-sync', { ...selection, revision: plan.revision })
      expect(
        await readFile(join(home, directory, 'common', 'SKILL.md'), 'utf8'),
      ).toBe(skillText)
      expect(
        (await service.run('preview-sync', selection)).changes,
        targetId,
      ).toEqual([])
    }
    expect(
      (await service.run('overview')).targets.filter(
        ({ detected }) => detected,
      ),
    ).toHaveLength(13)
  })

  test('translates portable MCP entries and preserves adjacent target configuration', async () => {
    const { home, service } = await fixture()
    const targetDir = join(home, '.config', 'opencode')
    await mkdir(targetDir, { recursive: true })
    const path = join(targetDir, 'opencode.json')
    await writeFile(
      path,
      JSON.stringify(
        {
          theme: 'light',
          mcp: {
            local: { type: 'remote', url: 'https://example.org/mcp' },
            custom: { type: 'custom', url: 'https://example.org/custom' },
          },
        },
        null,
        2,
      ),
    )
    await service.run('save-resource', {
      resource: {
        kind: 'mcp',
        id: 'docs',
        name: 'docs',
        config: { command: 'fixture-command', args: ['serve'] },
      },
    })
    const select = { targetId: 'opencode', kinds: ['mcp'], keys: ['mcp:docs'] }
    const plan = await service.run('preview-sync', select)
    expect(plan.changes.map(({ action, key }) => [action, key])).toEqual([
      ['add', 'mcp:docs'],
    ])
    await service.run('apply-sync', { ...select, revision: plan.revision })
    const adjacent = JSON.parse(await readFile(path, 'utf8'))
    expect(adjacent.theme).toBe('light')
    expect(adjacent.mcp.local.type).toBe('remote')
    expect(adjacent.mcp.docs).toMatchObject({
      type: 'local',
      command: ['fixture-command', 'serve'],
    })
    const scope = { targetId: 'opencode', kinds: ['mcp'] }
    const cleanup = await service.run('preview-sync', scope)
    expect(cleanup.warnings).toContain(
      `OpenCode 的 MCP custom（${path}）：无法转换该 MCP 传输类型`,
    )
    expect(cleanup.changes.map(({ action, key }) => [action, key])).toEqual([
      ['delete', 'mcp:local'],
    ])
  })

  test('applies the same MCP validation at creation, editing and distribution', async () => {
    const { home, service } = await fixture()
    await expect(
      service.run('create-resource', {
        kind: 'mcp',
        id: 'docs',
        transport: 'streamable-http',
        url: 'relative',
      }),
    ).rejects.toThrow('HTTP(S)')
    await expect(
      service.run('create-resource', {
        kind: 'mcp',
        id: '.internal',
        transport: 'stdio',
        command: 'fixture',
      }),
    ).rejects.toThrow('标识')
    const valid = await service.run('create-resource', {
      kind: 'mcp',
      id: 'docs',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    })
    const broken = {
      ...valid,
      id: 'broken',
      name: 'broken',
      config: { url: 'relative' },
    }
    await expect(
      service.run('save-resource', {
        resource: { ...broken, id: valid.id, name: valid.name },
        replace: true,
      }),
    ).rejects.toThrow('HTTP(S)')
    expect((await service.run('overview')).resources).toEqual([valid])
    const plan = await previewSync({
      home,
      targetId: 'codex',
      kinds: ['mcp'],
      resources: [
        broken,
        { ...valid, id: '.internal', name: '.internal' },
        valid,
      ],
    })
    expect(plan.changes.map(({ key }) => key)).toEqual(['mcp:docs'])
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/broken.*HTTP\(S\)/),
        expect.stringMatching(/\.internal.*标识无效/),
      ]),
    )
  })

  test('keeps quoted YAML keys when importing a flat Skill', async () => {
    const { home, service } = await fixture()
    const directory = join(home, '.config/opencode/skills')
    await mkdir(directory, { recursive: true })
    const text =
      '---\n"name": review # a valid key\ndescription: Review changes\n--- \nReview carefully.\n'
    await writeFile(join(directory, 'review.md'), text)
    const { candidates, warnings } = await service.run('scan', {
      targetIds: ['opencode'],
    })
    expect(warnings).toEqual([])
    expect(candidates.map(({ resource }) => resource)).toMatchObject([
      {
        id: 'review',
        name: 'review',
        files: { 'SKILL.md': Buffer.from(text).toString('base64') },
      },
    ])
  })

  test('creates local resources and converts new MCP connections for targets', async () => {
    const { home, service } = await fixture()
    const input = {
      kind: 'skill',
      id: 'code-review',
      description: 'Check code: correctness and tests.',
      text: '    Preserve Markdown indentation.\n',
    }
    await expect(
      service.run('create-resource', { ...input, id: 'Bad--Name' }),
    ).rejects.toThrow('Skill 标识')
    const skill = await service.run('create-resource', input)
    await expect(
      service.run('create-resource', { ...input, text: 'conflict' }),
    ).rejects.toThrow('重名')
    expect(
      await service.run('create-resource', {
        kind: 'instructions',
        id: 'rules',
        text: '# Local rules\n',
      }),
    ).toMatchObject({ kind: 'instructions', text: '# Local rules\n' })
    await service.run('create-resource', {
      kind: 'mcp',
      id: 'command',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    })
    await service.run('create-resource', {
      kind: 'mcp',
      id: 'remote',
      transport: 'streamable-http',
      url: 'https://example.org/mcp',
    })
    await service.run('create-resource', {
      kind: 'mcp',
      id: 'legacy',
      transport: 'sse',
      url: 'https://example.org/sse',
    })
    const { sources, targets, mcpProtocolBaseline } =
      await service.run('overview')
    expect(sources).toEqual([])
    expect(mcpProtocolBaseline).toBe('2026-07-28')
    expect(targets.find(({ id }) => id === 'codex')?.mcpTransports).toEqual([
      'stdio',
      'streamable-http',
    ])
    const skillPath = join(home, '.claude/skills/code-review/SKILL.md')
    await expect(readFile(skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const skillScope = { targetId: 'claude', kinds: ['skill'] }
    const skillPlan = await service.run('preview-sync', skillScope)
    await service.run('apply-sync', {
      ...skillScope,
      revision: skillPlan.revision,
    })
    const installed = await readFile(skillPath, 'utf8')
    expect(installed).toEqual(
      Buffer.from(skill.files!['SKILL.md'], 'base64').toString(),
    )
    expect(installed).toContain(
      'description: "Check code: correctness and tests."\n---\n\n    Preserve',
    )
    const qwenScope = { targetId: 'qwen', kinds: ['mcp'] }
    const qwen = await service.run('preview-sync', qwenScope)
    expect(qwen.warnings).toEqual([])
    await service.run('apply-sync', { ...qwenScope, revision: qwen.revision })
    expect(
      JSON.parse(await readFile(join(home, '.qwen/settings.json'), 'utf8'))
        .mcpServers,
    ).toEqual({
      command: { command: 'node', args: ['server.js'] },
      legacy: { url: 'https://example.org/sse' },
      remote: { httpUrl: 'https://example.org/mcp' },
    })
    expect((await service.run('preview-sync', qwenScope)).changes).toEqual([])
    const codex = await service.run('preview-sync', {
      targetId: 'codex',
      kinds: ['mcp'],
    })
    expect(codex.warnings).toContain('legacy → Codex：该目标无法转换 SSE 配置')
    expect(codex.changes.map(({ key }) => key)).toEqual([
      'mcp:command',
      'mcp:remote',
    ])
  })

  test('imports AGENTS.md and installs the same instructions under the native target name', async () => {
    const { home, service } = await fixture()
    await mkdir(join(home, '.codex'))
    const instructions = '# Team rules\n\nKeep changes focused.\n'
    await writeFile(join(home, '.codex', 'AGENTS.md'), instructions)
    const { candidates } = await service.run('scan', { targetIds: ['codex'] })
    const selected = candidates.find(
      ({ resource }) => resource.kind === 'instructions',
    )
    await service.run('import', {
      selections: [{ id: selected!.id }],
      targetIds: ['codex'],
    })
    const scope = { targetId: 'claude', kinds: ['instructions'] }
    const plan = await service.run('preview-sync', scope)
    expect(plan.changes.map(({ action, key }) => [action, key])).toEqual([
      ['add', 'instructions:agents'],
    ])
    await service.run('apply-sync', { ...scope, revision: plan.revision })
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(
      instructions,
    )
  })

  test('syncs the active Codex instructions and previews clearing both fallback paths', async () => {
    const { home, service } = await fixture()
    await mkdir(join(home, '.codex'))
    const fallback = join(home, '.codex/AGENTS.md')
    const override = join(home, '.codex/AGENTS.override.md')
    await writeFile(fallback, 'Fallback rules\n')
    await writeFile(override, '')
    const scan = () => service.run('scan', { targetIds: ['codex'] })
    expect((await scan()).candidates[0].resource.text).toBe('Fallback rules\n')
    await writeFile(override, 'Override rules\n')
    expect((await scan()).candidates[0].resource.text).toBe('Override rules\n')
    await service.run('create-resource', {
      kind: 'instructions',
      id: 'team',
      text: 'Central rules\n',
    })
    const scope = { targetId: 'codex', kinds: ['instructions'] }
    const plan = await service.run('preview-sync', scope)
    expect(plan.changes.map(({ action, path }) => [action, path])).toEqual([
      ['overwrite', override],
    ])
    await service.run('apply-sync', { ...scope, revision: plan.revision })
    expect(await readFile(override, 'utf8')).toBe('Central rules\n')
    expect(await readFile(fallback, 'utf8')).toBe('Fallback rules\n')
    await service.run('delete-resource', { key: 'instructions:team' })
    const cleanup = await service.run('preview-sync', scope)
    expect(cleanup.changes.map(({ action, path }) => [action, path])).toEqual([
      ['delete', override],
      ['delete', fallback],
    ])
    await service.run('apply-sync', { ...scope, revision: cleanup.revision })
    expect((await scan()).candidates).toEqual([])
  })

  test('converts a Codex plugin and distributes one component without touching adjacent Skills', async () => {
    const { home, service } = await fixture()
    const skill =
      '---\nname: review\ndescription: A fixture\n---\nReview a diff.\n'
    const files = Object.fromEntries(
      Object.entries({
        '.codex-plugin/plugin.json': JSON.stringify({
          name: 'review-kit',
          version: '1.0.0',
        }),
        'skills/review/SKILL.md': skill,
        '.mcp.json': JSON.stringify({
          mcpServers: { docs: { url: 'https://example.org/mcp' } },
        }),
        'hooks/hooks.json': '{"hooks":{}}',
      }).map(([path, value]) => [path, Buffer.from(value).toString('base64')]),
    )
    const plugin = pluginFromFiles(files)
    expect(plugin?.components?.map(({ kind }) => kind).sort()).toEqual([
      'mcp',
      'skill',
    ])
    await service.run('save-resource', { resource: plugin })
    const whole = {
      targetId: 'cursor',
      kinds: ['plugin'],
      keys: ['plugin:review-kit'],
    }
    const plan = await service.run('preview-sync', whole)
    expect(plan.changes.map(({ action, key }) => [action, key])).toEqual([
      ['add', 'plugin:review-kit'],
    ])
    expect(plan.warnings.join(' ')).toContain('hooks')
    await service.run('apply-sync', { ...whole, revision: plan.revision })
    const installed = join(home, '.cursor/plugins/local/review-kit')
    expect(
      JSON.parse(
        await readFile(join(installed, '.cursor-plugin/plugin.json'), 'utf8'),
      ).name,
    ).toBe('review-kit')
    expect(
      await readFile(join(installed, 'skills/review/SKILL.md'), 'utf8'),
    ).toBe(skill)

    const unrelated = await writeSkill(
      home,
      '.openclaw/skills',
      'private',
      'Local Skill',
    )
    const single = {
      targetId: 'openclaw',
      kinds: ['skill'],
      keys: ['plugin:review-kit/skill:review'],
    }
    const components = await service.run('preview-sync', single)
    expect(components.changes.map(({ action, key }) => [action, key])).toEqual([
      ['add', 'skill:review'],
    ])
    await service.run('apply-sync', {
      ...single,
      revision: components.revision,
    })
    expect(
      await readFile(join(home, '.openclaw/skills/review/SKILL.md'), 'utf8'),
    ).toBe(skill)
    expect(await readFile(unrelated, 'utf8')).toContain('Local Skill')
  })
})
