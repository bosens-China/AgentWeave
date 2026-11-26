import type {
  Api,
  ApiAction,
  BundlePlan,
  Overview,
  Resource,
  ResourceKind,
  Selection,
} from '@agentweave/protocol'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { errorCode, errorMessage } from './errors.js'
import { fingerprint, keyOf, object } from './adapters/files.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  applySync,
  listTargets,
  previewSync,
  scanTargets,
} from './adapters/index.js'
import { createRepository } from './central/index.js'
import { readNpmBundle } from './central/npm-bundle.js'
import { newResource } from './central/create.js'
import { MCP_PROTOCOL_BASELINE } from './adapters/mcp-format.js'

type Settings = Pick<Overview, 'initialized' | 'profiles'>

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

  async function scan(body: Record<string, unknown>) {
    const targetIds = stringList(body.targetIds, 'Agent', true)
    const { candidates, warnings } = await scanTargets({ home, targetIds })
    return { ...(await repository.compare(candidates)), warnings }
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
    async overview() {
      const [settings, resources, sources, targets] = await Promise.all([
        readSettings(),
        repository.list(),
        repository.listSources(),
        listTargets({ home }),
      ])
      const drift = await Promise.all(
        settings.profiles.map(async ({ targetId, kinds }) => {
          try {
            return {
              targetId,
              ...(await previewSync({ home, targetId, kinds, resources })),
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
        ...settings,
        resources,
        sources,
        targets,
        drift,
        mcpProtocolBaseline: MCP_PROTOCOL_BASELINE,
      }
    },
    scan,
    import: (body) =>
      mutate(async () => {
        const targetIds = stringList(body.targetIds, 'Agent', true)
        const selections = selectionsOf(body.selections)
        let result: Resource[] = []
        if (selections.length) {
          const { candidates } = await scanTargets({ home, targetIds })
          result = await repository.import(candidates, selections)
        }
        const settings = await readSettings()
        if (!settings.initialized)
          await saveSettings({ ...settings, initialized: true })
        return result
      }),
    'save-resource': (body) =>
      mutate(() =>
        repository.save(body.resource, {
          replace: body.replace === true,
          fromFile: body.fromFile === true,
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
      mutate(async () =>
        applySync({
          ...(await syncArgs(body)),
          resources: await repository.list(),
          revision: requiredString(body.revision, '同步预览'),
        }),
      ),
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
    'sync-github': (body) =>
      mutate(() =>
        repository.syncGithub(
          requiredString(body.id, '来源标识'),
          body.replaceShared === undefined
            ? undefined
            : requiredString(body.replaceShared, '冲突确认'),
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
