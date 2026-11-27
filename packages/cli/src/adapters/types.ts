import type {
  Resource,
  ResourceKind,
  SyncChange,
  Target,
} from '@agentweave/protocol'

export type McpLocation = {
  path: string
  key: string
  format: 'jsonc' | 'toml'
  variant: string
}
export type NativePluginKind =
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'antigravity'
  | 'pi'
export type PluginLocation = { kind: NativePluginKind; root: string }
export type TargetConfig = Pick<Target, 'id' | 'name'> & {
  root: string
  skills?: string
  sharedSkills?: string[]
  flatSkills?: boolean
  instructions?: string
  instructionsLimit?: number
  mcp?: McpLocation
  plugin?: PluginLocation
}
export type NativeTarget = TargetConfig &
  Target & { home: string; skills: string; sharedSkills: string[] }

export type Tree = {
  files: Record<string, string>
  modes?: Record<string, number>
}
export type FileOperation = Partial<Tree> & {
  path: string
  expected: string | null
  text?: string
  mode?: number
  verifyTree?: boolean
  beforeFingerprint?: string
}
export type ResourceEntry = {
  path: string
  expected: string | null
  resource: Resource
  updatedAt?: string
}
export type PluginEntry = ResourceEntry & {
  nativeId?: string
  enabled?: boolean
  managedBy?: 'builtin' | 'unverified-bundle' | 'account'
}
export type PluginOperation = {
  id: string
  payload?: Tree
  current?: PluginEntry
  beforeFingerprint: string
}
export type SectionPlan = {
  provided?: Resource[]
  changes: SyncChange[]
  operations: FileOperation[]
  pluginOperations?: PluginOperation[]
}
export type SyncOptions = {
  home?: string
  targetId: string
  kinds: ResourceKind[]
  keys?: string[]
  resources: Resource[]
}
