import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Modal, Skeleton } from 'antd'
import { CloudDownloadOutlined, CompassOutlined } from '@ant-design/icons'
import type { Scan, Selection, Target, Scope } from '@agentweave/protocol'
import { errorMessage, request } from './api'
import {
  matchesImportFilter,
  suggestedLocalSelections,
  type ImportFilter,
} from './import-selection'
import { ImportBrowser } from './import-browser'

export function useLocalScan(trigger: object | null) {
  const [scan, setScan] = useState<Scan | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!trigger) return undefined
    const controller = new AbortController()
    setLoading(true)
    setError('')
    request('scan', {}, controller.signal)
      .then((result) => {
        if (
          !Array.isArray(result.issues) ||
          result.candidates.some((candidate) => !candidate.contentHash)
        )
          throw new Error('本机服务版本过旧，请重启开发服务后重试。')
        setScan(result)
      })
      .catch((issue) => {
        if (!(issue instanceof Error && issue.name === 'AbortError'))
          setError(errorMessage(issue))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [trigger, revision])

  return {
    scan,
    error,
    loading,
    setScan,
    refresh: () => setRevision((previous) => previous + 1),
  }
}

export function Welcome({
  scanState,
  onScan,
  onSkip,
  onRestore,
  targets,
}: {
  scanState: ReturnType<typeof useLocalScan>
  onScan: (filter?: ImportFilter) => void
  onSkip?: () => void | Promise<void>
  onRestore: (scope: Scope) => void
  targets: Target[]
}) {
  const { scan, loading, error } = scanState
  const count = (filter: 'new' | 'conflict') =>
    new Set(
      scan?.candidates
        .filter((c) => matchesImportFilter(c, filter))
        .map((c) => c.resource.kind + ':' + c.resource.id),
    ).size
  const added = count('new'),
    conflicts = count('conflict')
  if (
    !onSkip &&
    !loading &&
    !error &&
    !added &&
    !conflicts &&
    !scan?.issues.length &&
    !scan?.missing?.length
  )
    return null
  return (
    <section className="welcome-panel">
      <div className="welcome-symbol">
        <CompassOutlined />
      </div>
      <div className="flex-1">
        <h2>本机资源变化</h2>
        <p>
          {loading ? (
            '正在扫描本机 Agent…'
          ) : scan ? (
            <>
              <Button
                type="link"
                size="small"
                disabled={!added}
                onClick={() => onScan('new')}
              >
                新增 {added} 项
              </Button>
              <Button
                type="link"
                size="small"
                disabled={!conflicts}
                onClick={() => onScan('conflict')}
              >
                冲突 {conflicts} 项
              </Button>
              {scan.issues.length ? `，需处理 ${scan.issues.length} 项` : ''}
            </>
          ) : (
            '扫描本机 Agent，再选择要放进中央仓库的资源。'
          )}
        </p>
        {scan?.missing?.map((item) => (
          <p key={item.targetId + item.key}>
            {targets.find((t) => t.id === item.targetId)?.name} 已移除{' '}
            {item.name}{' '}
            <Button
              size="small"
              onClick={() =>
                onRestore({
                  targetId: item.targetId,
                  kinds: [item.kind],
                  keys: [item.key],
                })
              }
            >
              从中央仓库恢复
            </Button>
          </p>
        ))}
        {error && (
          <p role="alert" className="text-red-800">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-2 justify-end flex-wrap">
        {onSkip && (
          <Button type="text" onClick={onSkip}>
            跳过
          </Button>
        )}
        <Button
          type="primary"
          icon={<CloudDownloadOutlined />}
          onClick={() => onScan()}
        >
          从本机导入中央仓库
        </Button>
      </div>
    </section>
  )
}

export function ImportDialog({
  scanState,
  targets,
  firstImport = false,
  filter = 'all',
  onClose,
  onDone,
}: {
  scanState: ReturnType<typeof useLocalScan>
  targets: Target[]
  filter?: ImportFilter
  firstImport?: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const { message } = App.useApp()
  const [manualSelection, setManualSelection] = useState<Selection[] | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const { scan, error, loading, refresh, setScan } = scanState
  const chosen = useMemo(
    () =>
      manualSelection ??
      suggestedLocalSelections(scan?.candidates ?? []).filter((s) =>
        scan?.candidates.some(
          (c) => c.id === s.id && matchesImportFilter(c, filter),
        ),
      ),
    [manualSelection, scan?.candidates, filter],
  )

  async function importItems() {
    setSaving(true)
    try {
      await request('import', { selections: chosen })
      message.success(`已导入 ${chosen.length} 项资源`)
      onClose()
      await onDone()
    } catch (issue) {
      message.error(errorMessage(issue))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      destroyOnHidden
      centered
      width={1000}
      styles={{
        body: { maxHeight: 'calc(100dvh - 180px)', overflowY: 'auto' },
      }}
      title={
        filter === 'new'
          ? '导入本机新增资源'
          : filter === 'conflict'
            ? '选择冲突版本'
            : firstImport
              ? '首次导入'
              : '从本机导入'
      }
      onCancel={() => {
        if (!dirty || window.confirm('当前修改尚未保存，确定放弃修改吗？'))
          onClose()
      }}
      onOk={importItems}
      confirmLoading={saving}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      cancelButtonProps={{ disabled: saving }}
      cancelText="关闭"
      okText={`导入 ${chosen.length} 项`}
      okButtonProps={{
        disabled: !chosen.length || loading || !!error || dirty,
      }}
    >
      <div className="flex flex-col gap-2">
        {error && (
          <Alert
            type="error"
            showIcon
            title="扫描失败"
            description={error}
            action={
              <Button
                size="small"
                onClick={() => {
                  setManualSelection(null)
                  refresh()
                }}
              >
                重试
              </Button>
            }
          />
        )}
        {loading ? (
          <Skeleton active />
        ) : (
          !error && (
            <>
              {scan && (
                <ImportBrowser
                  scan={scan}
                  filter={filter}
                  targets={targets}
                  chosen={chosen}
                  setChosen={setManualSelection}
                  onScan={setScan}
                  onDirtyChange={setDirty}
                />
              )}
            </>
          )
        )}
      </div>
    </Modal>
  )
}
