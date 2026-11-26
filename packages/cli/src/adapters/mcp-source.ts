import {
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
} from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { object } from './files.js'
import { decodeServer } from './mcp-format.js'
import { readMcp } from './mcp.js'

type Snapshot = Awaited<ReturnType<typeof readMcp>>

type Range = { start: number; end: number }

function restoreEntry(
  document: Record<string, unknown>,
  key: string,
  section: Record<string, unknown>,
  id: string,
  value: unknown,
) {
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(document)),
    document,
  ) as Record<string, unknown>
  copy[key] = Object.assign(
    Object.create(Object.getPrototypeOf(section)),
    section,
    { [id]: value },
  )
  return copy
}

function inlineTables(raw: string): Range[] {
  const ranges: Range[] = []
  const stack: number[] = []
  let quote = ''
  let comment = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (comment) {
      if (char === '\n') comment = false
      continue
    }
    if (quote) {
      if (quote[0] === '"' && char === '\\') {
        i++
        continue
      }
      if (raw.startsWith(quote, i)) {
        i += quote.length - 1
        quote = ''
      }
      continue
    }
    if (char === '#') {
      comment = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = raw.startsWith(char.repeat(3), i) ? char.repeat(3) : char
      i += quote.length - 1
    } else if (char === '{') stack.push(i)
    else if (char === '}' && stack.length)
      ranges.push({ start: stack.pop()!, end: i + 1 })
  }
  return ranges
}

