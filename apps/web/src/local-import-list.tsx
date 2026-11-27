import { Button, Checkbox, Empty, Table, Tag, Tooltip } from 'antd'
import type { TableProps } from 'antd'
import { CheckCircleOutlined, EyeOutlined } from '@ant-design/icons'
import type {
  ComparedCandidate,
  ResourceKind,
  Scan,
  Scope,
  Selection,
} from '@agentweave/protocol'
import {
  candidateLabels,
  formatUpdatedAt,
  isInRepository,
  tabSelections,
  toggleLocalSelection,
  type FlatImportRow,
} from './import-selection'

const mcpFieldLabels: Record<string, string> = {
  command: '启动命令',
  args: '启动参数',
  env: '环境变量',
  envVars: '环境变量',
  url: '服务地址',
  type: '连接方式',
  headers: '请求头',
  envHeaders: '请求头',
  bearerTokenEnvVar: '认证方式',
  enabled: '启用状态',
  options: '平台专用设置',
}

export function LocalImportList({
  scan,
  loading,
  kind,
  targetId,
  rows,
  visibleCandidates,
  labels,
  hiddenDuplicateCount,
  onShowDuplicates,
  chosen,
  setChosen,
  active,
  disabled,
  onOpen,
  onRestore,
}: {
  scan: Scan
  loading: boolean
  kind: ResourceKind
  targetId: string | null
  rows: FlatImportRow[]
  visibleCandidates: ComparedCandidate[]
  labels: Map<string, ReturnType<typeof candidateLabels>>
  hiddenDuplicateCount: number
  onShowDuplicates: () => void
  chosen: Selection[]
  setChosen: (selection: Selection[]) => void
  active: string
  disabled: boolean
  onOpen: (id: string, kind: ResourceKind) => void
  onRestore: (scope: Scope) => void
}) {
  const names = new Map(scan.targets.map(({ id, name }) => [id, name]))
  const selected = new Set(chosen.map(({ id }) => id))

  function statusFor(candidate: ComparedCandidate) {
    const label = labels.get(candidate.id) ?? {
      inRepository: isInRepository(candidate),
      conflict: false,
      duplicate: false,
      reference: undefined,
    }
    const { inRepository, conflict, duplicate, reference } = label
    const comparison = candidate.mcpComparison
    const referenceFields = reference?.mcpComparison?.fields
    const fields = candidate.conflictWithRepository
      ? comparison?.repositoryDifferences
      : comparison &&
        referenceFields &&
        [
          ...new Set([
            ...Object.keys(comparison.fields),
            ...Object.keys(referenceFields),
          ]),
        ].filter((field) => comparison.fields[field] !== referenceFields[field])
    const differences = [
      ...new Set(
        (fields ?? []).map((field) =>
          Object.hasOwn(mcpFieldLabels, field) ? mcpFieldLabels[field] : field,
        ),
      ),
    ]
    const source =
      reference && (names.get(reference.targetId) ?? reference.targetId)
    const differenceText = differences.length
      ? `差异字段：${differences.join('、')}。`
      : ''
    const summary = candidate.conflictWithRepository
      ? '与仓库有差异'
      : candidate.componentConflict?.length
        ? '存在多版本'
        : candidate.resource.kind === 'mcp'
          ? differences.length === 1
            ? `${differences[0]}不同`
            : '配置不同'
          : '存在多版本'
    const reason = candidate.conflictWithRepository
      ? `中央仓库已有同名资源，但内容不同。${differenceText}勾选并导入将覆盖中央仓库版本。`
      : candidate.componentConflict?.length
        ? `同时检测到与 ${candidate.componentConflict.join('、')} 内容不同的同名组件。勾选即可保留此版本导入中央仓库。`
        : `与${source ? ` ${source} 的` : '对照'}版本不同。${differenceText}勾选即可改用此版本导入。`

    return (
      <div className="flex flex-wrap gap-1">
        {inRepository && (
          <Tooltip
            trigger={['hover', 'focus']}
            title="中央仓库已有相同版本，无需重复导入"
          >
            <Tag
              icon={<CheckCircleOutlined />}
              color="success"
              variant="filled"
              tabIndex={0}
            >
              已在仓库
            </Tag>
          </Tooltip>
        )}
        {candidate.localChange && (
          <Tooltip
            trigger={['hover', 'focus']}
            title={
              candidate.localChange === 'added'
                ? '较上次本机检查新增的资源'
                : '较上次本机检查本地内容有变化'
            }
          >
            <Tag
              variant="filled"
              color={candidate.localChange === 'added' ? 'blue' : 'cyan'}
              tabIndex={0}
            >
              {candidate.localChange === 'added' ? '新增' : '修改'}
            </Tag>
          </Tooltip>
        )}
        {candidate.builtin && (
          <Tooltip
            trigger={['hover', 'focus']}
            title="平台自带的内置资源，默认不自动勾选，可按需手动导入"
          >
            <Tag color="blue" tabIndex={0}>
              内置
            </Tag>
          </Tooltip>
        )}
        {conflict && (
          <Tooltip trigger={['hover', 'focus']} title={reason}>
            <Tag
              variant="filled"
              color={candidate.conflictWithRepository ? 'orange' : 'gold'}
              tabIndex={0}
            >
              {summary}
            </Tag>
          </Tooltip>
        )}
        {duplicate && (
          <Tooltip
            trigger={['hover', 'focus']}
            title={
              source
                ? `与 ${source} 的版本内容一致，无需重复勾选。`
                : '内容相同，无需重复勾选。'
            }
          >
            <Tag color="cyan" tabIndex={0}>
              同内容重复
            </Tag>
          </Tooltip>
        )}
      </div>
    )
  }

  const allBulk = tabSelections(visibleCandidates, scan.candidates, chosen)
  const selectedRowKeys = visibleCandidates
    .filter((item) => !isInRepository(item) && selected.has(item.id))
    .map(({ id }) => id)

  const columns: TableProps<FlatImportRow>['columns'] = [
    {
      title: '资源',
      render: (_, row) => {
        if (row.type === 'removed') {
          return (
            <div className="min-w-0 wrap-anywhere">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{row.item.name}</span>
                {!targetId && (
                  <Tag variant="filled" className="text-xs">
                    {names.get(row.item.targetId) ?? row.item.targetId}
                  </Tag>
                )}
              </div>
            </div>
          )
        }
        const name =
          row.type === 'candidate'
            ? row.item.resource.name
            : (row.item.name ?? row.item.reason)
        const description = row.item.description
        const platformName = names.get(row.item.targetId) ?? row.item.targetId
        return (
          <div className="min-w-0 wrap-anywhere">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-medium">{name}</span>
              {!targetId && (
                <Tag variant="filled" className="text-xs m-0!">
                  {platformName}
                </Tag>
              )}
            </div>
            {description && (
              <div
                className="text-xs text-muted mt-0.5 line-clamp-2"
                title={description}
              >
                {description}
              </div>
            )}
          </div>
        )
      },
    },
    {
      title: '状态',
      width: 210,
      render: (_, row) => {
        if (row.type === 'candidate') return statusFor(row.item)
        if (row.type === 'removed') return <Tag>已移除</Tag>
        if (row.item.builtin) {
          return (
            <div className="flex flex-wrap gap-1">
              <Tooltip
                trigger={['hover', 'focus']}
                title="平台自带的内置资源，由平台维护且只读"
              >
                <Tag color="blue" tabIndex={0}>
                  内置
                </Tag>
              </Tooltip>
              <Tooltip
                trigger={['hover', 'focus']}
                title={`平台内置插件（只读，无需手动修改）：${row.item.reason}`}
              >
                <Tag variant="filled" color="default" tabIndex={0}>
                  格式不兼容
                </Tag>
              </Tooltip>
            </div>
          )
        }
        return (
          <Tooltip trigger={['hover', 'focus']} title={row.item.reason}>
            <Tag color="warning" tabIndex={0}>
              需处理
            </Tag>
          </Tooltip>
        )
      },
    },
    ...(kind === 'skill' || kind === 'plugin'
      ? [
          {
            title: '版本',
            width: 136,
            render: (_: unknown, row: FlatImportRow) => {
              const version =
                row.type === 'candidate' ? row.item.version : undefined
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
            width: 132,
            render: (_: unknown, row: FlatImportRow) => {
              const author =
                row.type === 'candidate' ? row.item.author : undefined
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
    ...(kind === 'skill'
      ? [
          {
            title: '更新时间',
            width: 148,
            render: (_: unknown, row: FlatImportRow) =>
              row.type === 'candidate' ? (
                <span className="text-xs text-muted whitespace-nowrap">
                  {formatUpdatedAt(row.item.updatedAt)}
                </span>
              ) : null,
          },
        ]
      : []),
    {
      title: '操作',
      width: 96,
      align: 'right',
      render: (_, row) => {
        if (row.type === 'removed') {
          const { key, targetId: itemTargetId, kind: itemKind } = row.item
          return (
            key && (
              <Button
                type="link"
                size="small"
                disabled={disabled}
                onClick={() =>
                  onRestore({
                    targetId: itemTargetId,
                    kinds: [itemKind],
                    keys: [key],
                  })
                }
              >
                恢复
              </Button>
            )
          )
        }
        if (
          row.type === 'candidate' ||
          (row.type === 'issue' && row.item.editable)
        )
          return (
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              disabled={disabled}
              onClick={() => onOpen(row.item.id, kind)}
            >
              审阅
            </Button>
          )
        return null
      },
    },
  ]

  return (
    <Table<FlatImportRow>
      className="min-w-0"
      size="middle"
      loading={loading}
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{
        x: kind === 'skill' ? 950 : kind === 'plugin' ? 810 : 540,
        y: 'clamp(240px, calc(100vh - 355px), 640px)',
      }}
      rowClassName={(row) => {
        if (row.key === active) return 'import-row-active'
        if (row.type === 'candidate') {
          if (isInRepository(row.item)) return 'import-row-in-repo'
          if (row.item.conflictWithRepository) return 'import-row-conflict'
        }
        return ''
      }}
      rowSelection={{
        columnWidth: 48,
        selectedRowKeys,
        columnTitle: (
          <Tooltip title="全选当前列表可安全导入的资源（不含已在仓库、冲突项及内置资源）">
            <Checkbox
              aria-label="全选当前列表可导入的资源"
              disabled={disabled || !allBulk.canToggle}
              checked={allBulk.complete}
              indeterminate={allBulk.selected > 0 && !allBulk.complete}
              onChange={() => setChosen(allBulk.next)}
            />
          </Tooltip>
        ),
        getCheckboxProps: (row) => {
          if (row.type !== 'candidate') return { disabled: true }
          const inRepo = isInRepository(row.item)
          return {
            disabled: disabled || inRepo,
            'aria-label': `选择 ${row.item.resource.name}`,
          }
        },
        renderCell: (_checked, row, _index, originNode) => {
          if (row.type !== 'candidate') return null
          if (isInRepository(row.item)) {
            return (
              <Tooltip title="中央仓库已有相同版本，无需重复导入">
                <span>{originNode}</span>
              </Tooltip>
            )
          }
          return originNode
        },
        onSelect: (row, checked) => {
          if (row.type !== 'candidate' || isInRepository(row.item)) return
          setChosen(
            toggleLocalSelection(row.item, scan.candidates, chosen, checked),
          )
        },
        onSelectMultiple: (checked, _selectedRows, changeableRows) => {
          let next = chosen
          for (const row of changeableRows) {
            if (row.type !== 'candidate' || isInRepository(row.item)) continue
            next = toggleLocalSelection(
              row.item,
              scan.candidates,
              next,
              checked,
            )
          }
          setChosen(next)
        },
      }}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            className="py-10"
            description={
              !scan.targets.length
                ? '未检测到已安装的 Agent'
                : hiddenDuplicateCount > 0
                  ? `当前视图隐藏了 ${hiddenDuplicateCount} 项与其他平台内容一致的重复资源`
                  : '当前筛选条件下暂无资源'
            }
          >
            {hiddenDuplicateCount > 0 && (
              <Button size="small" onClick={onShowDuplicates}>
                显示 {hiddenDuplicateCount} 项重复资源
              </Button>
            )}
          </Empty>
        ),
      }}
    />
  )
}
