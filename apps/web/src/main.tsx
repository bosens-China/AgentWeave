import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  App,
  Badge,
  Button,
  ConfigProvider,
  Layout,
  Menu,
  Skeleton,
  Tooltip,
} from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  ApartmentOutlined,
  DatabaseOutlined,
  ScanOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import 'antd/dist/reset.css'
import 'virtual:uno.css'
import type {
  Overview,
  GithubStatus,
  Resource,
  ResourceKind,
  Scope,
} from '@agentweave/protocol'
import { errorMessage, request, resourceKey } from './api'
import { useConfirmDiscard } from './shared-helpers'
import { AddGithubDialog, PageFailure, PageTitle } from './shared'

const CentralWorkspace = lazy(() =>
  import('./central-workspace').then(({ CentralWorkspace }) => ({
    default: CentralWorkspace,
  })),
)
const AgentsView = lazy(() =>
  import('./sync').then(({ AgentsView }) => ({ default: AgentsView })),
)
const ResourceDrawer = lazy(() =>
  import('./resources').then(({ ResourceDrawer }) => ({
    default: ResourceDrawer,
  })),
)
const SyncDialog = lazy(() =>
  import('./sync').then(({ SyncDialog }) => ({ default: SyncDialog })),
)
const LocalCheckPage = lazy(() =>
  import('./import').then(({ LocalCheckPage }) => ({
    default: LocalCheckPage,
  })),
)

const views = [
  { id: 'local', title: '本机检查', icon: ScanOutlined },
  { id: 'resources', title: '中央仓库', icon: DatabaseOutlined },
  { id: 'agents', title: '同步状态', icon: SyncOutlined },
]

function parseRoute(pathname: string, search: string) {
  const segment = pathname.replace(/^\/+|\/+$/g, '')
  const page =
    segment === 'agents'
      ? 'agents'
      : segment === 'resources' || segment === 'github'
        ? 'resources'
        : 'local'
  const params = new URLSearchParams(search)
  return {
    page,
    sourceId: segment === 'resources' ? params.get('source') : null,
    kind: segment === 'resources' ? params.get('kind') : null,
  }
}

function readView() {
  return parseRoute(window.location.pathname, window.location.search)
}

function currentPath() {
  return `${window.location.pathname}${window.location.search}`
}

