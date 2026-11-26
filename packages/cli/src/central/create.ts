import { isSkillName, skillNameProblem } from './validation.js'

function requiredText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`请填写${label}。`)
  return value.trim()
}

export function newResource(input: Record<string, unknown>) {
  const id = requiredText(input.id, '资源标识')
  const { kind, tags } = input
  const base = { kind, id, name: id, tags }
  if (kind === 'skill') {
    if (!isSkillName(id))
      throw new Error(skillNameProblem(id).replace(/^name/u, 'Skill 标识'))
    const description = requiredText(input.description, 'Skill 描述')
    if ([...description].length > 1024)
      throw new Error(
        `Skill 描述最多 1024 个字符；当前 ${[...description].length} 个字符。`,
      )
    const body = input.text
    if (typeof body !== 'string' || !body.trim())
      throw new Error('请填写 Skill 正文。')
    const text = `---\nname: ${JSON.stringify(id)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`
    return {
      ...base,
      files: { 'SKILL.md': Buffer.from(text).toString('base64') },
    }
  }
  if (kind === 'instructions') {
    requiredText(input.text, '全局指令正文')
    return { ...base, text: input.text }
  }
  if (kind !== 'mcp') throw new Error('请选择可新建的资源类型。')
  const { transport } = input
  if (transport === 'stdio') {
    if (input.url !== undefined || input.headers !== undefined)
      throw new Error('stdio 使用启动命令、参数和环境变量。')
    const command = requiredText(input.command, '启动命令')
    return {
      ...base,
      config: {
        command,
        args: input.args,
        env: input.env,
      },
    }
  }
  if (transport !== 'streamable-http' && transport !== 'sse')
    throw new Error('请选择 MCP 连接方式。')
  if (
    input.command !== undefined ||
    input.args !== undefined ||
    input.env !== undefined
  )
    throw new Error('远程 MCP 使用服务 URL 和请求头。')
  const url = requiredText(input.url, '服务 URL')
  return {
    ...base,
    config: {
      url,
      ...(transport === 'sse' && { type: transport }),
      headers: input.headers,
    },
  }
}
