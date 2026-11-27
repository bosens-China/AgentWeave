import type { Resource, ResourceMeta } from '@agentweave/protocol'
import { isMap } from 'yaml'
import { mcpTransport } from '../adapters/mcp-format.js'
import { skillFrontmatter } from './validation.js'

function cleanText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function cleanAuthor(value: unknown): string | undefined {
  const text = cleanText(value)
  if (text) return text
  if (value && typeof value === 'object' && 'name' in value)
    return cleanText((value as { name?: unknown }).name)
  return undefined
}

export function resourceMetadata(resource: Resource): ResourceMeta {
  try {
    if (resource.kind === 'skill' && resource.files?.['SKILL.md']) {
      const document = skillFrontmatter(
        Buffer.from(resource.files['SKILL.md'], 'base64').toString('utf8'),
      )
      if (document && isMap(document.contents) && !document.errors.length) {
        const meta = document.get('metadata')
        const metaMap = isMap(meta) ? meta : undefined
        const description = cleanText(document.get('description'))
        const author =
          cleanAuthor(document.get('author')) ??
          cleanAuthor(metaMap?.get('author'))
        const version =
          cleanText(document.get('version')) ??
          cleanText(metaMap?.get('version'))
        return {
          ...(description && { description }),
          ...(author && { author }),
          ...(version && { version }),
        }
      }
      return {}
    }
    if (resource.kind === 'mcp' && resource.config) {
      const config = resource.config
      const description = cleanText(config.description)
      const transport = mcpTransport(config)
      const command = cleanText(config.command)
      const endpoint = command
        ? [command, ...(Array.isArray(config.args) ? config.args : [])].join(
            ' ',
          )
        : cleanText(config.url)
      return {
        ...(description && { description }),
        ...(endpoint && {
          mcpTransport: {
            stdio: 'stdio',
            sse: 'SSE',
            'streamable-http': 'Streamable HTTP',
          }[transport],
          mcpEndpoint: endpoint,
        }),
      }
    }
    if (resource.kind === 'plugin') {
      const paths = {
        portable: ['plugin.json'],
        codex: ['.codex-plugin/plugin.json'],
        claude: ['.claude-plugin/plugin.json'],
        cursor: ['.cursor-plugin/plugin.json'],
        antigravity: [
          '.antigravity-plugin/plugin.json',
          '.gemini-plugin/plugin.json',
          'plugin.json',
        ],
        pi: ['package.json'],
      }
      const path = (
        resource.format ? paths[resource.format] : Object.values(paths).flat()
      ).find((name) => resource.files?.[name])
      if (path) {
        const parsed = JSON.parse(
          Buffer.from(resource.files![path], 'base64')
            .toString('utf8')
            .replace(/^\uFEFF/, ''),
        ) as { description?: unknown; author?: unknown; version?: unknown }
        const description = cleanText(parsed.description)
        const author = cleanAuthor(parsed.author)
        const version = cleanText(parsed.version)
        return {
          ...(description && { description }),
          ...(author && { author }),
          ...(version && { version }),
        }
      }
    }
    return {}
  } catch {
    return {}
  }
}

export function resourceDescription(resource: Resource): string | undefined {
  return resourceMetadata(resource).description
}
