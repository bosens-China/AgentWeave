import type {
  ComparedCandidate,
  LocalRemoval,
  Resource,
  ResourceKind,
  Scan,
  ScanIssue,
  Selection,
} from '@agentweave/protocol'

export type ImportFilter =
  | 'all'
  | 'importable'
  | 'inRepo'
  | 'added'
  | 'updated'
  | 'removed'
  | 'issues'

export function isInRepository(candidate: ComparedCandidate) {
  return candidate.status === 'same'
}

export function matchesImportFilter(
  item: ComparedCandidate,
  filter: ImportFilter,
) {
  if (filter === 'all') return true
  if (filter === 'importable') return !isInRepository(item)
  if (filter === 'inRepo') return isInRepository(item)
  return item.localChange === filter
}

export function platformSelections(
  platform: ComparedCandidate[],
  candidates: ComparedCandidate[],
  chosen: Selection[],
) {
  const platformIds = new Set(
    platform.filter((item) => !isInRepository(item)).map(({ id }) => id),
  )
  const selected = chosen.filter(({ id }) => platformIds.has(id)).length
  let next = chosen
  for (const candidate of platform) {
    if (
      isInRepository(candidate) ||
      candidate.builtin ||
      candidate.conflictWithRepository ||
      candidate.componentConflict?.length ||
      candidate.componentAlternatives?.length ||
      candidate.bundledBy?.some((id) =>
        next.some((entry) => entry.id === id),
      ) ||
      next.some(({ id }) => id === candidate.id)
    )
      continue
    if (
      candidate.status === 'conflict' &&
      candidateLabels(candidate, candidates, next).conflict
    )
      continue
    const proposed = toggleLocalSelection(candidate, candidates, next, true)
    if (proposed.length === next.length + 1) next = proposed
  }
  return {
    selected,
    complete: selected > 0 && next === chosen,
    canToggle: selected > 0 || next !== chosen,
    next:
      next === chosen ? chosen.filter(({ id }) => !platformIds.has(id)) : next,
  }
}

export function tabSelections(
  entries: ComparedCandidate[],
  candidates: ComparedCandidate[],
  chosen: Selection[],
) {
  return platformSelections(entries, candidates, chosen)
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
  const preferred: ComparedCandidate[] = []
  for (const candidate of candidates) {
    if (
      !canRecommend(candidate) ||
      preferred.some((item) =>
        resourcesMatch(item.resource, candidate.resource),
      )
    )
      continue
    preferred.push(candidate)
  }
  return preferred.map(({ id }) => ({ id }))
}

function canRecommend(candidate: ComparedCandidate) {
  return (
    !isInRepository(candidate) &&
    !candidate.builtin &&
    !candidate.conflictWithRepository &&
    !candidate.bundledBy?.length &&
    !candidate.componentConflict?.length &&
    !candidate.componentAlternatives?.length
  )
}

export function candidateLabels(
  candidate: ComparedCandidate,
  candidates: ComparedCandidate[],
  chosen: Selection[],
) {
  const inRepository = isInRepository(candidate)
  const group = candidates.filter((item) =>
    resourcesMatch(item.resource, candidate.resource),
  )
  const selected = group.find((item) => chosen.some(({ id }) => id === item.id))
  const preferred =
    selected ??
    group.find((item) => isInRepository(item)) ??
    group.find(canRecommend) ??
    group[0]
  const reference = preferred?.id === candidate.id ? undefined : preferred
  const conflict =
    !inRepository &&
    (!!candidate.componentConflict?.length ||
      !!candidate.conflictWithRepository ||
      (!!reference && reference.contentHash !== candidate.contentHash))
  const duplicate =
    !inRepository &&
    !conflict &&
    (!!candidate.bundledBy?.some((id) => chosen.some((s) => s.id === id)) ||
      reference?.contentHash === candidate.contentHash)
  return { inRepository, duplicate, conflict, reference }
}

export function isCollapsibleDuplicate({
  inRepository,
  conflict,
  duplicate,
}: {
  inRepository?: boolean
  conflict: boolean
  duplicate: boolean
}) {
  return duplicate && !conflict && !inRepository
}

