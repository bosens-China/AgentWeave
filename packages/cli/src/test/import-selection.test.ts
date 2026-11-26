import { describe, expect, test } from 'vitest'
import type { ComparedCandidate, Resource } from '@agentweave/protocol'
import {
  canCollapseCandidate,
  candidateLabels,
  suggestedLocalSelections,
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
  test('requires a choice for conflicting versions and keeps unrelated new items', () => {
    const versions = [
      candidate('first', 'a', 'one'),
      candidate('second', 'a', 'two'),
      candidate('other', 'b', 'other'),
    ]
    const result = compared(versions, []).candidates
    expect(suggestedLocalSelections(result)).toEqual([{ id: 'other' }])
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
    expect(suggestedLocalSelections(items)).toEqual([])
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
    expect(suggestedLocalSelections(items)).toEqual([])
    const initial = toggleLocalSelection(items[0], items, [], true)
    expect(candidateLabels(items[1], items, initial)).toEqual({
      duplicate: false,
      conflict: true,
    })
    expect(candidateLabels(items[2], items, initial)).toEqual({
      duplicate: true,
      conflict: true,
    })
    expect(candidateLabels(items[3], items, initial)).toEqual({
      duplicate: true,
      conflict: false,
    })
    const other = toggleLocalSelection(items[1], items, initial, true)
    expect(other).toEqual([{ id: 'b' }])
    expect(candidateLabels(items[2], items, other)).toEqual({
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
    expect(candidateLabels(items[1], items, [{ id: 'a' }])).toEqual({
      duplicate: true,
      conflict: false,
    })
  })

  test('collapses only unselected duplicates and conflicts without changing the selection', () => {
    const items = compared(
      [
        candidate('a', 'x', 'same'),
        candidate('b', 'x', 'same'),
        candidate('c', 'x', 'different'),
        candidate('d', 'y', 'independent'),
      ],
      [],
    ).candidates
    const chosen = [{ id: 'a' }, { id: 'd' }]
    const hidden = items.filter((item) =>
      canCollapseCandidate(
        candidateLabels(item, items, chosen),
        chosen.some(({ id }) => id === item.id),
      ),
    )
    expect(hidden.map(({ id }) => id)).toEqual(['b', 'c'])
    expect(chosen).toEqual([{ id: 'a' }, { id: 'd' }])
  })

  test('conflict and duplicate filters can be toggled independently', () => {
    const conflictOnly = { conflict: true, duplicate: false }
    const duplicateOnly = { conflict: false, duplicate: true }
    const both = { conflict: true, duplicate: true }
    expect(
      canCollapseCandidate(conflictOnly, false, {
        conflict: true,
        duplicate: false,
      }),
    ).toBe(true)
    expect(
      canCollapseCandidate(duplicateOnly, false, {
        conflict: true,
        duplicate: false,
      }),
    ).toBe(false)
    expect(
      canCollapseCandidate(conflictOnly, false, {
        conflict: false,
        duplicate: true,
      }),
    ).toBe(false)
    expect(
      canCollapseCandidate(duplicateOnly, false, {
        conflict: false,
        duplicate: true,
      }),
    ).toBe(true)
    expect(
      canCollapseCandidate(both, false, { conflict: true, duplicate: false }),
    ).toBe(true)
    expect(
      canCollapseCandidate(both, true, { conflict: true, duplicate: true }),
    ).toBe(false)
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
    expect(candidateLabels(items[1], items, [{ id: 'one' }])).toEqual({
      duplicate: true,
      conflict: false,
    })
  })
})
