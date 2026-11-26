import type { Resource } from '@agentweave/protocol'
import type { ParseError } from 'jsonc-parser'
import { errorMessage } from '../errors.js'
import { utf8Text } from '../central/validation.js'
import type { NativeTarget, ResourceEntry, SectionPlan } from './types.js'
import { readFile } from 'node:fs/promises'
import { parse as parseToml, stringify as encodeToml } from 'smol-toml'
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser'
import {
  checkName,
  fingerprint,
  keyOf,
  object,
  optional,
  pathState,
} from './files.js'

import { decodeServer, encodeServer } from './mcp-format.js'

export async function readMcp(target: NativeTarget) {
  if (!target.mcp) throw new Error(`${target.name} 不支持 MCP 配置`)
  const { key, path, format, variant } = target.mcp
  const expected = await pathState(path)
  const contents = await optional((file) => readFile(file), path)
  let raw: string
  let document: unknown
  try {
    raw = contents ? utf8Text(contents) : format === 'toml' ? '' : '{}\n'
    const errors: ParseError[] = []
    document =
      format === 'toml'
        ? parseToml(raw)
        : parseJsonc(raw, errors, { allowTrailingComma: true })
    if (!object(document) || errors.length) throw new Error('配置文件内容无效')
  } catch (error) {
    throw new Error(`${target.name} 的 MCP 配置无法读取，请先修复 ${path}`, {
      cause: error,
    })
  }
  const table = document[key]
  const nested =
    variant === 'opencode' &&
    (table === undefined ||
      (object(table) &&
        (!Object.keys(table).length ||
          (object(table.servers) && !Object.hasOwn(table.servers, 'type')) ||
          (!Object.hasOwn(table, 'servers') &&
            object(table.timeout) &&
            !Object.hasOwn(table.timeout, 'type')))))
  const nativeTarget = nested
    ? { ...target, mcp: { ...target.mcp, variant: 'opencode-v2' } }
    : target
  const field = nested ? [key, 'servers'] : [key]
  const section =
    (nested ? (object(table) ? table.servers : undefined) : table) ?? {}
  if (!object(section))
    throw new Error(`${target.name} 的 MCP 配置区格式无效：${path}`)
  const entries = new Map<string, Pick<ResourceEntry, 'path' | 'resource'>>()
  const invalidEntries: { id: string; reason: string; warning: string }[] = []
  for (const [id, value] of Object.entries(section)) {
    try {
      checkName(id)
      const config = decodeServer(value, nativeTarget)
      entries.set(id, {
        path,
        resource: { kind: 'mcp', id, name: id, config },
      })
    } catch (error) {
      const reason = errorMessage(error)
      invalidEntries.push({
        id,
        reason,
        warning: `${target.name} 的 MCP ${id}（${path}）：${reason}`,
      })
    }
  }
  return {
    expected,
    raw,
    document,
    section,
    field,
    entries,
    invalidEntries,
    warnings: invalidEntries.map(({ warning }) => warning),
    format,
    nativeTarget,
  }
}

export function planMcp(
  target: NativeTarget,
  snapshot: Awaited<ReturnType<typeof readMcp>>,
  desired: Map<string, Resource>,
  selective: boolean,
  warnings: string[],
): SectionPlan {
  if (!target.mcp) throw new Error(`${target.name} 不支持 MCP 配置`)
  const {
    entries,
    section,
    document,
    field,
    expected,
    raw,
    format,
    nativeTarget,
  } = snapshot
  const path = target.mcp.path
  const changes: SectionPlan['changes'] = []
  const patches = new Map<string, Record<string, unknown> | undefined>()
  for (const resource of desired.values()) {
    const previous = Object.hasOwn(section, resource.id)
      ? section[resource.id]
      : undefined
    if (previous && !entries.has(resource.id)) {
      warnings.push(
        `${target.name} 的 MCP ${resource.id} 有无法解析的原配置，本次保留`,
      )
      continue
    }
    try {
      const value = encodeServer(resource, nativeTarget, previous, warnings)
      const normalized = decodeServer(value, nativeTarget)
      if (
        previous &&
        fingerprint(entries.get(resource.id)?.resource.config) ===
          fingerprint(normalized)
      )
        continue
      patches.set(resource.id, value)
      changes.push({
        action: previous ? 'overwrite' : 'add',
        key: keyOf(resource),
        name: resource.name,
        kind: 'mcp',
        path,
      })
    } catch (error) {
      warnings.push(`${resource.name} → ${target.name}：${errorMessage(error)}`)
    }
  }
  if (!selective) {
    for (const [id, entry] of entries) {
      if (desired.has(id)) continue
      patches.set(id, undefined)
      changes.push({
        action: 'delete',
        key: keyOf(entry.resource),
        name: entry.resource.name,
        kind: 'mcp',
        path,
      })
    }
  }
  if (!changes.length) return { changes, operations: [] }
  let text = raw
  if (format === 'toml') {
    const settings = new Map(Object.entries(section))
    for (const [id, value] of patches) {
      if (value === undefined) settings.delete(id)
      else settings.set(id, value)
    }
    const updated = { ...document, [field[0]]: Object.fromEntries(settings) }
    if (!settings.size) delete updated[field[0]]
    text = encodeToml(updated)
    if (raw.split('\n').some((line) => /^\s*#/.test(line)))
      warnings.push('Codex 的 TOML 配置将重新排版，现有注释会被移除')
  } else {
    for (const [id, value] of patches) {
      text = applyEdits(
        text,
        modify(text, [...field, id], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      )
    }
  }
  return { changes, operations: [{ path, expected, text }] }
}
