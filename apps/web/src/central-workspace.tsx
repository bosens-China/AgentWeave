import { useMemo, useState } from 'react'
import {
  App,
  Button,
  Card,
  Dropdown,
  Empty,
  Input,
  List,
  Select,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { TableColumnType, TableProps } from 'antd'
import {
  CloudDownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  GithubOutlined,
  PlusOutlined,
  SearchOutlined,
  SendOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import type {
  GithubSource,
  GithubStatus,
  GithubUpdatePreview,
  Overview,
  Resource,
  ResourceKind,
  Scope,
} from '@agentweave/protocol'
import { errorMessage, request, resourceKey } from './api'
import { KindTag, PageFailure } from './shared'
import { kindOptions, resourceKinds } from './shared-helpers'

type CentralTab = ResourceKind | 'all'
type SourceFilter = 'all' | 'local' | string

const githubLabels = {
  add: '新增',
  overwrite: '覆盖',
  delete: '删除',
  link: '关联已有资源',
  unlink: '解除关联',
}

export function CentralWorkspace({
  data,
  checking,
  initialSourceId,
  initialKind,
  githubStatus,
  githubChecking,
  githubError,
  onCheckGithub,
  onAddGithub,
  onChanged,
  onOpen,
  onPreviewSync,
  onPreviewResource,
  onGoLocal,
  onFilterChange,
}: {
  data: Overview
  checking: boolean
  initialSourceId?: string | null
  initialKind?: string | null
  githubStatus: GithubStatus[]
  githubChecking: boolean
  githubError: string
  onCheckGithub: () => void
  onAddGithub: () => void
  onChanged: () => void | Promise<void>
  onOpen: (resource: Resource | null, kind?: ResourceKind) => void
  onPreviewSync: (scope: Scope) => void
  onPreviewResource: (resource: Resource) => void
  onGoLocal: () => void
  onFilterChange: (next: { kind: string; sourceId: string | null }) => void
}) {
  const { message, modal } = App.useApp()
  const [tab, setTab] = useState<CentralTab>(() =>
    initialKind && initialKind !== 'all'
      ? (kindOptions.find(({ value }) => value === initialKind)?.value ?? 'all')
      : 'all',
  )
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(
    initialSourceId && data.sources.some(({ id }) => id === initialSourceId)
      ? initialSourceId
      : 'all',
  )
  const [query, setQuery] = useState('')
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [previewingSource, setPreviewingSource] = useState<string | null>(null)

  const sourceByKey = useMemo(() => {
    const map = new Map<string, GithubSource>()
    for (const source of data.sources)
      for (const key of source.keys) if (!map.has(key)) map.set(key, source)
    return map
  }, [data.sources])

  const statusById = useMemo(
    () => new Map(githubStatus.map((row) => [row.id, row])),
    [githubStatus],
  )

  function sourceStatus(source: GithubSource) {
    const result = statusById.get(source.id)
    return result?.revision === source.revision ? result : undefined
  }

  function sourceLabel(source: GithubSource) {
    return source.url
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/^https?:\/\//i, '')
      .replace(/\.git$/i, '')
  }

  const kindCounts = new Map<ResourceKind, number>()
  for (const resource of data.resources)
    kindCounts.set(resource.kind, (kindCounts.get(resource.kind) ?? 0) + 1)

  const scopedResources = data.resources.filter((resource) => {
    if (tab !== 'all' && resource.kind !== tab) return false
    if (sourceFilter === 'all') return true
    const key = resourceKey(resource)
    if (sourceFilter === 'local') return !sourceByKey.has(key)
    const source = data.sources.find(({ id }) => id === sourceFilter)
    return Boolean(source?.keys.includes(key))
  })

  const keyword = query.trim().toLowerCase()
  const visible = scopedResources.filter((resource) => {
    if (!keyword) return true
    const meta = data.resourceMeta[resourceKey(resource)]
    return [
      resource.name,
      resource.id,
      meta?.description,
      meta?.author,
      meta?.version,
      meta?.mcpEndpoint,
      ...(resource.tags ?? []),
    ].some((value) => value?.toLowerCase().includes(keyword))
  })

  const visibleKeySet = new Set(visible.map(resourceKey))
  const activeSelectedKeys = selectedRowKeys.filter((key) =>
    visibleKeySet.has(key),
  )

  async function applyGithubUpdate(id: string, preview: GithubUpdatePreview) {
    try {
      const result = await request('sync-github', {
        id,
        token: preview.token,
        replaceShared: preview.shared?.token,
      })
      if ('conflict' in result) throw new Error('共享来源已变更，请重新预览。')
      message.success('已更新中央仓库中的资源')
      await onChanged()
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  async function previewGithubUpdate(source: GithubSource) {
    setPreviewingSource(source.id)
    try {
      const preview = await request('preview-github-update', {
        id: source.id,
      })
      if (source.revision === preview.revision) {
        message.info('此来源暂无可用更新')
        return
      }
      modal.confirm({
        title: `预览更新 · ${sourceLabel(source)}`,
        content: (
          <div>
            <Typography.Paragraph>
              GitHub 版本{' '}
              <Typography.Text code>
                {preview.revision.slice(0, 8)}
              </Typography.Text>
            </Typography.Paragraph>
            {preview.changes.length ? (
              <List
                size="small"
                split={false}
                dataSource={preview.changes}
                renderItem={(change) => (
                  <List.Item className="px-0! py-0.5!">
                    <Tag variant="filled">{githubLabels[change.action]}</Tag>{' '}
                    {change.key}
                  </List.Item>
                )}
              />
            ) : (
              <Typography.Paragraph>仅更新来源版本记录</Typography.Paragraph>
            )}
            {preview.shared && (
              <Typography.Paragraph className="whitespace-pre-wrap">
                {preview.shared.message}
              </Typography.Paragraph>
            )}
          </div>
        ),
        okText: '确认更新',
        cancelText: '取消',
        onOk: () => applyGithubUpdate(source.id, preview),
      })
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setPreviewingSource(null)
    }
  }

  const sourceColumn: TableColumnType<Resource> = {
    title: '来源',
    width: 150,
    render: (_, resource) => {
      const source = sourceByKey.get(resourceKey(resource))
      if (!source)
        return (
          <Tooltip title="来自本机 Agent 或手动创建">
            <Tag variant="filled" className="text-xs m-0!">
              本机
            </Tag>
          </Tooltip>
        )
      const status = sourceStatus(source)
      const statusText =
        status?.status === 'update'
          ? '有更新'
          : status?.status === 'error'
            ? '检查失败'
            : '已是最新'
      return (
        <Tooltip
          title={`${source.url}（${githubChecking ? '检查中' : statusText}）`}
        >
          <Tag
            color="blue"
            variant="filled"
            icon={<GithubOutlined className="m-0!" />}
            className="text-xs m-0! max-w-full truncate align-middle"
          >
            <span className="max-w-28 inline-block truncate align-middle">
              {sourceLabel(source)}
            </span>
          </Tag>
        </Tooltip>
      )
    },
  }

  const actionColumn: TableColumnType<Resource> = {
    title: '操作',
    key: 'actions',
    width: 150,
    align: 'right',
    fixed: 'right',
    render: (_, resource) => {
      const source = sourceByKey.get(resourceKey(resource))
      return (
        <div className="inline-flex items-center gap-1">
          {source ? (
            <Button
              type="link"
              size="small"
              icon={<CloudDownloadOutlined />}
              loading={previewingSource === source.id}
              onClick={() => void previewGithubUpdate(source)}
            >
              来源更新
            </Button>
          ) : (
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => onOpen(resource)}
            >
              编辑
            </Button>
          )}
          <Button
            type="link"
            size="small"
            icon={<SyncOutlined />}
            onClick={() => onPreviewResource(resource)}
          >
            分发
          </Button>
        </div>
      )
    },
  }

  const columns: TableProps<Resource>['columns'] = [
    {
      title: '资源',
      render: (_, resource) => {
        const meta = data.resourceMeta[resourceKey(resource)]
        return (
          <button
            type="button"
            className="w-full p-0 border-0 bg-transparent text-left cursor-pointer group min-w-0"
            onClick={() => onOpen(resource)}
          >
            <div className="font-medium text-[var(--ant-color-text)] group-hover:text-[var(--ant-color-primary)] transition-colors wrap-anywhere">
              {resource.name}
            </div>
            {meta?.description ? (
              <div
                className="text-xs text-muted mt-0.5 line-clamp-2 wrap-anywhere"
                title={meta.description}
              >
                {meta.description}
              </div>
            ) : (
              resource.name !== resource.id && (
                <div className="text-xs text-muted mt-0.5 wrap-anywhere">
                  {resource.id}
                </div>
              )
            )}
          </button>
        )
      },
    },
    ...(tab === 'all'
      ? [
          {
            title: '分类',
            width: 100,
            render: (_: unknown, resource: Resource) => (
              <KindTag kind={resource.kind} />
            ),
          },
        ]
      : []),
    ...(tab === 'skill' || tab === 'plugin'
      ? [
          {
            title: '版本',
            width: 120,
            render: (_: unknown, resource: Resource) => {
              const version = data.resourceMeta[resourceKey(resource)]?.version
              if (!version) return <span className="text-xs text-muted">—</span>
              const display = /^[vV]/.test(version) ? version : `v${version}`
              return (
                <Tooltip title={display}>
                  <Tag
                    variant="filled"
                    className="text-xs m-0! max-w-full truncate align-middle"
                  >
                    {display}
                  </Tag>
                </Tooltip>
              )
            },
          },
          {
            title: '作者',
            width: 120,
            render: (_: unknown, resource: Resource) => {
              const author = data.resourceMeta[resourceKey(resource)]?.author
              return author ? (
                <span className="text-xs text-muted wrap-anywhere">
                  {author}
                </span>
              ) : (
                <span className="text-xs text-muted">—</span>
              )
            },
          },
        ]
      : []),
    ...(tab === 'plugin'
      ? [
          {
            title: '组件',
            width: 80,
            render: (_: unknown, resource: Resource) =>
              resource.components?.length ? (
                <span className="text-xs text-muted">
                  {resource.components.length} 项
                </span>
              ) : (
                <span className="text-xs text-muted">—</span>
              ),
          },
        ]
      : []),
    ...(tab === 'mcp'
      ? [
          {
            title: '连接方式',
            width: 240,
            render: (_: unknown, resource: Resource) => {
              const meta = data.resourceMeta[resourceKey(resource)]
              if (!meta?.mcpTransport && !meta?.mcpEndpoint)
                return <span className="text-xs text-muted">—</span>
              return (
                <div className="min-w-0">
                  {meta.mcpTransport && (
                    <Tag
                      variant="filled"
                      color="purple"
                      className="text-xs m-0!"
                    >
                      {meta.mcpTransport}
                    </Tag>
                  )}
                  {meta.mcpEndpoint && (
                    <div
                      className="text-xs text-muted mt-0.5 truncate font-mono"
                      title={meta.mcpEndpoint}
                    >
                      {meta.mcpEndpoint}
                    </div>
                  )}
                </div>
              )
            },
          },
        ]
      : []),
    sourceColumn,
    {
      title: '标签',
      width: 160,
      responsive: ['md'],
      render: (_, resource) =>
        resource.tags?.length ? (
          <div className="flex gap-1 flex-wrap">
            {resource.tags.map((tag) => (
              <Tag key={tag} variant="filled" className="text-xs m-0!">
                {tag}
              </Tag>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted">—</span>
        ),
    },
    actionColumn,
  ]

  const scrollWidth =
    tab === 'all'
      ? 900
      : tab === 'plugin'
        ? 1100
        : tab === 'mcp'
          ? 1040
          : tab === 'skill'
            ? 1020
            : 800

  const sourceFilterOptions: {
    label: string
    value: SourceFilter
  }[] = [
    { label: '全部来源', value: 'all' },
    { label: '本机', value: 'local' },
    ...data.sources.map((source) => ({
      label: sourceLabel(source),
      value: source.id,
    })),
  ]

  const addMenuItems = [
    {
      key: 'skill',
      label: '新建 Skill',
      onClick: () => onOpen(null, 'skill'),
    },
    {
      key: 'mcp',
      label: '新建 MCP',
      onClick: () => onOpen(null, 'mcp'),
    },
    {
      key: 'instructions',
      label: '新建全局指令',
      onClick: () => onOpen(null, 'instructions'),
    },
    { type: 'divider' as const },
    {
      key: 'github',
      label: '添加 GitHub 仓库',
      icon: <GithubOutlined />,
      onClick: onAddGithub,
    },
    {
      key: 'local',
      label: '从本机导入',
      icon: <FileTextOutlined />,
      onClick: onGoLocal,
    },
  ]

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Tabs
        activeKey={tab}
        className="shrink-0"
        onChange={(key) => {
          setTab(key as CentralTab)
          setSelectedRowKeys([])
          setQuery('')
          onFilterChange({
            kind: key,
            sourceId:
              sourceFilter === 'all' || sourceFilter === 'local'
                ? null
                : sourceFilter,
          })
        }}
        tabBarExtraContent={
          <div className="flex items-center gap-2">
            {data.sources.length > 0 && (
              <Button
                icon={<SyncOutlined spin={githubChecking} />}
                onClick={onCheckGithub}
                disabled={githubChecking}
              >
                检查更新
              </Button>
            )}
            <Dropdown trigger={['click']} menu={{ items: addMenuItems }}>
              <Button type="primary" icon={<PlusOutlined />}>
                新增
              </Button>
            </Dropdown>
          </div>
        }
        items={[
          {
            key: 'all',
            label: (
              <span className="inline-flex items-center gap-2">
                全部
                <span className="text-xs text-muted">
                  {data.resources.length}
                </span>
              </span>
            ),
          },
          ...kindOptions.map(({ value, label }) => ({
            key: value,
            label: (
              <span className="inline-flex items-center gap-2">
                {label}
                <span className="text-xs text-muted">
                  {kindCounts.get(value) ?? 0}
                </span>
              </span>
            ),
          })),
        ]}
      />

      {githubError && data.sources.length > 0 && (
        <div className="mb-3 shrink-0">
          <PageFailure
            title="无法检查 GitHub 更新"
            error={githubError}
            onRetry={onCheckGithub}
          />
        </div>
      )}

      <Card
        styles={{
          body: {
            padding: 0,
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          },
        }}
        className="min-w-0 flex flex-col h-auto lg:h-[calc(100vh-236px)] lg:min-h-[380px] lg:max-h-[760px] overflow-hidden"
      >
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-b-solid border-[var(--ant-color-border-secondary)] bg-[var(--ant-color-bg-container)]">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Input
              prefix={<SearchOutlined className="text-muted" />}
              className="w-60 max-w-full"
              aria-label="搜索资源"
              placeholder="搜索名称、描述、作者或标签"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              allowClear
            />
            {data.sources.length > 0 && (
              <Select<SourceFilter>
                aria-label="按来源筛选"
                className="w-44 max-w-full"
                value={sourceFilter}
                options={sourceFilterOptions}
                onChange={(value) => {
                  setSourceFilter(value)
                  setSelectedRowKeys([])
                  onFilterChange({
                    kind: tab,
                    sourceId:
                      value === 'all' || value === 'local' ? null : value,
                  })
                }}
                popupMatchSelectWidth={false}
              />
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeSelectedKeys.length > 0 && (
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                onClick={() =>
                  onPreviewSync({
                    kinds: [
                      ...new Set(
                        visible
                          .filter((resource) =>
                            activeSelectedKeys.includes(resourceKey(resource)),
                          )
                          .map(({ kind }) => kind),
                      ),
                    ],
                    keys: activeSelectedKeys,
                  })
                }
              >
                批量分发（{activeSelectedKeys.length}）
              </Button>
            )}
            <Typography.Text type="secondary" className="text-xs">
              共 {visible.length} 项
            </Typography.Text>
          </div>
        </div>

        <Table
          className="min-w-0"
          size="middle"
          loading={checking}
          columns={columns}
          dataSource={visible}
          rowKey={resourceKey}
          pagination={false}
          rowSelection={{
            columnWidth: 48,
            selectedRowKeys: activeSelectedKeys,
            onChange: (keys) => setSelectedRowKeys(keys.map(String)),
          }}
          scroll={{
            x: scrollWidth,
            y: 'clamp(240px, calc(100vh - 355px), 640px)',
          }}
          locale={{
            emptyText: (
              <Empty
                className="py-10"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  scopedResources.length
                    ? '没有符合搜索条件的资源'
                    : sourceFilter !== 'all'
                      ? '该来源暂无资源'
                      : tab === 'all'
                        ? '中央仓库暂无资源'
                        : `中央仓库暂无 ${resourceKinds[tab].label}`
                }
              >
                {scopedResources.length ? (
                  <Button size="small" onClick={() => setQuery('')}>
                    清除搜索
                  </Button>
                ) : sourceFilter !== 'all' ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setSourceFilter('all')
                      onFilterChange({ kind: tab, sourceId: null })
                    }}
                  >
                    查看全部来源
                  </Button>
                ) : (
                  <Button type="primary" size="small" onClick={onGoLocal}>
                    前往本机检查导入
                  </Button>
                )}
              </Empty>
            ),
          }}
        />
      </Card>
    </div>
  )
}
