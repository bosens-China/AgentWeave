import type {
  Candidate,
  GithubSource,
  GithubStatus,
  GithubSyncResult,
  Resource,
  Selection,
} from '@agentweave/protocol'
import { errorMessage } from '../errors.js'
import { fingerprint } from '../adapters/files.js'
import { createHash } from 'node:crypto'
import { closeSync, constants, fchmodSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspectGithub, readGithub } from './github.js'
import { pluginFromFiles } from './plugin.js'
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

function openDatabase(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'repository.sqlite')
  const file = openSync(
    path,
    constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    if (process.platform !== 'win32') fchmodSync(file, 0o600)
  } finally {
    closeSync(file)
  }
  const db = new DatabaseSync(path)
  try {
    db.exec(
      'PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)',
    )
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function createRepository(
  root: string,
  {
    github = { inspect: inspectGithub, read: readGithub },
  }: {
    github?: { inspect: typeof inspectGithub; read: typeof readGithub }
  } = {},
) {
  function state<T>(
    callback: (data: RepositoryState) => T,
    writing = false,
  ): T {
    const db = openDatabase(root)
    try {
      if (writing) db.exec('BEGIN IMMEDIATE')
      const row = db.prepare('SELECT data FROM state WHERE id = 1').get()
      const data: RepositoryState =
        typeof row?.data === 'string'
          ? JSON.parse(row.data)
          : { resources: [], sources: [] }
      const result = callback(data)
      if (writing) {
        db.prepare(
          'INSERT INTO state(id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
        ).run(JSON.stringify(data))
        db.exec('COMMIT')
      }
      return result
    } finally {
      db.close()
    }
  }

  return {
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
    async save(resource: unknown, { replace = false, fromFile = false } = {}) {
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
      return state(({ resources }) => upsert(resources, clean, replace), true)
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
      const result = state(({ resources }) => compared(candidates, resources))
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
        const imported = importSelected(resources, candidates, choices)
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
      const sources = state(({ sources }) => sources.map(sourceSummary))
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
    async syncGithub(
      id: string,
      replaceShared?: string,
    ): Promise<GithubSyncResult> {
      const original = state(({ sources }) =>
        sources.find((source) => source.id === id),
      )
      if (!original) throw new Error('中央仓库中找不到此 GitHub 来源')
      const snapshot = await github.inspect(original.url)
      if (snapshot.revision === original.revision)
        return sourceSummary(original)
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
          if (replaceShared !== token) {
            const details = conflicts.map(
              ({ current, shared }) =>
                `${current.name}（${shared.map(({ url }) => url).join('、')}）`,
            )
            return {
              conflict: {
                token,
                message: `GitHub 新版本与其他来源共享的中央资源有冲突：\n${details.join('\n')}\n使用新版本会解除上列来源对这些资源的关联。`,
              },
            }
          }
          for (const { candidate, current, shared } of conflicts) {
            approved.add(candidate.id)
            const key = resourceKey(current)
            for (const other of shared) {
              for (const [binding, boundKey] of Object.entries(
                other.bindings,
              )) {
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
        const updated = importSelected(
          data.resources,
          eligible,
          eligible.map(({ id }) => ({
            id,
            replace: Object.hasOwn(source.bindings, id) || approved.has(id),
          })),
        )
        source.bindings = Object.fromEntries(
          updated.map(({ id, resource }) => [id, resourceKey(resource)]),
        )
        source.revision = snapshot.revision
        return sourceSummary(source)
      }, true)
    },
  }
}
