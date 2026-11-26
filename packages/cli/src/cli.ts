#!/usr/bin/env node
import type {
  ComparedCandidate,
  Selection,
  SyncPlan,
} from '@agentweave/protocol'
import { errorMessage } from './errors.js'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { startServer } from './server.js'
import { createService } from './service.js'
import { utf8Text } from './central/validation.js'

const help = `AgentWeave

  agentweave                           首次导入或查看状态
  agentweave ui [--no-open]             打开本地网页
  agentweave capabilities --json        查询 CLI 兼容版本和接入能力
  agentweave distribute --from DIR --target AGENT [--apply]
  agentweave init                       扫描并选择导入资源
  agentweave scan [AGENT ...]            查看可导入资源和导入标识
  agentweave import ID ...               导入指定资源（--replace ID 可显式覆盖）
  agentweave list                       列出中央资源
  agentweave create skill ID --description TEXT --file FILE
  agentweave create mcp ID --command PROGRAM [--arg ARG ...]
  agentweave create mcp ID --url URL [--transport streamable-http|sse]
  agentweave create instructions ID --file FILE
  agentweave save FILE [--overwrite]     从 JSON 文件保存资源
  agentweave remove KIND:ID              删除中央资源
  agentweave targets [AGENT]             查看 Agent 和支持的类型
  agentweave profile AGENT [KIND ...]     设置启动时检查的类型（省略类型则清除）
  agentweave sync AGENT KIND ...         预览类别同步（--resource KIND:ID 指定单项）
  agentweave sync AGENT KIND --apply     应用预览，确认后再改动目标
  agentweave github add URL              把 GitHub 资源加入中央仓库
  agentweave github check                检查已添加的 GitHub 来源
  agentweave github sync SOURCE_ID [--yes] [--replace-shared]
  agentweave status                      查看启动检查结果

全局选项  --root PATH  --json  --yes  --help  --version
资源类型  skill  mcp  instructions  plugin`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    root: { type: 'string' },
    port: { type: 'string' },
    json: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    apply: { type: 'boolean' },
    resource: { type: 'string', multiple: true },
    replace: { type: 'string', multiple: true },
    'replace-shared': { type: 'boolean' },
    from: { type: 'string' },
    target: { type: 'string' },
    revision: { type: 'string' },
    overwrite: { type: 'boolean' },
    description: { type: 'string' },
    file: { type: 'string' },
    command: { type: 'string' },
    arg: { type: 'string', multiple: true },
    url: { type: 'string' },
    transport: { type: 'string' },
    'no-open': { type: 'boolean' },
    dev: { type: 'boolean' },
  },
})

function print(value: unknown): void {
  if (values.json) console.log(JSON.stringify(value, null, 2))
  else if (Array.isArray(value)) value.forEach((row) => print(row))
  else
    console.log(
      stripVTControlCharacters(String(value)).replace(
        /[\u0000-\u0008\u000b-\u001f\u007f]/g,
        '',
      ),
    )
}

async function question(prompt: string) {
  const line = createInterface({ input: stdin, output: stdout })
  try {
    return (await line.question(prompt)).trim()
  } finally {
    line.close()
  }
}

async function confirm(prompt: string) {
  if (values.yes) return true
  if (!stdin.isTTY || !stdout.isTTY || values.json) {
    throw new Error('请在交互终端确认操作，或显式传入 --yes。')
  }
  return /^y(es)?$/i.test(await question(`${prompt} [y/N] `))
}

