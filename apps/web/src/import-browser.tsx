import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  ComparedCandidate,
  ResourceKind,
  Scan,
  Selection,
  Target,
} from '@agentweave/protocol'
import { App, Button, Empty, Input, Skeleton, Tabs, Tag, Tooltip } from 'antd'
import { DownOutlined, RightOutlined } from '@ant-design/icons'
import { errorMessage, request } from './api'
import { KindIcon, resourceKinds } from './shared'
import { PluginFileTree } from './plugin-file-tree'
import {
  canCollapseCandidate,
  matchesImportFilter,
  type ImportFilter,
  candidateLabels,
  resourcesMatch,
  toggleLocalSelection,
} from './import-selection'

type Source = {
  name: string
  content: string
  revision: string
  readOnly?: boolean
  binary?: boolean
}

export function ImportBrowser({
  scan,
  targets,
  chosen,
  setChosen,
  onScan,
  onDirtyChange,
  filter,
}: {
  scan: Scan
  filter: ImportFilter
  targets: Target[]
  chosen: Selection[]
  setChosen: (value: Selection[]) => void
  onScan: (scan: Scan) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const { message } = App.useApp()
  const [active, setActive] = useState('')
  const [source, setSource] = useState<Source | null>(null)
  const [pluginFiles, setPluginFiles] = useState<string[] | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filters, setFilters] = useState<
    Partial<Record<ResourceKind, { conflict: boolean; duplicate: boolean }>>
  >({})
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  )
  const requestNumber = useRef(0)
  const dirtyRef = useRef(false)
  const dirty = source !== null && draft !== source.content

  const open = useCallback(
    async (id: string, kind: ResourceKind) => {
      if (
        dirtyRef.current &&
        !window.confirm('当前修改尚未保存，确定放弃修改吗？')
      )
        return
      const number = ++requestNumber.current
      setActive(id)
      dirtyRef.current = false
      onDirtyChange(false)
      setSource(null)
      setPluginFiles(null)
      setActivePath(null)
      setReading(true)
      try {
        if (kind === 'plugin') {
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
    [message, onDirtyChange],
  )

  async function openPluginFile(path: string) {
    if (saving || path === activePath) return
    if (
      dirtyRef.current &&
      !window.confirm('当前修改尚未保存，确定放弃修改吗？')
    )
      return
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

  const toggle = useCallback(
    (candidate: ComparedCandidate, checked: boolean) => {
      setChosen(
        toggleLocalSelection(candidate, scan.candidates, chosen, checked),
      )
    },
    [chosen, scan.candidates, setChosen],
  )

  async function save() {
    if (!source) return
    setSaving(true)
    try {
      const next = await request('save-scan-source', {
        id: active,
        ...(pluginFiles && activePath && { path: activePath }),
        revision: source.revision,
        content: draft,
      })
      const updated = next.candidates.find(
        (candidate) => candidate.id === next.updatedId,
      )
      const selection = chosen.find(({ id }) => id === active)
      const remaining = chosen.filter(({ id }) =>
        next.candidates.some((candidate) => candidate.id === id),
      )
      if (
        selection &&
        updated &&
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
      message.success('文件已保存，并已重新扫描校验')
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const items = useMemo(() => {
    const names = new Map(targets.map(({ id, name }) => [id, name]))
    const selected = new Set(chosen.map(({ id }) => id))
    const labels = new Map(
      scan.candidates.map((candidate) => [
        candidate.id,
        candidateLabels(candidate, scan.candidates, chosen),
      ]),
    )
    const items = Object.entries(resourceKinds).flatMap(([kind, info]) => {
      const resourceKind = kind as ResourceKind
      const currentFilters = filters[resourceKind] ?? {
        conflict: false,
        duplicate: true,
      }
      const candidates = scan.candidates.filter(
        (item) =>
          item.resource.kind === kind && matchesImportFilter(item, filter),
      )
      const issues = scan.issues.filter(
        (item) => filter === 'all' && item.kind === kind,
      )
      if (!candidates.length && !issues.length) return []
      const conflictCount = candidates.filter(
        (item) => !selected.has(item.id) && labels.get(item.id)?.conflict,
      ).length
      const duplicateCount = candidates.filter(
        (item) => !selected.has(item.id) && labels.get(item.id)?.duplicate,
      ).length
      const collapsible = new Set(
        candidates
          .filter((candidate) =>
            canCollapseCandidate(
              labels.get(candidate.id)!,
              selected.has(candidate.id),
              currentFilters,
            ),
          )
          .map(({ id }) => id),
      )
      function toggleFilter(key: 'conflict' | 'duplicate') {
        setFilters((previous) => ({
          ...previous,
          [resourceKind]: { ...currentFilters, [key]: !currentFilters[key] },
        }))
        setExpandedGroups(
          (previous) =>
            new Set(
              [...previous].filter((value) => !value.startsWith(`${kind}:`)),
            ),
        )
      }
      const targetIds = [
        ...new Set([...candidates, ...issues].map((item) => item.targetId)),
      ]
      return [
        {
          key: kind,
          label: `${info.label} (${candidates.length + issues.filter((issue) => issue.name).length})`,
          children: (
            <>
              <div className="import-filter-toolbar">
                <span>筛选未勾选项</span>
                <Button
                  size="small"
                  aria-pressed={currentFilters.conflict}
                  disabled={!currentFilters.conflict && !conflictCount}
                  onClick={() => toggleFilter('conflict')}
                >
                  {currentFilters.conflict ? '展开' : '收起'}冲突（
                  {conflictCount}）
                </Button>
                <Button
                  size="small"
                  aria-pressed={currentFilters.duplicate}
                  disabled={!currentFilters.duplicate && !duplicateCount}
                  onClick={() => toggleFilter('duplicate')}
                >
                  {currentFilters.duplicate ? '展开' : '收起'}重复（
                  {duplicateCount}）
                </Button>
              </div>
              <div className="import-groups">
                {targetIds.map((targetId) => {
                  const groupKey = `${kind}:${targetId}`
                  const expanded = expandedGroups.has(groupKey)
                  const hiddenCount = candidates.filter(
                    (item) =>
                      item.targetId === targetId && collapsible.has(item.id),
                  ).length
                  return (
                    <section key={targetId}>
                      <h3 className="import-group-title">
                        {names.get(targetId) ?? targetId}
                        {issues
                          .filter(
                            (issue) =>
                              issue.targetId === targetId && !issue.name,
                          )
                          .map((issue) => (
                            <Tooltip key={issue.id} title={issue.reason}>
                              <Tag color="warning" tabIndex={0}>
                                需留意
                              </Tag>
                            </Tooltip>
                          ))}
                      </h3>
                      {!candidates.some((item) => item.targetId === targetId) &&
                        !issues.some(
                          (item) => item.targetId === targetId && item.name,
                        ) && (
                          <p className="import-group-empty">未发现可导入项</p>
                        )}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          className="import-group-disclosure"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedGroups((previous) => {
                              const next = new Set(previous)
                              if (next.has(groupKey)) next.delete(groupKey)
                              else next.add(groupKey)
                              return next
                            })
                          }
                        >
                          {expanded ? <DownOutlined /> : <RightOutlined />}
                          {expanded ? '收起' : '展开'} {hiddenCount} 项
                        </button>
                      )}
                      {candidates
                        .filter(
                          (item) =>
                            item.targetId === targetId &&
                            (expanded || !collapsible.has(item.id)),
                        )
                        .map((candidate) => (
                          <div
                            className={`import-row ${active === candidate.id ? 'import-row-active' : ''}`}
                            key={candidate.id}
                          >
                            <input
                              aria-label={`选择 ${candidate.resource.name}`}
                              type="checkbox"
                              disabled={saving}
                              checked={chosen.some(
                                ({ id }) => id === candidate.id,
                              )}
                              onChange={(event) =>
                                toggle(candidate, event.target.checked)
                              }
                            />
                            <KindIcon kind={candidate.resource.kind} />
                            <button
                              type="button"
                              className="import-row-name"
                              disabled={saving}
                              onClick={() =>
                                open(candidate.id, candidate.resource.kind)
                              }
                            >
                              <span className="import-item-name">
                                {candidate.resource.name}
                              </span>
                              {candidate.description && (
                                <span
                                  className="import-item-description"
                                  title={candidate.description}
                                >
                                  {candidate.description}
                                </span>
                              )}
                              {candidate.resource.kind === 'plugin' &&
                                !!candidate.componentConflict?.length && (
                                  <span className="text-sm text-amber-800 wrap-anywhere">
                                    组件版本不同：
                                    {candidate.componentConflict.join('、')}
                                  </span>
                                )}
                            </button>
                            {candidate.builtin && (
                              <Tooltip title="平台随附的插件，默认不勾选。">
                                <Tag color="blue" tabIndex={0}>
                                  内置
                                </Tag>
                              </Tooltip>
                            )}
                            {labels.get(candidate.id)?.conflict && (
                              <Tooltip
                                title={
                                  candidate.conflictWithRepository
                                    ? '与中央仓库中的版本不同。勾选并导入将替换中央版本。'
                                    : candidate.componentConflict?.length
                                      ? `与 ${candidate.componentConflict.join('、')} 含有不同版本的同名组件，请选择要保留的版本。`
                                      : `同名资源内容不同，来源：${[...new Set(scan.candidates.filter((c) => resourcesMatch(c.resource, candidate.resource)).map((c) => names.get(c.targetId) ?? c.targetId))].join('、')}。请选择要保留的版本。`
                                }
                              >
                                <Tag color="orange" tabIndex={0}>
                                  冲突
                                </Tag>
                              </Tooltip>
                            )}
                            {labels.get(candidate.id)?.duplicate && (
                              <Tooltip title="与同名资源内容相同，可合并来源">
                                <Tag color="green" tabIndex={0}>
                                  重复
                                </Tag>
                              </Tooltip>
                            )}
                          </div>
                        ))}
                      {issues
                        .filter(
                          (item) => item.targetId === targetId && item.name,
                        )
                        .map((issue) => (
                          <div
                            className={`import-row ${active === issue.id ? 'import-row-active' : ''}`}
                            key={issue.id}
                          >
                            <KindIcon kind={issue.kind} />
                            {issue.editable ? (
                              <button
                                type="button"
                                className="import-row-name"
                                disabled={saving}
                                onClick={() => open(issue.id, issue.kind)}
                              >
                                <span className="import-item-name">
                                  {issue.name}
                                </span>
                                {issue.description && (
                                  <span
                                    className="import-item-description"
                                    title={issue.description}
                                  >
                                    {issue.description}
                                  </span>
                                )}
                              </button>
                            ) : (
                              <span className="import-row-name">
                                <span className="import-item-name">
                                  {issue.name}
                                </span>
                                {issue.description && (
                                  <span
                                    className="import-item-description"
                                    title={issue.description}
                                  >
                                    {issue.description}
                                  </span>
                                )}
                              </span>
                            )}
                            {issue.builtin && <Tag color="blue">内置</Tag>}
                            <Tooltip title={issue.reason}>
                              <Tag color="warning" tabIndex={0}>
                                需处理
                              </Tag>
                            </Tooltip>
                          </div>
                        ))}
                    </section>
                  )
                })}
              </div>
            </>
          ),
        },
      ]
    })
    return items
  }, [
    scan,
    targets,
    chosen,
    active,
    saving,
    open,
    toggle,
    filters,
    expandedGroups,
    filter,
  ])

  return (
    <div className="import-browser">
      <div className="import-browser-list">
        {items.length ? (
          <Tabs items={items} />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="没有发现可导入的资源"
          />
        )}
      </div>
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
                <strong>{source.name}</strong>
                <Button
                  type="primary"
                  size="small"
                  disabled={!dirty || source.binary || source.readOnly}
                  loading={saving}
                  onClick={save}
                >
                  保存并校验
                </Button>
              </div>
              <p className="text-muted text-sm">
                {source.readOnly
                  ? '平台维护的内置插件，原文件只供查看。'
                  : '修改将直接保存到 Agent 的原始文件。'}
              </p>
              {source.binary ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="二进制文件无法以文本查看或编辑"
                />
              ) : (
                <Input.TextArea
                  aria-label={`编辑 ${source.name}`}
                  className="editor-text import-editor-text"
                  value={draft}
                  readOnly={source.readOnly}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    dirtyRef.current = event.target.value !== source.content
                    onDirtyChange(dirtyRef.current)
                  }}
                  disabled={saving}
                />
              )}
            </>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                pluginFiles
                  ? '选择文件查看和编辑内容'
                  : '选择资源查看和编辑内容'
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
