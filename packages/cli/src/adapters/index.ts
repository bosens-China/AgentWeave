import type {
  Candidate,
  Resource,
  ResourceKind,
  ScanIssue,
  SyncChange,
  SyncPlan,
  Target,
} from '@agentweave/protocol'
import { errorMessage } from '../errors.js'
import { normalizeResource, sameContent } from '../central/resource.js'
import { validateImport } from '../central/validation.js'
import { resourceDescription } from '../central/resource-description.js'
import type {
  FileOperation,
  NativeTarget,
  PluginEntry,
  PluginOperation,
  SectionPlan,
  SyncOptions,
} from './types.js'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  actualPath,
  applyFileOperations,
  fingerprint,
  keyOf,
  object,
  underSyncLock,
  validResourceId,
} from './files.js'
import { planInstructions, readInstructions } from './instructions.js'
import { planMcp, readMcp } from './mcp.js'
import { applyPluginOperations, planPlugins, readPlugins } from './plugins.js'
import { planSkills, readSkills } from './skills.js'
import { resolveTargets, targetFor } from './targets.js'

function issueReason(error: unknown): string {
  while (error instanceof Error && error.cause instanceof Error)
    error = error.cause
  return errorMessage(error)
}

export async function listTargets({ home = homedir() } = {}): Promise<
  Target[]
> {
  const targets = await resolveTargets({ home })
  return targets.map(
    ({ id, name, detected, kinds, mcpTransports, instructionsPaths }) => ({
      id,
      name,
      detected,
      kinds,
      mcpTransports,
      instructionsPaths,
    }),
  )
}

export type ScanSource = {
  id: string
  targetId: string
  path: string
  mcpId?: string
  readOnly?: boolean
  plugin?: { root: string; files?: string[] }
}

