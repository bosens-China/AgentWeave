import type { McpTransport, Resource } from '@agentweave/protocol'
import { object } from './files.js'

type McpTarget = { id: string; name: string; mcp?: { variant: string } }

export const MCP_PROTOCOL_BASELINE = '2026-07-28'

export function mcpTransports(variant: string): McpTransport[] {
  const transports: McpTransport[] = ['stdio', 'streamable-http']
  if (
    ['claude', 'standard', 'kimi', 'qwen', 'cline', 'windsurf'].includes(
      variant,
    )
  )
    transports.push('sse')
  return transports
}

const managedFields = new Set([
  'type',
  'command',
  'args',
  'env',
  'environment',
  'env_vars',
  'envVars',
  'url',
  'serverUrl',
  'httpUrl',
  'headers',
  'http_headers',
  'env_http_headers',
  'envHeaders',
  'bearer_token_env_var',
  'bearerTokenEnvVar',
  'enabled',
  'disabled',
])

const envFormats: Record<string, (name: string) => string> = {
  opencode: (name) => `{env:${name}}`,
  'opencode-v2': (name) => `{env:${name}}`,
  pi: (name) => `\${${name}}`,
  qwen: (name) => `\${${name}}`,
  cline: (name) => `\${env:${name}}`,
  windsurf: (name) => `\${env:${name}}`,
  claude: (name) => `\${${name}}`,
  standard: (name) => `\${${name}}`,
  copilot: (name) => `\${${name}}`,
  kiro: (name) => `\${${name}}`,
}

function portableVariable(text: string) {
  return text.replace(
    /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, first, second) => `\${${first ?? second}}`,
  )
}

function stringMap(
  data: unknown,
  transform = (value: string) => value,
): Record<string, string> | undefined {
  if (data === undefined) return undefined
  if (
    !object(data) ||
    Object.values(data).some((value) => typeof value !== 'string')
  ) {
    throw new Error('环境变量和请求头应为字符串键值对')
  }
  const entries = Object.entries(data)
  return entries.length
    ? Object.fromEntries(
        entries.map(([key, value]) => [key, transform(value as string)]),
      )
    : undefined
}

function strings(data: unknown, name: string): string[] | undefined {
  if (data === undefined) return undefined
  if (!Array.isArray(data) || data.some((value) => typeof value !== 'string'))
    throw new Error(`${name} 应为字符串列表`)
  return data.length ? data : undefined
}

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  )
}

export function normalizeMcpConfig(config: unknown) {
  if (!object(config)) throw new Error('MCP 缺少连接配置')
  const { command, url, type } = config
  if ((command === undefined) === (url === undefined))
    throw new Error('MCP 需要且只能指定一个启动命令或服务 URL')
  if (command !== undefined && (typeof command !== 'string' || !command.trim()))
    throw new Error('MCP 启动命令必须是非空字符串')
  if (url !== undefined) {
    if (typeof url !== 'string') throw new Error('MCP 服务 URL 必须是文本')
    const address = portableVariable(url).trim()
    const variable = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g
    const expanded = address
      .replace(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/, 'https://example.invalid')
      .replace(variable, 'example')
    if (!/^https?:\/\//i.test(expanded) || !URL.canParse(expanded))
      throw new Error('MCP 服务 URL 必须是有效的 HTTP(S) 地址或环境变量引用')
  }
  if (
    type !== undefined &&
    !(command !== undefined
      ? type === 'stdio'
      : type === 'http' || type === 'streamable-http' || type === 'sse')
  )
    throw new Error('MCP 传输类型与启动命令或服务 URL 不匹配')
  const args = strings(config.args, 'args')
  const envVars = strings(config.envVars, 'envVars')
  const env = stringMap(config.env)
  const headers = stringMap(config.headers)
  const envHeaders = stringMap(config.envHeaders)
  if (
    command !== undefined
      ? headers || envHeaders || config.bearerTokenEnvVar !== undefined
      : args || env || envVars
  )
    throw new Error('MCP 的命令参数、环境变量或请求头与连接方式不匹配')
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean')
    throw new Error('MCP 的 enabled 必须是布尔值')
  if (
    config.bearerTokenEnvVar !== undefined &&
    typeof config.bearerTokenEnvVar !== 'string'
  )
    throw new Error('MCP 的 Bearer Token 环境变量必须是字符串')
  return compact({
    ...config,
    type: type === 'sse' ? type : undefined,
    enabled: config.enabled === false ? false : undefined,
    args,
    envVars,
    env,
    headers,
    envHeaders,
  })
}

export function comparableMcpConfig(config: unknown) {
  const normalized = normalizeMcpConfig(config)
  const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u
  if (normalized.command !== undefined) {
    const forwarded = new Set(strings(normalized.envVars, 'envVars'))
    const env = stringMap(normalized.env, portableVariable)
    for (const [name, value] of Object.entries(env ?? {})) {
      if (variable.exec(value)?.[1] !== name) continue
      forwarded.add(name)
      delete env?.[name]
    }
    return compact({
      ...normalized,
      env: stringMap(env),
      envVars: forwarded.size ? [...forwarded].sort() : undefined,
    })
  }

  const headers = stringMap(normalized.headers, portableVariable)
  const envHeaders = new Map(
    Object.entries(stringMap(normalized.envHeaders) ?? {}),
  )
  let bearerTokenEnvVar = normalized.bearerTokenEnvVar
  for (const [header, value] of Object.entries(headers ?? {})) {
    const token =
      header === 'Authorization' &&
      /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value)?.[1]
    if (
      token &&
      !envHeaders.has(header) &&
      (bearerTokenEnvVar === undefined || bearerTokenEnvVar === token)
    ) {
      bearerTokenEnvVar = token
    } else {
      const name = variable.exec(value)?.[1]
      if (!name || (envHeaders.has(header) && envHeaders.get(header) !== name))
        continue
      envHeaders.set(header, name)
    }
    delete headers?.[header]
  }
  return compact({
    ...normalized,
    headers: stringMap(headers),
    envHeaders: stringMap(Object.fromEntries(envHeaders)),
    bearerTokenEnvVar,
  })
}