function AppShell() {
  const confirmDiscard = useConfirmDiscard()
  const [{ page, sourceId, kind }, setView] = useState(readView)
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)
  const [addGithub, setAddGithub] = useState(false)
  const [openedResource, setOpenedResource] = useState<{
    resource: Resource | null
    kind: ResourceKind
    revision?: string
  } | null>(null)
  const [sync, setSync] = useState<{
    scope: Scope
    refresh?: () => void
  } | null>(null)
  const localDirty = useRef(false)
  const activeRoute = useRef(currentPath())
  const historyIndex = useRef(0)
  const overviewRevision = useRef(0)

  const hasSources = Boolean(data?.sources.length)
  const [githubRefresh, setGithubRefresh] = useState(0)
  const [githubState, setGithubState] = useState<{
    data: Overview | null
    refresh: number
    rows: GithubStatus[]
    error: string
  }>({ data: null, refresh: -1, rows: [], error: '' })
  useEffect(() => {
    if (!data?.sources.length) return undefined
    const controller = new AbortController()
    request('check-github', {}, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted)
          setGithubState({ data, refresh: githubRefresh, rows, error: '' })
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setGithubState((previous) => ({
            data,
            refresh: githubRefresh,
            rows: previous.rows,
            error: errorMessage(issue),
          }))
      })
    return () => controller.abort()
  }, [data, githubRefresh])
  const githubChecking =
    hasSources &&
    (githubState.data !== data || githubState.refresh !== githubRefresh)
  const githubStatus = hasSources ? githubState.rows : []
  const githubError = hasSources && !githubChecking ? githubState.error : ''
  const load = useCallback(async (signal?: AbortSignal) => {
    const revision = ++overviewRevision.current
    setChecking(true)
    setError('')
    try {
      const snapshot = await request(
        'overview',
        { checkDrift: readView().page === 'agents' },
        signal,
      )
      if (!signal?.aborted && revision === overviewRevision.current)
        setData(snapshot)
    } catch (issue) {
      if (
        !(issue instanceof Error && issue.name === 'AbortError') &&
        revision === overviewRevision.current
      )
        setError(errorMessage(issue))
    } finally {
      if (!signal?.aborted && revision === overviewRevision.current)
        setChecking(false)
    }
  }, [])

  const navigate = useCallback(
    async (to: string) => {
      const url = new URL(to, window.location.origin)
      const destination = `${url.pathname}${url.search}`
      if (destination === activeRoute.current) return
      const next = parseRoute(url.pathname, url.search)
      if (localDirty.current && next.page !== 'local') {
        if (!(await confirmDiscard())) return
        localDirty.current = false
      }
      historyIndex.current += 1
      window.history.pushState(
        { ...window.history.state, awIndex: historyIndex.current },
        '',
        destination,
      )
      activeRoute.current = destination
      setView(next)
      if (next.page === 'agents') void load()
    },
    [confirmDiscard, load],
  )

  const updateCentralRoute = useCallback(
    (next: { kind: string; sourceId: string | null }) => {
      const url = new URL(window.location.href)
      if (next.kind === 'all') url.searchParams.delete('kind')
      else url.searchParams.set('kind', next.kind)
      if (next.sourceId) url.searchParams.set('source', next.sourceId)
      else url.searchParams.delete('source')
      const destination = `${url.pathname}${url.search}`
      window.history.replaceState(
        { ...window.history.state, awIndex: historyIndex.current },
        '',
        destination,
      )
      activeRoute.current = destination
      setView(parseRoute(url.pathname, url.search))
    },
    [],
  )

  useEffect(() => {
    window.history.replaceState(
      { ...window.history.state, awIndex: historyIndex.current },
      '',
    )
    const controller = new AbortController()
    const revision = ++overviewRevision.current
    request(
      'overview',
      { checkDrift: readView().page === 'agents' },
      controller.signal,
    )
      .then((snapshot) => {
        if (!controller.signal.aborted && revision === overviewRevision.current)
          setData(snapshot)
      })
      .catch((issue) => {
        if (
          !(issue instanceof Error && issue.name === 'AbortError') &&
          revision === overviewRevision.current
        )
          setError(errorMessage(issue))
      })
      .finally(() => {
        if (!controller.signal.aborted && revision === overviewRevision.current)
          setChecking(false)
      })
    async function updateView(event: PopStateEvent) {
      const destination = currentPath()
      if (destination === activeRoute.current) return
      const targetIndex =
        typeof event.state?.awIndex === 'number'
          ? event.state.awIndex
          : historyIndex.current
      const delta = targetIndex - historyIndex.current
      const next = readView()
      if (localDirty.current && next.page !== 'local') {
        if (!(await confirmDiscard())) {
          // 用 history.go 回到原条目，避免 pushState 截断前进/后退记录。
          if (delta !== 0) window.history.go(-delta)
          return
        }
        localDirty.current = false
      }
      historyIndex.current = targetIndex
      activeRoute.current = destination
      setView(next)
      if (next.page === 'agents') void load()
    }

    function preventUnload(event: BeforeUnloadEvent) {
      if (localDirty.current) event.preventDefault()
    }

    window.addEventListener('popstate', updateView)
    window.addEventListener('beforeunload', preventUnload)
    return () => {
      controller.abort()
      window.removeEventListener('popstate', updateView)
      window.removeEventListener('beforeunload', preventUnload)
    }
  }, [confirmDiscard, load])

  function previewSync(scope: Scope, refresh?: () => void) {
    setSync({ scope, refresh })
  }

  function previewResource(resource: Resource, plugin?: Resource) {
    const key = resourceKey(resource)
    const qualified = plugin ? `${resourceKey(plugin)}/${key}` : key
    previewSync({ kinds: [resource.kind], keys: [qualified] })
  }

  return (
    <Layout className="h-screen overflow-hidden">
      <Layout.Sider
        theme="light"
        width={220}
        className="h-screen shrink-0 border-r border-r-solid border-[var(--ant-color-border-secondary)]"
      >
        <a
          className="flex items-center gap-2 h-14 px-6 text-lg font-semibold text-[var(--ant-color-text)]!"
          href="/local"
          aria-label="AgentWeave 本机检查"
          onClick={(event) => {
            event.preventDefault()
            void navigate('/local')
          }}
        >
          <ApartmentOutlined className="text-[var(--ant-color-primary)] text-xl" />
          AgentWeave
        </a>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          className="border-none!"
          onClick={({ key }) => {
            void navigate(`/${key}`)
          }}
          items={views.map(({ id, title, icon: Icon }) => ({
            key: id,
            icon: <Icon />,
            label: title,
          }))}
        />
      </Layout.Sider>

      <Layout className="min-w-0 h-screen flex flex-col overflow-hidden bg-[var(--ant-color-bg-layout)]">
        <Layout.Header className="shrink-0 z-10 flex items-center justify-between h-14 px-6! leading-none! bg-[var(--ant-color-bg-container)]! border-b border-b-solid border-[var(--ant-color-border-secondary)]">
          <Tooltip title={data?.workspacePath}>
            <span>
              <Badge
                status={error ? 'error' : checking ? 'processing' : 'success'}
                text={error ? '工作区读取失败' : '本机工作区'}
              />
            </span>
          </Tooltip>
        </Layout.Header>
        <Layout.Content className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto lg:overflow-hidden p-5 lg:p-6 bg-[var(--ant-color-bg-layout)]">
          {error && (
            <div className="mb-4">
              <PageFailure error={error} onRetry={() => load()} />
            </div>
          )}
          <Suspense fallback={null}>
            {page === 'local' ? (
              <LocalCheckPage
                initialized={data?.initialized ?? true}
                onChanged={load}
                onRestore={previewSync}
                onDirtyChange={(dirty) => {
                  localDirty.current = dirty
                }}
              />
            ) : !data && !error ? (
              <Skeleton active />
            ) : (
              data &&
              (page === 'agents' ? (
                <div className="flex flex-col h-full min-h-0">
                  <PageTitle
                    title="同步状态"
                    description="查看各本机 Agent 与中央仓库的差异，配置同步范围或执行整类同步"
                    actions={
                      <Button
                        icon={<SyncOutlined spin={checking} />}
                        onClick={() => load()}
                        disabled={checking}
                      >
                        重新检查
                      </Button>
                    }
                  />
                  <AgentsView
                    data={data}
                    checking={checking}
                    onChanged={load}
                    onPreview={previewSync}
                  />
                </div>
              ) : (
                <div className="flex flex-col h-full min-h-0">
                  <PageTitle
                    title="中央仓库"
                    description="统一管理本机资源与 GitHub 来源，支持批量分发到多个 Agent"
                    actions={
                      <Button
                        icon={<SyncOutlined spin={checking} />}
                        onClick={() => load()}
                        disabled={checking}
                      >
                        刷新仓库
                      </Button>
                    }
                  />
                  <CentralWorkspace
                    data={data}
                    checking={checking}
                    initialSourceId={sourceId}
                    initialKind={kind}
                    githubStatus={githubStatus}
                    githubChecking={githubChecking}
                    githubError={githubError}
                    onCheckGithub={() => setGithubRefresh((n) => n + 1)}
                    onAddGithub={() => setAddGithub(true)}
                    onChanged={load}
                    onOpen={(resource, kind) => {
                      if (resource)
                        setOpenedResource({
                          resource,
                          kind: resource.kind,
                          revision:
                            data.resourceRevisions[resourceKey(resource)],
                        })
                      else if (kind) setOpenedResource({ resource: null, kind })
                    }}
                    onPreviewSync={previewSync}
                    onPreviewResource={previewResource}
                    onGoLocal={() => {
                      void navigate('/local')
                    }}
                    onFilterChange={updateCentralRoute}
                  />
                </div>
              ))
            )}
          </Suspense>
        </Layout.Content>
      </Layout>

      {addGithub && (
        <AddGithubDialog onClose={() => setAddGithub(false)} onDone={load} />
      )}
      <Suspense fallback={null}>
        {openedResource && (
          <ResourceDrawer
            {...openedResource}
            onClose={() => setOpenedResource(null)}
            onChanged={load}
            onPreview={previewResource}
          />
        )}
        {sync && data && (
          <SyncDialog
            scope={sync.scope}
            targets={data.targets}
            onClose={() => setSync(null)}
            onDone={() => {
              sync.refresh?.()
              return load()
            }}
          />
        )}
      </Suspense>
    </Layout>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('找不到网页根节点。')
createRoot(root).render(
  <ConfigProvider
    locale={zhCN}
    button={{ autoInsertSpace: false }}
    modal={{ styles: { header: { marginBottom: 16 } } }}
    theme={{
      token: {
        colorBgLayout: '#f7f8fa',
        colorBorderSecondary: '#eef0f4',
        borderRadius: 8,
      },
      components: {
        Layout: {
          bodyBg: '#f7f8fa',
          headerBg: '#ffffff',
          siderBg: '#ffffff',
        },
        Table: {
          headerBg: '#fafbfc',
        },
      },
    }}
  >
    <App>
      <AppShell />
    </App>
  </ConfigProvider>,
)
