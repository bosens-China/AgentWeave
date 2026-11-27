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
export type Candidate = {
  id: string
  targetId: string
  resource: Resource
  updatedAt?: string
  builtin?: boolean
  bundledBy?: string[]
  componentConflict?: string[]
  componentAlternatives?: string[]
}
export type ComparedCandidate = Candidate & {
  status: 'new' | 'same' | 'conflict'
  localChange?: 'added' | 'updated'
  contentHash: string
  description?: string
  author?: string
  version?: string
  conflictWithRepository?: boolean
  mcpComparison?: {
    fields: Record<string, string>
    repositoryDifferences?: string[]
  }
}
export type Selection = { id: string; replace?: boolean }
export type ScanIssue = {
  builtin?: boolean
  id: string
  targetId: string
  kind: ResourceKind
  name?: string
  description?: string
  warning: string
  reason: string
  editable: boolean
}
export type MissingLocal = {
  targetId: string
  kind: ResourceKind
  name: string
  key: string
}
export type LocalRemoval = Omit<MissingLocal, 'key'> & {
  resourceId: string
  key?: string
}
export type Scan = {
  missing?: MissingLocal[]
  localChanges: { removed: LocalRemoval[] }
  targets: Pick<Target, 'id' | 'name'>[]
  candidates: ComparedCandidate[]
  warnings: string[]
  issues: ScanIssue[]
}

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
export type GithubPreview = Pick<Scan, 'candidates' | 'warnings'> & {
  url: string
  revision: string
}
export type GithubUpdatePreview = {
  revision: string
  token: string
  changes: {
    key: string
    action: 'add' | 'overwrite' | 'delete' | 'unlink' | 'link'
  }[]
  shared?: { token: string; message: string }
}
export type GithubSyncResult =
  | GithubSource
  | {
      conflict: { token: string; message: string }
    }
export type ResourceMeta = {
  description?: string
  author?: string
  version?: string
  mcpTransport?: string
  mcpEndpoint?: string
}
export type Overview = {
  workspacePath: string
  initialized: boolean
  profiles: Profile[]
  resources: Resource[]
  resourceRevisions: Record<string, string>
  resourceMeta: Record<string, ResourceMeta>
  sources: GithubSource[]
  targets: Target[]
  drift: Drift[]
  mcpProtocolBaseline: string
}

export interface Api {
  capabilities: { request: object; response: Capabilities }
  overview: { request: { checkDrift?: boolean }; response: Overview }
  scan: { request: { targetIds?: string[]; record?: boolean }; response: Scan }
  'list-scan-files': {
    request: { id: string }
    response: { files: string[] }
  }
  'read-scan-source': {
    request: { id: string; path?: string }
    response: {
      name: string
      content: string
      revision: string
      readOnly?: boolean
      binary?: boolean
    }
  }
  'save-scan-source': {
    request: { id: string; path?: string; revision: string; content: string }
    response: Scan & { updatedId?: string }
  }
  import: {
    request: { targetIds?: string[]; selections: Selection[] }
    response: Resource[]
  }
  'save-resource': {
    request: {
      resource: Resource
      replace?: boolean
      fromFile?: boolean
      revision?: string
    }
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
  'preview-github-update': {
    request: { id: string }
    response: GithubUpdatePreview
  }
  'sync-github': {
    request: { id: string; replaceShared?: string; token: string }
    response: GithubSyncResult
  }
}

export type ApiAction = keyof Api
