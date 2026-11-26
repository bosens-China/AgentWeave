import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App, Button, ConfigProvider, Skeleton, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  ApartmentOutlined,
  DatabaseOutlined,
  GithubOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import 'antd/dist/reset.css'
import 'virtual:uno.css'
import './styles.css'
import type {
  Overview,
  GithubStatus,
  Resource,
  ResourceKind,
  Scope,
} from '@agentweave/protocol'
import { errorMessage, request, resourceKey } from './api'
import type { ImportFilter } from './import-selection'
import { ImportDialog, useLocalScan, Welcome } from './import'
import { AddGithubDialog, PageFailure } from './shared'

const ResourcesView = lazy(() =>
  import('./resources').then(({ ResourcesView }) => ({
    default: ResourcesView,
  })),
)
const ResourceDrawer = lazy(() =>
  import('./resources').then(({ ResourceDrawer }) => ({
    default: ResourceDrawer,
  })),
)
const AgentsView = lazy(() =>
  import('./sync').then(({ AgentsView }) => ({ default: AgentsView })),
)
const SyncDialog = lazy(() =>
  import('./sync').then(({ SyncDialog }) => ({ default: SyncDialog })),
)
const GithubView = lazy(() =>
  import('./github').then(({ GithubView }) => ({ default: GithubView })),
)

const views = [
  { id: 'resources', title: '中央仓库', icon: DatabaseOutlined },
  { id: 'agents', title: '同步目标', icon: SyncOutlined },
  { id: 'github', title: 'GitHub 来源', icon: GithubOutlined },
]

function readView() {
  const page = window.location.hash.slice(1)
  return views.some(({ id }) => id === page) ? page : 'resources'
}

