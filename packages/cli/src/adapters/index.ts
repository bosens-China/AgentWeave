import type {
  Candidate,
  Resource,
  SyncChange,
  SyncPlan,
  Target,
} from '@agentweave/protocol'
import { errorMessage } from '../errors.js'
import { normalizeResource, sameContent } from '../central/resource.js'
import { validateImport } from '../central/validation.js'
import type {
  FileOperation,
  NativeTarget,
  PluginOperation,
  ResourceEntry,
  SectionPlan,
  SyncOptions,
} from './types.js'
import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'
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
import { externalConsumers, resolveTargets, targetFor } from './targets.js'

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

export async function scanTargets({
  home = homedir(),
  targetIds,
}: { home?: string; targetIds?: string[] } = {}) {
  const targets = await resolveTargets({ home })
  const selected = targetIds
    ? [...new Set(targetIds)].map((id) => targetFor(targets, id))
    : targets.filter((target) => target.detected)
  const sections = await Promise.all(
    selected.map(async (target) => {
      const candidates: Candidate[] = []
      const warnings: string[] = []
      function add({
        resource,
        path,
      }: Pick<ResourceEntry, 'resource' | 'path'>) {
        try {
          const checked = normalizeResource(validateImport(resource))
          const id = fingerprint([target.id, path, resource])
          candidates.push({
            id,
            targetId: target.id,
            resource: { ...checked, tags: [target.id] },
          })
        } catch (error) {
          warnings.push(
            `${target.name} 的 ${resource.name}（${path}）：${errorMessage(error)}`,
          )
        }
      }
      async function scan<T>(
        handler: () => Promise<T>,
        consume: (snapshot: T) => void,
      ) {
        try {
          const snapshot = await handler()
          consume(snapshot)
        } catch (error) {
          warnings.push(`${target.name}：${errorMessage(error)}`)
        }
      }
      if (target.plugin)
        await scan(
          () => readPlugins(target, { validate: true }),
          ({ entries, warnings: messages }) => {
            entries.forEach(add)
            warnings.push(...messages)
          },
        )
      if (target.instructions)
        await scan(
          () => readInstructions(target),
          ({ effective }) => {
            if (effective) add(effective)
          },
        )
      if (target.mcp)
        await scan(
          () => readMcp(target),
          ({ entries, warnings: messages }) => {
            entries.forEach(add)
            warnings.push(...messages)
          },
        )
      for (const directory of [target.skills, ...target.sharedSkills]) {
        await scan(
          () => readSkills(directory, target),
          ({ entries, warnings: messages }) => {
            entries.forEach(add)
            warnings.push(...messages)
          },
        )
      }
      return { candidates, warnings }
    }),
  )
  const all = sections.flatMap((section) => section.candidates)
  const order = { plugin: 0, instructions: 1, mcp: 2, skill: 3 }
  const components = new Map<string, Resource[]>()
  for (const { resource } of all) {
    for (const component of resource.components ?? []) {
      const key = keyOf(component)
      components.set(key, [...(components.get(key) ?? []), component])
    }
  }
  return {
    candidates: all
      .filter(
        ({ resource }) =>
          resource.kind === 'plugin' ||
          !components
            .get(keyOf(resource))
            ?.some((component) => sameContent(component, resource)),
      )
      .sort(
        (first, second) =>
          order[first.resource.kind] - order[second.resource.kind],
      ),
    warnings: [...new Set(sections.flatMap((section) => section.warnings))],
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
    for (const other of targets) {
      const otherLocations =
        kind === 'skill'
          ? [other.skills, ...other.sharedSkills]
          : (other.instructionsPaths ?? [])
      for (const location of otherLocations) {
        if ((await canonical(location)) === changed) affected.add(other.name)
      }
    }
    for (const name of externalConsumers.get(relative(target.home, path)) ?? [])
      affected.add(name)
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
  for (const kind of syncKinds) {
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
    await applyFileOperations(home, plan.operations)
    try {
      await applyPluginOperations(plan.target, plan.pluginOperations)
    } catch (error) {
      if (!plan.operations.length) throw error
      throw new Error(
        `已应用 ${plan.operations.length} 处文件变更，插件同步遇到问题。${errorMessage(error)}。请重新预览当前差异`,
        { cause: error },
      )
    }
    return plan.output
  })
}
