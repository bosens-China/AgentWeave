import { useState } from 'react'
import { Alert, App, Button, Empty, Tag } from 'antd'
import { GithubOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons'
import type {
  GithubSource,
  GithubStatus,
  GithubUpdatePreview,
} from '@agentweave/protocol'
import { errorMessage, request } from './api'
import { PageTitle } from './shared'

const statusTags = {
  current: ['success', '已是最新'],
  update: ['processing', '有更新'],
  error: ['error', '检查失败'],
}

export function GithubView({
  sources,
  status,
  checking,
  check,
  onAdd,
  onChanged,
}: {
  sources: GithubSource[]
  status: GithubStatus[]
  checking: boolean
  check: () => void
  onAdd: () => void
  onChanged: () => void | Promise<void>
}) {
  const { message, modal } = App.useApp()
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<{ id: string; message: string }>()

  async function apply(id: string, preview: GithubUpdatePreview) {
    setSyncing(id)
    try {
      const result = await request('sync-github', {
        id,
        token: preview.token,
        replaceShared: preview.shared?.token,
      })
      if ('conflict' in result) throw new Error('共享来源已变化，请重新预览')
      message.success('已同步到中央仓库')
      await onChanged()
    } catch (error) {
      setSyncError({ id, message: errorMessage(error) })
    } finally {
      setSyncing(null)
    }
  }

  async function sync(id: string) {
    setSyncing(id)
    setSyncError(undefined)
    try {
      const preview = await request('preview-github-update', { id })
      if (sources.find((s) => s.id === id)?.revision === preview.revision) {
        message.info('中央仓库已是此来源的最新版本')
        return
      }
      const labels = {
        add: '新增',
        overwrite: '覆盖',
        delete: '删除',
        link: '关联已有资源',
        unlink: '解除来源关联',
      }
      modal.confirm({
        title: '确认更新中央仓库',
        content: (
          <div>
            <p>GitHub 版本 {preview.revision.slice(0, 8)}</p>
            {preview.changes.length ? (
              <ul>
                {preview.changes.map((c) => (
                  <li key={c.key}>
                    {labels[c.action]} {c.key}
                  </li>
                ))}
              </ul>
            ) : (
              <p>仅更新来源版本记录</p>
            )}
            {preview.shared && (
              <p className="whitespace-pre-wrap">{preview.shared.message}</p>
            )}
          </div>
        ),
        okText: '确认更新',
        cancelText: '取消',
        onOk: () => apply(id, preview),
      })
    } catch (error) {
      setSyncError({ id, message: errorMessage(error) })
    } finally {
      setSyncing(null)
    }
  }

  return (
    <>
      <PageTitle
        title="GitHub 来源"
        description="添加 GitHub 资源、检查更新，并将选定版本同步到中央仓库。"
        actions={
          <>
            <Button
              icon={<SyncOutlined />}
              onClick={check}
              disabled={!sources.length || !!syncing}
              loading={checking}
            >
              检查更新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>
              添加来源
            </Button>
          </>
        }
      />
      <section className="surface">
        <div className="panel-heading">
          <h2>已添加来源</h2>
          <span className="text-sm text-muted">{sources.length} 个来源</span>
        </div>
        {!sources.length && (
          <div className="p-8">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有 GitHub 来源"
            >
              <Button onClick={onAdd} type="primary">
                添加 GitHub 来源
              </Button>
            </Empty>
          </div>
        )}
        {sources.map((source) => {
          const result = status.find(
            ({ id, revision }) =>
              id === source.id && revision === source.revision,
          )
          const tag = result ? statusTags[result.status] : undefined
          return (
            <div className="source-row" key={source.id}>
              <span className="kind-icon">
                <GithubOutlined />
              </span>
              <div className="flex-1 min-w-0">
                <a
                  className="wrap-anywhere text-base font-semibold"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.url.replace(/^https:\/\//, '')}
                </a>
                <div className="flex gap-2 items-center flex-wrap mt-1 text-sm text-muted">
                  <span>{source.keys.length} 项资源</span>
                  {source.revision && (
                    <code>{source.revision.slice(0, 8)}</code>
                  )}
                  {tag && <Tag color={tag[0]}>{tag[1]}</Tag>}
                </div>
                {result?.error && (
                  <Alert className="mt-2" type="error" title={result.error} />
                )}
                {syncError?.id === source.id && (
                  <Alert
                    className="mt-2"
                    showIcon
                    type="error"
                    title="同步失败"
                    description={
                      <div className="whitespace-pre-wrap wrap-anywhere">
                        {syncError.message}
                      </div>
                    }
                  />
                )}
              </div>
              <Button
                icon={<SyncOutlined />}
                onClick={() => sync(source.id)}
                disabled={checking || (!!syncing && syncing !== source.id)}
                loading={syncing === source.id}
              >
                预览更新
              </Button>
            </div>
          )
        })}
      </section>
    </>
  )
}