export async function scanTargets({
  home = homedir(),
  targetIds,
}: { home?: string; targetIds?: string[] } = {}) {
  const targets = await resolveTargets({ home })
  const selected = (
    targetIds
      ? [...new Set(targetIds)].map((id) => targetFor(targets, id))
      : targets
  ).filter((target) => target.detected)
  const sections = await Promise.all(
    selected.map(async (target) => {
      const candidates: Candidate[] = []
      const warnings: string[] = []
      const issues: ScanIssue[] = []
      const sources: ScanSource[] = []
      const warningRoots = new Map<
        string,
        { pluginRoot: string; builtin?: boolean }
      >()
      function add({
        resource,
        path,
        managedBy,
        updatedAt,
      }: Pick<PluginEntry, 'resource' | 'path' | 'managedBy' | 'updatedAt'>) {
        const builtin = managedBy === 'builtin'
        const id = fingerprint(
          builtin
            ? [target.id, path, resource, 'builtin']
            : [target.id, path, resource],
        )
        sources.push({
          id,
          targetId: target.id,
          ...(builtin && { readOnly: true }),
          path:
            resource.kind === 'skill' && !path.endsWith('.md')
              ? join(path, 'SKILL.md')
              : path,
          ...(resource.kind === 'mcp' && { mcpId: resource.id }),
          ...(resource.kind === 'plugin' && {
            plugin: { root: path, files: Object.keys(resource.files ?? {}) },
          }),
        })
        try {
          const checked = normalizeResource(validateImport(resource))
          candidates.push({
            id,
            targetId: target.id,
            ...(updatedAt && { updatedAt }),
            ...(builtin && { builtin: true }),
            resource: {
              ...checked,
              tags: builtin ? [target.id, '内置'] : [target.id],
            },
          })
        } catch (error) {
          const reason = issueReason(error)
          const warning = `${target.name} 的 ${resource.name}（${path}）：${errorMessage(error)}`
          warnings.push(warning)
          issues.push({
            id,
            targetId: target.id,
            kind: resource.kind,
            name: resource.name,
            description: resourceDescription(resource),
            warning,
            reason,
            ...(builtin && { builtin: true }),
            editable: true,
          })
        }
      }
      async function scan<T>(
        kind: ResourceKind,
        handler: () => Promise<T>,
        consume: (snapshot: T) => void,
      ) {
        const before = warnings.length
        try {
          const snapshot = await handler()
          consume(snapshot)
        } catch (error) {
          warnings.push(`${target.name}：${errorMessage(error)}`)
        }
        for (const warning of warnings.slice(before)) {
          if (!issues.some((issue) => issue.warning === warning)) {
            const id = fingerprint([target.id, kind, warning])
            const warningSource = warningRoots.get(warning)
            const pluginRoot = warningSource?.pluginRoot
            const path =
              pluginRoot ?? (kind === 'mcp' ? target.mcp?.path : undefined)
            const name =
              kind === 'mcp'
                ? undefined
                : warning.match(
                    /的\s*(?:Skill|插件|本地包)\s+(.+?)(?:（|：)/,
                  )?.[1]
            if (path)
              sources.push({
                id,
                targetId: target.id,
                path,
                ...(pluginRoot && { plugin: { root: pluginRoot } }),
                ...(warningSource?.builtin && { readOnly: true }),
              })
            const detail =
              warning.match(/^.*?）：([\s\S]*)$/)?.[1] ??
              (name ? warning.match(/^.*?：([\s\S]*)$/)?.[1] : undefined) ??
              (warning.startsWith(`${target.name}：`)
                ? warning.slice(target.name.length + 1)
                : warning)
            issues.push({
              id,
              targetId: target.id,
              kind,
              name,
              warning,
              reason: detail.replace(/^(?:[^：\n]+\/)+[^：\n]+：\s*/u, ''),
              ...(warningSource?.builtin && { builtin: true }),
              editable: !!path,
            })
          }
        }
      }
      if (target.plugin)
        await scan(
          'plugin',
          () => readPlugins(target, { validate: true }),
          ({ entries, warnings: messages, warningSources: sourcePaths }) => {
            entries.forEach(add)
            warnings.push(...messages)
            sourcePaths.forEach((source) =>
              warningRoots.set(source.warning, source),
            )
          },
        )
      if (target.instructions)
        await scan(
          'instructions',
          () => readInstructions(target),
          ({ effective }) => {
            if (effective) add(effective)
          },
        )
      if (target.mcp)
        await scan(
          'mcp',
          () => readMcp(target),
          ({ entries, invalidEntries }) => {
            entries.forEach(add)
            for (const { id: mcpId, reason, warning } of invalidEntries) {
              const id = fingerprint([target.id, 'mcp', warning])
              warnings.push(warning)
              issues.push({
                id,
                targetId: target.id,
                kind: 'mcp',
                name: mcpId,
                reason,
                warning,
                editable: true,
              })
              sources.push({
                id,
                targetId: target.id,
                path: target.mcp!.path,
                mcpId,
              })
            }
          },
        )
      for (const directory of [target.skills, ...target.sharedSkills]) {
        await scan(
          'skill',
          () => readSkills(directory, target),
          ({ entries, warnings: messages }) => {
            entries.forEach(add)
            warnings.push(...messages)
          },
        )
      }
      return { candidates, warnings, issues, sources }
    }),
  )
  const all = sections.flatMap((section) => section.candidates)
  const order = { plugin: 0, instructions: 1, mcp: 2, skill: 3 }
  const components = new Map<
    string,
    { plugin: Candidate; resource: Resource }[]
  >()
  const alternatives = new Map<
    string,
    { ids: Set<string>; labels: Set<string> }
  >()
  function conflict(left: Candidate, right: Candidate, component?: Resource) {
    const related = alternatives.get(left.id) ?? {
      ids: new Set<string>(),
      labels: new Set<string>(),
    }
    related.ids.add(right.id)
    const label = component
      ? `${right.resource.name}（${component.kind === 'skill' ? 'Skill' : 'MCP'}「${component.id}」）`
      : right.resource.name
    related.labels.add(label)
    alternatives.set(left.id, related)
  }
  for (const plugin of all) {
    for (const resource of plugin.resource.components ?? []) {
      const key = keyOf(resource)
      const owners = components.get(key) ?? []
      if (resource.kind === 'skill' || resource.kind === 'mcp') {
        for (const other of owners) {
          if (
            other.plugin.id === plugin.id ||
            sameContent(other.resource, resource)
          )
            continue
          conflict(plugin, other.plugin, resource)
          conflict(other.plugin, plugin, resource)
        }
      }
      owners.push({ plugin, resource })
      components.set(key, owners)
    }
  }
  const annotated = all.map((candidate) => {
    const owners = components.get(keyOf(candidate.resource)) ?? []
    const bundledBy: string[] = []
    for (const owner of owners) {
      if (sameContent(owner.resource, candidate.resource))
        bundledBy.push(owner.plugin.id)
      else {
        conflict(candidate, owner.plugin)
        conflict(owner.plugin, candidate)
      }
    }
    return bundledBy.length ? { ...candidate, bundledBy } : candidate
  })
  return {
    candidates: annotated
      .map((item) => {
        const others = alternatives.get(item.id)
        return others
          ? {
              ...item,
              componentConflict: [...others.labels],
              componentAlternatives: [...others.ids],
            }
          : item
      })
      .sort(
        (first, second) =>
          order[first.resource.kind] - order[second.resource.kind],
      ),
    targets: selected,
    warnings: [...new Set(sections.flatMap((section) => section.warnings))],
    issues: sections.flatMap((section) => section.issues),
    sources: sections.flatMap((section) => section.sources),
  }
}