export function decodeServer(raw: unknown, target: McpTarget) {
  if (!object(raw)) throw new Error('需要对象格式的 MCP 配置')
  const { variant } = target.mcp ?? {}
  if (!variant) throw new Error('缺少目标 MCP 格式')
  const opencode = variant.startsWith('opencode')
  const command =
    opencode && Array.isArray(raw.command) ? raw.command[0] : raw.command
  const commandArgs =
    opencode && Array.isArray(raw.command) ? raw.command.slice(1) : raw.args
  const url = raw.url ?? raw.serverUrl ?? raw.httpUrl
  if (
    (raw.command !== undefined &&
      (typeof command !== 'string' || !command.trim())) ||
    [raw.url, raw.serverUrl, raw.httpUrl].some(
      (value) =>
        value !== undefined && (typeof value !== 'string' || !value.trim()),
    ) ||
    (command === undefined) === (url === undefined)
  ) {
    throw new Error('需要一条启动命令或一个服务 URL')
  }
  if (
    [raw.enabled, raw.disabled].some(
      (value) => value !== undefined && typeof value !== 'boolean',
    )
  )
    throw new Error('MCP 的 enabled 或 disabled 必须是布尔值')
  const nativeTypes = command
    ? ['stdio', 'local']
    : [
        'sse',
        'http',
        'remote',
        'streamable-http',
        'streamableHttp',
        'streamable_http',
      ]
  if (
    raw.type !== undefined &&
    (typeof raw.type !== 'string' || !nativeTypes.includes(raw.type))
  )
    throw new Error('无法转换该 MCP 传输类型')
  const type =
    raw.type === 'sse' ||
    (variant === 'qwen' && raw.type === undefined && raw.url)
      ? 'sse'
      : undefined
  const args = strings(commandArgs, 'args')?.map(portableVariable)
  const env = stringMap(raw.env ?? raw.environment, portableVariable)
  const envVars = strings(raw.envVars ?? raw.env_vars, 'envVars')
  const headers = stringMap(raw.headers ?? raw.http_headers, portableVariable)
  const envHeaders = stringMap(raw.envHeaders ?? raw.env_http_headers)
  const bearerTokenEnvVar = raw.bearer_token_env_var ?? raw.bearerTokenEnvVar
  const enabled =
    raw.enabled === false || raw.disabled === true ? false : undefined
  const options = Object.fromEntries(
    Object.entries(raw).filter(
      ([name, value]) =>
        !managedFields.has(name) &&
        !(
          variant === 'copilot' &&
          name === 'tools' &&
          Array.isArray(value) &&
          value.length === 1 &&
          value[0] === '*'
        ),
    ),
  )
  return normalizeMcpConfig({
    command:
      typeof command === 'string' && command
        ? portableVariable(command)
        : undefined,
    args,
    env,
    envVars,
    url: typeof url === 'string' && url ? portableVariable(url) : undefined,
    headers,
    envHeaders,
    bearerTokenEnvVar,
    type,
    enabled,
    options:
      target.id && Object.keys(options).length
        ? { [target.id]: options }
        : undefined,
  })
}

export function mcpTransport(config: Record<string, unknown>): McpTransport {
  if (config.type === 'sse') return 'sse'
  return config.command !== undefined ? 'stdio' : 'streamable-http'
}

