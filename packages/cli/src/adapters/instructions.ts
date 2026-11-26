import type { Resource } from '@agentweave/protocol'
import { utf8Text } from '../central/validation.js'
import type { NativeTarget, ResourceEntry, SectionPlan } from './types.js'
import { readFile } from 'node:fs/promises'
import { fingerprint, keyOf, optional, pathState } from './files.js'

export async function readInstructions(target: NativeTarget) {
  if (!target.instructionsPaths)
    throw new Error(`${target.name} 不支持全局指令`)
  const entries: ResourceEntry[] = []
  for (const path of target.instructionsPaths) {
    const bytes = await optional((file) => readFile(file), path)
    if (bytes === null) continue
    let text
    try {
      text = utf8Text(bytes)
    } catch (error) {
      throw new Error(`${path} 的全局指令必须是有效的 UTF-8 文本`, {
        cause: error,
      })
    }
    entries.push({
      path,
      expected: await pathState(path),
      resource: { kind: 'instructions', id: 'agents', name: 'AGENTS.md', text },
    })
  }
  const effective =
    target.id === 'codex'
      ? entries.find(({ resource }) => resource.text?.trim())
      : entries[0]
  return { entries, effective }
}

export function planInstructions(
  target: NativeTarget,
  { entries, effective }: Awaited<ReturnType<typeof readInstructions>>,
  desired: Map<string, Resource>,
  selective: boolean,
  warnings: string[],
): SectionPlan {
  const defaultPath = target.instructions
  if (!defaultPath) throw new Error(`${target.name} 不支持全局指令`)
  const resource = desired.values().next().value
  if (desired.size > 1) {
    warnings.push(
      `${target.name} 的全局位置只能使用一份指令文件，请单独选择一份分发`,
    )
    return { changes: [], operations: [] }
  }
  if (!resource) {
    if (selective) return { changes: [], operations: [] }
    return {
      changes: entries.map(({ path, resource }) => ({
        action: 'delete',
        path,
        key: keyOf(resource),
        name: resource.name,
        kind: 'instructions',
      })),
      operations: entries.map(({ path, expected, resource }) => ({
        path,
        expected,
        beforeFingerprint: fingerprint(resource.text),
      })),
    }
  }
  if (typeof resource.text !== 'string') throw new Error('指令资源缺少正文')
  if (
    target.instructionsLimit &&
    [...resource.text].length > target.instructionsLimit
  ) {
    warnings.push(
      `${target.name} 的全局指令最多读取 ${target.instructionsLimit} 字符，当前资源无法完整分发`,
    )
    return { changes: [], operations: [] }
  }
  if (target.id !== 'claude' && /^(?:@|!\[)[^\s]/m.test(resource.text)) {
    warnings.push(
      `${resource.name} 含有文件引用，请确认 ${target.name} 能读取这些引用`,
    )
  }
  const path = effective?.path ?? defaultPath
  const current = effective ?? entries.find((entry) => entry.path === path)
  if (path !== defaultPath && !resource.text.trim()) {
    warnings.push('Codex 会跳过空指令文件，无法用空白内容覆盖当前全局指令')
    return { changes: [], operations: [] }
  }
  if (resource.text === current?.resource.text)
    return { changes: [], operations: [] }
  const action = current ? 'overwrite' : 'add'
  const changes: SectionPlan['changes'] = [
    {
      action,
      path,
      key: keyOf(resource),
      name: resource.name,
      kind: 'instructions',
    },
  ]
  return {
    changes,
    operations: [
      {
        path,
        expected: current?.expected ?? null,
        text: resource.text,
        beforeFingerprint: fingerprint(current?.resource.text),
      },
    ],
  }
}