function AppShell() {
  const { message } = App.useApp()
  const [view, setView] = useState(readView)
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [addGithub, setAddGithub] = useState(false)
  const [importFilter, setImportFilter] = useState<ImportFilter>('all')
  const [importOpen, setImportOpen] = useState(false)
  const [openedResource, setOpenedResource] = useState<{
    resource: Resource | null
    kind: ResourceKind
  } | null>(null)
  const [scope, setScope] = useState<Scope | null>(null)
  const overviewRevision = useRef(0)
  const firstImport = data?.initialized === false
  const local = useLocalScan(data)

  const [githubStatus, setGithubStatus] = useState<GithubStatus[]>([])
  const [githubChecking, setGithubChecking] = useState(false)
  const [githubRefresh, setGithubRefresh] = useState(0)
  const [githubError, setGithubError] = useState('')
  useEffect(() => {
    if (!data?.sources.length) {
      setGithubStatus([])
      setGithubChecking(false)
      setGithubError('')
      return
    }
    const controller = new AbortController()
    setGithubChecking(true)
    setGithubError('')
    request('check-github', {}, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setGithubStatus(rows)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setGithubError(errorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setGithubChecking(false)
      })
    return () => controller.abort()
  }, [data, githubRefresh])
  const updates = githubStatus.filter((row) => row.status === 'update').length
  const load = useCallback(async (signal?: AbortSignal) => {
    const revision = ++overviewRevision.current
    setChecking(true)
    setError('')
    try {
      const snapshot = await request('overview', {}, signal)
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

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    const updateView = () => setView(readView())
    window.addEventListener('hashchange', updateView)
    return () => {
      controller.abort()
      window.removeEventListener('hashchange', updateView)
    }
  }, [load])

  async function skipImport() {
    try {
      await request('import', { selections: [] })
      await load()
    } catch (issue) {
      message.error(errorMessage(issue))
    }
  }

  function openImport(filter: ImportFilter = 'all') {
    setImportFilter(filter)
    setImportOpen(true)
  }

  function previewResource(resource: Resource, plugin?: Resource) {
    const key = resourceKey(resource)
    const qualified = plugin ? `${resourceKey(plugin)}/${key}` : key
    setScope({ kinds: [resource.kind], keys: [qualified] })
  }

  const pending = (data?.drift ?? []).filter(
    ({ changes }) => changes?.length,
  ).length
  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="主导航">
        <a className="brand" href="#resources" aria-label="AgentWeave 中央仓库">
          <span className="brand-icon">
            <ApartmentOutlined />
          </span>
          <span>
            Agent<span className="brand-accent">Weave</span>
          </span>
        </a>
        <div className="nav-list">
          {views.map(({ id, title, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={view === id ? 'page' : undefined}
              className={`nav-link ${view === id ? 'nav-link-active' : ''}`}
            >
              <Icon />
              <span>{title}</span>
              {id === 'agents' && !!pending && (
                <span className="nav-number">{pending}</span>
              )}
            </a>
          ))}
        </div>
      </nav>

      <div className="workspace">
        <header className="top-bar">
          <div className="flex gap-2 items-center text-sm font-medium">
            <span className={`status-dot ${!error ? 'dot-online' : ''}`} />
            <span>{error ? '本机读取失败' : '本机工作区'}</span>
          </div>
          <Button
            type="text"
            size="small"
            icon={<SyncOutlined spin={checking} />}
            onClick={() => load()}
            disabled={checking}
          >
            重新检查
          </Button>
        </header>
        <main className="workspace-content">
          {error && (
            <div className="mb-4">
              <PageFailure error={error} onRetry={() => load()} />
            </div>
          )}
          {!data && !error && <Skeleton active />}
          {data && (
            <Suspense fallback={<Skeleton active />}>
              {view === 'resources' && (
                <Welcome
                  scanState={local}
                  onScan={openImport}
                  targets={data.targets}
                  onRestore={setScope}
                  onSkip={firstImport ? skipImport : undefined}
                />
              )}
              {githubError && (
                <PageFailure
                  error={githubError}
                  onRetry={() => setGithubRefresh((n) => n + 1)}
                />
              )}
              {view === 'resources' && !!updates && (
                <Button href="#github" icon={<GithubOutlined />}>
                  GitHub 有 {updates} 个来源可更新
                </Button>
              )}
              {view === 'resources' && (
                <ResourcesView
                  workspacePath={data.workspacePath}
                  resources={data.resources}
                  firstImport={firstImport}
                  onAddGithub={() => setAddGithub(true)}
                  onScan={() => openImport()}
                  onOpen={(resource, kind) => {
                    if (resource)
                      setOpenedResource({ resource, kind: resource.kind })
                    else if (kind) setOpenedResource({ resource: null, kind })
                  }}
                  onPreview={previewResource}
                />
              )}
              {view === 'agents' && (
                <AgentsView data={data} onChanged={load} onPreview={setScope} />
              )}
              {view === 'github' && (
                <GithubView
                  sources={data.sources}
                  status={githubStatus}
                  checking={githubChecking}
                  check={() => setGithubRefresh((n) => n + 1)}
                  onChanged={load}
                  onAdd={() => setAddGithub(true)}
                />
              )}
            </Suspense>
          )}
        </main>
      </div>

      {addGithub && (
        <AddGithubDialog onClose={() => setAddGithub(false)} onDone={load} />
      )}
      {importOpen && data && (
        <ImportDialog
          scanState={local}
          targets={data.targets}
          firstImport={firstImport}
          filter={importFilter}
          onClose={() => setImportOpen(false)}
          onDone={load}
        />
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
        {scope && data && (
          <SyncDialog
            scope={scope}
            targets={data.targets}
            onClose={() => setScope(null)}
            onDone={load}
          />
        )}
      </Suspense>
    </div>
  )
}

const token = theme.getDesignToken()
const layoutColors = {
  '--surface': token.colorBgContainer,
  '--canvas': token.colorBgLayout,
  '--text': token.colorText,
  '--muted': token.colorTextSecondary,
  '--line': token.colorBorderSecondary,
  '--fill': token.colorFillQuaternary,
  '--accent': token.colorPrimary,
  '--accent-dark': token.colorPrimaryTextActive,
  '--accent-bg': token.colorPrimaryBg,
  '--accent-bg-hover': token.colorPrimaryBgHover,
  '--accent-border': token.colorPrimaryBorder,
  '--success': token.colorSuccess,
  '--success-bg': token.colorSuccessBg,
  '--error': token.colorErrorText,
}
for (const [name, value] of Object.entries(layoutColors)) {
  document.documentElement.style.setProperty(name, value)
}

const root = document.getElementById('root')
if (!root) throw new Error('找不到网页根节点。')
createRoot(root).render(
  <ConfigProvider locale={zhCN}>
    <App>
      <AppShell />
    </App>
  </ConfigProvider>,
)