export function encodeServer(
  resource: Resource,
  target: McpTarget,
  previous: unknown = {},
  warnings: string[] = [],
): Record<string, unknown> {
  const config = comparableMcpConfig(resource.config)
  const { variant } = target.mcp ?? {}
  if (!variant) throw new Error('缺少目标 MCP 格式')
  const transport = mcpTransport(config)
  const local = transport === 'stdio'
  const codex = variant === 'codex'
  const opencode = variant.startsWith('opencode')
  if (!mcpTransports(variant).includes(transport))
    throw new Error(
      `该目标无法转换 ${transport === 'sse' ? 'SSE' : transport} 配置`,
    )
  const disabledKey = ['cline', 'kiro', 'windsurf', 'opencode-v2'].includes(
    variant,
  )
    ? 'disabled'
    : null
  const enabledKey = ['opencode', 'codex', 'pi'].includes(variant)
    ? 'enabled'
    : null
  if (config.enabled === false && !disabledKey && !enabledKey)
    throw new Error('该目标无法表达已禁用的设置')
  const options = object(config.options) ? config.options : {}
  const targetOptions = options[target.id]
  const configOptions = object(targetOptions) ? targetOptions : {}
  const omittedOptions = Object.keys(options).filter(
    (name) => name !== target.id,
  )
  if (omittedOptions.length)
    warnings.push(
      `${resource.name} 包含仅适用于 ${omittedOptions.join('、')} 的设置，当前目标使用通用连接配置`,
    )
  const extras = Object.fromEntries(
    Object.entries({
      ...(object(previous) ? previous : {}),
      ...configOptions,
    }).filter(([key]) => !managedFields.has(key)),
  )
  const expand = (value: unknown) => {
    if (typeof value !== 'string')
      throw new Error('需要一条启动命令或一个服务 URL')
    const src = portableVariable(value)
    return src.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (!envFormats[variant])
        throw new Error('该目标无法表达连接配置中的环境变量引用')
      return envFormats[variant](name)
    })
  }
  const encoded = { ...extras }
  if (config.enabled === false) {
    if (disabledKey) encoded[disabledKey] = true
    if (enabledKey) encoded[enabledKey] = false
  }
  if (local) {
    const args = strings(config.args, 'args')?.map(expand)
    const vars = strings(config.envVars, 'envVars')
    const env = stringMap(config.env, expand)
    const mappedVars = codex
      ? {}
      : Object.fromEntries(
          (vars ?? []).map((name) => [name, expand(`\${${name}}`)]),
        )
    const environment = { ...mappedVars, ...env }
    if (opencode) {
      encoded.type = 'local'
      encoded.command = [expand(config.command), ...(args ?? [])]
      if (Object.keys(environment).length) encoded.environment = environment
    } else {
      encoded.command = expand(config.command)
      if (args) encoded.args = args
      if (Object.keys(environment).length) encoded.env = environment
      if (codex && vars) encoded.env_vars = vars
      if (variant === 'copilot') encoded.type = 'local'
      if (['claude', 'pi', 'kimi', 'cline'].includes(variant))
        encoded.type = 'stdio'
    }
  } else {
    const headers = stringMap(config.headers, expand)
    const envHeaders = stringMap(config.envHeaders)
    const bearerTokenEnvVar = config.bearerTokenEnvVar
    const resolvedHeaders = { ...headers }
    if (codex) {
      if (headers) encoded.http_headers = headers
      if (envHeaders) encoded.env_http_headers = envHeaders
      if (bearerTokenEnvVar) encoded.bearer_token_env_var = bearerTokenEnvVar
    } else {
      for (const [header, name] of Object.entries(envHeaders ?? {})) {
        Object.defineProperty(resolvedHeaders, header, {
          value: expand(`\${${name}}`),
          enumerable: true,
          configurable: true,
        })
      }
      if (bearerTokenEnvVar)
        resolvedHeaders.Authorization = expand(
          `Bearer \${${bearerTokenEnvVar}}`,
        )
      if (Object.keys(resolvedHeaders).length) encoded.headers = resolvedHeaders
    }
    if (variant === 'antigravity' || variant === 'windsurf')
      encoded.serverUrl = expand(config.url)
    else if (variant === 'qwen' && transport === 'streamable-http')
      encoded.httpUrl = expand(config.url)
    else encoded.url = expand(config.url)
    if (opencode) encoded.type = 'remote'
    if (variant === 'cline')
      encoded.type = transport === 'sse' ? 'sse' : 'streamableHttp'
    if (
      ['claude', 'copilot', 'pi', 'kimi'].includes(variant) ||
      (transport === 'sse' && variant !== 'qwen')
    )
      encoded.type = transport === 'streamable-http' ? 'http' : transport
  }
  if (variant === 'copilot' && encoded.tools === undefined)
    encoded.tools = ['*']
  return encoded
}
