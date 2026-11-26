import {
  suggestedLocalSelections,
  toggleLocalSelection,
} from '../../../../apps/web/src/import-selection.js'
import { installFixtureAgents } from './installed-fixture.js'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { pluginFromFiles } from '../central/plugin.js'
import { readNpmBundle } from '../central/npm-bundle.js'
import { previewSync } from '../adapters/index.js'
import { startServer } from '../server.js'
import { createService } from '../service.js'

const fixtureDirectories: string[] = []

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-workflow-'))
  fixtureDirectories.push(home)
  await installFixtureAgents(
    home,
    'cursor',
    'codex',
    'claude',
    'qwen',
    'opencode',
  )
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
  test('imports only checked resources', async () => {
    const { home, service } = await fixture()
    await writeSkill(home, '.cursor/skills', 'checked', 'Checked')
    await writeSkill(home, '.cursor/skills', 'unchecked', 'Unchecked')
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const checked = scan.candidates.find(
      (item) => item.resource.id === 'checked',
    )!
    const result = await service.run('import', {
      targetIds: ['cursor'],
      selections: [{ id: checked.id }],
    })
    expect(result.map((item) => item.id)).toEqual(['checked'])
    expect(
      (await service.run('overview')).resources.map((item) => item.id),
    ).toEqual(['checked'])
  })

  test('imports the edited shared skill when the same agent also has a private copy', async () => {
    const { home, service } = await fixture()
    const privateFile = await writeSkill(
      home,
      '.cursor/skills',
      'sample',
      'Private',
    )
    await writeSkill(home, '.agents/skills', 'sample', 'Shared')
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const shared = scan.candidates.find(({ resource }) =>
      Buffer.from(resource.files!['SKILL.md'], 'base64')
        .toString()
        .includes('Shared'),
    )!
    const source = await service.run('read-scan-source', { id: shared.id })
    const edited = source.content.replace('Shared', 'Updated shared copy')
    const next = await service.run('save-scan-source', {
      id: shared.id,
      revision: source.revision,
      content: edited,
    })
    expect(next.updatedId).toBeDefined()
    const [imported] = await service.run('import', {
      selections: [{ id: next.updatedId }],
    })
    expect(Buffer.from(imported.files!['SKILL.md'], 'base64').toString()).toBe(
      edited,
    )
    expect(await readFile(privateFile, 'utf8')).toContain('Private')
  })

  test('scans and imports a local plugin larger than 32 MiB', async () => {
    const { home, service } = await fixture()
    const plugin = join(home, '.cursor/plugins/local/large')
    await mkdir(join(plugin, '.cursor-plugin'), { recursive: true })
    await writeFile(
      join(plugin, '.cursor-plugin/plugin.json'),
      JSON.stringify({ name: 'large' }),
    )
    await writeFile(join(plugin, 'large.bin'), Buffer.alloc(33 * 1024 * 1024))
    await writeSkill(
      home,
      '.cursor/plugins/local/large/skills',
      'valid',
      'Body',
    )
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({ name: 'large', version: '1.0.0' }),
    )
    expect(
      (await readNpmBundle(plugin, join(home, 'AgentWeave'))).candidates.length,
    ).toBeGreaterThan(0)
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const candidate = scan.candidates.find(
      (item) => item.resource.id === 'large',
    )
    expect(candidate).toBeDefined()
    const imported = await service.run('import', {
      targetIds: ['cursor'],
      selections: [{ id: candidate!.id }],
    })
    expect(imported[0].id).toBe('large')
    expect(
      Buffer.from(imported[0].files!['large.bin'], 'base64').byteLength,
    ).toBe(33 * 1024 * 1024)
    const { server, url } = await startServer(service, { port: 0 })
    try {
      const response = await fetch(`${url}/api/save-resource`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ resource: imported[0], replace: true }),
      })
      expect(response.status).toBe(200)
      await response.body?.cancel()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 30000)

  test('edits an invalid scanned skill and rescans it without overwriting external changes', async () => {
    const { home, service } = await fixture()
    const file = await writeSkill(home, '.cursor/skills', 'repair-me', 'Body')
    await writeFile(file, '---\nname: repair-me\n---\nBody\n')
    const first = await service.run('scan', {})
    const issue = first.issues.find((item) => item.name === 'repair-me')
    expect(issue).toMatchObject({
      targetId: 'cursor',
      kind: 'skill',
      editable: true,
    })
    const source = await service.run('read-scan-source', { id: issue!.id })
    await writeFile(file, 'changed externally')
    await expect(
      service.run('save-scan-source', {
        id: issue!.id,
        revision: source.revision,
        content: 'replacement',
      }),
    ).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('changed externally')
    await writeFile(file, source.content)
    const refreshed = await service.run('scan', {})
    const current = refreshed.issues.find((item) => item.name === 'repair-me')!
    const editable = await service.run('read-scan-source', { id: current.id })
    const content = '---\nname: repair-me\ndescription: Fixed\n---\nBody\n'
    const result = await service.run('save-scan-source', {
      id: current.id,
      revision: editable.revision,
      content,
    })
    expect(await readFile(file, 'utf8')).toBe(content)
    expect(result.issues.some((item) => item.name === 'repair-me')).toBe(false)
    expect(
      result.candidates.some((item) => item.resource.id === 'repair-me'),
    ).toBe(true)
  })

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
    const { candidates, warnings, issues } = await service.run('scan', {
      targetIds,
    })
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'plugin', name: 'broken' }),
        expect.objectContaining({
          kind: 'mcp',
          name: 'broken',
          reason: expect.stringContaining('HTTP(S)'),
        }),
      ]),
    )
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

  test('shows the underlying plugin validation reason without its file path', async () => {
    const { home, service } = await fixture()
    const plugin = join(home, '.cursor/plugins/local/contains-invalid')
    await mkdir(join(plugin, '.cursor-plugin'), { recursive: true })
    await writeFile(
      join(plugin, '.cursor-plugin/plugin.json'),
      JSON.stringify({ name: 'contains-invalid' }),
    )
    await writeSkill(
      home,
      '.cursor/plugins/local/contains-invalid/skills',
      'bad',
      'Body',
    )
    await writeFile(
      join(plugin, 'skills/bad/SKILL.md'),
      '---\nname: BAD\ndescription: test\n---\n',
    )
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const issue = scan.issues.find((item) => item.name === 'contains-invalid')
    expect(issue?.reason).toContain('name')
    expect(issue?.reason).not.toContain('skills/bad/')
    expect(issue?.warning).toContain('skills/bad/SKILL.md')
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
      ['cursor', 'skill', 'review'],
    ])
    expect(candidates[3].bundledBy).toEqual([candidates[0].id])
    expect(candidates[2].componentConflict).toContain('sample')
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
    expect(before.targets.every((t) => t.detected)).toBe(true)
    expect(before.targets.some((t) => t.id === 'pi')).toBe(false)
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
      for (const action of ['save-resource', 'save-scan-source']) {
        const status = await new Promise<number | undefined>(
          (resolve, reject) => {
            const req = httpRequest(
              `${url}/api/${action}`,
              {
                agent: false,
                method: 'POST',
                headers: {
                  Origin: url,
                  'Content-Type': 'application/json',
                  'Content-Length': 128 * 1024 * 1024 + 1,
                },
              },
              (response) => {
                response.resume()
                resolve(response.statusCode)
              },
            )
            req.on('error', reject)
            req.end()
          },
        )
        expect(status).toBe(413)
      }
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
    await installFixtureAgents(home, ...Object.keys(paths))
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

