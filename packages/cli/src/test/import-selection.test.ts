import { describe, expect, test } from 'vitest'
import type { ComparedCandidate, Resource } from '@agentweave/protocol'
import {
  candidateLabels,
  fixSkillNameFrontmatter,
  isCollapsibleDuplicate,
  isInRepository,
  platformSelections,
  suggestedLocalSelections,
  tabSelections,
  toggleLocalSelection,
} from '../../../../apps/web/src/import-selection.js'
import { compared } from '../central/resource.js'

function candidate(id: string, name: string, text: string) {
  return {
    id,
    targetId: id,
    resource: { kind: 'instructions' as const, id: name, name, text },
  }
}

describe('local import defaults', () => {
  test('toggles a whole platform across kinds without replacing or clearing other sources', () => {
    const items = compared(
      [
        { ...candidate('instruction', 'one', 'one'), targetId: 'cursor' },
        {
          id: 'mcp',
          targetId: 'cursor',
          resource: {
            kind: 'mcp',
            id: 'shared',
            name: 'shared',
            config: { command: 'node' },
          },
        },
        { ...candidate('overwrite', 'saved', 'changed'), targetId: 'cursor' },
        {
          ...candidate('builtin', 'internal', 'built-in'),
          targetId: 'cursor',
          builtin: true,
        },
        {
          id: 'plugin',
          targetId: 'cursor',
          resource: { kind: 'plugin', id: 'package', name: 'package' },
        },
        {
          ...candidate('child', 'bundled', 'bundled'),
          targetId: 'cursor',
          bundledBy: ['plugin'],
        },
        candidate('external', 'other', 'other'),
      ],
      [candidate('existing', 'saved', 'original').resource],
    ).candidates
    const platform = items.filter(({ targetId }) => targetId === 'cursor')
    const chosen = [{ id: 'external' }, { id: 'instruction' }]
    const partial = platformSelections(platform, items, chosen)
    expect(partial).toMatchObject({
      selected: 1,
      complete: false,
      canToggle: true,
    })
    expect(partial.next).toEqual([...chosen, { id: 'mcp' }, { id: 'plugin' }])
    const complete = platformSelections(platform, items, partial.next)
    expect(complete).toMatchObject({
      selected: 3,
      complete: true,
      next: [{ id: 'external' }],
    })
    expect(
      platformSelections([platform[2]], items, [{ id: 'external' }]).canToggle,
    ).toBe(false)
    expect(
      platformSelections(platform, items, [
        ...partial.next,
        { id: 'overwrite', replace: true },
      ]).next,
    ).toEqual([{ id: 'external' }])
  })

  test('uses the first local version as the default and keeps unrelated new items', () => {
    const versions = [
      candidate('first', 'a', 'one'),
      candidate('second', 'a', 'two'),
      candidate('other', 'b', 'other'),
    ]
    const result = compared(versions, []).candidates
    const chosen = suggestedLocalSelections(result)
    expect(chosen).toEqual([{ id: 'first' }, { id: 'other' }])
    expect(candidateLabels(result[0], result, chosen).conflict).toBe(false)
    expect(candidateLabels(result[1], result, chosen)).toMatchObject({
      duplicate: false,
      conflict: true,
      reference: { id: 'first' },
    })
  })

  test('never selects an overwrite of the central repository by default', () => {
    const first = candidate('first', 'a', 'one')
    const second = candidate('second', 'a', 'two')
    const existing = candidate('existing', 'a', 'existing').resource
    const conflicts = compared([first, second], [existing]).candidates
    expect(conflicts.every((item) => item.conflictWithRepository)).toBe(true)
    expect(suggestedLocalSelections(conflicts)).toEqual([])
    const same = compared([first, second], [second.resource]).candidates
    expect(suggestedLocalSelections(same)).toEqual([])
  })

  test('recognizes matching names with different identifiers', () => {
    const items: ComparedCandidate[] = [
      {
        ...candidate('one', 'name', 'one'),
        status: 'conflict',
        contentHash: 'one',
      },
      {
        ...candidate('two', 'name', 'two'),
        resource: {
          ...candidate('two', 'name', 'two').resource,
          id: 'different',
        },
        status: 'conflict',
        contentHash: 'two',
      },
    ]
    expect(suggestedLocalSelections(items)).toEqual([{ id: items[0].id }])
  })

  test('distinguishes equal content from different versions and keeps only compatible selections', () => {
    const items = compared(
      [
        candidate('a', 'instructions', 'first'),
        candidate('b', 'instructions', 'other'),
        candidate('c', 'instructions', 'other'),
        candidate('d', 'instructions', 'first'),
      ],
      [],
    ).candidates
    expect(suggestedLocalSelections(items)).toEqual([{ id: items[0].id }])
    const initial = toggleLocalSelection(items[0], items, [], true)
    expect(candidateLabels(items[1], items, initial)).toMatchObject({
      duplicate: false,
      conflict: true,
    })
    expect(candidateLabels(items[2], items, initial)).toMatchObject({
      duplicate: false,
      conflict: true,
    })
    expect(candidateLabels(items[3], items, initial)).toMatchObject({
      duplicate: true,
      conflict: false,
    })
    const other = toggleLocalSelection(items[1], items, initial, true)
    expect(other).toEqual([{ id: 'b' }])
    expect(candidateLabels(items[2], items, other)).toMatchObject({
      duplicate: true,
      conflict: false,
    })
    expect(toggleLocalSelection(items[2], items, other, true)).toEqual([
      { id: 'b' },
      { id: 'c' },
    ])
  })

  test('defaults to one item when all versions are identical', () => {
    const items = compared(
      [candidate('a', 'item', 'same'), candidate('b', 'item', 'same')],
      [],
    ).candidates
    expect(suggestedLocalSelections(items)).toEqual([{ id: 'a' }])
    expect(candidateLabels(items[1], items, [{ id: 'a' }])).toMatchObject({
      duplicate: true,
      conflict: false,
    })
  })

  test('groups duplicates regardless of selection while leaving conflicting versions in view', () => {
    const items = compared(
      [
        candidate('a', 'x', 'same'),
        candidate('b', 'x', 'same'),
        candidate('c', 'x', 'different'),
        candidate('d', 'x', 'different'),
        candidate('e', 'y', 'independent'),
      ],
      [],
    ).candidates
    for (const chosen of [[{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]]) {
      const duplicates = items.filter((item) =>
        isCollapsibleDuplicate(candidateLabels(item, items, chosen)),
      )
      expect(duplicates.map(({ id }) => id)).toEqual(['b'])
    }
  })

  test.each<Resource>([
    { kind: 'skill', id: 'a', name: 'a', files: { 'SKILL.md': 'YWJj' } },
    { kind: 'mcp', id: 'a', name: 'a', config: { command: 'node' } },
    { kind: 'instructions', id: 'a', name: 'a', text: 'abc' },
    { kind: 'plugin', id: 'a', name: 'a', files: { 'plugin.json': 'e30=' } },
  ])('detects identical $kind content for different sources', (resource) => {
    const items = compared(
      [
        {
          id: 'one',
          targetId: 'one',
          resource: { ...resource, tags: ['one'] },
        },
        {
          id: 'two',
          targetId: 'two',
          resource: { ...resource, tags: ['two'] },
        },
      ],
      [],
    ).candidates
    expect(candidateLabels(items[1], items, [{ id: 'one' }])).toMatchObject({
      duplicate: true,
      conflict: false,
    })
  })

  test('disables selection and labels items already present in the central repository', () => {
    const existing = candidate('existing', 'saved', 'same-content').resource
    const items = compared(
      [
        {
          ...candidate('in-repo', 'saved', 'same-content'),
          targetId: 'cursor',
        },
        {
          ...candidate('fresh', 'brand-new', 'new-content'),
          targetId: 'cursor',
        },
      ],
      [existing],
    ).candidates
    const [inRepo, fresh] = items
    expect(isInRepository(inRepo)).toBe(true)
    expect(isInRepository(fresh)).toBe(false)
    expect(suggestedLocalSelections(items)).toEqual([{ id: 'fresh' }])
    expect(toggleLocalSelection(inRepo, items, [], true)).toEqual([])
    expect(platformSelections(items, items, [])).toMatchObject({
      selected: 0,
      complete: false,
      canToggle: true,
      next: [{ id: 'fresh' }],
    })
    expect(platformSelections([inRepo], items, [])).toMatchObject({
      selected: 0,
      complete: false,
      canToggle: false,
      next: [],
    })
    expect(tabSelections(items, items, [])).toMatchObject({
      selected: 0,
      complete: false,
      canToggle: true,
      next: [{ id: 'fresh' }],
    })
    const label = candidateLabels(inRepo, items, [])
    expect(label).toMatchObject({
      inRepository: true,
      duplicate: false,
      conflict: false,
    })
    expect(isCollapsibleDuplicate(label)).toBe(false)
  })

  test('auto-fixes uppercase or mismatched skill frontmatter names', () => {
    expect(
      fixSkillNameFrontmatter(
        '---\nname: My_Skill\ndescription: demo\n---\nBody\n',
        'name 不能包含大写字母，请使用小写字母',
      ),
    ).toEqual({
      name: 'my-skill',
      next: '---\nname: "my-skill"\ndescription: demo\n---\nBody\n',
    })

    expect(
      fixSkillNameFrontmatter(
        '---\nname: wrong-name\ndescription: demo\n---\nBody\n',
        'SKILL.md 的 name「wrong-name」必须与目录名「expected-dir」一致',
      ),
    ).toEqual({
      name: 'expected-dir',
      next: '---\nname: "expected-dir"\ndescription: demo\n---\nBody\n',
    })

    expect(
      fixSkillNameFrontmatter(
        '---\nname: already-valid\ndescription: demo\n---\nBody\n',
      ),
    ).toBeNull()
  })
})