function inlineToml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(', ')}]`
  if (object(value) && !(value instanceof Date))
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${inlineToml(item)}`)
      .join(', ')} }`
  return stringifyToml({ value })
    .replace(/^value\s*=\s*/u, '')
    .trim()
}

function patchInlineToml(
  snapshot: Snapshot,
  id: string,
  entry: Record<string, unknown>,
): string | undefined {
  if (isDeepStrictEqual(entry, snapshot.section[id])) return snapshot.raw
  const replacement = inlineToml(entry)
  for (const { start, end } of inlineTables(snapshot.raw)) {
    const original = snapshot.raw.slice(start, end)
    if (original.includes('#')) continue
    try {
      if (
        !isDeepStrictEqual(
          parseToml(`value = ${original}`).value,
          snapshot.section[id],
        )
      )
        continue
      const output =
        snapshot.raw.slice(0, start) + replacement + snapshot.raw.slice(end)
      const updated = parseToml(output)
      const section = updated[snapshot.field[0]]
      if (!object(section) || !isDeepStrictEqual(section[id], entry)) continue
      const restored = restoreEntry(
        updated,
        snapshot.field[0],
        section,
        id,
        snapshot.section[id],
      )
      if (isDeepStrictEqual(restored, snapshot.document)) return output
    } catch {
      // Ignore candidates that are not the selected inline table.
    }
  }
  return undefined
}

function tomlRanges(
  raw: string,
  key: string,
  id: string,
  trimTrailing = true,
): Range[] {
  const headers: { start: number; target: boolean }[] = []
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let offset = 0
  for (const line of lines) {
    const match = line.match(/^\s*(\[{1,2}.*?\]{1,2})\s*(?:#.*)?(?:\r?\n)?$/u)
    if (match) {
      try {
        const doc = parseToml(match[1])
        const section = doc[key]
        headers.push({
          start: offset,
          target: object(section) && Object.hasOwn(section, id),
        })
      } catch {
        // A line that is not a TOML table header may occur inside a string.
      }
    }
    offset += line.length
  }
  return headers.flatMap((header, index) => {
    if (!header.target) return []
    const end = headers[index + 1]?.start ?? raw.length
    const trailing = trimTrailing
      ? (raw
          .slice(header.start, end)
          .match(/(?:^[ \t]*(?:#[^\r\n]*)?\r?\n)+(?![\s\S])/mu)?.[0].length ??
        0)
      : 0
    return [{ start: header.start, end: end - trailing }]
  })
}

function parsedEntry(content: string, snapshot: Snapshot, id: string) {
  let doc: unknown
  if (snapshot.format === 'toml') {
    doc = parseToml(content)
    if (
      !object(doc) ||
      Object.keys(doc).length !== 1 ||
      !object(doc[snapshot.field[0]])
    )
      throw new Error('请只填写当前 MCP 服务的 TOML 配置')
    doc = doc[snapshot.field[0]]
  } else {
    const errors: ParseError[] = []
    doc = parseJsonc(content, errors, { allowTrailingComma: true })
    if (errors.length) throw new Error('MCP 配置的 JSON 格式无效')
  }
  if (
    !object(doc) ||
    Object.keys(doc).length !== 1 ||
    !Object.hasOwn(doc, id) ||
    !object(doc[id])
  )
    throw new Error(`请只填写当前 MCP 服务「${id}」的配置，不能修改服务名称`)
  decodeServer(doc[id], snapshot.nativeTarget)
  return doc[id]
}

function jsonServerNode(snapshot: Snapshot, id: string) {
  let node = parseTree(snapshot.raw, [], { allowTrailingComma: true })
  for (const key of [...snapshot.field, id]) {
    const matches = node?.children?.filter(
      (property) => property.children?.[0].value === key,
    )
    if (!matches?.length) throw new Error('MCP 服务已变化，请重新扫描')
    if (matches.length > 1)
      throw new Error('MCP 配置路径含重复键，请先整理原文件')
    node = matches[0].children?.[1]
  }
  if (!node) throw new Error('MCP 服务已变化，请重新扫描')
  return node
}

export function previewMcpSource(snapshot: Snapshot, id: string): string {
  if (!Object.hasOwn(snapshot.section, id))
    throw new Error('MCP 服务已变化，请重新扫描')
  if (snapshot.format === 'toml') {
    const ranges = tomlRanges(snapshot.raw, snapshot.field[0], id)
    const text = ranges
      .map(({ start, end }) => snapshot.raw.slice(start, end))
      .join('')
    try {
      const parsed = parseToml(text)
      const section = parsed[snapshot.field[0]]
      if (
        object(section) &&
        Object.keys(section).length === 1 &&
        isDeepStrictEqual(section[id], snapshot.section[id])
      )
        return text
    } catch {
      // Fall back to a readable standalone definition for less common TOML layouts.
    }
    return stringifyToml({
      [snapshot.field[0]]: { [id]: snapshot.section[id] },
    })
  }
  const node = jsonServerNode(snapshot, id)
  return `{\n  ${JSON.stringify(id)}: ${snapshot.raw.slice(node.offset, node.offset + node.length)}\n}\n`
}

export function patchMcpSource(
  snapshot: Snapshot,
  id: string,
  content: string,
): string {
  const entry = parsedEntry(content, snapshot, id)
  if (snapshot.format === 'toml') {
    const ranges = tomlRanges(snapshot.raw, snapshot.field[0], id)
    if (!ranges.length) {
      const output = patchInlineToml(snapshot, id, entry)
      if (output !== undefined) return output
      throw new Error('当前 TOML 布局无法安全修改单个服务，请在原文件中编辑')
    }
    const editedRanges = tomlRanges(content, snapshot.field[0], id, false)
    let output = ''
    let cursor = 0
    ranges.forEach(({ start, end }, index) => {
      output += snapshot.raw.slice(cursor, start)
      if (editedRanges.length === ranges.length) {
        const edited = editedRanges[index]
        const part = `${index === 0 ? content.slice(0, edited.start) : ''}${content.slice(edited.start, edited.end)}`
        output += part.endsWith('\n') ? part : `${part}\n`
      } else if (index === 0) output += `${content.trimEnd()}\n`
      cursor = end
    })
    output += snapshot.raw.slice(cursor)
    let updated: Record<string, unknown>
    try {
      updated = parseToml(output)
    } catch {
      throw new Error('当前 TOML 布局无法安全修改单个服务，请在原文件中编辑')
    }
    const section = updated[snapshot.field[0]]
    if (
      !object(section) ||
      !Object.hasOwn(section, id) ||
      !isDeepStrictEqual(section[id], entry)
    )
      throw new Error('当前 TOML 布局无法安全修改单个服务，请在原文件中编辑')
    const restored = restoreEntry(
      updated,
      snapshot.field[0],
      section,
      id,
      snapshot.section[id],
    )
    if (!isDeepStrictEqual(restored, snapshot.document))
      throw new Error('修改会影响其他配置，请在原文件中编辑')
    return output
  }
  const errors: ParseError[] = []
  const edited = parseTree(content, errors, { allowTrailingComma: true })
  if (edited?.type !== 'object' || edited.children?.length !== 1)
    throw new Error(`请只填写当前 MCP 服务「${id}」的配置，不能修改服务名称`)
  const value = edited && findNodeAtLocation(edited, [id])
  const existing = jsonServerNode(snapshot, id)
  if (errors.length || !value) throw new Error('MCP 服务已变化，请重新扫描')
  return (
    snapshot.raw.slice(0, existing.offset) +
    content.slice(value.offset, value.offset + value.length) +
    snapshot.raw.slice(existing.offset + existing.length)
  )
}
