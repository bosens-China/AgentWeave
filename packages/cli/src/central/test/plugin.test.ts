import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  discoverResources,
  mcpResources,
  pluginFromFiles,
  readPlugin,
} from '../plugin.js'
import { decodeServer } from '../../adapters/mcp-format.js'
import { parseGithubUrl, resolveGithubRevision } from '../github.js'

function encode(text: unknown) {
  return Buffer.from(
    typeof text === 'string' ? text : JSON.stringify(text),
  ).toString('base64')
}

it('uses native Codex declarations, preserving the files and separating components', () => {
  const files = {
    '.codex-plugin/plugin.json': encode({
      name: 'writer',
      skills: './workflows',
      mcpServers: './connections.json',
      hooks: './hook.json',
    }),
    'workflows/draft/SKILL.md': encode('---\nname: draft\n---\nDraft.'),
    'workflows/draft/script.sh': encode('Script file'),
    'skills/ignored/SKILL.md': encode('Ignored by Codex legacy declaration'),
    'connections.json': encode({
      mcpServers: {
        writer: {
          command: 'writer',
          args: ['serve'],
          env_vars: ['WRITER_TOKEN'],
        },
      },
    }),
    'AGENTS.md': encode('Use writer for drafts'),
  }
  const plugin = pluginFromFiles(files, { 'workflows/draft/script.sh': 0o755 })
  expect(plugin).toMatchObject({
    name: 'writer',
    format: 'codex',
    files,
    unsupported: ['hooks'],
    components: [
      { kind: 'skill', id: 'draft', modes: { 'script.sh': 0o755 } },
      {
        kind: 'mcp',
        id: 'writer',
        config: {
          command: 'writer',
          args: ['serve'],
          envVars: ['WRITER_TOKEN'],
        },
      },
      { kind: 'instructions', text: 'Use writer for drafts' },
    ],
  })
})

it('uses the portable schema and keeps the nested package together', () => {
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'search',
  }
  const files = {
    'plugins/search/plugin.json': encode(manifest),
    'plugins/search/.codex-plugin/plugin.json': encode({
      name: 'overlay',
      skills: './ignored',
    }),
    'plugins/search/skills/search/SKILL.md': encode('Search.'),
    'plugins/search/mcp.json': encode({
      mcpServers: {
        lookup: { type: 'streamable-http', url: 'https://example.test/mcp' },
      },
    }),
    'plugins/search/ignored/extra/SKILL.md': encode('Not under skills'),
    'skills/another/SKILL.md': encode('Simple standalone skill.'),
  }
  const resources = discoverResources(files, {}, 'root')
  expect(resources).toHaveLength(2)
  expect(resources[0]).toMatchObject({
    id: 'search',
    format: 'portable',
    components: [
      { kind: 'skill', id: 'search' },
      {
        kind: 'mcp',
        id: 'lookup',
        config: { url: 'https://example.test/mcp' },
      },
    ],
  })
  expect(resources[0].components?.[1].config).not.toHaveProperty('type')
  expect(resources[1]).toMatchObject({ kind: 'skill', id: 'another' })
})

it('preserves authentication environment fields in native and source MCP imports', () => {
  const config = {
    url: 'https://example.test/mcp',
    env_http_headers: { 'X-Token': 'DEMO_TOKEN' },
    bearer_token_env_var: 'DEMO_BEARER_TOKEN',
  }
  expect(mcpResources({ mcpServers: { docs: config } })[0].config).toEqual(
    decodeServer(config, {
      id: 'codex',
      name: 'Codex',
      mcp: { variant: 'codex' },
    }),
  )
  expect(mcpResources({ docs: config })[0].config).toMatchObject({
    envHeaders: { 'X-Token': 'DEMO_TOKEN' },
    bearerTokenEnvVar: 'DEMO_BEARER_TOKEN',
  })
})

it('reports malformed manifests and resource files while discovering their valid siblings', () => {
  const files = {
    'plugins/broken/.codex-plugin/plugin.json': encode('{malformed'),
    'plugins/broken/skills/draft/SKILL.md': encode(
      '---\nname: draft\ndescription: Draft\n---\nDraft.',
    ),
    'skills/good/SKILL.md': encode(
      '---\nname: good # a comment\ndescription: >-\n  Find facts\n  from source files.\n---\nRead sources.',
    ),
    'skills/mismatch/SKILL.md': encode(
      '---\nname: wrong-name\ndescription: Check.\n---\nCheck changes.',
    ),
    'skills/bad-yaml/SKILL.md': encode(
      '---\nname: bad-yaml\ndescription: [\n---\nCheck changes.',
    ),
    'AGENTS.md': encode('   \n'),
    'mcp.json': encode({
      mcpServers: {
        docs: { url: 'https://example.test/mcp' },
        invalid: { command: 'node', args: [42] },
      },
    }),
    '.mcp.json': encode('[]'),
  }
  const warnings: string[] = []
  const resources = discoverResources(files, {}, 'root', undefined, warnings)
  expect(resources.map(({ kind, id, name }) => [kind, id, name])).toEqual([
    ['skill', 'good', 'good'],
    ['mcp', 'docs', 'docs'],
  ])
  expect(warnings).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/plugins\/broken.*plugin\.json.*JSON/),
      expect.stringMatching(/skills\/mismatch\/SKILL\.md.*目录名/),
      expect.stringMatching(/skills\/bad-yaml\/SKILL\.md.*YAML/),
      expect.stringMatching(/AGENTS\.md.*非空/),
      expect.stringMatching(/mcp\.json.*invalid.*args/),
      expect.stringMatching(/\.mcp\.json.*JSON/),
    ]),
  )
})

it('loads a Gemini-named Antigravity manifest from disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentweave-plugin-'))
  try {
    await mkdir(join(directory, '.gemini-plugin'))
    await writeFile(
      join(directory, '.gemini-plugin', 'plugin.json'),
      JSON.stringify({ name: 'native' }),
    )
    expect(
      await readPlugin(directory, { format: 'antigravity' }),
    ).toMatchObject({ format: 'antigravity', id: 'native' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('resolves GitHub refs with slashes and rejects non-GitHub resource locations', () => {
  const branchRevision = 'a'.repeat(40)
  const shorterRevision = 'b'.repeat(40)
  const source = parseGithubUrl(
    'https://github.com/Example/Repo/blob/feat%2Falpha/skills/review/SKILL.md',
  )
  expect(
    resolveGithubRevision(
      source,
      new Map([
        ['refs/heads/feat', shorterRevision],
        ['refs/heads/feat/alpha', branchRevision],
      ]),
    ),
  ).toMatchObject({ revision: branchRevision, path: 'skills/review/SKILL.md' })
  expect(() => parseGithubUrl('https://example.test/owner/repo')).toThrow(
    'GitHub HTTPS',
  )
  expect(() => parseGithubUrl('https://github.com:8443/owner/repo')).toThrow(
    'GitHub HTTPS',
  )
  expect(() =>
    parseGithubUrl('https://github.com/owner/repo/issues/10'),
  ).toThrow('仓库')
})
