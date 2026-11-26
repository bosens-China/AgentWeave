import { installFixtureAgents } from './installed-fixture.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readMcp } from '../adapters/mcp.js'
import { patchMcpSource } from '../adapters/mcp-source.js'
import { resolveTargets, targetFor } from '../adapters/targets.js'
import { createService } from '../service.js'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-mcp-source-'))
  await installFixtureAgents(home, 'cursor', 'codex', 'opencode')
  return {
    home,
    service: createService({ home, root: join(home, 'repository') }),
  }
}

const codexText =
  '# Global comment\nmodel = "existing"\n\n[mcp_servers.first]\ncommand = "old" # keep this\nargs = ["serve"]\n\n[mcp_servers.first.env]\nTOKEN = "${TOKEN}"\n\n# Other server comment\n[mcp_servers.second]\ncommand = "other"\n\n[features]\nflag = true\n'

test('edits one Codex MCP in native TOML and preserves other services and comments', async () => {
  const { home, service } = await fixture()
  try {
    const path = join(home, '.codex/config.toml')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(path, codexText)
    const scan = await service.run('scan', { targetIds: ['codex'] })
    const first = scan.candidates.find((item) => item.resource.id === 'first')!
    expect(first.resource.config).toMatchObject({
      command: 'old',
      args: ['serve'],
    })
    const source = await service.run('read-scan-source', { id: first.id })
    expect(source.content).toContain('[mcp_servers.first]')
    expect(source.content).toContain('[mcp_servers.first.env]')
    expect(source.content).not.toContain('command = "other"')
    expect(source.content).not.toContain('model =')
    await expect(
      service.run('save-scan-source', {
        id: first.id,
        revision: source.revision,
        content: source.content.replace('command = "old"', 'command = ""'),
      }),
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(codexText)
    const changed = source.content.replace('command = "old"', 'command = "new"')
    const refreshed = await service.run('save-scan-source', {
      id: first.id,
      revision: source.revision,
      content: changed,
    })
    expect(await readFile(path, 'utf8')).toBe(
      codexText.replace('command = "old"', 'command = "new"'),
    )
    const updated = refreshed.candidates.find(
      (item) => item.targetId === 'codex' && item.resource.id === 'first',
    )!
    await service.run('import', {
      targetIds: ['codex'],
      selections: [{ id: updated.id }],
    })
    const stored = (await service.run('overview')).resources.find(
      (item) => item.id === 'first',
    )!
    expect(stored.config).toMatchObject({
      command: 'new',
      args: ['serve'],
      env: { TOKEN: '${TOKEN}' },
    })
    const target = { targetId: 'opencode', kinds: ['mcp'], keys: ['mcp:first'] }
    const plan = await service.run('preview-sync', target)
    await service.run('apply-sync', { ...target, revision: plan.revision })
    const opencode = JSON.parse(
      await readFile(join(home, '.config/opencode/opencode.json'), 'utf8'),
    )
    expect(opencode.mcp.servers.first).toMatchObject({
      type: 'local',
      command: ['new', 'serve'],
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30000)

test('edits a JSONC server without touching adjacent entries or comments', async () => {
  const { home, service } = await fixture()
  try {
    const path = join(home, '.cursor/mcp.json')
    await mkdir(join(home, '.cursor'), { recursive: true })
    const raw =
      '{\n  // keep global\n  "theme": "dark",\n  "mcpServers": {\n    "one": { "command": "old", "args": ["a"] },\n    // keep other\n    "two": { "command": "other" }\n  }\n}\n'
    await writeFile(path, raw)
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const candidate = scan.candidates.find(
      (item) => item.resource.id === 'one',
    )!
    const source = await service.run('read-scan-source', { id: candidate.id })
    expect(source.content).toContain('"one"')
    expect(source.content).not.toContain('"two"')
    expect(source.content).not.toContain('theme')
    await expect(
      service.run('save-scan-source', {
        id: candidate.id,
        revision: source.revision,
        content: '{"one": {"command": ""}}',
      }),
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(raw)
    await expect(
      service.run('save-scan-source', {
        id: candidate.id,
        revision: source.revision,
        content: '{"one":{"command":"wrong"},"one":{"command":"valid"}}',
      }),
    ).rejects.toThrow('只填写当前')
    expect(await readFile(path, 'utf8')).toBe(raw)
    await service.run('save-scan-source', {
      id: candidate.id,
      revision: source.revision,
      content: source.content.replace('"old"', '"new"'),
    })
    expect(await readFile(path, 'utf8')).toBe(raw.replace('"old"', '"new"'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('repairs an invalid MCP server without exposing or modifying another server', async () => {
  const { home, service } = await fixture()
  try {
    const directory = join(home, '.cursor')
    const path = join(directory, 'mcp.json')
    await mkdir(directory, { recursive: true })
    const raw =
      '{"mcpServers":{"db（prod）":{"url":"ftp://bad"},"db":{"command":"node"}}}'
    await writeFile(path, raw)
    const scan = await service.run('scan', { targetIds: ['cursor'] })
    const issue = scan.issues.find((item) => item.name === 'db（prod）')!
    const source = await service.run('read-scan-source', { id: issue.id })
    expect(source.content).toContain('ftp://bad')
    expect(source.content).not.toContain('node')
    const result = await service.run('save-scan-source', {
      id: issue.id,
      revision: source.revision,
      content: source.content.replace('ftp://bad', 'https://example.test/mcp'),
    })
    expect(await readFile(path, 'utf8')).toBe(
      raw.replace('ftp://bad', 'https://example.test/mcp'),
    )
    expect(
      result.candidates.some((item) => item.resource.id === 'db（prod）'),
    ).toBe(true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('shows and edits the OpenCode native server definition inside its nested layout', async () => {
  const { home, service } = await fixture()
  try {
    const directory = join(home, '.config/opencode')
    const path = join(directory, 'opencode.jsonc')
    await mkdir(directory, { recursive: true })
    const raw =
      '{\n // app settings\n "mcp": { "servers": { "one": { "type": "local", "command": ["node", "one.js"] }, "two": { "type": "remote", "url": "https://example.org" } } },\n "theme": "dark"\n}\n'
    await writeFile(path, raw)
    const scan = await service.run('scan', { targetIds: ['opencode'] })
    const candidate = scan.candidates.find(
      (item) => item.resource.id === 'one',
    )!
    expect(candidate.resource.config).toMatchObject({
      command: 'node',
      args: ['one.js'],
    })
    const source = await service.run('read-scan-source', { id: candidate.id })
    expect(source.content).toContain('"command": ["node", "one.js"]')
    expect(source.content).not.toContain('"two"')
    await service.run('save-scan-source', {
      id: candidate.id,
      revision: source.revision,
      content: source.content.replace('one.js', 'updated.js'),
    })
    expect(await readFile(path, 'utf8')).toBe(
      raw.replace('one.js', 'updated.js'),
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('edits an inline TOML server without rewriting its siblings or overwriting changed files', async () => {
  const { home, service } = await fixture()
  try {
    const path = join(home, '.codex/config.toml')
    await mkdir(join(home, '.codex'), { recursive: true })
    const raw =
      'mcp_servers = { one = { command = "old" }, two = { command = "other" } }\n'
    await writeFile(path, raw)
    const scan = await service.run('scan', { targetIds: ['codex'] })
    const candidate = scan.candidates.find(
      (item) => item.resource.id === 'one',
    )!
    const source = await service.run('read-scan-source', { id: candidate.id })
    expect(source.content).not.toContain('other')
    const updated = await service.run('save-scan-source', {
      id: candidate.id,
      revision: source.revision,
      content: source.content.replace('old', 'new'),
    })
    const saved = await readFile(path, 'utf8')
    expect(saved).toContain('two = { command = "other" }')
    expect(saved).toContain('"command" = "new"')
    const next = updated.candidates.find((item) => item.resource.id === 'one')!
    const fresh = await service.run('read-scan-source', { id: next.id })
    await writeFile(path, `${saved}# external change\n`)
    await expect(
      service.run('save-scan-source', {
        id: next.id,
        revision: fresh.revision,
        content: fresh.content,
      }),
    ).rejects.toThrow('文件已被修改')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test.each([
  '{"mcpServers":{"one":{"command":"first"},"one":{"command":"last"}}}',
  '{"mcpServers":{"one":{"command":"first"}},"mcpServers":{"one":{"command":"last"}}}',
])('rejects ambiguous MCP paths in the original JSONC', async (raw) => {
  const { home, service } = await fixture()
  try {
    const directory = join(home, '.cursor')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'mcp.json')
    await writeFile(path, raw)
    const { candidates } = await service.run('scan', { targetIds: ['cursor'] })
    expect(candidates[0].resource.config?.command).toBe('last')
    await expect(
      service.run('read-scan-source', { id: candidates[0].id }),
    ).rejects.toThrow('重复键')
    const snapshot = await readMcp(
      targetFor(await resolveTargets({ home }), 'cursor'),
    )
    expect(() =>
      patchMcpSource(snapshot, 'one', '{"one":{"command":"new"}}'),
    ).toThrow('重复键')
    expect(await readFile(path, 'utf8')).toBe(raw)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
