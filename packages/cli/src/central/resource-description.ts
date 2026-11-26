import type { Resource } from '@agentweave/protocol'
import { isMap } from 'yaml'
import { skillFrontmatter } from './validation.js'

export function resourceDescription(resource: Resource): string | undefined {
  try {
    let description: unknown
    if (resource.kind === 'skill' && resource.files?.['SKILL.md']) {
      const document = skillFrontmatter(
        Buffer.from(resource.files['SKILL.md'], 'base64').toString('utf8'),
      )
      if (document && isMap(document.contents) && !document.errors.length)
        description = document.get('description')
    } else if (resource.kind === 'mcp') {
      description = resource.config?.description
    } else if (resource.kind === 'plugin') {
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
      if (path)
        description = JSON.parse(
          Buffer.from(resource.files![path], 'base64')
            .toString('utf8')
            .replace(/^\uFEFF/, ''),
        ).description
    }
    return typeof description === 'string' && description.trim()
      ? description.trim()
      : undefined
  } catch {
    return undefined
  }
}
