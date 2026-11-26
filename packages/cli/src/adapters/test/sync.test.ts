import type { SyncOptions } from '../types.js'
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
import { afterEach, beforeEach, expect, it } from 'vitest'
import { pluginFromFiles } from '../../central/plugin.js'
import { applySync, previewSync, scanTargets } from '../index.js'
import { convertPlugin } from '../plugins.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentweave-adapter-'))
})
afterEach(async () => {
  await rm(home, { force: true, recursive: true })
})

const bytes = (value: string) => Buffer.from(value).toString('base64')
const docsPlugin = () => {
  const resource = pluginFromFiles({
    'plugin.json': bytes(
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'docs-helper',
        version: '1.0.0',
        description: 'Read documentation',
      }),
    ),
    'skills/review/SKILL.md': bytes(
      '---\nname: review\ndescription: Review documentation\n---\nReview the changes.',
    ),
    'mcp.json': bytes(
      JSON.stringify({
        mcpServers: {
          docs: { type: 'streamable-http', url: 'https://example.com/mcp' },
        },
      }),
    ),
    'hooks/hooks.json': bytes('{"hooks":{}}'),
  })
  if (!resource?.components) throw new Error('Missing fixture components')
  return { ...resource, components: resource.components }
}

async function sync(options: SyncOptions) {
  const plan = await previewSync(options)
  return applySync({ ...options, revision: plan.revision })
}

it('converts an OpenAI portable plugin into Claude and Cursor packages and identifies skipped hooks', async () => {
  const plugin = docsPlugin()
  const warnings: string[] = []
  const converted = convertPlugin(
    plugin,
    { id: 'claude', name: 'Claude Code', plugin: { kind: 'claude' } },
    warnings,
  )
  const parsed = pluginFromFiles(converted.files, converted.modes, 'claude')
  expect(parsed?.components?.map(({ kind }) => kind)).toEqual(['skill', 'mcp'])
  expect(warnings.join(' ')).toContain('hooks')
  const options: SyncOptions = {
    home,
    targetId: 'cursor',
    kinds: ['plugin'],
    resources: [plugin],
  }
  await sync(options)
  expect((await previewSync(options)).changes).toEqual([])
  const { candidates } = await scanTargets({ home, targetIds: ['cursor'] })
  expect(
    candidates.find(({ resource }) => resource.kind === 'plugin')?.resource
      .components,
  ).toHaveLength(2)
})

it('distributes one component without deleting an unrelated skill', async () => {
  const path = join(home, '.claude/skills/independent')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), 'Independent skill')
  const options: SyncOptions = {
    home,
    targetId: 'claude',
    kinds: ['skill'],
    keys: ['plugin:docs-helper/skill:review'],
    resources: [docsPlugin()],
  }
  const plan = await sync(options)
  expect(plan.changes.map(({ action, kind }) => [action, kind])).toEqual([
    ['add', 'skill'],
  ])
  expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(
    'Independent skill',
  )
  expect(
    await readFile(join(home, '.claude/skills/review/SKILL.md'), 'utf8'),
  ).toContain('Review the changes')
})

it('writes the current OpenCode and Qwen HTTP format while preserving unrelated settings', async () => {
  await mkdir(join(home, '.config/opencode'), { recursive: true })
  await writeFile(
    join(home, '.config/opencode/opencode.jsonc'),
    '{\n  // Preserve this comment\n  "mcp": { "timeout": { "startup": 3000 } }\n}\n',
  )
  const resource = {
    kind: 'mcp' as const,
    id: 'docs',
    name: 'docs',
    config: { url: 'https://example.com/mcp' },
  }
  const base: Omit<SyncOptions, 'targetId'> = {
    home,
    kinds: ['mcp'],
    resources: [resource],
  }
  await sync({ ...base, targetId: 'opencode' })
  const openCode = await readFile(
    join(home, '.config/opencode/opencode.jsonc'),
    'utf8',
  )
  expect(openCode).toContain('Preserve this comment')
  expect(JSON.parse(openCode.replace(/^\s*\/\/.*$/m, '')).mcp).toEqual({
    timeout: { startup: 3000 },
    servers: { docs: { type: 'remote', url: resource.config.url } },
  })
  await sync({ ...base, targetId: 'qwen' })
  const qwen = JSON.parse(
    await readFile(join(home, '.qwen/settings.json'), 'utf8'),
  )
  expect(qwen.mcpServers.docs).toEqual({ httpUrl: resource.config.url })
})

it.skipIf(process.platform === 'win32')(
  'does not write through a symlinked target root',
  async () => {
    const path = join(home, 'another-skills-directory')
    await mkdir(path, { recursive: true })
    await mkdir(join(home, '.claude'), { recursive: true })
    await symlink(path, join(home, '.claude/skills'), 'dir')
    const opts: SyncOptions = {
      home,
      targetId: 'claude',
      kinds: ['skill'],
      resources: [docsPlugin().components[0]],
    }
    const plan = await previewSync(opts)
    await expect(
      applySync({ ...opts, revision: plan.revision }),
    ).rejects.toThrow(/符号链接/)
    await expect(
      readFile(join(path, 'review/SKILL.md')),
    ).rejects.toHaveProperty('code', 'ENOENT')
  },
)