export function toggleLocalSelection(
  candidate: ComparedCandidate,
  candidates: ComparedCandidate[],
  chosen: Selection[],
  checked: boolean,
): Selection[] {
  if (!checked) return chosen.filter(({ id }) => id !== candidate.id)
  if (isInRepository(candidate)) return chosen
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

export type FlatImportRow = { key: string } & (
  | { type: 'candidate'; item: ComparedCandidate }
  | { type: 'issue'; item: ScanIssue }
  | { type: 'removed'; item: LocalRemoval }
)

export function updatedAtMs(iso?: string) {
  if (!iso) return -1
  const time = Date.parse(iso)
  return Number.isNaN(time) ? -1 : time
}

export function formatUpdatedAt(iso?: string) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function buildFlatImportRows({
  scan,
  kind,
  targetId,
  filter,
  query,
  hideDuplicates,
  chosen,
}: {
  scan: Scan
  kind: ResourceKind
  targetId: string | null
  filter: ImportFilter
  query: string
  hideDuplicates: boolean
  chosen: Selection[]
}) {
  const keyword = query.trim().toLowerCase()
  const matchesTarget = (id: string) => !targetId || id === targetId
  const matchesQuery = (...fields: (string | undefined)[]) => {
    if (!keyword) return true
    return fields.some((field) => field?.toLowerCase().includes(keyword))
  }

  const allScopedCandidates = scan.candidates.filter(
    (item) => item.resource.kind === kind && matchesTarget(item.targetId),
  )
  const labels = new Map(
    allScopedCandidates.map((item) => [
      item.id,
      candidateLabels(item, scan.candidates, chosen),
    ]),
  )

  const filteredCandidates = allScopedCandidates.filter(
    (item) =>
      matchesImportFilter(item, filter) &&
      matchesQuery(
        item.resource.name,
        item.description,
        item.author,
        item.version,
      ),
  )
  if (kind === 'skill') {
    filteredCandidates.sort(
      (left, right) =>
        updatedAtMs(right.updatedAt) - updatedAtMs(left.updatedAt) ||
        left.resource.name.localeCompare(right.resource.name),
    )
  }

  let hiddenDuplicateCount = 0
  const visibleCandidates: ComparedCandidate[] = []
  for (const item of filteredCandidates) {
    if (hideDuplicates && isCollapsibleDuplicate(labels.get(item.id)!)) {
      hiddenDuplicateCount++
      continue
    }
    visibleCandidates.push(item)
  }

  const issues =
    filter === 'all' || filter === 'issues'
      ? scan.issues.filter(
          (item) =>
            item.kind === kind &&
            matchesTarget(item.targetId) &&
            (filter !== 'issues' || !item.builtin) &&
            matchesQuery(item.name ?? item.reason, item.description),
        )
      : []
  const removed =
    filter === 'all' || filter === 'removed'
      ? scan.localChanges.removed.filter(
          (item) =>
            item.kind === kind &&
            matchesTarget(item.targetId) &&
            matchesQuery(item.name),
        )
      : []

  const rows: FlatImportRow[] = [
    ...visibleCandidates.map<FlatImportRow>((item) => ({
      type: 'candidate',
      key: item.id,
      item,
    })),
    ...issues.map<FlatImportRow>((item) => ({
      type: 'issue',
      key: item.id,
      item,
    })),
    ...removed.map<FlatImportRow>((item) => ({
      type: 'removed',
      key: `removed:${item.targetId}:${item.resourceId}`,
      item,
    })),
  ]

  return { rows, visibleCandidates, labels, hiddenDuplicateCount }
}

const validSkillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function normalizeSkillName(raw: string) {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

export function fixSkillNameFrontmatter(
  content: string,
  reason?: string,
): { next: string; name: string } | null {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(
    content,
  )
  if (!match) return null
  const [, open, frontmatter, close] = match
  const lineMatch =
    /^([ \t]*name[ \t]*:[ \t]*)([^\r\n#]*?)([ \t]*(?:#.*)?)$/m.exec(frontmatter)
  if (!lineMatch) return null
  const expectedFromReason = reason?.match(/必须与目录名「([^」]+)」一致/)?.[1]
  const targetName =
    expectedFromReason && validSkillNamePattern.test(expectedFromReason)
      ? expectedFromReason
      : normalizeSkillName(lineMatch[2])
  if (!targetName || !validSkillNamePattern.test(targetName)) return null
  const currentClean = lineMatch[2].trim().replace(/^['"]|['"]$/g, '')
  if (currentClean === targetName) return null
  const nextFrontmatter = frontmatter.replace(
    lineMatch[0],
    `${lineMatch[1]}"${targetName}"${lineMatch[3]}`,
  )
  return {
    name: targetName,
    next: `${open}${nextFrontmatter}${close}${content.slice(match[0].length)}`,
  }
}
