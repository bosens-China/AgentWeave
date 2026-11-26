import { useState } from 'react'
import { Alert, App, Button, Empty, Tag } from 'antd'
import { GithubOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons'
import type { GithubSource, GithubStatus } from '@agentweave/protocol'
import { errorMessage, request } from './api'
import { PageTitle } from './shared'

const statusTags = {
  current: ['success', '已是最新'],
  update: ['processing', '有更新'],
  error: ['error', '检查失败'],
}

export function GithubView({
  sources,
  onAdd,
  onChanged,
}: {
  sources: GithubSource[]
  onAdd: () => void
  onChanged: () => void | Promise<void>
}) {
  const { message, modal } = App.useApp()
  const [status, setStatus] = useState<GithubStatus[]>([])
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<{ id: string; message: string }>()

  async function check() {
    setChecking(true)
    try {
      setStatus(await request('check-github'))
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setChecking(false)
    }
  }

  async function sync(id: string, replaceShared?: string) {
    setSyncing(id)
    setSyncError(undefined)
    try {
      const result = await request('sync-github', { id, replaceShared })
      if ('conflict' in result) {
        modal.confirm({
          title: '选择要保留的共享资源版本',
          content: (
            <div className="whitespace-pre-wrap wrap-anywhere">
              {result.conflict.message}
            </div>
          ),
          okText: '使用 GitHub 版本',
          okButtonProps: { danger: true },
          cancelText: '保留中央版本',
          onOk: () => sync(id, result.conflict.token),
        })
        return
      }
      setStatus((previous) => previous.filter((item) => item.id !== id))
      message.success('已同步到中央仓库')
      await onChanged()
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
                同步到中央仓库
              </Button>
            </div>
          )
        })}
      </section>
    </>
  )
}
