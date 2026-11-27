import { useCallback, useRef, useState } from 'react'
import type { ResourceKind, Scan, Scope, Selection } from '@agentweave/protocol'
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Segmented,
  Skeleton,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  DesktopOutlined,
  LeftOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { errorMessage, request } from './api'
import { kindOptions, resourceKinds, useConfirmDiscard } from './shared-helpers'
import { PluginFileTree } from './plugin-file-tree'
import {
  buildFlatImportRows,
  candidateLabels,
  fixSkillNameFrontmatter,
  isCollapsibleDuplicate,
  isInRepository,
  type ImportFilter,
  toggleLocalSelection,
} from './import-selection'
import { LocalImportList } from './local-import-list'

type Source = {
  name: string
  content: string
  revision: string
  readOnly?: boolean
  binary?: boolean
}

export function ImportBrowser({
  scan,
  loading,
  kind,
  onKindChange,
  importing,
  chosen,
  setChosen,
  onImport,
  onScan,
  onDirtyChange,
  onRestore,
}: {
  scan: Scan
  loading: boolean
  kind: ResourceKind
  onKindChange: (kind: ResourceKind) => void
  importing: boolean
  chosen: Selection[]
  setChosen: (value: Selection[]) => void
  onImport: (kind: ResourceKind, selections: Selection[]) => void
  onScan: (scan: Scan) => void
  onDirtyChange: (dirty: boolean) => void
  onRestore: (scope: Scope) => void
}) {
  const { message } = App.useApp()
  const totalCounts = new Map<ResourceKind, number>()
  for (const { resource } of scan.candidates)
    totalCounts.set(resource.kind, (totalCounts.get(resource.kind) ?? 0) + 1)
  for (const { kind: itemKind } of scan.issues)
    totalCounts.set(itemKind, (totalCounts.get(itemKind) ?? 0) + 1)
  for (const { kind: itemKind } of scan.localChanges.removed)
    totalCounts.set(itemKind, (totalCounts.get(itemKind) ?? 0) + 1)

  const [selectedTarget, setSelectedTarget] = useState<string | null>(null)
  const [filter, setFilter] = useState<ImportFilter>('all')
  const [query, setQuery] = useState('')
  const [hideDuplicates, setHideDuplicates] = useState(true)

  const [active, setActive] = useState('')
  const [source, setSource] = useState<Source | null>(null)
  const [pluginFiles, setPluginFiles] = useState<string[] | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const confirmDiscard = useConfirmDiscard()
  const requestNumber = useRef(0)
  const dirtyRef = useRef(false)
  const dirty = source !== null && draft !== source.content

  const selectedSet = new Set(chosen.map(({ id }) => id))
  const candidateById = new Map(scan.candidates.map((item) => [item.id, item]))
  const issueById = new Map(scan.issues.map((item) => [item.id, item]))
  const targetNames = new Map(scan.targets.map(({ id, name }) => [id, name]))

  const kindCandidates = scan.candidates.filter(
    ({ resource }) => resource.kind === kind,
  )
  const kindIssues = scan.issues.filter((item) => item.kind === kind)
  const kindRemoved = scan.localChanges.removed.filter(
    (item) => item.kind === kind,
  )

  const platforms = scan.targets.map((target) => {
    const entries = kindCandidates.filter(
      ({ targetId }) => targetId === target.id,
    )
    const issuesCount = kindIssues.filter(
      ({ targetId }) => targetId === target.id,
    ).length
    const removedCount = kindRemoved.filter(
      ({ targetId }) => targetId === target.id,
    ).length
    const inRepoCount = entries.filter(isInRepository).length
    const importableCount = entries.length - inRepoCount
    const selectedCount = entries.filter(
      (item) => !isInRepository(item) && selectedSet.has(item.id),
    ).length
    const total = entries.length + issuesCount + removedCount
    return {
      ...target,
      total,
      inRepoCount,
      importableCount,
      selectedCount,
    }
  })

  const activeTargetId =
    selectedTarget === '__all__'
      ? null
      : selectedTarget && platforms.some(({ id }) => id === selectedTarget)
        ? selectedTarget
        : ((platforms.find(({ total }) => total > 0) ?? platforms[0])?.id ??
          null)

  const scopedCandidates = kindCandidates.filter(
    ({ targetId }) => !activeTargetId || targetId === activeTargetId,
  )
  const scopedIssues = kindIssues.filter(
    ({ targetId }) => !activeTargetId || targetId === activeTargetId,
  )
  const scopedRemoved = kindRemoved.filter(
    ({ targetId }) => !activeTargetId || targetId === activeTargetId,
  )
  const totalDuplicatesInScope = scopedCandidates.filter((item) =>
    isCollapsibleDuplicate(candidateLabels(item, scan.candidates, chosen)),
  ).length

  const { rows, visibleCandidates, labels, hiddenDuplicateCount } =
    buildFlatImportRows({
      scan,
      kind,
      targetId: activeTargetId,
      filter,
      query,
      hideDuplicates,
      chosen,
    })

  const reviewableIds = rows
    .filter(
      (row) =>
        row.type === 'candidate' || (row.type === 'issue' && row.item.editable),
    )
    .map((row) => row.key)
  const activeReviewIndex = active ? reviewableIds.indexOf(active) : -1

  function closePreview() {
    requestNumber.current++
    dirtyRef.current = false
    onDirtyChange(false)
    setActive('')
    setSource(null)
    setPluginFiles(null)
    setActivePath(null)
    setReading(false)
  }

  async function switchKind(next: ResourceKind) {
    if (next === kind) return
    if (dirtyRef.current && !(await confirmDiscard())) return
    closePreview()
    onKindChange(next)
    setFilter('all')
    setQuery('')
  }

  async function selectPlatform(next: string) {
    if (dirtyRef.current && !(await confirmDiscard())) return
    closePreview()
    setSelectedTarget(next)
    setFilter('all')
  }

  const open = useCallback(
    async (id: string, targetKind: ResourceKind) => {
      if (id !== active && dirtyRef.current && !(await confirmDiscard())) return
      const number = ++requestNumber.current
      setActive(id)
      dirtyRef.current = false
      onDirtyChange(false)
      setSource(null)
      setPluginFiles(null)
      setActivePath(null)
      setReading(true)
      try {
        if (targetKind === 'plugin') {
          const result = await request('list-scan-files', { id })
          if (number === requestNumber.current) setPluginFiles(result.files)
          return
        }
        const result = await request('read-scan-source', { id })
        if (number !== requestNumber.current) return
        setSource(result)
        setDraft(result.content)
      } catch (error) {
        if (number === requestNumber.current) message.error(errorMessage(error))
      } finally {
        if (number === requestNumber.current) setReading(false)
      }
    },
    [active, message, onDirtyChange, confirmDiscard],
  )

  async function openPluginFile(path: string) {
    if (saving || importing || path === activePath) return
    if (dirtyRef.current && !(await confirmDiscard())) return
    const number = ++requestNumber.current
    dirtyRef.current = false
    onDirtyChange(false)
    setActivePath(path)
    setSource(null)
    setReading(true)
    try {
      const result = await request('read-scan-source', { id: active, path })
      if (number !== requestNumber.current) return
      setSource(result)
      setDraft(result.content)
    } catch (error) {
      if (number === requestNumber.current) message.error(errorMessage(error))
    } finally {
      if (number === requestNumber.current) setReading(false)
    }
  }

  async function save(contentToSave = draft, successText?: string) {
    if (!source) return
    setSaving(true)
    try {
      const next = await request('save-scan-source', {
        id: active,
        ...(pluginFiles && activePath && { path: activePath }),
        revision: source.revision,
        content: contentToSave,
      })
      const updated = next.candidates.find(
        (candidate) => candidate.id === next.updatedId,
      )
      const selection = chosen.find(({ id }) => id === active)
      const remaining = chosen.filter(({ id }) =>
        next.candidates.some(
          (candidate) => candidate.id === id && !isInRepository(candidate),
        ),
      )
      if (
        selection &&
        updated &&
        !isInRepository(updated) &&
        !remaining.some(({ id }) => id === updated.id) &&
        (!updated.conflictWithRepository || selection.replace)
      )
        setChosen(
          toggleLocalSelection(updated, next.candidates, remaining, true),
        )
      else setChosen(remaining)
      onScan(next)
      setActive(pluginFiles && updated ? updated.id : '')
      setSource(null)
      setPluginFiles(
        pluginFiles && updated
          ? Object.keys(updated.resource.files ?? {}).sort()
          : null,
      )
      setActivePath(null)
      dirtyRef.current = false
      onDirtyChange(false)
      message.success(successText ?? '已保存原文件并重新扫描')
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const kindChosen = chosen.filter(({ id }) => {
    const candidate = candidateById.get(id)
    return (
      candidate &&
      candidate.resource.kind === kind &&
      !isInRepository(candidate)
    )
  })
  const kindLabel = resourceKinds[kind].label

  const importableCount = scopedCandidates.filter(
    (item) => !isInRepository(item),
  ).length
  const inRepoCount = scopedCandidates.length - importableCount
  const addedCount = scopedCandidates.filter(
    ({ localChange }) => localChange === 'added',
  ).length
  const updatedCount = scopedCandidates.filter(
    ({ localChange }) => localChange === 'updated',
  ).length

  const actionableIssuesCount = scopedIssues.filter(
    (item) => !item.builtin,
  ).length
  const filterOptions: { label: string; value: ImportFilter }[] = [
    { label: '全部', value: 'all' },
    { label: `可导入 ${importableCount}`, value: 'importable' },
    { label: `已在仓库 ${inRepoCount}`, value: 'inRepo' },
    ...(addedCount > 0
      ? [{ label: `新增 ${addedCount}`, value: 'added' as const }]
      : []),
    ...(updatedCount > 0
      ? [{ label: `修改 ${updatedCount}`, value: 'updated' as const }]
      : []),
    ...(scopedRemoved.length > 0
      ? [{ label: `已移除 ${scopedRemoved.length}`, value: 'removed' as const }]
      : []),
    ...(actionableIssuesCount > 0
      ? [{ label: `需处理 ${actionableIssuesCount}`, value: 'issues' as const }]
      : []),
  ]
  const effectiveFilter = filterOptions.some(({ value }) => value === filter)
    ? filter
    : 'all'

  const activeCandidate = active ? candidateById.get(active) : undefined
  const activeIssue = active ? issueById.get(active) : undefined
  const activeTitle =
    activeCandidate?.resource.name ??
    activeIssue?.name ??
    source?.name ??
    '原文件审阅'
  const activePlatformName = activeCandidate
    ? (targetNames.get(activeCandidate.targetId) ?? activeCandidate.targetId)
    : activeIssue
      ? (targetNames.get(activeIssue.targetId) ?? activeIssue.targetId)
      : ''

  const skillNameFix =
    activeIssue &&
    source &&
    !source.readOnly &&
    !source.binary &&
    /(^|\/)SKILL\.md$/i.test(activePath ?? source.name)
      ? fixSkillNameFrontmatter(draft, activeIssue.reason)
      : null

  const busy = loading || saving || importing

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Tabs
        activeKey={kind}
        className="shrink-0"
        onChange={(key) => {
          const option = kindOptions.find(({ value }) => value === key)
          if (option) void switchKind(option.value)
        }}
        tabBarExtraContent={
          <Tooltip
            title={dirty ? '请先保存或放弃原文件修改后再导入' : undefined}
          >
            <span>
              <Button
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={importing}
                disabled={!kindChosen.length || loading || saving || dirty}
                onClick={() => onImport(kind, kindChosen)}
              >
                导入 {kindLabel}
                {kindChosen.length ? `（${kindChosen.length}）` : ''}
              </Button>
            </span>
          </Tooltip>
        }
        items={kindOptions.map(({ value, label }) => ({
          key: value,
          label: (
            <span className="inline-flex items-center gap-2">
              {label}
              <span className="text-xs text-muted">
                {totalCounts.get(value) ?? 0}
              </span>
            </span>
          ),
          disabled: value !== kind && busy,
        }))}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[224px_minmax(0,1fr)] gap-4 flex-1 min-h-0 items-stretch">
        <Card
          size="small"
          title="本机平台"
          extra={
            <Typography.Text type="secondary" className="text-xs">
              {platforms.length} 个
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
          className="min-w-0 flex flex-col h-auto lg:h-[calc(100vh-236px)] lg:min-h-[380px] lg:max-h-[760px]"
        >
          {platforms.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={loading ? '扫描中…' : '暂无资源'}
              className="my-4"
            />
          ) : (
            <div className="flex flex-col gap-1">
              {platforms.length > 1 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void selectPlatform('__all__')}
                  className={`flex items-center justify-between gap-2 w-full px-3 py-2 rounded-md border-0 text-left cursor-pointer transition-colors ${
                    activeTargetId === null
                      ? 'bg-[var(--ant-color-primary-bg)] text-[var(--ant-color-primary)] font-medium'
                      : 'bg-transparent text-[var(--ant-color-text)] hover:bg-[var(--ant-color-fill-tertiary)]'
                  }`}
                >
                  <span className="truncate">全部平台</span>
                  <span className="text-xs text-muted shrink-0">
                    {kindChosen.length > 0
                      ? `已选 ${kindChosen.length}`
                      : `${kindCandidates.length}`}
                  </span>
                </button>
              )}
              {platforms.map((platform) => {
                const isSelected = activeTargetId === platform.id
                return (
                  <button
                    key={platform.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void selectPlatform(platform.id)}
                    className={`flex items-center justify-between gap-2 w-full px-3 py-2 rounded-md border-0 text-left cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[var(--ant-color-primary-bg)] text-[var(--ant-color-primary)] font-medium'
                        : 'bg-transparent text-[var(--ant-color-text)] hover:bg-[var(--ant-color-fill-tertiary)]'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <DesktopOutlined className="shrink-0 opacity-70" />
                      <span className="truncate">{platform.name}</span>
                    </span>
                    <span className="text-xs shrink-0">
                      {platform.total ===
                      0 ? null : platform.importableCount === 0 &&
                        platform.inRepoCount > 0 ? (
                        <span className="text-[var(--ant-color-success)]">
                          <CheckCircleOutlined /> {platform.inRepoCount}
                        </span>
                      ) : platform.selectedCount > 0 ? (
                        <span className="text-[var(--ant-color-primary)]">
                          {platform.selectedCount}/{platform.importableCount}
                        </span>
                      ) : (
                        <span className="text-muted">
                          {platform.importableCount}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </Card>

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
                placeholder="搜索名称或描述"
                aria-label="搜索资源名称或描述"
                className="w-52 max-w-full"
                allowClear
                value={query}
                disabled={loading}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Segmented
                aria-label={`按状态筛选 ${kindLabel}`}
                options={filterOptions}
                value={effectiveFilter}
                disabled={busy}
                onChange={(value) => setFilter(value)}
              />
            </div>
            {totalDuplicatesInScope > 0 && (
              <label className="inline-flex items-center gap-2 text-xs text-muted cursor-pointer select-none">
                <Switch
                  size="small"
                  checked={hideDuplicates}
                  disabled={busy}
                  onChange={setHideDuplicates}
                />
                隐藏同内容重复（{totalDuplicatesInScope}）
              </label>
            )}
          </div>
          <LocalImportList
            scan={scan}
            loading={loading}
            kind={kind}
            targetId={activeTargetId}
            rows={rows}
            visibleCandidates={visibleCandidates}
            labels={labels}
            hiddenDuplicateCount={hiddenDuplicateCount}
            onShowDuplicates={() => setHideDuplicates(false)}
            chosen={chosen}
            setChosen={setChosen}
            active={active}
            disabled={busy}
            onOpen={open}
            onRestore={onRestore}
          />
        </Card>
      </div>

      <Drawer
        open={Boolean(active)}
        width={680}
        destroyOnHidden={false}
        onClose={async () => {
          if (saving || importing) return
          if (!dirtyRef.current || (await confirmDiscard())) closePreview()
        }}
        title={
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="truncate">{activeTitle}</span>
            {activeCandidate?.version && (
              <Tag variant="filled" className="shrink-0 m-0!">
                {/^[vV]/.test(activeCandidate.version)
                  ? activeCandidate.version
                  : `v${activeCandidate.version}`}
              </Tag>
            )}
            {activeCandidate?.author && (
              <span className="text-xs font-normal text-muted shrink-0">
                by {activeCandidate.author}
              </span>
            )}
            {activePlatformName && (
              <Tag variant="filled" className="shrink-0 m-0!">
                {activePlatformName}
              </Tag>
            )}
          </div>
        }
        extra={
          <div className="flex items-center gap-2">
            {activeCandidate &&
              (isInRepository(activeCandidate) ? (
                <Tag
                  icon={<CheckCircleOutlined />}
                  color="success"
                  variant="filled"
                >
                  已在仓库
                </Tag>
              ) : (
                <Checkbox
                  checked={selectedSet.has(activeCandidate.id)}
                  disabled={busy}
                  onChange={(event) =>
                    setChosen(
                      toggleLocalSelection(
                        activeCandidate,
                        scan.candidates,
                        chosen,
                        event.target.checked,
                      ),
                    )
                  }
                >
                  勾选导入
                </Checkbox>
              ))}
            <Button
              size="small"
              icon={<LeftOutlined />}
              disabled={busy || activeReviewIndex <= 0}
              aria-label="上一条"
              onClick={() => {
                if (activeReviewIndex > 0)
                  void open(reviewableIds[activeReviewIndex - 1], kind)
              }}
            />
            <Button
              size="small"
              icon={<RightOutlined />}
              disabled={
                busy ||
                activeReviewIndex < 0 ||
                activeReviewIndex >= reviewableIds.length - 1
              }
              aria-label="下一条"
              onClick={() => {
                if (
                  activeReviewIndex >= 0 &&
                  activeReviewIndex < reviewableIds.length - 1
                )
                  void open(reviewableIds[activeReviewIndex + 1], kind)
              }}
            />
          </div>
        }
      >
        {activeIssue && (
          <Alert
            className="mb-3"
            showIcon
            type={activeIssue.builtin ? 'info' : 'warning'}
            title={
              activeIssue.builtin
                ? '平台内置插件（只读，无法在此修改）'
                : '校验未通过'
            }
            description={activeIssue.reason}
          />
        )}
        <div
          className={`import-detail ${pluginFiles ? 'import-detail-plugin' : ''}`}
        >
          {pluginFiles && (
            <aside className="plugin-files">
              <div className="plugin-files-title">插件文件</div>
              {pluginFiles.length ? (
                <PluginFileTree
                  files={pluginFiles}
                  selected={activePath}
                  onSelect={openPluginFile}
                />
              ) : (
                <p className="import-group-empty">没有可查看的文件</p>
              )}
            </aside>
          )}
          <div className="import-editor">
            {reading ? (
              <Skeleton active />
            ) : source ? (
              <>
                <div className="import-editor-heading">
                  <p className="m-0 text-muted text-sm">
                    {source.readOnly
                      ? '该资源由平台内置维护，此处仅支持只读查看。'
                      : '保存将直接修改该 Agent 本机的原文件并重新扫描。'}
                  </p>
                  {!source.readOnly && (
                    <div className="flex items-center gap-2 shrink-0">
                      {skillNameFix && (
                        <Tooltip
                          title={`将 name 修正为「${skillNameFix.name}」并保存重新校验`}
                        >
                          <Button
                            size="small"
                            disabled={importing || saving}
                            onClick={() => {
                              setDraft(skillNameFix.next)
                              dirtyRef.current = true
                              onDirtyChange(true)
                              void save(
                                skillNameFix.next,
                                `已将 name 修正为「${skillNameFix.name}」并重新扫描`,
                              )
                            }}
                          >
                            一键修复名称
                          </Button>
                        </Tooltip>
                      )}
                      <Button
                        type="primary"
                        size="small"
                        disabled={importing || !dirty || source.binary}
                        loading={saving}
                        onClick={() => void save()}
                      >
                        保存并校验
                      </Button>
                    </div>
                  )}
                </div>
                {source.binary ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="此文件为二进制格式，暂不支持预览"
                  />
                ) : (
                  <Input.TextArea
                    aria-label={`${source.readOnly ? '查看' : '编辑'} ${source.name}`}
                    className="editor-text import-editor-text"
                    value={draft}
                    readOnly={source.readOnly}
                    onChange={(event) => {
                      setDraft(event.target.value)
                      dirtyRef.current = event.target.value !== source.content
                      onDirtyChange(dirtyRef.current)
                    }}
                    disabled={saving || importing}
                  />
                )}
              </>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  pluginFiles
                    ? '请选择左侧插件文件进行查看'
                    : '暂无可预览的文件内容'
                }
              />
            )}
          </div>
        </div>
      </Drawer>
    </div>
  )
}