async function affectedConsumers(
  targets: NativeTarget[],
  target: NativeTarget,
  changes: SyncChange[],
) {
  const affected = new Set(changes.length ? [target.name] : [])
  const byPath = new Map<string, string>()
  async function canonical(path: string) {
    const cached = byPath.get(path)
    if (cached) return cached
    const location = await actualPath(path)
    byPath.set(path, location)
    return location
  }
  const locations = new Map<string, 'skill' | 'instructions'>()
  for (const { kind, path } of changes) {
    if (kind === 'skill') locations.set(target.skills, kind)
    if (kind === 'instructions') locations.set(path, kind)
  }
  for (const [path, kind] of locations) {
    const changed = await canonical(path)
    for (const other of targets.filter((item) => item.detected)) {
      const otherLocations =
        kind === 'skill'
          ? [other.skills, ...other.sharedSkills]
          : (other.instructionsPaths ?? [])
      for (const location of otherLocations) {
        if ((await canonical(location)) === changed) affected.add(other.name)
      }
    }
  }
  return [...affected]
}

async function buildSyncPlan({
  home = homedir(),
  targetId,
  kinds,
  keys,
  resources,
}: SyncOptions) {
  home = resolve(home)
  const targets = await resolveTargets({ home })
  const target = targetFor(targets, targetId)
  if (
    !Array.isArray(kinds) ||
    !kinds.length ||
    kinds.some((kind) => !target.kinds.includes(kind))
  ) {
    throw new Error(`${target.name} 无法同步所选的资源类型`)
  }
  if (!Array.isArray(resources)) throw new Error('中央仓库资源列表无效')
  if (
    keys !== undefined &&
    (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string'))
  ) {
    throw new Error('同步的资源列表无效')
  }
  const selectedKeys = new Set(keys)
  const selective = keys !== undefined
  const candidates = new Map(
    resources.map((resource) => [keyOf(resource), resource]),
  )
  for (const resource of resources) {
    if (resource.kind !== 'plugin') continue
    for (const component of resource.components ?? [])
      candidates.set(`${keyOf(resource)}/${keyOf(component)}`, component)
  }
  if (selective && [...selectedKeys].some((key) => !candidates.has(key))) {
    throw new Error('所选资源已变化，请刷新后重试')
  }
  const syncKinds = [...new Set(kinds)].sort()
  const changes: SyncChange[] = []
  const warnings: string[] = []
  const operations: FileOperation[] = []
  const pluginOperations: PluginOperation[] = []
  const selectedResources = selective
    ? [...selectedKeys]
        .map((key) => candidates.get(key))
        .filter((resource) => resource !== undefined)
    : resources
  if (
    selective &&
    selectedResources.some((resource) => !syncKinds.includes(resource.kind))
  ) {
    throw new Error('所选资源与本次同步类型不一致')
  }
  const bundled = new Map<string, Resource[]>()
  if (
    target.plugin &&
    !syncKinds.includes('plugin') &&
    syncKinds.some((kind) => kind === 'skill' || kind === 'mcp')
  ) {
    try {
      const snapshot = await readPlugins(target)
      warnings.push(...snapshot.warnings)
      for (const entry of snapshot.entries) {
        if ('enabled' in entry && entry.enabled === false) continue
        for (const component of entry.resource.components ?? []) {
          const key = keyOf(component)
          bundled.set(key, [...(bundled.get(key) ?? []), component])
        }
      }
    } catch (error) {
      warnings.push(
        `无法核对 ${target.name} 的插件组件，本次按独立资源处理：${errorMessage(error)}`,
      )
    }
  }
  for (const kind of [...syncKinds].sort(
    (a, b) => Number(b === 'plugin') - Number(a === 'plugin'),
  )) {
    const desired = new Map<string, Resource>()
    for (const resource of selectedResources) {
      if (!object(resource) || resource.kind !== kind) continue
      if (!validResourceId(resource.id)) {
        warnings.push(
          `「${resource.name}」的资源标识无效，跳过分发：${resource.id}`,
        )
        continue
      }
      if (desired.has(resource.id))
        throw new Error(`中央仓库中存在重复资源：${keyOf(resource)}`)
      desired.set(resource.id, resource)
    }
    if (!selective && (kind === 'skill' || kind === 'mcp')) {
      for (const plugin of resources.filter((r) => r.kind === 'plugin')) {
        for (const component of plugin.components ?? []) {
          if (component.kind !== kind) continue
          const existing = desired.get(component.id)
          if (existing && !sameContent(existing, component))
            throw new Error(
              `插件 ${plugin.name} 和另一份 ${component.name} 内容不同，请选择单项分发要保留的版本。`,
            )
          desired.set(component.id, component)
        }
      }
    }
    for (const [id, item] of desired) {
      if (bundled.get(keyOf(item))?.some((c) => sameContent(c, item)))
        desired.delete(id)
    }
    let section: SectionPlan
    if (kind === 'skill') {
      const snapshot = await readSkills(target.skills, target)
      warnings.push(...snapshot.warnings)
      section = await planSkills(target, snapshot, desired, selective, warnings)
      if (target.sharedSkills.length) {
        warnings.push(
          `${target.name} 还会读取共享的 Skills。本次同步对齐 ${target.skills}，共享位置为 ${target.sharedSkills.join('、')}`,
        )
      }
    } else if (kind === 'mcp') {
      const snapshot = await readMcp(target)
      warnings.push(...snapshot.warnings)
      section = planMcp(target, snapshot, desired, selective, warnings)
    } else if (kind === 'instructions') {
      section = planInstructions(
        target,
        await readInstructions(target),
        desired,
        selective,
        warnings,
      )
    } else {
      const snapshot = await readPlugins(target)
      warnings.push(...snapshot.warnings)
      section = await planPlugins(
        target,
        snapshot,
        desired,
        selective,
        warnings,
      )
      for (const component of section.provided ?? []) {
        const key = keyOf(component)
        bundled.set(key, [...(bundled.get(key) ?? []), component])
      }
    }
    changes.push(...section.changes)
    operations.push(...section.operations)
    pluginOperations.push(...(section.pluginOperations ?? []))
  }
  const affectedTargets = await affectedConsumers(targets, target, changes)
  const messages = [...new Set(warnings)]
  const revision = fingerprint({
    home,
    targetId,
    syncKinds,
    keys: selective ? [...selectedKeys].sort() : null,
    changes,
    messages,
    affectedTargets,
    operations,
    pluginOperations,
  })
  return {
    target,
    operations,
    pluginOperations,
    output: { changes, warnings: messages, affectedTargets, revision },
  }
}

export async function previewSync(options: SyncOptions): Promise<SyncPlan> {
  return (await buildSyncPlan(options)).output
}

export async function applySync({
  revision,
  ...options
}: SyncOptions & { revision: string }): Promise<SyncPlan> {
  const home = resolve(options.home ?? homedir())
  if (typeof revision !== 'string' || !revision)
    throw new Error('请先预览并确认本次同步')
  return underSyncLock(home, async () => {
    const plan = await buildSyncPlan({ ...options, home })
    if (revision !== plan.output.revision)
      throw new Error('预览已过期，请重新预览同步差异')
    let operations = plan.operations
    if (plan.pluginOperations.length) {
      // The native CLI can edit the same configuration that stores independent MCP servers.
      const mcpPath = plan.target.mcp?.path
      const includesMcp = operations.some(
        (operation) => operation.path === mcpPath,
      )
      const servers = includesMcp
        ? fingerprint((await readMcp(plan.target)).section)
        : undefined
      await applyPluginOperations(plan.target, plan.pluginOperations)
      if (includesMcp) {
        const fresh = await buildSyncPlan({ ...options, home })
        const newServers = fingerprint((await readMcp(plan.target)).section)
        const fileChanges = (changes: SyncChange[]) =>
          changes.filter((change) => change.kind !== 'plugin')
        if (
          servers !== newServers ||
          fingerprint(fileChanges(plan.output.changes)) !==
            fingerprint(fileChanges(fresh.output.changes))
        ) {
          throw new Error('插件已同步，其他资源已变化，请重新预览。')
        }
        const updated = fresh.operations.find(
          (operation) => operation.path === mcpPath,
        )
        if (!updated) throw new Error('插件已同步，请重新预览 MCP 变更。')
        operations = operations.map((operation) =>
          operation.path === mcpPath ? updated : operation,
        )
      }
    }
    await applyFileOperations(home, operations)
    return plan.output
  })
}
