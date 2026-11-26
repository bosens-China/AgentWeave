export type ResourceKind = 'skill' | 'mcp' | 'instructions' | 'plugin'
export type McpTransport = 'stdio' | 'streamable-http' | 'sse'
export type NewResource = { id: string; tags?: string[] } & (
  | { kind: 'skill'; description: string; text: string }
  | { kind: 'instructions'; text: string }
  | {
      kind: 'mcp'
      transport: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  | {
      kind: 'mcp'
      transport: 'streamable-http' | 'sse'
      url: string
      headers?: Record<string, string>
    }
)
export type PluginFormat =
  | 'codex'
  | 'portable'
  | 'claude'
  | 'cursor'
  | 'antigravity'
  | 'pi'
export type Resource = {
  kind: ResourceKind
  id: string
  name: string
  tags?: string[]
  files?: Record<string, string>
  modes?: Record<string, number>
  config?: Record<string, unknown>
  text?: string
  format?: PluginFormat
  components?: Resource[]
  unsupported?: string[]
  sourcePath?: string
}

export type Target = {
  id: string
  name: string
  detected: boolean
  kinds: ResourceKind[]
  mcpTransports?: McpTransport[]
  instructionsPaths?: string[]
}
export type Candidate = { id: string; targetId: string; resource: Resource }
export type ComparedCandidate = Candidate & {
  status: 'new' | 'same' | 'conflict'
}
export type Selection = { id: string; replace?: boolean }
export type Scan = { candidates: ComparedCandidate[]; warnings: string[] }

export type Scope = {
  kinds: ResourceKind[]
  targetId?: string
  keys?: string[]
}
export type Profile = { targetId: string; kinds: ResourceKind[] }
export type SyncChange = {
  action: 'add' | 'overwrite' | 'delete'
  kind: ResourceKind
  key: string
  name: string
  path: string
}
export type SyncPlan = {
  changes: SyncChange[]
  warnings: string[]
  affectedTargets: string[]
  revision: string
}
export type Capabilities = {
  version: string
  apiVersions: number[]
  features: string[]
}
export type BundleRequest = {
  from: string
  targetId: string
  overwrite?: boolean
}
export type BundlePlan = SyncPlan & {
  packageName: string
  packageVersion: string
  resourceCount: number
}
export type Drift = Omit<SyncPlan, 'revision'> & {
  targetId: string
  revision: string | null
}

export type GithubSource = {
  id: string
  url: string
  revision: string
  keys: string[]
}
export type GithubStatus = GithubSource & {
  status: 'current' | 'update' | 'error'
  latestRevision?: string
  error?: string
}
export type GithubPreview = Scan & {
  url: string
  revision: string
}
export type GithubSyncResult =
  | GithubSource
  | {
      conflict: { token: string; message: string }
    }
export type Overview = {
  initialized: boolean
  profiles: Profile[]
  resources: Resource[]
  sources: GithubSource[]
  targets: Target[]
  drift: Drift[]
  mcpProtocolBaseline: string
}

export interface Api {
  capabilities: { request: object; response: Capabilities }
  overview: { request: object; response: Overview }
  scan: { request: { targetIds?: string[] }; response: Scan }
  import: {
    request: { targetIds?: string[]; selections: Selection[] }
    response: Resource[]
  }
  'save-resource': {
    request: { resource: Resource; replace?: boolean; fromFile?: boolean }
    response: Resource
  }
  'create-resource': { request: NewResource; response: Resource }
  'delete-resource': { request: { key: string }; response: { removed: true } }
  'set-profile': { request: Profile; response: Profile[] }
  'preview-sync': { request: Profile & { keys?: string[] }; response: SyncPlan }
  'apply-sync': {
    request: Profile & { keys?: string[]; revision: string }
    response: SyncPlan
  }
  'preview-bundle': { request: BundleRequest; response: BundlePlan }
  'apply-bundle': {
    request: BundleRequest & { revision: string }
    response: BundlePlan
  }
  'preview-github': { request: { url: string }; response: GithubPreview }
  'add-github': {
    request: { url: string; selections?: Selection[]; revision?: string }
    response: GithubSource
  }
  'check-github': { request: object; response: GithubStatus[] }
  'sync-github': {
    request: { id: string; replaceShared?: string }
    response: GithubSyncResult
  }
}

export type ApiAction = keyof Api
