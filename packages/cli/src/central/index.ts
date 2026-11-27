import type {
  Candidate,
  GithubSource,
  GithubStatus,
  GithubSyncResult,
  GithubUpdatePreview,
  Resource,
  Selection,
} from '@agentweave/protocol'
import { errorMessage } from '../errors.js'
import { fingerprint } from '../adapters/files.js'
import { createHash } from 'node:crypto'
import { workspaceState } from './workspace.js'
import { inspectGithub, readGithub } from './github.js'
import { pluginFromFiles } from './plugin.js'
import { resourceMetadata } from './resource-description.js'
import { validateImport } from './validation.js'
import {
  compared,
  importSelected,
  matching,
  normalizeCandidates,
  normalizeResource,
  resourceKey,
  sameContent,
  upsert,
} from './resource.js'

type TrackedSource = Omit<GithubSource, 'keys'> & {
  bindings: Record<string, string>
  excluded: string[]
  watchAll: boolean
}
type RepositoryState = { resources: Resource[]; sources: TrackedSource[] }

function sourceSummary({
  id,
  url,
  revision,
  bindings,
}: TrackedSource): GithubSource {
  return {
    id,
    url,
    revision,
    keys: [...new Set(Object.values(bindings))].sort(),
  }
}

function githubCandidates(
  github: Pick<GithubSource, 'id' | 'url'>,
  resources: Resource[],
) {
  return normalizeCandidates(
    resources.map((resource) => ({
      id: createHash('sha256')
        .update(
          JSON.stringify([
            github.id,
            resource.sourcePath ?? '',
            resourceKey(resource),
          ]),
        )
        .digest('hex')
        .slice(0, 24),
      targetId: github.url,
      resource,
    })),
  )
}

