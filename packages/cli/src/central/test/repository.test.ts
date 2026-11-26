import type { Candidate, Resource } from '@agentweave/protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRepository } from '../index.js'
import { parseGithubUrl } from '../github.js'

function skill(id: string, name = id, body = 'Shared text'): Resource {
  return {
    kind: 'skill',
    id,
    name,
    files: { 'SKILL.md': Buffer.from(body).toString('base64') },
  }
}

function entry(id: string, targetId: string, resource: Resource): Candidate {
  return { id, targetId, resource }
}

describe('central repository', () => {
  let root: string
  let repo: ReturnType<typeof createRepository>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentweave-repository-'))
    repo = createRepository(root)
  })
  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('deduplicates identical content and keeps the selected sources', async () => {
    const options = [
      entry('a', 'codex', skill('review')),
      entry('b', 'claude', skill('review')),
      entry('c', 'pi', skill('review-copy', 'review')),
    ]
    await repo.import(
      options,
      options.map(({ id }) => ({ id })),
    )
    expect(await repo.list()).toEqual([
      { ...skill('review'), tags: ['claude', 'codex', 'pi'] },
    ])
    expect(
      (await repo.compare(options)).candidates.map(({ status }) => status),
    ).toEqual(['same', 'same', 'same'])
  })

  it('asks for a single version and applies only the chosen replacement', async () => {
    const options = [
      entry('a', 'codex', skill('review')),
      entry('b', 'claude', skill('review', 'review', 'Claude version')),
    ]
    expect(
      (await repo.compare(options)).candidates.map(({ status }) => status),
    ).toEqual(['conflict', 'conflict'])
    await expect(
      repo.import(options, [{ id: 'a' }, { id: 'b', replace: true }]),
    ).rejects.toThrow('多个版本')
    expect(await repo.list()).toEqual([])
    await repo.import(options, [{ id: 'a' }])
    await expect(repo.import(options, [{ id: 'b' }])).rejects.toThrow('重名')
    await repo.import(options, [{ id: 'b', replace: true }])
    expect(await repo.list()).toEqual([
      { ...options[1].resource, tags: ['claude'] },
    ])
    await repo.remove('skill:review')
    expect(await repo.list()).toEqual([])
  })

  it('rejects unsafe file paths and colliding resource identities', async () => {
    await expect(
      repo.save({
        ...skill('paths'),
        files: { ...skill('paths').files, '../outside': 'WA==' },
      }),
    ).rejects.toThrow('无效')
    await repo.save(skill('one', 'First'))
    await repo.save(skill('two', 'Second'))
    await expect(
      repo.save(skill('one', 'Second'), { replace: true }),
    ).rejects.toThrow('不同资源')
    expect(await repo.list()).toHaveLength(2)
  })

  it('checks a GitHub update without applying it, then updates only on explicit sync', async () => {
    const url = 'https://github.com/example/resources'
    const source = parseGithubUrl(url)
    let revision = 'a'.repeat(40)
    let contents = [skill('one')]
    let warnings: string[] = []
    repo = createRepository(root, {
      github: {
        inspect: async () => ({ ...source, revision, path: '' }),
        read: async () => ({ resources: contents, warnings }),
      },
    })
    const preview = await repo.previewGithub(url)
    revision = 'b'.repeat(40)
    await expect(
      repo.addGithub(url, [{ id: preview.candidates[0].id }], preview.revision),
    ).rejects.toThrow('重新预览')
    await repo.addGithub(url)
    await repo.save(skill('one', 'one', 'Local change'), { replace: true })
    revision = 'c'.repeat(40)
    contents = [skill('one', 'one', 'Remote change'), skill('two')]
    expect(await repo.checkGithub()).toEqual([
      expect.objectContaining({ status: 'update', latestRevision: revision }),
    ])
    expect((await repo.list())[0].files).toEqual(
      skill('one', 'one', 'Local change').files,
    )
    warnings = ['skills/one/SKILL.md：缺少 description']
    contents = [skill('two')]
    expect(await repo.previewGithub(url)).toMatchObject({ warnings })
    await expect(repo.syncGithub(source.id)).rejects.toThrow('缺少 description')
    expect(await repo.listSources()).toMatchObject([
      { revision: 'b'.repeat(40), keys: ['skill:one'] },
    ])
    expect((await repo.list())[0].files).toEqual(
      skill('one', 'one', 'Local change').files,
    )
    warnings = []
    contents = [skill('one', 'one', 'Remote change'), skill('two')]
    expect(await repo.syncGithub(source.id)).toMatchObject({
      revision,
      keys: ['skill:one', 'skill:two'],
    })
    expect(await repo.list()).toEqual(
      contents.map((resource) => ({ ...resource, tags: [url] })),
    )
    expect(await repo.checkGithub()).toEqual([
      expect.objectContaining({ status: 'current' }),
    ])
    await repo.remove('skill:one')
    revision = 'd'.repeat(40)
    expect(await repo.syncGithub(source.id)).toMatchObject({
      keys: ['skill:two'],
    })
    await repo.removeSource(source.id)
    expect(await repo.listSources()).toEqual([])
    expect(await repo.list()).toHaveLength(1)
  })

  it('keeps unrelated duplicate content when a source removes it upstream', async () => {
    const url = 'https://github.com/example/resources'
    const source = parseGithubUrl(url)
    let revision = 'a'.repeat(40)
    let contents = [skill('one'), skill('two')]
    repo = createRepository(root, {
      github: {
        inspect: async () => ({ ...source, revision, path: '' }),
        read: async () => ({ resources: contents, warnings: [] }),
      },
    })
    await repo.import(
      [entry('local', 'codex', skill('one'))],
      [{ id: 'local' }],
    )
    const preview = await repo.previewGithub(url)
    await repo.addGithub(
      url,
      [{ id: preview.candidates[0].id }],
      preview.revision,
    )
    contents = [skill('two'), skill('three')]
    revision = 'b'.repeat(40)
    expect(await repo.syncGithub(source.id)).toMatchObject({ keys: [] })
    expect(await repo.list()).toEqual([{ ...skill('one'), tags: ['codex'] }])
  })

  it('preserves an independently created central file after GitHub stops supplying the identical file', async () => {
    const source = parseGithubUrl('https://github.com/example/resources')
    let revision = 'a'.repeat(40),
      contents = [skill('manual')]
    repo = createRepository(root, {
      github: {
        inspect: async () => ({ ...source, path: '', revision }),
        read: async () => ({ resources: contents, warnings: [] }),
      },
    })
    await repo.save(skill('manual'))
    await repo.addGithub(source.url)
    contents = []
    revision = 'b'.repeat(40)
    const preview = await repo.previewGithubUpdate(source.id)
    expect(preview.changes).toEqual([{ key: 'skill:manual', action: 'unlink' }])
    await repo.syncGithub(source.id, undefined, preview.token)
    expect(await repo.list()).toEqual([{ ...skill('manual'), tags: ['本地'] }])
  })

  it('asks before replacing a resource shared with another GitHub source', async () => {
    const first = parseGithubUrl('https://github.com/example/first')
    const second = parseGithubUrl('https://github.com/example/second')
    let revision = 'a'.repeat(40)
    let next = skill('review')
    repo = createRepository(root, {
      github: {
        inspect: async (url) => ({
          ...parseGithubUrl(url),
          revision: url === first.url ? revision : 'a'.repeat(40),
          path: '',
        }),
        read: async ({ id }) => ({
          resources:
            id === first.id ? [next] : [skill('review'), skill('other')],
          warnings: [],
        }),
      },
    })
    await repo.addGithub(first.url)
    await repo.addGithub(second.url)
    const before = await repo.list()
    expect(before.find(({ id }) => id === 'review')?.tags).toEqual([
      first.url,
      second.url,
    ])

    revision = 'b'.repeat(40)
    next = skill('review', 'review', 'first update')
    const result = await repo.syncGithub(first.id)
    if (!('conflict' in result)) throw new Error('Expected a conflict')
    expect(result.conflict.message).toContain(second.url)
    expect(await repo.list()).toEqual(before)
    expect((await repo.listSources()).map((source) => source.revision)).toEqual(
      ['a'.repeat(40), 'a'.repeat(40)],
    )

    revision = 'c'.repeat(40)
    next = skill('review', 'review', 'newer update')
    const fresh = await repo.syncGithub(first.id, result.conflict.token)
    if (!('conflict' in fresh)) throw new Error('Expected renewed confirmation')
    expect(fresh.conflict.token).not.toBe(result.conflict.token)
    expect(await repo.list()).toEqual(before)

    expect(await repo.syncGithub(first.id, fresh.conflict.token)).toMatchObject(
      {
        revision,
        keys: ['skill:review'],
      },
    )
    expect(await repo.list()).toEqual([
      { ...skill('other'), tags: [second.url] },
      { ...next, tags: [first.url] },
    ])
    expect(
      (await repo.listSources()).find(({ id }) => id === second.id),
    ).toMatchObject({
      revision: 'a'.repeat(40),
      keys: ['skill:other'],
    })
  })
})

