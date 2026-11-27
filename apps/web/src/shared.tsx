import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ComparedCandidate,
  GithubPreview,
  Resource,
  ResourceKind,
  Selection,
  Target,
} from '@agentweave/protocol'
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Collapse,
  Form,
  Input,
  List,
  Modal,
  Tag,
  Typography,
} from 'antd'
import { GithubOutlined } from '@ant-design/icons'
import { decodeFile, errorMessage, request, resourceKey } from './api'
import { resourceKinds } from './shared-helpers'

export function KindIcon({ kind }: { kind: ResourceKind }) {
  const { icon: Icon, color, bg } = resourceKinds[kind] ?? resourceKinds.plugin
  return (
    <span
      className="grid place-items-center shrink-0 size-9 rounded-lg text-base"
      style={{ color, background: bg }}
      aria-hidden="true"
    >
      <Icon />
    </span>
  )
}

export function KindTag({ kind }: { kind: ResourceKind }) {
  return (
    <Tag variant="filled" color={resourceKinds[kind]?.tag}>
      {resourceKinds[kind]?.label ?? kind}
    </Tag>
  )
}

export function PageTitle({
  title,
  description,
  actions,
}: {
  title: string
  description: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap gap-4 justify-between items-start mb-4">
      <div>
        <Typography.Title level={3} className="m-0!">
          {title}
        </Typography.Title>
        <Typography.Text type="secondary" className="block mt-1">
          {description}
        </Typography.Text>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Warnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null
  return (
    <Alert
      showIcon
      type="warning"
      title="部分资源需要处理"
      description={
        <List
          size="small"
          split={false}
          dataSource={warnings}
          renderItem={(warning) => (
            <List.Item className="px-0! py-0.5!">{warning}</List.Item>
          )}
        />
      }
    />
  )
}

export function CandidateSelection({
  candidates,
  targets,
  chosen,
  setChosen,
}: {
  candidates: ComparedCandidate[]
  targets: Target[]
  chosen: Selection[]
  setChosen: (value: Selection[]) => void
}) {
  const decisions = new Map(
    chosen.map((selection) => [selection.id, selection]),
  )
  const names = new Map(targets.map(({ id, name }) => [id, name]))

  function toggle(candidate: ComparedCandidate, checked: boolean) {
    if (!checked) {
      setChosen(chosen.filter((selection) => selection.id !== candidate.id))
      return
    }
    // 同名冲突只提交一份，由用户明确选择。
    const key = resourceKey(candidate.resource)
    const siblings = candidates.filter(
      (item) => resourceKey(item.resource) === key,
    )
    const hasConflict = siblings.some((item) => item.status === 'conflict')
    const keep = chosen.filter(
      (selection) =>
        !hasConflict || !siblings.some(({ id }) => id === selection.id),
    )
    setChosen([
      ...keep,
      {
        id: candidate.id,
        ...(candidate.status === 'conflict' && { replace: true }),
      },
    ])
  }

  if (!candidates.length)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="没有发现可导入的资源"
      />
    )
  return (
    <div className="selection-list">
      {candidates.map((candidate) => (
        <div className="candidate-entry" key={candidate.id}>
          <Checkbox
            className="selection-row w-full"
            checked={decisions.has(candidate.id)}
            onChange={(event) => toggle(candidate, event.target.checked)}
          >
            <span className="flex items-center gap-3">
              <KindIcon kind={candidate.resource.kind} />
              <span className="flex-1 min-w-0">
                <strong className="break-all">{candidate.resource.name}</strong>
                <span className="block text-muted text-sm">
                  {names.get(candidate.targetId) ?? candidate.targetId}
                </span>
              </span>
              {candidate.status === 'conflict' && (
                <Tag color="orange">选择保留此版本</Tag>
              )}
              {candidate.status === 'same' && <Tag color="green">合并来源</Tag>}
            </span>
          </Checkbox>
          {candidate.status === 'conflict' && (
            <CandidateContent resource={candidate.resource} />
          )}
        </div>
      ))}
    </div>
  )
}

function CandidateContent({ resource }: { resource: Resource }) {
  const files = Object.keys(resource.files ?? {})
  const manifest = files.find((file) => /(^|\/)plugin\.json$/.test(file))
  const mainFile = files.includes('SKILL.md') ? 'SKILL.md' : manifest
  const content =
    resource.text ??
    (resource.config && JSON.stringify(resource.config, null, 2)) ??
    (mainFile && resource.files && decodeFile(resource.files[mainFile])) ??
    files.join('\n')

  return (
    <Collapse
      ghost
      size="small"
      className="candidate-content"
      items={[
        {
          key: 'content',
          label: `查看${mainFile ? ` ${mainFile}` : '内容'}`,
          children: (
            <Typography.Paragraph className="m-0! max-h-44 overflow-auto whitespace-pre-wrap font-mono text-xs wrap-anywhere">
              {content || '没有可显示的文本内容'}
            </Typography.Paragraph>
          ),
        },
      ]}
    />
  )
}

function suggestedSelections(candidates: ComparedCandidate[]): Selection[] {
  const conflicts = new Set(
    candidates
      .filter(({ status }) => status === 'conflict')
      .map(({ resource }) => resourceKey(resource)),
  )
  return candidates
    .filter(({ resource }) => !conflicts.has(resourceKey(resource)))
    .map(({ id }) => ({ id }))
}

export function AddGithubDialog({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const { message } = App.useApp()
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<GithubPreview | null>(null)
  const [chosen, setChosen] = useState<Selection[]>([])
  const [loading, setLoading] = useState(false)

  async function advance() {
    setLoading(true)
    try {
      if (!preview) {
        const result = await request('preview-github', { url: url.trim() })
        setPreview(result)
        setChosen(suggestedSelections(result.candidates))
        return
      }
      await request('add-github', {
        url: url.trim(),
        revision: preview.revision,
        selections: chosen,
      })
      onClose()
      message.success('已将 GitHub 资源导入中央仓库')
      await onDone()
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open
      onCancel={onClose}
      title="添加 GitHub 仓库"
      onOk={advance}
      okText={preview ? `导入 ${chosen.length} 项` : '预览资源'}
      cancelText="取消"
      width={610}
      confirmLoading={loading}
      closable={!loading}
      mask={{ closable: !loading }}
      keyboard={!loading}
      cancelButtonProps={{ disabled: loading }}
      okButtonProps={{ disabled: preview ? !chosen.length : !url.trim() }}
    >
      <Form layout="vertical" component="div">
        <Form.Item
          label={
            <span>
              <GithubOutlined /> GitHub 地址
            </span>
          }
          htmlFor="github-url"
          className="mb-4!"
        >
          <Input
            id="github-url"
            type="url"
            placeholder="https://github.com/组织/仓库"
            value={url}
            disabled={loading}
            onChange={(event) => {
              setUrl(event.target.value)
              setPreview(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !loading && url.trim() && !preview)
                advance()
            }}
          />
        </Form.Item>
      </Form>
      {preview && (
        <>
          <Warnings warnings={preview.warnings} />
          <CandidateSelection
            candidates={preview.candidates}
            targets={[]}
            chosen={chosen}
            setChosen={setChosen}
          />
        </>
      )}
    </Modal>
  )
}

export function PageFailure({
  title = '无法读取工作区',
  error,
  onRetry,
}: {
  title?: string
  error: string
  onRetry: () => void | Promise<void>
}) {
  return (
    <Alert
      showIcon
      type="error"
      title={title}
      description={error}
      action={<Button onClick={onRetry}>重试</Button>}
    />
  )
}
