import type {
  Api,
  ApiAction,
  BundlePlan,
  Candidate,
  Overview,
  Resource,
  ResourceKind,
  Selection,
} from '@agentweave/protocol'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { errorCode, errorMessage } from './errors.js'
import {
  applyFileOperations,
  assertParents,
  fingerprint,
  keyOf,
  object,
  pathState,
  readTree,
  validFilePath,
} from './adapters/files.js'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  applySync,
  listTargets,
  previewSync,
  scanTargets,
} from './adapters/index.js'
import type { ScanSource } from './adapters/index.js'
import { createRepository } from './central/index.js'
import { readNpmBundle } from './central/npm-bundle.js'
import { newResource } from './central/create.js'
import { MCP_PROTOCOL_BASELINE } from './adapters/mcp-format.js'
import { resolveTargets, targetFor } from './adapters/targets.js'
import {
  sameContent,
  matching,
  compared as compareResources,
} from './central/resource.js'
import { convertPlugin } from './adapters/plugins.js'
import { convertedPiTree } from './adapters/pi-plugins.js'
import { readMcp } from './adapters/mcp.js'
import { patchMcpSource, previewMcpSource } from './adapters/mcp-source.js'
import { compareLocalSnapshot, type LocalSnapshot } from './local-snapshot.js'

type LocalBinding = {
  targetId: string
  kind: ResourceKind
  name: string
  key: string
  id: string
  candidateId: string
}
type Settings = Pick<Overview, 'initialized' | 'profiles'> & {
  bindings?: LocalBinding[]
  localSnapshot?: LocalSnapshot
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode = 400,
  ) {
    super(message)
  }
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim())
    throw new RequestError(`请输入${label}。`)
  return value
}

function stringList(value: unknown, label: string): string[]
function stringList(
  value: unknown,
  label: string,
  optional: true,
): string[] | undefined
function stringList(
  value: unknown,
  label: string,
  optional = false,
): string[] | undefined {
  if (value === undefined && optional) return undefined
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new RequestError(`${label}必须是字符串列表。`)
  }
  return [...new Set(value)]
}

function selectionsOf(value: unknown): Selection[]
function selectionsOf(value: unknown, optional: true): Selection[] | undefined
function selectionsOf(
  value: unknown,
  optional = false,
): Selection[] | undefined {
  if (value === undefined && optional) return undefined
  if (
    !Array.isArray(value) ||
    value.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        (row.replace !== undefined && typeof row.replace !== 'boolean'),
    )
  )
    throw new RequestError('请选择有效的导入项。')
  return value.map(({ id, replace }) => ({ id, replace: replace === true }))
}