function importGithubResources(
  resources: Resource[],
  candidates: Candidate[],
  choices: Selection[],
  sources: TrackedSource[],
) {
  const tracked = new Set(
    sources.flatMap((source) => Object.values(source.bindings)),
  )
  const selected = new Set(choices.map((choice) => choice.id))
  for (const candidate of candidates) {
    if (!selected.has(candidate.id)) continue
    const existing = matching(resources, candidate.resource)
    if (
      existing &&
      !existing.tags?.length &&
      !tracked.has(resourceKey(existing)) &&
      sameContent(existing, candidate.resource)
    ) {
      existing.tags = ['本地']
    }
  }
  return importSelected(resources, candidates, choices)
}
export function createRepository(
  root: string,
  {
    github = { inspect: inspectGithub, read: readGithub },
  }: {
    github?: { inspect: typeof inspectGithub; read: typeof readGithub }
  } = {},
) {
  function state<T>(callback: (data: RepositoryState) => T, writing = false) {
    return workspaceState(root, callback, writing)
  }

  async function updateGithub(
    id: string,
    replaceShared?: string,
    preview = false,
    expected?: string,
  ): Promise<GithubSyncResult | GithubUpdatePreview> {
    const original = await state(({ sources }) =>
      sources.find((source) => source.id === id),
    )
    if (!original) throw new Error('中央仓库中找不到此 GitHub 来源')
    const snapshot = await github.inspect(original.url)
    if (snapshot.revision === original.revision) {
      if (preview)
        return {
          revision: snapshot.revision,
          token: snapshot.revision,
          changes: [],
        }
      if (expected && expected !== snapshot.revision)
        throw new Error('更新预览已过期，请重新检查')
      return sourceSummary(original)
    }
    const { resources: found, warnings } = await github.read(snapshot)
    if (warnings.length)
      throw new Error(
        `GitHub 更新未通过格式校验，中央仓库已保留原版本。\n${warnings.join('\n')}`,
      )
    const candidates = githubCandidates(snapshot, found)
    return state((data) => {
      const source = data.sources.find((entry) => entry.id === id)
      if (!source || JSON.stringify(source) !== JSON.stringify(original))
        throw new Error('此 GitHub 来源已变更，请重试同步')
      const token = fingerprint([
        snapshot.revision,
        data.sources,
        data.resources,
      ])
      if (expected && token !== expected)
        throw new Error('更新预览已过期，请重新检查')
      const before = new Map(
        data.resources.map((resource) => [resourceKey(resource), resource]),
      )
      let shared: GithubUpdatePreview['shared']
      const keysBefore = new Set(Object.values(source.bindings))
      const eligible = candidates.filter(
        ({ id }) =>
          !source.excluded.includes(id) &&
          (source.watchAll || Object.hasOwn(source.bindings, id)),
      )
      const owners = new Map<string, TrackedSource[]>()
      for (const other of data.sources) {
        if (other.id === id) continue
        for (const key of new Set(Object.values(other.bindings)))
          owners.set(key, [...(owners.get(key) ?? []), other])
      }
      const conflicts = eligible.flatMap((candidate) => {
        const current = matching(data.resources, candidate.resource)
        const shared = current && owners.get(resourceKey(current))
        return current && shared && !sameContent(current, candidate.resource)
          ? [{ candidate, current, shared }]
          : []
      })
      const approved = new Set<string>()
      if (conflicts.length) {
        const token = fingerprint([id, snapshot.revision, conflicts])
        const details = conflicts.map(
          ({ current, shared }) =>
            `${current.name}（${shared.map((s) => s.url).join('、')}）`,
        )
        shared = {
          token,
          message: `使用 GitHub 版本将解除其他来源对以下资源的关联：\n${details.join('\n')}`,
        }
        if (!preview && replaceShared !== token) return { conflict: shared }
        for (const { candidate, current, shared } of conflicts) {
          approved.add(candidate.id)
          const key = resourceKey(current)
          for (const other of shared) {
            for (const [binding, boundKey] of Object.entries(other.bindings)) {
              if (boundKey !== key) continue
              delete other.bindings[binding]
              other.excluded.push(binding)
            }
          }
        }
      } else if (replaceShared) {
        throw new Error('GitHub 更新已变化，请重新确认。')
      }
      const remaining = new Set(eligible.map(({ id }) => source.bindings[id]))
      for (const key of keysBefore) {
        if (remaining.has(key)) continue
        const resource = data.resources.find(
          (entry) => resourceKey(entry) === key,
        )
        if (!resource) continue
        const tags = (resource.tags ?? []).filter((tag) => tag !== source.url)
        if (tags.length || owners.has(key)) resource.tags = tags
        else data.resources.splice(data.resources.indexOf(resource), 1)
      }
      const updated = importGithubResources(
        data.resources,
        eligible,
        eligible.map(({ id }) => ({
          id,
          replace: Object.hasOwn(source.bindings, id) || approved.has(id),
        })),
        data.sources,
      )
      source.bindings = Object.fromEntries(
        updated.map(({ id, resource }) => [id, resourceKey(resource)]),
      )
      if (preview) {
        const changes: GithubUpdatePreview['changes'] = []
        for (const resource of data.resources) {
          const key = resourceKey(resource)
          const previous = before.get(key)
          if (!previous) changes.push({ key, action: 'add' })
          else if (!sameContent(previous, resource))
            changes.push({ key, action: 'overwrite' })
          else if (
            !keysBefore.has(key) &&
            Object.values(source.bindings).includes(key)
          )
            changes.push({ key, action: 'link' })
          else if (
            keysBefore.has(key) &&
            !Object.values(source.bindings).includes(key)
          )
            changes.push({ key, action: 'unlink' })
        }
        for (const key of before.keys())
          if (!data.resources.some((r) => resourceKey(r) === key))
            changes.push({ key, action: 'delete' })
        return { token, revision: snapshot.revision, changes, shared }
      }
      source.revision = snapshot.revision
      return sourceSummary(source)
    }, !preview)
  }

  return {
    async overview() {
      return state(({ resources, sources }) => ({
        resources: resources.sort((a, b) =>
          resourceKey(a).localeCompare(resourceKey(b)),
        ),
        resourceRevisions: Object.fromEntries(
          resources.map((resource) => [
            resourceKey(resource),
            fingerprint(resource),
          ]),
        ),
        resourceMeta: Object.fromEntries(
          resources.map((resource) => [
            resourceKey(resource),
            resourceMetadata(resource),
          ]),
        ),
        sources: sources.map(sourceSummary),
      }))
    },
    async list() {
      return state(({ resources }) =>
        resources.sort((a, b) => resourceKey(a).localeCompare(resourceKey(b))),
      )
    },
    async compare(candidates: Candidate[]) {
      const normalized = normalizeCandidates(candidates)
      return state(({ resources }) => compared(normalized, resources))
    },
    async import(
      candidates: Candidate[],
      selections: Selection[],
      { preview = false } = {},
    ) {
      const normalized = normalizeCandidates(candidates)
      return state(({ resources }) => {
        const imported = importSelected(resources, normalized, selections)
        const keys = new Set(
          imported.map(({ resource }) => resourceKey(resource)),
        )
        return resources.filter((resource) => keys.has(resourceKey(resource)))
      }, !preview)
    },
    async remove(key: string) {
      return state((data) => {
        const index = data.resources.findIndex(
          (resource) => resourceKey(resource) === key,
        )
        if (index === -1) throw new Error('中央仓库中找不到此资源')
        const [removed] = data.resources.splice(index, 1)
        for (const source of data.sources)
          for (const [id, bound] of Object.entries(source.bindings)) {
            if (key !== bound) continue
            delete source.bindings[id]
            source.excluded.push(id)
          }
        return removed
      }, true)
    },
    async save(
      resource: unknown,
      {
        replace,
        fromFile,
        revision,
      }: {
        replace?: boolean
        fromFile?: boolean
        revision?: string
      } = {},
    ) {
      const clean = normalizeResource(resource)
      if (fromFile) {
        if (clean.kind === 'plugin' && clean.format !== 'pi') {
          const plugin = pluginFromFiles(
            clean.files ?? {},
            clean.modes,
            clean.format,
            true,
          )
          if (!plugin) throw new Error('无法识别插件清单')
          validateImport(plugin)
        }
        validateImport(clean)
      }
      return state(({ resources }) => {
        if (revision !== undefined) {
          const current = resources.find(
            (item) => resourceKey(item) === resourceKey(clean),
          )
          if (!current || fingerprint(current) !== revision)
            throw new Error('资源已被其他操作更新，请重新打开后再保存。')
        }
        return upsert(resources, clean, replace === true)
      }, true)
    },
    async listSources() {
      return state(({ sources }) => sources.map(sourceSummary))
    },
    async removeSource(id: string) {
      return state(({ sources }) => {
        const index = sources.findIndex((source) => source.id === id)
        if (index === -1) throw new Error('中央仓库中找不到此 GitHub 来源')
        return sourceSummary(sources.splice(index, 1)[0])
      }, true)
    },
    async previewGithub(url: string) {
      const snapshot = await github.inspect(url)
      const { resources: found, warnings } = await github.read(snapshot)
      const candidates = githubCandidates(snapshot, found)
      if (!candidates.length && !warnings.length)
        throw new Error('此地址未找到可导入的资源')
      const result = await state(({ resources }) =>
        compared(candidates, resources),
      )
      return {
        url: snapshot.url,
        revision: snapshot.revision,
        warnings,
        ...result,
      }
    },
    async addGithub(url: string, selections?: Selection[], revision?: string) {
      const snapshot = await github.inspect(url)
      if (revision && revision !== snapshot.revision)
        throw new Error('GitHub 资源已更新，请重新预览后再添加')
      const { resources: found, warnings } = await github.read(snapshot)
      const candidates = githubCandidates(snapshot, found)
      if (!candidates.length)
        throw new Error(warnings.join('\n') || '此地址未找到可导入的资源')
      return state(({ sources, resources }) => {
        if (sources.some((source) => source.id === snapshot.id))
          throw new Error('这个 GitHub 地址已添加，请同步已有来源')
        const choices = selections ?? candidates.map(({ id }) => ({ id }))
        if (!choices.length) throw new Error('请至少选择一个 GitHub 资源')
        const imported = importGithubResources(
          resources,
          candidates,
          choices,
          sources,
        )
        const bindings = Object.fromEntries(
          imported.map(({ id, resource }) => [id, resourceKey(resource)]),
        )
        const source = {
          id: snapshot.id,
          url: snapshot.url,
          revision: snapshot.revision,
          bindings,
          excluded: [],
          watchAll: Object.keys(bindings).length === candidates.length,
        }
        sources.push(source)
        return sourceSummary(source)
      }, true)
    },
    async checkGithub(): Promise<GithubStatus[]> {
      const sources = await state(({ sources }) => sources.map(sourceSummary))
      return Promise.all(
        sources.map(async (source): Promise<GithubStatus> => {
          try {
            const snapshot = await github.inspect(source.url)
            return {
              ...source,
              latestRevision: snapshot.revision,
              status:
                snapshot.revision === source.revision ? 'current' : 'update',
            }
          } catch (error) {
            return { ...source, status: 'error', error: errorMessage(error) }
          }
        }),
      )
    },
    async previewGithubUpdate(id: string) {
      return (await updateGithub(id, undefined, true)) as GithubUpdatePreview
    },
    async syncGithub(id: string, replaceShared?: string, token?: string) {
      return (await updateGithub(
        id,
        replaceShared,
        false,
        token,
      )) as GithubSyncResult
    },
  }
}
