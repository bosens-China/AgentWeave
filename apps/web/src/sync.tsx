import { useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Modal,
  Select,
  Table,
  Tag,
} from 'antd'
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  DesktopOutlined,
  LinkOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import type { TableProps } from 'antd'
import type {
  Overview,
  ResourceKind,
  Scope,
  SyncChange,
  SyncPlan,
  Target,
} from '@agentweave/protocol'
import { errorMessage, request } from './api'
import { KindTag, kindOptions, PageTitle, Warnings } from './shared'

const actionNames = {
  add: { name: '新增', color: 'green' },
  overwrite: { name: '覆盖', color: 'orange' },
  delete: { name: '删除', color: 'red' },
}

export function AgentsView({
  data,
  onPreview,
  onChanged,
}: {
  data: Overview
  onPreview: (scope: Scope) => void
  onChanged: () => void | Promise<void>
}) {
  const { message } = App.useApp()
  const [saving, setSaving] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [selection, setSelection] = useState<ResourceKind[] | null>(null)
  const targets = data.targets
  const target =
    targets.find(({ id }) => id === targetId) ??
    targets.find(({ detected }) => detected) ??
    targets[0]
  const currentKinds =
    data.profiles.find((profile) => profile.targetId === target?.id)?.kinds ??
    []
  const kinds = selection ?? currentKinds
  const drift = data.drift.find((entry) => entry.targetId === target?.id)
  const stale =
    kinds.length !== currentKinds.length ||
    kinds.some((kind) => !currentKinds.includes(kind))

  async function saveProfile() {
    if (!target) return
    setSaving(true)
    try {
      await request('set-profile', { targetId: target.id, kinds })
      await onChanged()
      setSelection(null)
      message.success('同步范围已保存')
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageTitle
        title="同步目标"
        description="选择本机 Agent 和资源类型，预览中央仓库与目标之间的差异。"
      />
      <div className="agents-grid">
        <section className="surface agents-list" aria-label="本机 Agent">
          <div className="panel-heading">
            <h2>本机 Agent</h2>
            <span className="text-sm text-muted">
              {targets.filter(({ detected }) => detected).length} /{' '}
              {targets.length} 已检测
            </span>
          </div>
          {targets.map((item) => {
            const active = item.id === target?.id
            return (
              <button
                className={`agent-option ${active ? 'agent-option-active' : ''}`}
                type="button"
                key={item.id}
                onClick={() => {
                  setSelection(null)
                  setTargetId(item.id)
                }}
                aria-pressed={active}
                disabled={saving}
              >
                <DesktopOutlined aria-hidden="true" />
                <span className="text-left flex-1">{item.name}</span>
                <span
                  className={`status-dot ${item.detected ? 'dot-online' : ''}`}
                  title={item.detected ? '已检测' : '未检测'}
                />
                {active && <ArrowRightOutlined aria-hidden="true" />}
              </button>
            )
          })}
        </section>
        {target && (
          <section className="surface agent-panel">
            <div className="flex justify-between items-start gap-4 flex-wrap">
              <div>
                <h2>{target.name}</h2>
                <p className="text-muted mb-0">用户级全局配置</p>
              </div>
              <Tag
                bordered={false}
                color={target.detected ? 'green' : 'default'}
              >
                {target.detected ? '已检测' : '未检测'}
              </Tag>
            </div>
            {(target.mcpTransports || target.instructionsPaths) && (
              <dl className="agent-panel-section flex flex-col gap-2">
                {target.mcpTransports && (
                  <div>
                    <dt className="font-medium">MCP 连接方式</dt>
                    <dd className="m-0 text-muted">
                      {target.mcpTransports
                        .map(
                          (transport) =>
                            ({
                              stdio: 'stdio',
                              'streamable-http': 'Streamable HTTP',
                              sse: '旧版 SSE',
                            })[transport],
                        )
                        .join('、')}
                      <span className="block text-xs">
                        中央协议基准 {data.mcpProtocolBaseline}
                      </span>
                    </dd>
                  </div>
                )}
                {target.instructionsPaths && (
                  <div>
                    <dt className="font-medium">全局指令位置</dt>
                    <dd className="m-0 text-muted">
                      {target.instructionsPaths.map((path) => (
                        <code
                          className="block wrap-anywhere text-xs"
                          key={path}
                        >
                          {path}
                        </code>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
            <div className="agent-panel-section">
              <h3>同步范围</h3>
              <p className="text-muted">
                打开 AgentWeave 时检查已保存范围内的差异。
              </p>
              <Checkbox.Group<ResourceKind>
                value={kinds}
                onChange={setSelection}
                options={kindOptions.filter(({ value }) =>
                  target.kinds.includes(value),
                )}
                disabled={!target.detected || saving}
              />
              <div className="flex gap-2 flex-wrap mt-5">
                <Button
                  onClick={saveProfile}
                  disabled={!stale || !target.detected}
                  loading={saving}
                >
                  保存范围
                </Button>
                <Button
                  type="primary"
                  icon={<SyncOutlined />}
                  disabled={!kinds.length || !target.detected}
                  onClick={() => onPreview({ targetId: target.id, kinds })}
                >
                  预览同步
                </Button>
              </div>
            </div>
            {drift && (
              <div className="agent-panel-section">
                <h3>最近检查</h3>
                {!drift.revision ? (
                  <Alert
                    type="error"
                    showIcon
                    title="差异检查失败"
                    description={drift.warnings.join('；')}
                  />
                ) : (
                  <>
                    <div className="flex gap-2 flex-wrap mb-3">
                      {drift.changes?.length ? (
                        Object.entries(actionNames).map(
                          ([action, { name, color }]) => (
                            <Tag key={action} color={color}>
                              {name}{' '}
                              {
                                drift.changes.filter(
                                  (change) => change.action === action,
                                ).length
                              }
                            </Tag>
                          ),
                        )
                      ) : (
                        <Tag
                          color={drift.warnings?.length ? 'default' : 'green'}
                          icon={<CheckCircleOutlined />}
                        >
                          {drift.warnings?.length
                            ? '没有可应用的差异'
                            : '已与中央仓库一致'}
                        </Tag>
                      )}
                    </div>
                    <Warnings warnings={drift.warnings} />
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  )
}

export function SyncDialog({
  scope,
  targets,
  onClose,
  onDone,
}: {
  scope: Scope
  targets: Target[]
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const { message } = App.useApp()
  const [targetId, setTargetId] = useState(scope.targetId)
  const [preview, setPreview] = useState<SyncPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const selected = targets.find(({ id }) => id === targetId)
  const eligible = targets.filter(
    ({ kinds, detected }) =>
      detected && scope.kinds.every((kind) => kinds.includes(kind)),
  )
  const { kinds, keys } = scope

  useEffect(() => {
    if (!scope.targetId) return undefined
    const controller = new AbortController()
    request(
      'preview-sync',
      { targetId: scope.targetId, kinds, keys },
      controller.signal,
    )
      .then(setPreview)
      .catch((error) => {
        if (!(error instanceof Error && error.name === 'AbortError'))
          message.error(errorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    setLoading(true)
    return () => controller.abort()
  }, [scope.targetId, kinds, keys, message])

  async function advance() {
    if (!targetId) return
    setLoading(true)
    try {
      const payload = { targetId, kinds, keys }
      if (!preview) {
        setPreview(await request('preview-sync', payload))
        return
      }
      await request('apply-sync', { ...payload, revision: preview.revision })
      onClose()
      message.success('同步已应用')
      await onDone()
    } catch (error) {
      if (preview) setPreview(null)
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  const columns: TableProps<SyncChange>['columns'] = [
    {
      title: '操作',
      dataIndex: 'action',
      width: 85,
      render: (action: SyncChange['action']) => (
        <Tag color={actionNames[action]?.color}>
          {actionNames[action]?.name ?? action}
        </Tag>
      ),
    },
    {
      title: '资源',
      render: (_, row) => (
        <div className="wrap-anywhere">
          <strong>{row.name}</strong> <KindTag kind={row.kind} />
          <div className="text-muted text-xs mt-1">{row.path}</div>
        </div>
      ),
    },
  ]
  return (
    <Modal
      open
      width={680}
      title={
        scope.targetId
          ? `预览同步 · ${selected?.name ?? scope.targetId}`
          : '分发选中的资源'
      }
      onCancel={onClose}
      onOk={advance}
      okText={preview ? '确认并同步' : '预览变更'}
      cancelText="关闭"
      confirmLoading={loading}
      okButtonProps={{
        disabled: !targetId || (!!preview && !preview.changes.length),
      }}
      closable={!loading}
      mask={{ closable: !loading }}
      keyboard={!loading}
      cancelButtonProps={{ disabled: loading }}
    >
      {!scope.targetId && (
        <div className="mb-4">
          <label className="field-label" htmlFor="sync-target">
            目标 Agent
          </label>
          <Select
            id="sync-target"
            className="w-full"
            placeholder="选择已安装且支持该资源的 Agent"
            virtual={false}
            value={targetId}
            options={eligible.map(({ id, name }) => ({
              label: name,
              value: id,
            }))}
            onChange={(value) => {
              setTargetId(value)
              setPreview(null)
            }}
            disabled={loading}
            notFoundContent="暂无可接收的本机 Agent"
          />
        </div>
      )}
      {preview && (
        <div className="flex flex-col gap-3">
          <Warnings warnings={preview.warnings} />
          {preview.affectedTargets?.length > 1 && (
            <Alert
              title="使用共享配置"
              type="info"
              showIcon
              icon={<LinkOutlined />}
              description={preview.affectedTargets
                .map(
                  (id) =>
                    targets.find((target) => target.id === id)?.name ?? id,
                )
                .join('、')}
            />
          )}
          <Table
            size="small"
            dataSource={preview.changes}
            columns={columns}
            rowKey={(change) => `${change.key}:${change.path}:${change.action}`}
            pagination={false}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="没有需要同步的差异"
                />
              ),
            }}
          />
        </div>
      )}
    </Modal>
  )
}