test('ignores uninstalled agents and detects returning local edits, removals and converted packages', async () => {
  const { home, service } = await fixture()
  await writeSkill(home, '.pi/agent/skills', 'leftover', 'uninstalled agent')
  const local = await writeSkill(
    home,
    '.cursor/skills',
    'review',
    'current version',
  )
  const scan = await service.run('scan')
  expect(scan.candidates.some((c) => c.targetId === 'pi')).toBe(false)
  const candidate = scan.candidates.find((c) => c.resource.id === 'review')!
  await service.run('import', { selections: [{ id: candidate.id }] })
  await writeFile(
    local,
    (await readFile(local, 'utf8')).replace(
      'current version',
      'changed locally',
    ),
  )
  expect(
    (await service.run('scan')).candidates.find(
      (c) => c.resource.id === 'review',
    )?.status,
  ).toBe('conflict')
  await rm(local.replace(/SKILL\.md$/, ''), { recursive: true })
  expect((await service.run('scan')).missing).toContainEqual(
    expect.objectContaining({ targetId: 'cursor', key: 'skill:review' }),
  )
  await installFixtureAgents(home, 'antigravity')
  const pkg = join(home, '.cursor/plugins/local/native')
  await mkdir(join(pkg, '.cursor-plugin'), { recursive: true })
  await writeFile(join(pkg, '.cursor-plugin/plugin.json'), '{"name":"native"}')
  await writeSkill(
    home,
    '.cursor/plugins/local/native/skills',
    'bundled',
    'an original',
  )
  const source = (await service.run('scan')).candidates.find(
    (c) => c.resource.id === 'native',
  )!
  await service.run('import', { selections: [{ id: source.id }] })
  const options = { targetId: 'antigravity', kinds: ['plugin'] }
  const plan = await service.run('preview-sync', options)
  await service.run('apply-sync', { ...options, revision: plan.revision })
  expect(
    (await service.run('scan')).candidates.find(
      (c) => c.targetId === 'antigravity' && c.resource.id === 'native',
    )?.status,
  ).toBe('same')
  const original = (await service.run('overview')).resources.find(
    (r) => r.id === 'native',
  )!
  expect(original.format).toBe('cursor')
  expect(original.files).toHaveProperty(['.cursor-plugin/plugin.json'])
})

