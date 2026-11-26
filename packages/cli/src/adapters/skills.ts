import type { Resource } from '@agentweave/protocol'
import { errorMessage } from '../errors.js'
import { isMap } from 'yaml'
import { skillFrontmatter, skillName, utf8Text } from '../central/validation.js'
import type { NativeTarget, ResourceEntry, SectionPlan } from './types.js'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  checkName,
  fingerprint,
  keyOf,
  optional,
  pathState,
  readTree,
} from './files.js'

type SkillEntry = ResourceEntry & { flat?: boolean }

function flatPayload(raw: Buffer, id: string) {
  const text = utf8Text(raw)
  if (/^(?:\uFEFF)?---\r?\n/.test(text)) {
    const yaml = skillFrontmatter(text)
    if (
      yaml &&
      isMap(yaml.contents) &&
      !yaml.errors.length &&
      !yaml.warnings.length &&
      !yaml.has('name')
    ) {
      return Buffer.from(
        text.replace(
          /^(?:\uFEFF)?---\r?\n/,
          `---\nname: ${JSON.stringify(id)}\n`,
        ),
      )
    }
    return Buffer.from(raw)
  }
  const firstLine =
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 240) ?? id
  return Buffer.from(
    `---\nname: ${JSON.stringify(id)}\ndescription: ${JSON.stringify(firstLine)}\n---\n\n${text}`,
  )
}

export async function readSkills(
  path: string,
  target: NativeTarget,
  { includeFlat = target.flatSkills } = {},
): Promise<{ entries: SkillEntry[]; warnings: string[] }> {
  const entries: SkillEntry[] = []
  const warnings: string[] = []
  async function walk(directory: string, depth: number) {
    const children = await optional(
      (path) => readdir(path, { withFileTypes: true }),
      directory,
    )
    for (const child of (children ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (child.name.startsWith('.') || child.name === 'node_modules') continue
      let full = join(directory, child.name)
      const logical = full
      try {
        // A top-level symlink is common with skills managers. Read its copy, never write through it.
        if (child.isSymbolicLink()) {
          if (depth !== 0) continue
          full = await realpath(full)
        }
        const kind = child.isSymbolicLink() ? await stat(full) : child
        if (
          kind.isFile() &&
          includeFlat &&
          depth === 0 &&
          extname(child.name) === '.md'
        ) {
          const id = checkName(basename(child.name, '.md'))
          const file = flatPayload(await readFile(full), id)
          const resource: Resource = {
            kind: 'skill',
            id,
            name: skillName(file.toString('utf8'), id),
            files: { 'SKILL.md': file.toString('base64') },
          }
          entries.push({
            path: logical,
            expected: await pathState(logical),
            flat: true,
            resource,
          })
        } else if (kind.isDirectory()) {
          const marker = await optional(lstat, join(full, 'SKILL.md'))
          if (marker) {
            const id = checkName(child.name)
            const contents = await readTree(full)
            if (!Object.hasOwn(contents.files, 'SKILL.md'))
              throw new Error('SKILL.md 不是普通文件')
            const name = skillName(
              Buffer.from(contents.files['SKILL.md'], 'base64').toString(
                'utf8',
              ),
              id,
            )
            entries.push({
              path: logical,
              expected: await pathState(logical),
              resource: { kind: 'skill', id, name, ...contents },
            })
          } else if (depth < 5 && !child.isSymbolicLink()) {
            await walk(full, depth + 1)
          }
        }
      } catch (error) {
        warnings.push(
          `${target.name} 的 Skill ${logical}：${errorMessage(error)}`,
        )
      }
    }
  }
  await walk(path, 0)
  return { entries, warnings }
}

function payload(resource: Resource) {
  return { files: resource.files, modes: resource.modes ?? {} }
}

export async function planSkills(
  target: NativeTarget,
  snapshot: { entries: SkillEntry[] },
  desired: Map<string, Resource>,
  selective: boolean,
  warnings: string[],
): Promise<SectionPlan> {
  const changes: SectionPlan['changes'] = []
  const operations: SectionPlan['operations'] = []
  const locations = new Map<string, SkillEntry[]>()
  for (const entry of snapshot.entries) {
    const id = entry.resource.id.toLowerCase()
    const matches = locations.get(id) ?? []
    matches.push(entry)
    locations.set(id, matches)
  }
  const targetIds = new Set()
  for (const resource of desired.values()) {
    const id = resource.id.toLowerCase()
    if (targetIds.has(id))
      throw new Error(`中央仓库中存在大小写冲突的 Skills：${resource.id}`)
    targetIds.add(id)
    const matches = locations.get(id) ?? []
    if (matches.length > 1) {
      warnings.push(
        `${target.name} 存在多个同名 Skill ${resource.id}，请选择并整理目标中的重复项`,
      )
      continue
    }
    const current = matches[0]
    const beforeFingerprint = fingerprint(
      current ? payload(current.resource) : null,
    )
    if (current && beforeFingerprint === fingerprint(payload(resource)))
      continue
    if (!resource.files || !Object.hasOwn(resource.files, 'SKILL.md')) {
      warnings.push(`${resource.name} 缺少 SKILL.md，无法分发`)
      continue
    }
    const path = current?.path ?? join(target.skills, checkName(resource.id))
    if (!current && (await pathState(path))) {
      warnings.push(`${path} 已存在，无法识别为有效 Skill，本次保留`)
      continue
    }
    changes.push({
      action: current ? 'overwrite' : 'add',
      key: keyOf(resource),
      name: resource.name,
      kind: 'skill',
      path,
    })
    if (!current?.flat) {
      operations.push({
        path,
        expected: current?.expected ?? null,
        beforeFingerprint,
        verifyTree: Boolean(current),
        ...payload(resource),
      })
    } else if (Object.keys(resource.files).length === 1) {
      operations.push({
        path,
        expected: current.expected,
        beforeFingerprint,
        text: Buffer.from(resource.files['SKILL.md'], 'base64').toString(
          'utf8',
        ),
      })
    } else {
      const folder = join(target.skills, checkName(resource.id))
      if (await pathState(folder))
        throw new Error(`无法将平铺 Skill 转为目录，位置已存在：${folder}`)
      operations.push({ path, expected: current.expected, beforeFingerprint })
      operations.push({ path: folder, expected: null, ...payload(resource) })
    }
  }
  if (!selective) {
    for (const [id, matches] of locations) {
      if (targetIds.has(id)) continue
      for (const entry of matches) {
        changes.push({
          action: 'delete',
          key: keyOf(entry.resource),
          name: entry.resource.name,
          kind: 'skill',
          path: entry.path,
        })
        operations.push({
          path: entry.path,
          expected: entry.expected,
          beforeFingerprint: fingerprint(payload(entry.resource)),
          verifyTree: !entry.flat,
        })
      }
    }
  }
  return { changes, operations }
}