it('previews GitHub removals and binds consent to both the remote and central versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentweave-github-confirm-'))
  try {
    const source = parseGithubUrl('https://github.com/example/resources')
    let revision = 'a'.repeat(40),
      contents = [skill('retired'), skill('updated')]
    const repo = createRepository(root, {
      github: {
        inspect: async () => ({ ...source, revision, path: '' }),
        read: async () => ({ resources: contents, warnings: [] }),
      },
    })
    await repo.addGithub(source.url)
    revision = 'b'.repeat(40)
    contents = [skill('added'), skill('updated', 'updated', 'New content')]
    const first = await repo.previewGithubUpdate(source.id)
    expect(first.changes).toEqual(
      expect.arrayContaining([
        { key: 'skill:retired', action: 'delete' },
        { key: 'skill:added', action: 'add' },
        { key: 'skill:updated', action: 'overwrite' },
      ]),
    )
    expect((await repo.list()).map((r) => r.id)).toEqual(['retired', 'updated'])
    revision = 'c'.repeat(40)
    await expect(
      repo.syncGithub(source.id, undefined, first.token),
    ).rejects.toThrow('过期')
    const second = await repo.previewGithubUpdate(source.id)
    await repo.save(skill('personal'))
    await expect(
      repo.syncGithub(source.id, undefined, second.token),
    ).rejects.toThrow('过期')
    const final = await repo.previewGithubUpdate(source.id)
    await repo.syncGithub(source.id, undefined, final.token)
    expect((await repo.list()).map((r) => r.id)).toEqual([
      'added',
      'personal',
      'updated',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
