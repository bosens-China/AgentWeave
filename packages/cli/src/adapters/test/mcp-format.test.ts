import { expect, test } from 'vitest'
import type { Resource } from '@agentweave/protocol'
import { decodeServer, encodeServer } from '../mcp-format.js'

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