async function chooseCandidates(
  candidates: ComparedCandidate[],
): Promise<Selection[]> {
  if (!candidates.length) return []
  const bulk = candidates.filter((candidate) => !candidate.builtin)
  if (values.yes) {
    if (
      bulk.some((c) => c.status === 'conflict' || c.componentConflict?.length)
    ) {
      throw new Error('发现重名冲突，请交互选择要保留的版本。')
    }
    return bulk.map(({ id }) => ({ id }))
  }
  if (!stdin.isTTY || !stdout.isTTY || values.json) {
    throw new Error('请在交互终端选择导入项，或在无冲突时显式传入 --yes。')
  }
  candidates.forEach(
    ({ resource, status, targetId, componentConflict, builtin }, index) => {
      const label = componentConflict?.length
        ? '组件冲突：' + componentConflict.join('、')
        : { new: '新增', same: '合并来源', conflict: '重名冲突' }[status]
      print(
        `${index + 1}. ${resource.name}  ${resource.kind} · ${targetId} · ${label}${builtin ? ' · 内置' : ''}`,
      )
    },
  )
  const answer = await question(
    candidates.some((c) => c.builtin)
      ? '输入要导入的序号（all 跳过内置插件，内置插件可单独输入序号，直接回车跳过） '
      : '输入要导入的序号（逗号分隔，all 选全部，直接回车跳过） ',
  )
  if (!answer) return []
  if (
    /^all$/i.test(answer) &&
    bulk.some((c) => c.status === 'conflict' || c.componentConflict?.length)
  ) {
    throw new Error('有重名冲突，请用序号逐项选择保留的版本。')
  }
  const selected = /^all$/i.test(answer)
    ? bulk
    : [...new Set(answer.split(/[,，\s]+/).map(Number))].map(
        (index) => candidates[index - 1],
      )
  if (selected.some((row) => !row)) throw new Error('导入序号无效。')
  return selected.map(({ id, conflictWithRepository }) => ({
    id,
    replace: !!conflictWithRepository,
  }))
}

function printPlan({
  changes,
  warnings,
  affectedTargets,
}: Omit<SyncPlan, 'revision'>) {
  const labels = { add: '新增', overwrite: '覆盖', delete: '删除' }
  warnings.forEach((warning) => print(`提示  ${warning}`))
  if (affectedTargets.length > 1)
    print(`受影响的 Agent  ${affectedTargets.join('、')}`)
  if (!changes.length) print('当前没有待同步的变更。')
  changes.forEach(({ action, kind, name, path }) =>
    print(`${labels[action]}  ${name} (${kind})  ${path}`),
  )
}

function openBrowser(url: string) {
  const launcher =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open'
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(launcher, args, { stdio: 'ignore', detached: true })
  child.on('error', () => print(`请在浏览器中打开 ${url}`))
  child.unref()
}

