import { expect, test } from 'vitest'
import type { Resource } from '@agentweave/protocol'
import { resourceDescription } from '../resource-description.js'

const encode = (value: string) => Buffer.from(value).toString('base64')

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
