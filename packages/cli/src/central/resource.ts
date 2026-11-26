import type {
  Candidate,
  ComparedCandidate,
  PluginFormat,
  Resource,
  ResourceKind,
  Selection,
} from '@agentweave/protocol'
import {
  object,
  sortedObject,
  validFilePath,
  validResourceId,
} from '../adapters/files.js'
import { normalizeMcpConfig } from '../adapters/mcp-format.js'

const kinds = ['skill', 'mcp', 'instructions', 'plugin']
const formats = ['codex', 'portable', 'claude', 'cursor', 'antigravity', 'pi']
const maxPackageBytes = 32 * 1024 * 1024

export function resourceKey(resource: Pick<Resource, 'kind' | 'id'>) {
  return `${resource.kind}:${resource.id}`
}

export function normalizeResource(value: unknown): Resource {
  if (
    !object(value) ||
    typeof value.kind !== 'string' ||
    !kinds.includes(value.kind) ||
    !validResourceId(value.id) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 240 ||
    /[\x00-\x1f]/u.test(value.name)
  )
    throw new Error('资源需要有效的类型、标识和名称')
  const resource: Resource = {
    kind: value.kind as ResourceKind,
    id: value.id,
    name: value.name.trim(),
  }
  if (value.tags !== undefined) {
    if (
      !Array.isArray(value.tags) ||
      !value.tags.every(
        (tag) => typeof tag === 'string' && tag.trim().length > 0,
      )
    )
      throw new Error('资源标签必须是非空字符串')
    if (value.tags.length) resource.tags = [...new Set(value.tags)].sort()
  }
  if (['skill', 'plugin'].includes(value.kind)) {
    if (
      !value.files ||
      typeof value.files !== 'object' ||
      Array.isArray(value.files)
    )
      throw new Error('资源需要文件内容')
    let size = 0
    const paths = new Set<string>()
    const pathsByForm = new Map<string, string>()
    const files = Object.entries(value.files).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    resource.files = Object.fromEntries(
      files.map(([path, bytes]) => {
        const normalized = path.normalize('NFC').toLowerCase()
        if (
          !validFilePath(path) ||
          paths.has(normalized) ||
          typeof bytes !== 'string' ||
          Buffer.from(bytes, 'base64').toString('base64') !== bytes
        )
          throw new Error(`资源包含无效或重复的文件路径：${path}`)
        const parts = path.split('/')
        for (let index = 1; index < parts.length; index += 1) {
          const directory = parts.slice(0, index).join('/')
          const form = directory.normalize('NFC').toLowerCase()
          if (pathsByForm.has(form) && pathsByForm.get(form) !== directory)
            throw new Error(
              `资源中的目录仅大小写或 Unicode 形式不同：${directory}`,
            )
          pathsByForm.set(form, directory)
        }
        paths.add(normalized)
        size += bytes.length
        if (size > (maxPackageBytes * 4) / 3 + 4096)
          throw new Error('资源超过 32 MB')
        return [path, bytes]
      }),
    )
    for (const path of paths) {
      const parts = path.split('/')
      if (
        parts
          .slice(0, -1)
          .some((_, index) => paths.has(parts.slice(0, index + 1).join('/')))
      )
        throw new Error(`资源文件与目录重名：${path}`)
    }
    if (value.modes !== undefined) {
      if (
        !value.modes ||
        typeof value.modes !== 'object' ||
        Array.isArray(value.modes)
      )
        throw new Error('资源含有无法识别的文件权限')
      const modes = Object.entries(value.modes)
      if (
        modes.some(
          ([path, mode]) =>
            mode !== 0o755 || !Object.hasOwn(resource.files ?? {}, path),
        )
      )
        throw new Error('资源含有无法识别的文件权限')
      if (modes.length)
        resource.modes = Object.fromEntries(modes) as Record<string, number>
    }
  }
  if (
    value.kind === 'skill' &&
    !Object.hasOwn(resource.files ?? {}, 'SKILL.md')
  )
    throw new Error('Skill 必须包含 SKILL.md')
  if (value.kind === 'mcp') resource.config = normalizeMcpConfig(value.config)
  if (value.kind === 'instructions') {
    if (typeof value.text !== 'string') throw new Error('全局指令必须提供文本')
    resource.text = value.text
  }
  if (value.kind === 'plugin') {
    if (typeof value.format === 'string' && formats.includes(value.format))
      resource.format = value.format as PluginFormat
    if (value.unsupported !== undefined) {
      if (
        !Array.isArray(value.unsupported) ||
        !value.unsupported.every((item) => typeof item === 'string')
      )
        throw new Error('无法识别插件的转换提示')
      if (value.unsupported.length)
        resource.unsupported = [...new Set(value.unsupported)].sort()
    }
    const components = value.components ?? []
    if (
      !Array.isArray(components) ||
      components.some((component) => component?.kind === 'plugin')
    )
      throw new Error('插件组件格式无效')
    resource.components = components.map(normalizeResource)
  }
  return resource
}