test.each(['skill', 'mcp', 'both', 'identical'])(
  'compares %s components supplied solely by two local plugins',
  async (difference) => {
    const { home, service } = await fixture()
    for (const name of ['docs-tools', 'review-tools']) {
      const folder = `.cursor/plugins/local/${name}`
      await mkdir(join(home, folder, '.cursor-plugin'), { recursive: true })
      await writeFile(
        join(home, folder, '.cursor-plugin/plugin.json'),
        JSON.stringify({ name }),
      )
      await writeSkill(
        home,
        `${folder}/skills`,
        'review',
        difference === 'skill' || difference === 'both' ? name : 'shared',
      )
      const command =
        difference === 'mcp' || difference === 'both' ? name : 'shared'
      await writeFile(
        join(home, folder, '.mcp.json'),
        JSON.stringify({ mcpServers: { docs: { command } } }),
      )
    }
    const { candidates } = await service.run('scan')
    expect(candidates.map((c) => c.resource.kind)).toEqual(['plugin', 'plugin'])
    const [first, second] = candidates
    const both = candidates.map((c) => ({ id: c.id }))
    if (difference === 'identical') {
      expect(
        candidates.every((c) => c.status === 'new' && !c.componentConflict),
      ).toBe(true)
      expect(suggestedLocalSelections(candidates)).toEqual(both)
      await service.run('import', { selections: both })
    } else {
      for (const [item, other] of [
        [first, second],
        [second, first],
      ]) {
        expect(item.status).toBe('conflict')
        expect(item.componentAlternatives).toEqual([other.id])
        const expected = []
        if (difference !== 'mcp')
          expected.push(`${other.resource.name}（Skill「review」）`)
        if (difference !== 'skill')
          expected.push(`${other.resource.name}（MCP「docs」）`)
        expect(item.componentConflict?.slice().sort()).toEqual(expected.sort())
      }
      expect(suggestedLocalSelections(candidates)).toEqual([])
      const chosen = toggleLocalSelection(
        second,
        candidates,
        [{ id: first.id }],
        true,
      )
      expect(chosen).toEqual([{ id: second.id }])
      await expect(service.run('import', { selections: both })).rejects.toThrow(
        '同名组件',
      )
      expect((await service.run('overview')).resources).toEqual([])
      await service.run('import', { selections: chosen })
    }
    const plan = await service.run('preview-sync', {
      targetId: 'opencode',
      kinds: ['skill', 'mcp'],
    })
    expect(plan.changes.map((c) => c.key).sort()).toEqual([
      'mcp:docs',
      'skill:review',
    ])
  },
)
