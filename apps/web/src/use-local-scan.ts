import { useEffect, useState } from 'react'
import type { ResourceKind, Scan } from '@agentweave/protocol'
import { errorMessage, request } from './api'

function localKey(targetId: string, kind: ResourceKind, resourceId: string) {
  return JSON.stringify([targetId, kind, resourceId])
}

function keepRecentChanges(previous: Scan | null, next: Scan): Scan {
  const recent = new Map(
    previous?.candidates.flatMap(({ targetId, resource, localChange }) =>
      localChange
        ? [
            [
              localKey(targetId, resource.kind, resource.id),
              localChange,
            ] as const,
          ]
        : [],
    ),
  )
  const installed = new Set(next.targets.map(({ id }) => id))
  const present = new Set(
    next.candidates.map(({ targetId, resource }) =>
      localKey(targetId, resource.kind, resource.id),
    ),
  )
  const removed = [...next.localChanges.removed]
  const removalKeys = new Set(
    removed.map(({ targetId, kind, resourceId }) =>
      localKey(targetId, kind, resourceId),
    ),
  )
  for (const item of previous?.localChanges.removed ?? []) {
    const key = localKey(item.targetId, item.kind, item.resourceId)
    if (
      installed.has(item.targetId) &&
      !present.has(key) &&
      !removalKeys.has(key)
    )
      removed.push(item)
  }
  return {
    ...next,
    candidates: next.candidates.map((item) => ({
      ...item,
      localChange:
        recent.get(
          localKey(item.targetId, item.resource.kind, item.resource.id),
        ) ?? item.localChange,
    })),
    localChanges: { removed },
  }
}

export function useLocalScan() {
  const [scan, setScan] = useState<Scan | null>(null)
  const [error, setError] = useState('')
  const [check, setCheck] = useState({ record: true })
  const [settled, setSettled] = useState<typeof check | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    request('scan', check, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        if (!result.localChanges || !Array.isArray(result.targets))
          throw new Error('本机服务版本过旧，请重启开发服务后重试。')
        setScan((previous) =>
          check.record ? result : keepRecentChanges(previous, result),
        )
        setError('')
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(errorMessage(issue))
      })
      .finally(() => {
        if (!controller.signal.aborted) setSettled(check)
      })
    return () => controller.abort()
  }, [check])

  const loading = settled !== check
  return {
    scan,
    error: loading ? '' : error,
    loading,
    setScan: (next: Scan) =>
      setScan((previous) => keepRecentChanges(previous, next)),
    refresh: (record = true) => setCheck({ record }),
  }
}
