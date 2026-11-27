import { expect, test } from 'vitest'
import type { Resource } from '@agentweave/protocol'
import { decodeServer, encodeServer } from '../mcp-format.js'
import { compared, sameContent } from '../../central/resource.js'

const variants = [
  'codex',
  'claude',
  'pi',
  'opencode',
  'opencode-v2',
  'standard',
  'antigravity',
  'cline',
  'windsurf',
  'qwen',
  'kiro',
  'copilot',
  'kimi',
]

test.each(variants)(
  'round-trips standard MCP connections through %s native format',
  (variant) => {
    const target = { id: variant, name: variant, mcp: { variant } }
    const local: Resource = {
      kind: 'mcp',
      id: 'local',
      name: 'local',
      config: { command: 'node', args: ['server.js'] },
    }
    const remote: Resource = {
      kind: 'mcp',
      id: 'remote',
      name: 'remote',
      config: { url: 'https://example.test/mcp' },
    }
    expect(decodeServer(encodeServer(local, target), target)).toEqual(
      local.config,
    )
    expect(decodeServer(encodeServer(remote, target), target)).toEqual(
      remote.config,
    )
  },
)

test('compares declared environment forwarding across native MCP formats', () => {
  const codex = { id: 'codex', name: 'Codex', mcp: { variant: 'codex' } }
  const cursor = { id: 'cursor', name: 'Cursor', mcp: { variant: 'standard' } }
  const resource = (config: Record<string, unknown>): Resource => ({
    kind: 'mcp',
    name: 'memory',
    id: 'memory',
    config,
  })
  const forwarded = resource(
    decodeServer({ command: 'node', env_vars: ['TOKEN', 'DEBUG'] }, codex),
  )
  const equivalent = resource(
    decodeServer(
      {
        type: 'stdio',
        command: 'node',
        env: { DEBUG: '${env:DEBUG}', TOKEN: '${TOKEN}' },
      },
      cursor,
    ),
  )
  const withoutForwarding = resource(decodeServer({ command: 'node' }, cursor))
  expect(sameContent(forwarded, equivalent)).toBe(true)
  expect(encodeServer(equivalent, codex)).toEqual({
    command: 'node',
    env_vars: ['DEBUG', 'TOKEN'],
  })
  expect(sameContent(forwarded, withoutForwarding)).toBe(false)
  const { candidates } = compared(
    [equivalent, withoutForwarding].map((item, index) => ({
      id: String(index),
      targetId: 'cursor',
      resource: item,
    })),
    [forwarded],
  )
  expect(candidates.map(({ status }) => status)).toEqual(['same', 'conflict'])
  expect(candidates[1].mcpComparison?.repositoryDifferences).toEqual([
    'envVars',
  ])
})

test('compares equivalent HTTP authentication and header references', () => {
  const codex = { id: 'codex', name: 'Codex', mcp: { variant: 'codex' } }
  const cursor = { id: 'cursor', name: 'Cursor', mcp: { variant: 'standard' } }
  const url = 'https://example.test/mcp'
  const base = { kind: 'mcp' as const, id: 'remote', name: 'remote' }
  const native = {
    url,
    bearer_token_env_var: 'TOKEN',
    env_http_headers: { 'X-Team': 'TEAM' },
  }
  const codexResource = { ...base, config: decodeServer(native, codex) }
  const resource = {
    ...base,
    config: decodeServer(
      {
        type: 'streamable-http',
        url,
        headers: { Authorization: 'Bearer ${TOKEN}', 'X-Team': '${env:TEAM}' },
      },
      cursor,
    ),
  }
  expect(sameContent(codexResource, resource)).toBe(true)
  expect(encodeServer(resource, codex)).toEqual(native)
  expect(
    sameContent(codexResource, {
      ...resource,
      config: { ...resource.config, type: 'sse' },
    }),
  ).toBe(false)
})
