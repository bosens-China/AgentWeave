import type { LocalRemoval } from '@agentweave/protocol'
import { fingerprint } from './adapters/files.js'
import type { scanTargets } from './adapters/index.js'

type LocalScan = Awaited<ReturnType<typeof scanTargets>>
type SnapshotEntry = Omit<LocalRemoval, 'key'> & { revision: string }
export type LocalSnapshot = Record<string, SnapshotEntry>

export function compareLocalSnapshot(
  previous: LocalSnapshot | undefined,
  { candidates, targets, issues }: LocalScan,
) {
  const snapshots = new Map<
    string,
    { resource: Omit<SnapshotEntry, 'revision'>; ids: string[] }
  >()
  for (const { id, targetId, resource } of candidates) {
    const { kind, id: resourceId, name } = resource
    const key = fingerprint([targetId, kind, resourceId])
    const entry = snapshots.get(key) ?? {
      resource: { targetId, kind, resourceId, name },
      ids: [],
    }
    entry.ids.push(id)
    snapshots.set(key, entry)
  }

  const snapshot = { ...previous }
  const changes = new Map<string, 'added' | 'updated'>()
  const removed: Omit<LocalRemoval, 'key'>[] = []
  for (const [key, { resource, ids }] of snapshots) {
    const revision = fingerprint(ids.sort())
    const old = previous?.[key]
    if (!old || old.revision !== revision)
      for (const id of ids) changes.set(id, old ? 'updated' : 'added')
    snapshot[key] = { ...resource, revision }
  }

  const scanned = new Set(targets.map(({ id }) => id))
  for (const [key, { revision: _, ...item }] of Object.entries(
    previous ?? {},
  )) {
    if (
      snapshots.has(key) ||
      !scanned.has(item.targetId) ||
      issues.some(
        ({ targetId, kind }) =>
          targetId === item.targetId && kind === item.kind,
      )
    )
      continue
    delete snapshot[key]
    removed.push(item)
  }
  return { snapshot, changes, removed }
}
