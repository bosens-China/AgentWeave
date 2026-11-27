import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createService } from '../../service.js'
import type { Resource } from '@agentweave/protocol'
import {
  resourceDescription,
  resourceMetadata,
} from '../resource-description.js'

const encode = (value: string) => Buffer.from(value).toString('base64')

test('overview 按资源标识返回描述、作者、版本和 MCP 连接信息', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentweave-meta-'))
  try {
    const service = createService({ home, root: join(home, 'repo') })
    const resources: Resource[] = [
      {
        kind: 'skill',
        id: 'demo',
        name: 'demo',
        files: {
          'SKILL.md': encode(
            '---\nname: demo\ndescription: 示例 # 仅是 YAML 注释\nmetadata:\n  author: Alice\n  version: 2\n---\n正文',
          ),
        },
      },
      {
        kind: 'plugin',
        id: 'demo',
        name: 'demo',
        format: 'cursor',
        files: {
          '.cursor-plugin/plugin.json': encode(
            '{"name":"demo","description":"插件","version":"1.2","author":{"name":"Team"}}',
          ),
          'plugin.json': encode('{"name":"demo","description":"其他清单"}'),
        },
      },
      {
        kind: 'mcp',
        id: 'demo',
        name: 'demo',
        config: {
          command: 'node',
          args: ['server.js', '--stdio'],
          description: '本地服务',
        },
      },
      {
        kind: 'mcp',
        id: 'events',
        name: 'events',
        config: { type: 'sse', url: 'https://example.com/events' },
      },
      {
        kind: 'mcp',
        id: 'http',
        name: 'http',
        config: { type: 'http', url: 'https://example.com/mcp' },
      },
    ]
    for (const resource of resources)
      await service.run('save-resource', { resource })
    expect((await service.run('overview')).resourceMeta).toEqual({
      'skill:demo': { description: '示例', author: 'Alice', version: '2' },
      'plugin:demo': { description: '插件', author: 'Team', version: '1.2' },
      'mcp:demo': {
        description: '本地服务',
        mcpTransport: 'stdio',
        mcpEndpoint: 'node server.js --stdio',
      },
      'mcp:events': {
        mcpTransport: 'SSE',
        mcpEndpoint: 'https://example.com/events',
      },
      'mcp:http': {
        mcpTransport: 'Streamable HTTP',
        mcpEndpoint: 'https://example.com/mcp',
      },
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('reads descriptions from skill frontmatter and plugin or MCP metadata', () => {
  const skill: Resource = {
    kind: 'skill',
    id: 'x',
    name: 'x',
    files: {
      'SKILL.md': encode(
        '---\nname: x\ndescription: >-\n  First line\n  second line\n---\nBody',
      ),
    },
  }
  const plugin: Resource = {
    kind: 'plugin',
    id: 'x',
    name: 'x',
    files: {
      '.cursor-plugin/plugin.json': encode('{"description":"A plugin"}'),
    },
  }
  const mcp: Resource = {
    kind: 'mcp',
    id: 'x',
    name: 'x',
    config: { command: 'node', description: 'A server' },
  }
  expect(resourceDescription(skill)).toBe('First line second line')
  expect(resourceDescription(plugin)).toBe('A plugin')
  expect(
    resourceDescription({
      ...plugin,
      format: 'cursor',
      files: {
        ...plugin.files,
        'plugin.json': encode('{"description":"Different manifest"}'),
      },
    }),
  ).toBe('A plugin')
  expect(resourceDescription(mcp)).toBe('A server')
  expect(
    resourceDescription({
      ...skill,
      files: { 'SKILL.md': encode('---\ninvalid: [\n---') },
    }),
  ).toBeUndefined()
})

test('reads optional author and version from skill frontmatter and plugin manifest', () => {
  expect(
    resourceMetadata({
      kind: 'skill',
      id: 'a',
      name: 'a',
      files: {
        'SKILL.md': encode(
          '---\nname: a\ndescription: Desc\nauthor: Alice\nversion: 1.2.0\n---\nBody',
        ),
      },
    }),
  ).toEqual({ description: 'Desc', author: 'Alice', version: '1.2.0' })

  expect(
    resourceMetadata({
      kind: 'skill',
      id: 'b',
      name: 'b',
      files: {
        'SKILL.md': encode(
          '---\nname: b\ndescription: Desc\nmetadata:\n  author: Bob\n  version: v0.31.0\n---\nBody',
        ),
      },
    }),
  ).toEqual({ description: 'Desc', author: 'Bob', version: 'v0.31.0' })

  expect(
    resourceMetadata({
      kind: 'plugin',
      id: 'p',
      name: 'p',
      files: {
        'plugin.json': encode(
          '{"description":"Plug","version":"2.0.0","author":{"name":"Team"}}',
        ),
      },
    }),
  ).toEqual({ description: 'Plug', author: 'Team', version: '2.0.0' })
})