function contentOf({ id, tags, components, ...value }: Resource): unknown {
  if (value.kind === 'mcp') {
    try {
      value.config = normalizeMcpConfig(value.config)
    } catch {
      // Older repositories can contain MCP settings rejected by the current validator.
    }
  }
  return sortedObject(
    components
      ? {
          ...value,
          components: [...components]
            .sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))
            .map(contentOf),
        }
      : value,
  )
}

export function sameContent(left: Resource, right: Resource) {
  return JSON.stringify(contentOf(left)) === JSON.stringify(contentOf(right))
}

export function matching(resources: Resource[], candidate: Resource) {
  const id = candidate.id.normalize('NFC').toLowerCase()
  const name = candidate.name.normalize('NFC').toLowerCase()
  const matches = resources.filter(
    (resource) =>
      resource.kind === candidate.kind &&
      (resource.id.normalize('NFC').toLowerCase() === id ||
        resource.name.normalize('NFC').toLowerCase() === name),
  )
  if (matches.length > 1)
    throw new Error(`「${candidate.name}」的名称和标识分别匹配到不同资源`)
  return matches[0]
}

export function normalizeCandidates(candidates: Candidate[]): Candidate[] {
  if (!Array.isArray(candidates)) throw new Error('待导入项目格式无效')
  const ids = new Set()
  return candidates.map((item) => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id))
      throw new Error('待导入项目包含无效或重复的标识')
    ids.add(item.id)
    return { ...item, resource: normalizeResource(item.resource) }
  })
}

export function compared(
  candidates: Candidate[],
  resources: Resource[],
): { candidates: ComparedCandidate[] } {
  return {
    candidates: candidates.map((candidate) => {
      const already = matching(resources, candidate.resource)
      let status: ComparedCandidate['status'] = 'new'
      if (already)
        status = sameContent(already, candidate.resource) ? 'same' : 'conflict'
      else if (
        candidates.some(
          (other) =>
            other !== candidate &&
            matching([other.resource], candidate.resource) &&
            !sameContent(other.resource, candidate.resource),
        )
      )
        status = 'conflict'
      return { ...candidate, status }
    }),
  }
}

export function upsert(
  resources: Resource[],
  candidate: Resource,
  replace: boolean,
) {
  const existing = matching(resources, candidate)
  if (!existing) {
    resources.push(candidate)
    return candidate
  }
  const same = sameContent(existing, candidate)
  if (!same && !replace)
    throw new Error(
      `「${candidate.name}」与中央仓库资源重名，请选择要保留的版本`,
    )
  let tags = candidate.tags
  if (same)
    tags = [...new Set([...(existing.tags ?? []), ...(tags ?? [])])].sort()
  const stored = { ...candidate, id: existing.id }
  if (tags?.length) stored.tags = tags
  resources[resources.indexOf(existing)] = stored
  return stored
}

export function importSelected(
  resources: Resource[],
  candidates: Candidate[],
  selections: Selection[],
) {
  if (!Array.isArray(selections)) throw new Error('请选择要导入的资源')
  const selected: { id: string; resource: Resource; replace: boolean }[] = []
  for (const choice of selections) {
    const item = candidates.find((candidate) => candidate.id === choice?.id)
    if (!item) throw new Error('所选资源已失效，请重新扫描')
    const resource = { ...item.resource }
    if (item.targetId)
      resource.tags = [
        ...new Set([...(resource.tags ?? []), item.targetId]),
      ].sort()
    if (
      selected.some(
        (entry) =>
          matching([entry.resource], resource) &&
          !sameContent(entry.resource, resource),
      )
    ) {
      throw new Error(`「${resource.name}」有多个版本，请保留其中一个`)
    }
    selected.push({ id: item.id, resource, replace: choice.replace === true })
  }
  return selected.map((item) => ({
    id: item.id,
    resource: upsert(resources, item.resource, item.replace),
  }))
}
