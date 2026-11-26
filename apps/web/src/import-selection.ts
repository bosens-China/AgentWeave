import type {
  ComparedCandidate,
  Resource,
  Selection,
} from '@agentweave/protocol'

export type ImportFilter = 'all' | 'new' | 'conflict'
export function matchesImportFilter(
  item: ComparedCandidate,
  filter: ImportFilter,
) {
  if (filter === 'all') return true
  if (item.componentConflict?.length || item.status === 'conflict')
    return filter === 'conflict'
  return filter === 'new' && item.status === 'new' && !item.bundledBy?.length
}

export function resourcesMatch(left: Resource, right: Resource) {
  const normalize = (value: string) => value.normalize('NFC').toLowerCase()
  return (
    left.kind === right.kind &&
    (normalize(left.id) === normalize(right.id) ||
      normalize(left.name) === normalize(right.name))
  )
}

export function suggestedLocalSelections(
  candidates: ComparedCandidate[],
): Selection[] {
  return candidates.flatMap((candidate) => {
    const group = candidates.filter((item) =>
      resourcesMatch(item.resource, candidate.resource),
    )
    if (
      candidate.builtin ||
      candidate.status !== 'new' ||
      candidate.bundledBy?.length ||
      candidate.componentConflict?.length ||
      group.some((item) => item.status === 'conflict')
    )
      return []
    const preferred = group.find(
      (item) => !item.builtin && !item.bundledBy?.length,
    )
    return preferred === candidate ? [{ id: candidate.id }] : []
  })
}

export function candidateLabels(
  candidate: ComparedCandidate,
  candidates: ComparedCandidate[],
  chosen: Selection[],
) {
  const group = candidates.filter((item) =>
    resourcesMatch(item.resource, candidate.resource),
  )
  const previous = group.slice(0, group.indexOf(candidate))
  const selected = group.find((item) => chosen.some(({ id }) => id === item.id))
  const duplicate =
    candidate.status === 'same' ||
    !!candidate.bundledBy?.some((id) => chosen.some((s) => s.id === id)) ||
    previous.some((item) => item.contentHash === candidate.contentHash)
  const conflict =
    !!candidate.componentConflict?.length ||
    !!candidate.conflictWithRepository ||
    (!!selected &&
      selected.id !== candidate.id &&
      selected.contentHash !== candidate.contentHash) ||
    (!selected && candidate.status === 'conflict')
  return { duplicate, conflict }
}

export function canCollapseCandidate(
  labels: { conflict: boolean; duplicate: boolean },
  selected: boolean,
  filters = { conflict: true, duplicate: true },
) {
  return (
    !selected &&
    ((filters.conflict && labels.conflict) ||
      (filters.duplicate && labels.duplicate))
  )
}

export function toggleLocalSelection(
  candidate: ComparedCandidate,
  candidates: ComparedCandidate[],
  chosen: Selection[],
  checked: boolean,
): Selection[] {
  if (!checked) return chosen.filter(({ id }) => id !== candidate.id)
  return [
    ...chosen.filter(({ id }) => {
      if (
        candidate.bundledBy?.includes(id) ||
        candidate.componentAlternatives?.includes(id)
      )
        return false
      const item = candidates.find((entry) => entry.id === id)
      if (item?.bundledBy?.includes(candidate.id)) return false
      return (
        !item ||
        !resourcesMatch(item.resource, candidate.resource) ||
        item.contentHash === candidate.contentHash
      )
    }),
    {
      id: candidate.id,
      ...(candidate.conflictWithRepository && { replace: true }),
    },
  ]
}
