import { useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Divider,
  Empty,
  Form,
  Modal,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
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
import { KindTag, Warnings } from './shared'
import { kindOptions } from './shared-helpers'

const transportNames = {
  stdio: 'stdio',
  'streamable-http': 'Streamable HTTP',
  sse: '旧版 SSE',
}

const actionNames = {
  add: { name: '新增', color: 'green' },
  overwrite: { name: '覆盖', color: 'orange' },
  delete: { name: '删除', color: 'red' },
}

const syncChangeColumns: TableProps<SyncChange>['columns'] = [
  {
    title: '操作',
    dataIndex: 'action',
    width: 80,
    render: (action: SyncChange['action']) => (
      <Tag variant="filled" color={actionNames[action]?.color} className="m-0!">
        {actionNames[action]?.name ?? action}
      </Tag>
    ),
  },
  {
    title: '资源',
    render: (_, row) => (
      <div className="wrap-anywhere">
        <span className="font-medium">{row.name}</span>{' '}
        <KindTag kind={row.kind} />
        <div className="text-muted text-xs mt-0.5 font-mono">{row.path}</div>
      </div>
    ),
  },
]

export function AgentsView({
  checking,
  data,
  onPreview,
  onChanged,
}: {
  checking: boolean
  data: Overview
  onPreview: (scope: Scope) => void
  onChanged: () => void | Promise<void>
}) {
  const { message } = App.useApp()
  const [saving, setSaving] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [selection, setSelection] = useState<ResourceKind[] | null>(null)
  const targets = data.targets.filter((t) => t.detected)
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
    <div className="grid grid-cols-1 lg:grid-cols-[224px_minmax(0,1fr)] gap-4 items-stretch">
      <Card
        size="small"
        title="本机 Agent"
        extra={
          <Typography.Text type="secondary" className="text-xs">
            {targets.length} 个
          </Typography.Text>
        }
        styles={{
          body: {
            padding: 8,
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
          },
        }}
        className="min-w-0 flex flex-col h-auto lg:h-[calc(100vh-192px)] lg:min-h-[400px] lg:max-h-[800px]"
      >
        {!targets.length ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="未检测到已安装的 Agent"
            className="my-6"
          />
        ) : (
          <div className="flex flex-col gap-1">
            {targets.map((item) => {
              const isSelected = target?.id === item.id
              const itemKinds =
                data.profiles.find((p) => p.targetId === item.id)?.kinds ?? []
              const itemDrift = data.drift.find((d) => d.targetId === item.id)
              const changeCount = itemDrift?.changes?.length ?? 0
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setSelection(null)
                    setTargetId(item.id)
                  }}
                  className={`flex items-center justify-between gap-2 w-full px-3 py-2 rounded-md border-0 text-left cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-[var(--ant-color-primary-bg)] text-[var(--ant-color-primary)] font-medium'
                      : 'bg-transparent text-[var(--ant-color-text)] hover:bg-[var(--ant-color-fill-tertiary)]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <DesktopOutlined className="shrink-0 opacity-70" />
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="text-xs shrink-0">
                    {itemDrift && !itemDrift.revision ? (
                      <Tooltip title="差异检查失败，点开查看原因">
                        <CloseCircleOutlined
                          className="text-[var(--ant-color-error)]"
                          aria-label="差异检查失败"
                        />
                      </Tooltip>
                    ) : changeCount > 0 ? (
                      <span className="text-[var(--ant-color-warning)] font-medium">
                        {changeCount} 差异
                      </span>
                    ) : itemDrift && itemKinds.length > 0 ? (
                      <CheckCircleOutlined
                        className="text-[var(--ant-color-success)]"
                        aria-label="已与中央仓库一致"
                      />
                    ) : itemKinds.length > 0 ? (
                      <span className="text-muted">{itemKinds.length} 类</span>
                    ) : (
                      <span className="text-muted">未配置</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </Card>

      {target ? (
        <Card
          title={target.name}
          extra={
            <Button
              type="primary"
              icon={<SyncOutlined />}
              disabled={!kinds.length || !target.detected}
              onClick={() => onPreview({ targetId: target.id, kinds })}
            >
              同步到 {target.name}
            </Button>
          }
          styles={{
            body: {
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
            },
          }}
          className="min-w-0 flex flex-col h-auto lg:h-[calc(100vh-192px)] lg:min-h-[400px] lg:max-h-[800px] overflow-hidden"
        >
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="m-0 text-base font-semibold">同步范围</h3>
              <Button
                size="small"
                type={stale ? 'primary' : 'default'}
                ghost={stale}
                onClick={saveProfile}
                disabled={!stale || !target.detected}
                loading={saving}
              >
                保存范围
              </Button>
            </div>
            <p className="text-muted text-sm mb-3">
              勾选需要与中央仓库对齐的资源类型，进入本页时会自动检查差异。
            </p>
            <Checkbox.Group<ResourceKind>
              value={kinds}
              onChange={setSelection}
              options={kindOptions.filter(({ value }) =>
                target.kinds.includes(value),
              )}
              disabled={!target.detected || saving}
            />
          </div>

          {!drift && checking && currentKinds.length > 0 && (
            <Typography.Text type="secondary" className="block mt-4 text-sm">
              正在检查同步差异…
            </Typography.Text>
          )}

          {drift && (
            <>
              <Divider />
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h3 className="m-0 text-base font-semibold">差异明细</h3>
                  {drift.revision && (
                    <div className="flex gap-1.5 flex-wrap">
                      {drift.changes?.length ? (
                        Object.entries(actionNames).map(
                          ([action, { name, color }]) => {
                            const count = drift.changes.filter(
                              (change) => change.action === action,
                            ).length
                            return count > 0 ? (
                              <Tag
                                key={action}
                                color={color}
                                variant="filled"
                                className="m-0!"
                              >
                                {name} {count}
                              </Tag>
                            ) : null
                          },
                        )
                      ) : (
                        <Tag
                          color={drift.warnings?.length ? 'default' : 'success'}
                          variant="filled"
                          icon={<CheckCircleOutlined />}
                          className="m-0!"
                        >
                          {drift.warnings?.length
                            ? '没有可应用的差异'
                            : '已与中央仓库一致'}
                        </Tag>
                      )}
                    </div>
                  )}
                </div>
                {!drift.revision ? (
                  <Alert
                    type="error"
                    showIcon
                    title="差异检查失败"
                    description={drift.warnings.join('；')}
                  />
                ) : (
                  <div className="flex flex-col gap-3">
                    <Warnings warnings={drift.warnings} />
                    {drift.changes?.length > 0 && (
                      <Table
                        size="small"
                        dataSource={drift.changes}
                        columns={syncChangeColumns}
                        rowKey={(change) =>
                          `${change.key}:${change.path}:${change.action}`
                        }
                        pagination={false}
                        scroll={{ y: 260 }}
                      />
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {(target.mcpTransports || target.instructionsPaths) && (
            <>
              <Divider />
              <div>
                <h3 className="m-0 mb-2 text-base font-semibold">平台能力</h3>
                <Descriptions
                  column={1}
                  size="small"
                  items={[
                    ...(target.mcpTransports
                      ? [
                          {
                            key: 'mcp',
                            label: 'MCP 连接方式',
                            children: (
                              <Tooltip
                                title={`MCP 协议基准版本 ${data.mcpProtocolBaseline}`}
                              >
                                <span>
                                  {target.mcpTransports
                                    .map(
                                      (transport) => transportNames[transport],
                                    )
                                    .join('、')}
                                </span>
                              </Tooltip>
                            ),
                          },
                        ]
                      : []),
                    ...(target.instructionsPaths
                      ? [
                          {
                            key: 'instructions',
                            label: '全局指令路径',
                            children: (
                              <div className="flex flex-col gap-1">
                                {target.instructionsPaths.map((path) => (
                                  <Typography.Text
                                    code
                                    className="wrap-anywhere text-xs"
                                    key={path}
                                  >
                                    {path}
                                  </Typography.Text>
                                ))}
                              </div>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            </>
          )}
        </Card>
      ) : (
        <Card className="min-w-0 flex items-center justify-center h-auto lg:h-[calc(100vh-192px)] lg:min-h-[400px] lg:max-h-[800px]">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无可同步的本机 Agent"
          />
        </Card>
      )}
    </div>
  )
}

type TargetPreview = {
  targetId: string
  targetName: string
  plan: SyncPlan
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
  const [selectedIds, setSelectedIds] = useState<string[]>(
    scope.targetId ? [scope.targetId] : [],
  )
  const [previews, setPreviews] = useState<TargetPreview[] | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [loading, setLoading] = useState(Boolean(scope.targetId))
  const eligible = targets.filter(
    ({ detected, kinds }) =>
      detected && scope.kinds.every((kind) => kinds.includes(kind)),
  )
  const nameOf = (id: string) =>
    targets.find((target) => target.id === id)?.name ?? id
  const { kinds, keys } = scope

  const totalChanges =
    previews?.reduce((sum, item) => sum + item.plan.changes.length, 0) ?? 0
  const totalDeletes =
    previews?.reduce(
      (sum, item) =>
        sum +
        item.plan.changes.filter(({ action }) => action === 'delete').length,
      0,
    ) ?? 0
  const actionablePreviews =
    previews?.filter(({ plan }) => plan.changes.length > 0) ?? []

  useEffect(() => {
    if (!scope.targetId) return undefined
    const targetId = scope.targetId
    const controller = new AbortController()
    request('preview-sync', { targetId, kinds, keys }, controller.signal)
      .then((plan) => {
        if (!controller.signal.aborted)
          setPreviews([{ targetId, targetName: nameOf(targetId), plan }])
      })
      .catch((error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          setPreviewFailed(true)
          message.error(errorMessage(error))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.targetId, kinds, keys, message])

  async function advance() {
    if (!selectedIds.length) return
    setLoading(true)
    try {
      if (!previews) {
        const results = await Promise.all(
          selectedIds.map(async (targetId) => ({
            targetId,
            targetName: nameOf(targetId),
            plan: await request('preview-sync', { targetId, kinds, keys }),
          })),
        )
        setPreviews(results)
        setPreviewFailed(false)
        return
      }
      const applied: string[] = []
      const failed: { name: string; message: string }[] = []
      for (const { targetId, targetName, plan } of actionablePreviews) {
        try {
          await request('apply-sync', {
            targetId,
            kinds,
            keys,
            revision: plan.revision,
          })
          applied.push(targetName)
        } catch (error) {
          failed.push({ name: targetName, message: errorMessage(error) })
        }
      }
      await onDone()
      // 保留未完成目标的预览，重新预览后再确认，避免丢失已完成结果。
      const remaining = actionablePreviews.filter(({ targetName }) =>
        failed.some((item) => item.name === targetName),
      )
      if (!failed.length) {
        onClose()
        message.success(
          applied.length > 1
            ? `已分发到 ${applied.length} 个目标 Agent`
            : `已同步到 ${applied[0] ?? '目标 Agent'}`,
        )
        return
      }
      message.warning(
        applied.length
          ? `已完成 ${applied.join('、')}，${failed.map((item) => item.name).join('、')} 需要重新预览`
          : `${failed[0].name} 同步失败：${failed[0].message}`,
      )
      if (!remaining.length) onClose()
      else {
        const refreshed = await Promise.all(
          remaining.map(async ({ targetId, targetName: name }) => ({
            targetId,
            targetName: name,
            plan: await request('preview-sync', { targetId, kinds, keys }),
          })),
        )
        setPreviews(refreshed)
      }
    } catch (error) {
      if (previews) {
        setPreviews(null)
        setPreviewFailed(true)
      }
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  const allSelected =
    eligible.length > 0 && selectedIds.length === eligible.length

  return (
    <Modal
      open
      width={720}
      title={
        scope.targetId
          ? `预览同步 · ${nameOf(scope.targetId)}`
          : scope.keys && scope.keys.length > 1
            ? `批量分发 ${scope.keys.length} 项资源`
            : '分发资源'
      }
      onCancel={onClose}
      onOk={advance}
      okText={
        previews || (scope.targetId && !previewFailed)
          ? scope.keys
            ? actionablePreviews.length > 1
              ? `确认分发到 ${actionablePreviews.length} 个平台`
              : '确认分发'
            : '确认同步'
          : '预览变更'
      }
      cancelText="取消"
      confirmLoading={loading}
      okButtonProps={{
        disabled:
          loading ||
          !selectedIds.length ||
          (!!scope.targetId && !previews && !previewFailed) ||
          (!!previews && totalChanges === 0),
      }}
      closable={!loading}
      mask={{ closable: !loading }}
      keyboard={!loading}
      cancelButtonProps={{ disabled: loading }}
    >
      {!scope.targetId && (
        <Form layout="vertical" component="div">
          <Form.Item
            label={
              <div className="flex items-center justify-between w-full gap-2">
                <span>目标 Agent（可多选）</span>
                {eligible.length > 1 && (
                  <Button
                    type="link"
                    size="small"
                    className="p-0! h-auto!"
                    disabled={loading}
                    onClick={() => {
                      setSelectedIds(
                        allSelected ? [] : eligible.map(({ id }) => id),
                      )
                      setPreviews(null)
                    }}
                  >
                    {allSelected ? '清空已选' : `全选（${eligible.length}）`}
                  </Button>
                )}
              </div>
            }
            htmlFor="sync-target"
          >
            <Select
              id="sync-target"
              mode="multiple"
              className="w-full"
              placeholder="选择一个或多个已安装且支持该资源的 Agent"
              virtual={false}
              value={selectedIds}
              options={eligible.map(({ id, name }) => ({
                label: name,
                value: id,
              }))}
              onChange={(values) => {
                setSelectedIds(values)
                setPreviews(null)
              }}
              disabled={loading}
              notFoundContent="暂无可接收的本机 Agent"
            />
          </Form.Item>
        </Form>
      )}
      {previews && (
        <div className="flex flex-col gap-4 max-h-[55vh] overflow-y-auto pr-1">
          {totalDeletes > 0 && (
            <Alert
              type="error"
              showIcon
              title={`将从目标 Agent 中删除 ${totalDeletes} 项资源`}
              description="请核对下方的变更列表，再确认同步。"
            />
          )}
          {previews.map(({ targetId, targetName, plan }) => (
            <div key={targetId} className="flex flex-col gap-2">
              {previews.length > 1 && (
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm">{targetName}</strong>
                  <span className="text-xs text-muted">
                    {plan.changes.length
                      ? `${plan.changes.length} 项变更`
                      : '无需变更'}
                  </span>
                </div>
              )}
              <Warnings warnings={plan.warnings} />
              {plan.affectedTargets?.length > 1 && (
                <Alert
                  title="使用共享配置"
                  type="info"
                  showIcon
                  icon={<LinkOutlined />}
                  description={plan.affectedTargets.map(nameOf).join('、')}
                />
              )}
              <Table
                size="small"
                dataSource={plan.changes}
                columns={syncChangeColumns}
                rowKey={(change) =>
                  `${targetId}:${change.key}:${change.path}:${change.action}`
                }
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="已与中央仓库一致，无需变更"
                    />
                  ),
                }}
              />
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