async function main() {
  const [command, ...args] = positionals
  if (values.help || command === 'help') return print(help)
  const { run } = createService({ root: values.root })
  if (values.version) return print((await run('capabilities')).version)
  if (command === 'capabilities')
    return console.log(JSON.stringify(await run('capabilities'), null, 2))
  if (command === 'ui' || command === 'serve') {
    const port = values.port === undefined ? 10107 : Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('端口必须是 0–65535 内的整数。')
    const { url } = await startServer(
      { run },
      { port, dev: values.dev === true },
    )
    print(url)
    if (command === 'ui' && !values['no-open']) openBrowser(url)
    return
  }

  if (
    command === 'init' ||
    !command ||
    command === 'status' ||
    command === 'list' ||
    command === 'targets'
  ) {
    const overview = await run('overview')
    if (
      command === 'init' ||
      (!command &&
        !overview.initialized &&
        (values.yes || (stdin.isTTY && !values.json)))
    ) {
      const { candidates, warnings } = await run('scan')
      if (!values.json) warnings.forEach((warning) => print(`提示  ${warning}`))
      const selections = await chooseCandidates(candidates)
      const imported = await run('import', { selections })
      return print(
        values.json
          ? imported
          : `首次设置完成，已确认 ${selections.length} 项资源。`,
      )
    }
    if (command === 'list') {
      const rows = overview.resources.map(({ kind, id, name, tags }) => ({
        kind,
        id,
        name,
        tags,
      }))
      return print(
        values.json
          ? rows
          : rows.map(({ kind, id, name }) => `${kind}:${id}  ${name}`),
      )
    }
    if (command === 'targets') {
      if (args[0]) {
        const target = overview.targets.find(({ id }) => id === args[0])
        if (!target) throw new Error(`未知 Agent ${args[0]}。`)
        return print(
          values.json
            ? target
            : [
                `${target.name}  ${target.kinds.join('、')}`,
                ...(target.mcpTransports
                  ? [
                      `MCP（中央基准 ${overview.mcpProtocolBaseline}）  ${target.mcpTransports.join('、')}`,
                    ]
                  : []),
                ...(target.instructionsPaths ?? []),
              ],
        )
      }
      return print(
        values.json
          ? overview.targets
          : overview.targets.map(
              ({ id, name, detected, kinds }) =>
                `${id}  ${name}  ${detected ? '已检测到' : '未检测到'}  ${kinds.join('、')}`,
            ),
      )
    }
    const [local, github] = await Promise.all([
      run('scan'),
      overview.sources.length ? run('check-github') : [],
    ])
    const added = new Set(
      local.candidates
        .filter(
          (c) =>
            c.status === 'new' &&
            !c.componentConflict?.length &&
            !c.bundledBy?.length,
        )
        .map((c) => c.resource.kind + ':' + c.resource.id),
    ).size
    const conflicts = new Set(
      local.candidates
        .filter((c) => c.status === 'conflict' || c.componentConflict?.length)
        .map((c) => c.resource.kind + ':' + c.resource.id),
    ).size
    if (values.json)
      return print({
        ...overview,
        local: {
          added,
          conflicts,
          missing: local.missing,
          issues: local.issues,
        },
        github,
      })
    print(
      `本机新增 ${added} 项，冲突 ${conflicts} 项，已移除 ${local.missing?.length ?? 0} 项。运行 agentweave ui 可选择导入或恢复。`,
    )
    for (const source of github.filter((s) => s.status !== 'current'))
      print(
        `GitHub ${source.url}  ${source.status === 'update' ? '有更新' : source.error}`,
      )
    print(
      `中央仓库 ${overview.resources.length} 项资源，已检测到 ${overview.targets.filter(({ detected }) => detected).length} 个 Agent。`,
    )
    if (!overview.initialized)
      print('运行 agentweave init 或 agentweave ui 开始首次设置。')
    for (const { targetId, ...plan } of overview.drift) {
      print(`\n${targetId}`)
      printPlan(plan)
    }
    return
  }

  if (command === 'scan') {
    const result = await run('scan', {
      targetIds: args.length ? args : undefined,
    })
    if (values.json) return print(result)
    return print([
      ...result.warnings.map((warning) => `提示  ${warning}`),
      ...result.candidates.map(
        ({ id, status, targetId, resource, componentConflict, builtin }) =>
          `${id}  ${targetId}  ${resource.name}  ${status}${builtin ? '  内置' : ''}${componentConflict?.length ? `  组件版本不同：${componentConflict.join('、')}` : ''}`,
      ),
    ])
  }
  if (command === 'import') {
    const replacements = new Set(values.replace || [])
    const selections = [...new Set([...args, ...replacements])].map((id) => ({
      id,
      replace: replacements.has(id),
    }))
    if (!selections.length)
      throw new Error('请从 agentweave scan 选择至少一项。')
    const result = await run('import', { selections })
    return print(values.json ? result : `已处理 ${selections.length} 项导入。`)
  }
  if (command === 'create') {
    const [kind, id] = args
    if (!id || !['skill', 'mcp', 'instructions'].includes(kind))
      throw new Error(
        '用法为 agentweave create skill|mcp|instructions ID，请查看 --help。',
      )
    const result = await run('create-resource', {
      kind,
      id,
      description: values.description,
      text:
        values.file && kind !== 'mcp'
          ? await readFile(values.file, 'utf8')
          : undefined,
      transport: values.transport ?? (values.url ? 'streamable-http' : 'stdio'),
      command: values.command,
      args: values.arg,
      url: values.url,
    })
    return print(values.json ? result : `已创建 ${result.kind}:${result.id}。`)
  }
  if (command === 'save') {
    if (!args[0]) throw new Error('请提供资源 JSON 文件。')
    const file = args[0]
    try {
      const resource: unknown = JSON.parse(
        utf8Text(await readFile(file)).replace(/^\uFEFF/, ''),
      )
      if (values.overwrite && !(await confirm('用该文件覆盖中央资源？'))) return
      const result = await run('save-resource', {
        resource,
        replace: values.overwrite,
        fromFile: true,
      })
      return print(values.json ? result : '已保存到中央仓库。')
    } catch (error) {
      throw new Error(`${file}：${errorMessage(error)}`, { cause: error })
    }
  }
  if (command === 'remove') {
    if (!args[0]) throw new Error('请提供资源标识。')
    if (!(await confirm('从中央仓库删除该资源？'))) return
    await run('delete-resource', { key: args[0] })
    return print(values.json ? { removed: true } : '已从中央仓库删除。')
  }
  if (command === 'profile') {
    const result = await run('set-profile', {
      targetId: args[0],
      kinds: args.slice(1),
    })
    return print(values.json ? result : '已保存启动检查设置。')
  }
  if (command === 'sync') {
    const request = {
      targetId: args[0],
      kinds: args.slice(1),
      keys: values.resource,
    }
    const plan = await run('preview-sync', request)
    if (values.json && (!values.apply || !plan.changes.length))
      return print(plan)
    if (!values.json) printPlan(plan)
    if (
      !values.apply ||
      !plan.changes.length ||
      !(await confirm('应用列出的同步变更？'))
    )
      return
    const result = await run('apply-sync', {
      ...request,
      revision: plan.revision,
    })
    return print(values.json ? result : '已完成同步。')
  }
  if (command === 'distribute') {
    if (!values.from || !values.target)
      throw new Error(
        '请使用 --from 指定 npm 包目录，并用 --target 指定目标 Agent。',
      )
    const request = {
      from: resolve(values.from),
      targetId: values.target,
      overwrite: values.overwrite,
    }
    const plan = await run('preview-bundle', request)
    if (!values.json) {
      print(
        `${plan.packageName}@${plan.packageVersion}  ${plan.resourceCount} 项资源`,
      )
      printPlan(plan)
    }
    if (!values.apply || !plan.resourceCount) {
      if (values.json) print(plan)
      return
    }
    if (values.revision && values.revision !== plan.revision)
      throw new Error('分发预览已过期，请重新预览。')
    if (!(await confirm('导入到中央仓库并应用列出的分发变更？'))) return
    const result = await run('apply-bundle', {
      ...request,
      revision: plan.revision,
    })
    return print(values.json ? result : '已导入并分发 npm 包资源。')
  }
  if (command === 'github' && args[0] === 'add') {
    const { url, revision, candidates, warnings } = await run(
      'preview-github',
      {
        url: args[1],
      },
    )
    for (const warning of warnings)
      console.error(stripVTControlCharacters(`提示  ${warning}`))
    const selections = await chooseCandidates(candidates)
    if (!selections.length)
      return print(values.json ? { added: false, warnings } : '未添加资源。')
    const result = await run('add-github', { url, revision, selections })
    return print(values.json ? result : `已添加 GitHub 来源 ${result.id}。`)
  }
  if (command === 'github' && args[0] === 'check') {
    const rows = await run('check-github')
    const status = { current: '已是最新', update: '有更新', error: '检查失败' }
    return print(
      values.json
        ? rows
        : rows.map(
            ({ id, url, status: state, error }) =>
              `${id}  ${url}  ${error || status[state]}`,
          ),
    )
  }
  if (command === 'github' && args[0] === 'sync') {
    const source = { id: args[1] }
    const preview = await run('preview-github-update', source)
    if (!values.json) {
      for (const change of preview.changes)
        print(`${change.action}  ${change.key}`)
      if (preview.shared) print(preview.shared.message)
    }
    if (
      preview.shared &&
      !values['replace-shared'] &&
      (!stdin.isTTY || values.json)
    ) {
      if (values.json)
        return print({ conflict: preview.shared, changes: preview.changes })
      throw new Error('共享来源冲突，请明确传入 --replace-shared。')
    }
    if (!values.yes || (preview.shared && !values['replace-shared'])) {
      if (!stdin.isTTY || !stdout.isTTY || values.json)
        return print(
          values.json ? preview : '以上为预览，传入 --yes 应用本次更新。',
        )
      if (
        !/^y(es)?$/i.test(await question('确认应用以上变更到中央仓库？ [y/N] '))
      )
        return print('已取消。')
    }
    const result = await run('sync-github', {
      ...source,
      token: preview.token,
      replaceShared: preview.shared?.token,
    })
    if ('conflict' in result) throw new Error('共享来源已变化，请重新预览')
    return print(values.json ? result : 'GitHub 资源已同步到中央仓库。')
  }
  throw new Error('未知命令，运行 agentweave --help 查看用法。')
}

main().catch((error) => {
  console.error(stripVTControlCharacters(errorMessage(error)))
  process.exitCode = 1
})