export function createService({
  home = homedir(),
  root = process.env.AGENTWEAVE_HOME || join(home, 'AgentWeave'),
} = {}) {
  const repositoryRoot = resolve(root)
  const repository = createRepository(repositoryRoot)
  const settingsPath = join(repositoryRoot, 'agentweave-settings.json')

  async function readSettings(): Promise<Settings> {
    try {
      return JSON.parse(await readFile(settingsPath, 'utf8'))
    } catch (error) {
      if (errorCode(error) === 'ENOENT')
        return { initialized: false, profiles: [] }
      throw error
    }
  }

  async function saveSettings(settings: Settings) {
    const temporaryPath = join(repositoryRoot, `.settings-${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporaryPath, settingsPath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  async function mutate<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(repositoryRoot, { recursive: true, mode: 0o700 })
    const release = await lockfile.lock(repositoryRoot, {
      lockfilePath: join(repositoryRoot, '.operation.lock'),
      retries: { retries: 4, minTimeout: 100, maxTimeout: 400 },
    })
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  const scanSources = new Map<string, ScanSource>()

  async function inbound(
    candidates: Candidate[],
    resources: Resource[],
    bindings: LocalBinding[],
    targets: Awaited<ReturnType<typeof resolveTargets>>,
  ) {
    return candidates.map((candidate) => {
      const current = matching(resources, candidate.resource)
      if (!current || sameContent(current, candidate.resource)) return candidate
      if (
        bindings.some(
          (binding) =>
            binding.candidateId === candidate.id &&
            binding.key === keyOf(current),
        )
      )
        return {
          ...candidate,
          resource: { ...current, tags: candidate.resource.tags },
        }
      if (current.kind !== 'plugin') return candidate
      const target = targetFor(targets, candidate.targetId)
      try {
        const expected =
          target.plugin?.kind === 'pi'
            ? convertedPiTree(current, [])
            : convertPlugin(current, target, [])
        const actual = { ...candidate.resource.files }
        if (target.plugin?.kind === 'pi')
          delete actual['.agentweave-package.json']
        if (
          fingerprint([expected.files, expected.modes ?? {}]) ===
          fingerprint([actual, candidate.resource.modes ?? {}])
        )
          return {
            ...candidate,
            resource: { ...current, tags: candidate.resource.tags },
          }
      } catch {
        // An unconvertible package is compared in its original format.
      }
      return candidate
    })
  }

  function remember(settings: Settings, item: Candidate, key: string) {
    settings.bindings = (settings.bindings ?? []).filter(
      (b) =>
        !(
          b.targetId === item.targetId &&
          b.kind === item.resource.kind &&
          b.id === item.resource.id
        ),
    )
    settings.bindings.push({
      targetId: item.targetId,
      kind: item.resource.kind,
      name: item.resource.name,
      id: item.resource.id,
      candidateId: item.id,
      key,
    })
  }

  async function scan(body: Record<string, unknown>, edited?: ScanSource) {
    const targetIds = stringList(body.targetIds, 'Agent', true)
    const result = await scanTargets({ home, targetIds })
    const { candidates, warnings, issues, sources, targets } = result
    const resources = await repository.list()
    const settings = await readSettings()
    const { bindings = [], localSnapshot } = settings
    const { snapshot, changes, removed } = compareLocalSnapshot(
      localSnapshot,
      result,
    )
    const compared = compareResources(
      await inbound(candidates, resources, bindings, targets),
      resources,
    )
    const components = resources.flatMap((plugin) =>
      (plugin.components ?? []).map((resource) => ({ plugin, resource })),
    )
    compared.candidates.forEach((candidate, index) => {
      const raw = candidates[index].resource
      if (!matching(resources, raw)) {
        const related = components.filter(
          (item) => keyOf(item.resource) === keyOf(raw),
        )
        if (related.some((item) => sameContent(item.resource, raw)))
          candidate.status = 'same'
        else if (related.length) {
          candidate.status = 'conflict'
          candidate.componentConflict = [
            ...new Set([
              ...(candidate.componentConflict ?? []),
              ...related.map((item) => item.plugin.name),
            ]),
          ]
        }
      }
      if (candidate.status === 'new' && candidate.componentConflict?.length)
        candidate.status = 'conflict'
      candidate.resource = raw
      if (localSnapshot || candidate.status !== 'same')
        candidate.localChange = changes.get(candidate.id)
    })
    const availableKeys = new Set([
      ...resources.map(keyOf),
      ...components.map(
        ({ plugin, resource }) => keyOf(plugin) + '/' + keyOf(resource),
      ),
    ])
    const missingBindings = bindings.filter(
      (b) =>
        availableKeys.has(b.key) &&
        targets.some((t) => t.id === b.targetId) &&
        !issues.some((i) => i.targetId === b.targetId && i.kind === b.kind) &&
        !candidates.some(
          (c) =>
            c.targetId === b.targetId &&
            c.resource.kind === b.kind &&
            c.resource.id === b.id,
        ),
    )
    const missing = missingBindings.map(({ key, targetId, kind, name }) => ({
      key,
      targetId,
      kind,
      name,
    }))
    const localRemovals = removed.map((item) => {
      const binding = bindings.find(
        (b) =>
          b.targetId === item.targetId &&
          b.kind === item.kind &&
          b.id === item.resourceId,
      )
      return binding && availableKeys.has(binding.key)
        ? { ...item, key: binding.key }
        : item
    })
    if (!localSnapshot)
      localRemovals.push(
        ...missingBindings.map(
          ({ id: resourceId, key, targetId, kind, name }) => ({
            resourceId,
            key,
            targetId,
            kind,
            name,
          }),
        ),
      )

    if (
      body.record === true &&
      (!localSnapshot || changes.size || removed.length)
    )
      await saveSettings({ ...settings, localSnapshot: snapshot })

    if (!targetIds) scanSources.clear()
    else {
      for (const [id, source] of scanSources)
        if (targetIds.includes(source.targetId)) scanSources.delete(id)
    }
    for (const source of sources) scanSources.set(source.id, source)
    const updated =
      edited &&
      sources.find(
        (source) =>
          source.targetId === edited.targetId &&
          source.path === edited.path &&
          source.mcpId === edited.mcpId,
      )
    return {
      ...compared,
      missing,
      localChanges: { removed: localRemovals },
      targets: targets.map(({ id, name }) => ({ id, name })),
      warnings,
      issues,
      ...(updated && { updatedId: updated.id }),
    }
  }

  function findScanSource(id: string) {
    const source = scanSources.get(id)
    if (!source) throw new RequestError('资源已变化，请重新扫描。')
    return source
  }

  async function pluginFiles(source: ScanSource) {
    if (!source.plugin) throw new RequestError('该资源不是插件。')
    await assertParents(home, join(source.plugin.root, 'placeholder'))
    const info = await lstat(source.plugin.root)
    if (!info.isDirectory()) throw new RequestError('插件目录无法读取。')
    return (source.plugin.files ??= Object.keys(
      (await readTree(source.plugin.root)).files,
    ))
  }

  async function scanSource(source: ScanSource, filePath?: unknown) {
    let path = source.path
    if (source.plugin) {
      if (
        !validFilePath(filePath) ||
        !(await pluginFiles(source)).includes(filePath)
      )
        throw new RequestError('请选择插件中的有效文件。')
      path = join(source.plugin.root, filePath)
      await assertParents(home, path)
    } else if (filePath !== undefined)
      throw new RequestError('该资源不支持选择文件。')
    const info = await lstat(path)
    if (!info.isFile()) throw new RequestError('只能编辑普通文件。')
    const expected = await pathState(path)
    const bytes = await readFile(path)
    let content = ''
    let binary = bytes.includes(0)
    try {
      if (!binary)
        content = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes)
    } catch {
      binary = true
    }
    const snapshot =
      source.mcpId !== undefined
        ? await readMcp(
            targetFor(await resolveTargets({ home }), source.targetId),
          )
        : undefined
    if (
      snapshot &&
      (snapshot.raw !== content || snapshot.expected !== expected)
    )
      throw new RequestError('文件已被修改，请重新扫描。')
    return {
      ...source,
      path,
      expected,
      mode: info.mode & 0o777,
      content,
      binary,
      snapshot,
      revision: fingerprint([expected, bytes.toString('base64')]),
    }
  }

  async function syncArgs(body: Record<string, unknown>, emptyAllowed = false) {
    const targetId = requiredString(body.targetId, '目标 Agent')
    const kinds = stringList(body.kinds, '资源类型')
    const keys = stringList(body.keys, '资源标识', true)
    const target = (await listTargets({ home })).find(
      ({ id }) => id === targetId,
    )
    if (!target) throw new RequestError(`未知 Agent ${targetId}。`)
    if (
      kinds.some(
        (kind) => !target.kinds.some((supported) => supported === kind),
      )
    )
      throw new RequestError('目标不支持所选资源类型。')
    if (!emptyAllowed && !kinds.length)
      throw new RequestError('请选择至少一种资源类型。')
    if (keys && !keys.length)
      throw new RequestError('请至少选择一项要分发的资源。')
    return { home, targetId, kinds: kinds as ResourceKind[], keys }
  }

  async function bundlePlan(body: Record<string, unknown>) {
    const targetId = requiredString(body.targetId, '目标 Agent')
    const target = (await listTargets({ home })).find(
      ({ id }) => id === targetId,
    )
    if (!target) throw new RequestError(`未知 Agent ${targetId}。`)
    const bundle = await readNpmBundle(
      requiredString(body.from, 'npm 包目录'),
      repositoryRoot,
    )
    const warnings = [...bundle.warnings]
    const candidates = bundle.candidates.filter(({ resource }) => {
      if (target.kinds.includes(resource.kind)) return true
      warnings.push(
        `${target.name} 不支持 ${resource.name}（${resource.kind}）`,
      )
      return false
    })
    const compared = (await repository.compare(candidates)).candidates
    const conflicts = compared.filter(({ status }) => status === 'conflict')
    if (conflicts.length && body.overwrite !== true) {
      throw new RequestError(
        `中央仓库已有同名且内容不同的资源：${conflicts.map(({ resource }) => resource.name).join('、')}。若选择包内版本，请启用覆盖后重新预览。`,
        409,
      )
    }
    for (const { resource } of conflicts)
      warnings.push(`将以 npm 包内的版本替换中央仓库资源：${resource.name}`)
    const selections = compared.map(({ id, status }) => ({
      id,
      replace: status === 'conflict',
    }))
    const resources = await repository.import(candidates, selections, {
      preview: true,
    })
    const options = resources.length
      ? {
          home,
          targetId,
          resources,
          kinds: [...new Set(resources.map(({ kind }) => kind))],
          keys: resources.map(keyOf),
        }
      : undefined
    const sync = options ? await previewSync(options) : undefined
    const result: BundlePlan = {
      packageName: bundle.name,
      packageVersion: bundle.version,
      resourceCount: resources.length,
      changes: sync?.changes ?? [],
      warnings: [...new Set([...warnings, ...(sync?.warnings ?? [])])],
      affectedTargets: sync?.affectedTargets ?? [],
      revision: fingerprint([
        targetId,
        bundle.signature,
        compared,
        resources,
        warnings,
        sync,
      ]),
    }
    return { result, bundle, candidates, selections, options, sync }
  }

  const actions = {
    async capabilities() {
      const pkg = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      )
      return {
        version: String(pkg.version),
        apiVersions: [1],
        features: ['distribute-npm-bundle'],
      }
    },
    async overview(body) {
      const [settings, snapshot, targets] = await Promise.all([
        readSettings(),
        repository.overview(),
        listTargets({ home }),
      ])
      const drift = await Promise.all(
        (body.checkDrift === false ? [] : settings.profiles)
          .filter((p) => targets.some((t) => t.id === p.targetId && t.detected))
          .map(async ({ targetId, kinds }) => {
            try {
              return {
                targetId,
                ...(await previewSync({
                  home,
                  targetId,
                  kinds,
                  resources: snapshot.resources,
                })),
              }
            } catch (error) {
              return {
                targetId,
                changes: [],
                warnings: [errorMessage(error)],
                affectedTargets: [],
                revision: null,
              }
            }
          }),
      )
      return {
        initialized: settings.initialized,
        profiles: settings.profiles,
        workspacePath: join(repositoryRoot, 'codex'),
        ...snapshot,
        targets: targets.filter((t) => t.detected),
        drift,
        mcpProtocolBaseline: MCP_PROTOCOL_BASELINE,
      }
    },
    scan: (body) =>
      body.record === true ? mutate(() => scan(body)) : scan(body),
    'list-scan-files': async (body) => {
      const source = findScanSource(requiredString(body.id, '资源标识'))
      return {
        files: (await pluginFiles(source)).sort((a, b) => a.localeCompare(b)),
      }
    },
    'read-scan-source': async (body) => {
      const source = await scanSource(
        findScanSource(requiredString(body.id, '资源标识')),
        body.path,
      )
      return {
        name:
          source.mcpId !== undefined
            ? `${source.mcpId} · ${basename(source.path)}`
            : source.plugin
              ? String(body.path)
              : basename(source.path),
        content:
          source.mcpId !== undefined && source.snapshot
            ? previewMcpSource(source.snapshot, source.mcpId)
            : source.content,
        revision: source.revision,
        ...(source.binary && { binary: true }),
        ...(source.readOnly && { readOnly: true }),
      }
    },
    'save-scan-source': (body) =>
      mutate(async () => {
        const origin = findScanSource(requiredString(body.id, '资源标识'))
        // Recheck membership before writing, including plugins removed since preview.
        const current = await scanTargets({
          home,
          targetIds: [origin.targetId],
        })
        const verified = current.sources.find((item) => item.id === origin.id)
        if (!verified) throw new RequestError('资源已变化，请重新扫描。')
        if (verified.readOnly)
          throw new RequestError('内置插件由平台维护，导入原文件只供查看。')
        const source = await scanSource(verified, body.path)
        if (source.revision !== requiredString(body.revision, '文件版本'))
          throw new RequestError('文件已被修改，请重新打开后再保存。')
        if (typeof body.content !== 'string')
          throw new RequestError('文件内容无效。')
        if (source.binary) throw new RequestError('二进制文件不能在此编辑。')
        const text =
          source.mcpId !== undefined && source.snapshot
            ? patchMcpSource(source.snapshot, source.mcpId, body.content)
            : body.content
        await applyFileOperations(home, [
          {
            path: source.path,
            expected: source.expected,
            text,
            mode: source.mode,
          },
        ])
        return scan({}, origin)
      }),
    import: (body) =>
      mutate(async () => {
        const targetIds = stringList(body.targetIds, 'Agent', true)
        const selections = selectionsOf(body.selections)
        const settings = await readSettings()
        const scan = await scanTargets({ home, targetIds })
        const { candidates, targets } = scan
        let result: Resource[] = []
        if (selections.length) {
          const chosen = new Set(selections.map((s) => s.id))
          if (
            candidates.some(
              (c) =>
                chosen.has(c.id) &&
                c.componentAlternatives?.some((id) => chosen.has(id)),
            )
          )
            throw new RequestError(
              '所选资源包含不同版本的同名组件，请选择要保留的版本。',
            )
          const redundant = new Set(
            candidates
              .filter((c) => c.bundledBy?.some((id) => chosen.has(id)))
              .map((c) => c.id),
          )
          const selected = selections.filter((s) => !redundant.has(s.id))
          result = await repository.import(
            await inbound(
              candidates,
              await repository.list(),
              settings.bindings ?? [],
              targets,
            ),
            selected,
          )
          for (const item of candidates.filter((c) =>
            selected.some((s) => s.id === c.id),
          )) {
            const stored = matching(result, item.resource)
            if (stored) remember(settings, item, keyOf(stored))
          }
        }
        const { snapshot } = compareLocalSnapshot(settings.localSnapshot, scan)
        await saveSettings({
          ...settings,
          initialized: true,
          localSnapshot: snapshot,
        })
        return result
      }),
    'save-resource': (body) =>
      mutate(() =>
        repository.save(body.resource, {
          replace: body.replace === true,
          fromFile: body.fromFile === true,
          revision:
            body.revision === undefined
              ? undefined
              : requiredString(body.revision, '资源版本'),
        }),
      ),
    'create-resource': (body) =>
      mutate(() => repository.save(newResource(body))),
    'delete-resource': (body) =>
      mutate(async () => {
        await repository.remove(requiredString(body.key, '资源标识'))
        return { removed: true as const }
      }),
    'set-profile': (body) =>
      mutate(async () => {
        const { targetId, kinds } = await syncArgs(body, true)
        const settings = await readSettings()
        const profiles = settings.profiles.filter(
          (profile) => profile.targetId !== targetId,
        )
        if (kinds.length) profiles.push({ targetId, kinds })
        await saveSettings({ ...settings, profiles })
        return profiles
      }),
    'preview-sync': async (body) =>
      previewSync({
        ...(await syncArgs(body)),
        resources: await repository.list(),
      }),
    'apply-sync': (body) =>
      mutate(async () => {
        const args = await syncArgs(body)
        const resources = await repository.list()
        const plan = await applySync({
          ...args,
          resources,
          revision: requiredString(body.revision, '同步预览'),
        })
        if (plan.changes.length) {
          const settings = await readSettings()
          const { candidates } = await scanTargets({
            home,
            targetIds: [args.targetId],
          })
          for (const change of plan.changes) {
            if (change.action === 'delete') {
              settings.bindings = settings.bindings?.filter(
                (b) =>
                  !(
                    b.targetId === args.targetId &&
                    b.kind === change.kind &&
                    b.id === change.key.slice(change.kind.length + 1)
                  ),
              )
              continue
            }
            const found = candidates.find(
              (c) => keyOf(c.resource) === change.key,
            )
            if (!found) continue
            const top = resources.find((r) => keyOf(r) === change.key)
            const owner = resources.find((r) =>
              r.components?.some((c) => keyOf(c) === change.key),
            )
            const key =
              args.keys?.find(
                (k) => k === change.key || k.endsWith('/' + change.key),
              ) ?? (top ? change.key : owner && keyOf(owner) + '/' + change.key)
            if (key) remember(settings, found, key)
          }
          await saveSettings(settings)
        }
        return plan
      }),
    'preview-bundle': async (body) => (await bundlePlan(body)).result,
    'apply-bundle': (body) =>
      mutate(async () => {
        const plan = await bundlePlan(body)
        if (requiredString(body.revision, '分发预览') !== plan.result.revision)
          throw new RequestError('npm 包或分发目标已变化，请重新预览。', 409)
        if (plan.options && plan.sync) {
          await plan.bundle.prepareRuntime()
          await repository.import(plan.candidates, plan.selections)
          try {
            await applySync({ ...plan.options, revision: plan.sync.revision })
          } catch (error) {
            throw new Error(
              `已导入中央仓库，目标分发失败：${errorMessage(error)}`,
              { cause: error },
            )
          }
        }
        return plan.result
      }),
    'preview-github': (body) =>
      repository.previewGithub(requiredString(body.url, 'GitHub 地址')),
    'add-github': (body) =>
      mutate(() =>
        repository.addGithub(
          requiredString(body.url, 'GitHub 地址'),
          selectionsOf(body.selections, true),
          typeof body.revision === 'string' ? body.revision : undefined,
        ),
      ),
    'check-github': () => repository.checkGithub(),
    'preview-github-update': (body) =>
      repository.previewGithubUpdate(requiredString(body.id, '来源标识')),
    'sync-github': (body) =>
      mutate(() =>
        repository.syncGithub(
          requiredString(body.id, '来源标识'),
          body.replaceShared === undefined
            ? undefined
            : requiredString(body.replaceShared, '冲突确认'),
          requiredString(body.token, 'GitHub 更新预览'),
        ),
      ),
  } satisfies {
    [A in ApiAction]: (
      body: Record<string, unknown>,
    ) => Promise<Api[A]['response']>
  }

  function run<A extends ApiAction>(
    action: A,
    body?: Record<string, unknown>,
  ): Promise<Api[A]['response']>
  function run(action: string, body?: unknown): Promise<unknown>
  async function run(action: string, body: unknown = {}): Promise<unknown> {
    if (!Object.hasOwn(actions, action))
      throw new RequestError('请求不存在。', 404)
    if (!object(body)) throw new RequestError('请求必须是 JSON 对象。')
    return actions[action as ApiAction](body)
  }
  return { run }
}
