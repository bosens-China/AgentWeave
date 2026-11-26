import type { Resource } from '@agentweave/protocol'
import { parseDocument, isMap } from 'yaml'
import { errorMessage } from '../errors.js'

export function utf8Text(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch {
    throw new Error('文件必须是有效的 UTF-8 文本')
  }
}

export function isSkillName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  )
}

const binaryControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u

export function skillFrontmatter(text: string) {
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    text,
  )?.[1]
  return header === undefined
    ? undefined
    : parseDocument(header, { prettyErrors: false })
}

export function skillName(text: string, fallback: string) {
  const yaml = skillFrontmatter(text)
  const name = isMap(yaml?.contents) ? yaml?.get('name') : undefined
  return typeof name === 'string' && name.trim() ? name.trim() : fallback
}

function instructionsText(text: string | undefined) {
  if (!text?.trim() || binaryControls.test(text))
    throw new Error('全局指令必须是非空的 Markdown 文本')
}

export function validateImport(resource: Resource): Resource {
  if (resource.kind === 'skill') {
    const encoded = resource.files?.['SKILL.md']
    if (!encoded) throw new Error('SKILL.md 缺失或为空')
    const text = utf8Text(Buffer.from(encoded, 'base64'))
    if (binaryControls.test(text))
      throw new Error('SKILL.md 必须是 Markdown 文本')
    const yaml = skillFrontmatter(text)
    if (!yaml) throw new Error('SKILL.md 缺少用 --- 包围的 YAML 元数据')
    const issue = yaml.errors[0] ?? yaml.warnings[0]
    if (issue) throw new Error(`SKILL.md 的 YAML 格式无效：${issue.message}`)
    if (!isMap(yaml.contents))
      throw new Error('SKILL.md 的 YAML 元数据必须是键值对')
    const name = yaml.get('name')
    if (!isSkillName(name))
      throw new Error(
        'SKILL.md 的 name 需为 1–64 个小写字母、数字或分隔用的连字符',
      )
    if (name !== resource.id)
      throw new Error(
        `SKILL.md 的 name「${name}」必须与目录名「${resource.id}」一致`,
      )
    const description = yaml.get('description')
    if (
      typeof description !== 'string' ||
      !description.trim() ||
      [...description].length > 1024
    )
      throw new Error('SKILL.md 的 description 必须是 1–1024 个字符的非空文本')
    return { ...resource, name }
  }
  if (resource.kind === 'instructions') instructionsText(resource.text)
  if (resource.kind === 'plugin') {
    const components = resource.components?.map((component) => {
      try {
        return validateImport(component)
      } catch (error) {
        throw new Error(
          `${component.sourcePath ?? component.name}：${errorMessage(error)}`,
          { cause: error },
        )
      }
    })
    return { ...resource, components }
  }
  return resource
}
