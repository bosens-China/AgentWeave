import { useState } from 'react'
import { Alert, App, Button, Tooltip } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import type { ResourceKind, Scan, Scope, Selection } from '@agentweave/protocol'
import { errorMessage, request } from './api'
import { isInRepository, suggestedLocalSelections } from './import-selection'
import { ImportBrowser } from './import-browser'
import { PageTitle } from './shared'
import { kindOptions, resourceKinds, useConfirmDiscard } from './shared-helpers'
import { useLocalScan } from './use-local-scan'

const emptyScan: Scan = {
  targets: [],
  candidates: [],
  warnings: [],
  issues: [],
  localChanges: { removed: [] },
}

export function LocalCheckPage({
  initialized,
  onChanged,
  onRestore,
  onDirtyChange,
}: {
  initialized: boolean
  onChanged: () => void | Promise<void>
  onRestore: (scope: Scope, refresh: () => void) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const { message } = App.useApp()
  const confirmDiscard = useConfirmDiscard()
  const [manualSelection, setManualSelection] = useState<Selection[] | null>(
    null,
  )
  const [selectedKind, setSelectedKind] = useState<ResourceKind | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const { scan, error, loading, refresh, setScan } = useLocalScan()
  const candidates = scan?.candidates ?? []
  const defaultKind =
    kindOptions.find(
      ({ value }) =>
        candidates.some(({ resource }) => resource.kind === value) ||
        scan?.issues.some(({ kind }) => kind === value) ||
        scan?.localChanges.removed.some(({ kind }) => kind === value),
    )?.value ?? 'skill'
  const activeKind = selectedKind ?? defaultKind
  const selectableIds = new Set(
    candidates.filter((item) => !isInRepository(item)).map(({ id }) => id),
  )
  const chosen = (
    manualSelection ?? suggestedLocalSelections(candidates)
  ).filter(({ id }) => selectableIds.has(id))

  function editState(value: boolean) {
    setDirty(value)
    onDirtyChange(value)
  }

  async function recheck() {
    if (dirty && !(await confirmDiscard())) return
    editState(false)
    setManualSelection(null)
    refresh()
  }

  async function importItems(selections: Selection[], kind?: ResourceKind) {
    setSaving(true)
    try {
      const imported = await request('import', { selections })
      if (selections.length) {
        const label = kind ? ` ${resourceKinds[kind].label}` : '资源'
        message.success(`已导入 ${imported.length} 项${label}`)
      }
      if (kind) {
        const importedIds = new Set(selections.map(({ id }) => id))
        setManualSelection((previous) =>
          previous ? previous.filter(({ id }) => !importedIds.has(id)) : null,
        )
      } else {
        setManualSelection(null)
      }
      refresh()
      await onChanged()
    } catch (issue) {
      message.error(errorMessage(issue))
    } finally {
      setSaving(false)
    }
  }

  const busy = loading || saving
  return (
    <div className="flex flex-col h-full min-h-0">
      <PageTitle
        title="本机检查"
        description="扫描本机已安装的 Agent，按分类与平台审阅并导入到中央仓库"
        actions={
          <>
            {!initialized && (
              <Tooltip title="跳过首次导入，先进入空仓库，稍后可随时回来导入">
                <Button
                  type="text"
                  disabled={busy || dirty || !!error}
                  onClick={() => importItems([])}
                >
                  暂不导入
                </Button>
              </Tooltip>
            )}
            <Button
              icon={<SyncOutlined />}
              loading={loading}
              disabled={saving}
              onClick={recheck}
            >
              重新检查
            </Button>
          </>
        }
      />
      {error ? (
        <Alert type="error" showIcon title="本机检查失败" description={error} />
      ) : (
        <ImportBrowser
          scan={scan ?? emptyScan}
          loading={loading}
          kind={activeKind}
          onKindChange={setSelectedKind}
          importing={saving}
          chosen={chosen}
          setChosen={setManualSelection}
          onImport={(kind, selections) => importItems(selections, kind)}
          onScan={setScan}
          onDirtyChange={editState}
          onRestore={(scope) => {
            if (dirty) {
              message.info('请先保存修改或关闭原文件预览')
              return
            }
            onRestore(scope, () => refresh(false))
          }}
        />
      )}
    </div>
  )
}
