import { useEffect, useState } from 'react'
import { Alert, App, Button, Modal, Skeleton } from 'antd'
import { CloudDownloadOutlined, CompassOutlined } from '@ant-design/icons'
import type { Scan, Selection, Target } from '@agentweave/protocol'
import { errorMessage, request } from './api'
import { CandidateSelection, suggestedSelections, Warnings } from './shared'

export function useLocalScan(shouldScan: boolean) {
  const [scan, setScan] = useState<Scan | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!shouldScan && !revision) return undefined
    const controller = new AbortController()
    setLoading(true)
    setError('')
    request('scan', {}, controller.signal)
      .then(setScan)
      .catch((issue) => {
        if (!(issue instanceof Error && issue.name === 'AbortError'))
          setError(errorMessage(issue))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [shouldScan, revision])

  return {
    scan,
    error,
    loading,
    refresh: () => setRevision((previous) => previous + 1),
  }
}

export function Welcome({
  scanState,
  onScan,
  onSkip,
}: {
  scanState: ReturnType<typeof useLocalScan>
  onScan: () => void
  onSkip: () => void | Promise<void>
}) {
  const { scan, loading, error } = scanState
  return (
    <section className="welcome-panel">
      <div className="welcome-symbol">
        <CompassOutlined />
      </div>
      <div className="flex-1">
        <h2>导入本机 Agent 资源</h2>
        <p>
          {loading
            ? '正在扫描本机 Agent…'
            : scan
              ? `发现 ${scan.candidates.length} 项资源可导入。`
              : '扫描本机 Agent，再选择要放进中央仓库的资源。'}
        </p>
        {error && (
          <p role="alert" className="text-red-800">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-2 justify-end flex-wrap">
        <Button type="text" onClick={onSkip}>
          跳过
        </Button>
        <Button
          type="primary"
          icon={<CloudDownloadOutlined />}
          onClick={onScan}
        >
          查看导入项
        </Button>
      </div>
    </section>
  )
}

export function ImportDialog({
  scanState,
  targets,
  firstImport = false,
  onClose,
  onDone,
}: {
  scanState: ReturnType<typeof useLocalScan>
  targets: Target[]
  firstImport?: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const { message } = App.useApp()
  const [manualSelection, setManualSelection] = useState<Selection[] | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const { scan, error, loading, refresh } = scanState
  const chosen = manualSelection ?? suggestedSelections(scan?.candidates ?? [])

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
      width={660}
      title={firstImport ? '首次导入' : '从本机导入'}
      onCancel={onClose}
      onOk={importItems}
      confirmLoading={saving}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      cancelButtonProps={{ disabled: saving }}
      cancelText="关闭"
      okText={`导入 ${chosen.length} 项`}
      okButtonProps={{ disabled: !chosen.length || loading || !!error }}
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
              <Warnings warnings={scan?.warnings} />
              <CandidateSelection
                candidates={scan?.candidates ?? []}
                targets={targets}
                chosen={chosen}
                setChosen={setManualSelection}
              />
            </>
          )
        )}
      </div>
    </Modal>
  )
}
