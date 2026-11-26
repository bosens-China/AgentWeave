# npm 包接入

项目作者可以在一个 npm 包中附带 Skills 和 MCP，再用 AgentWeave 将它们分发到用户选定的 Agent。npm 包可以沿用 Codex 插件清单或通用插件格式，也可以直接包含 `skills/`、`mcp.json` 或 `.mcp.json`。资源会先通过格式校验。

## 探测 AgentWeave

项目的接入脚本先找项目内已安装的 CLI，再找 `PATH` 上的 CLI。用以下命令确认候选程序支持所需功能。

```sh
agentweave capabilities --json
```

接入脚本需要确认 `apiVersions` 包含 `1`，并且 `features` 包含 `distribute-npm-bundle`。CLI 的 npm 版本写在 `version` 中，可以在出错时用于提示。没有兼容版本时，可以让用户选择安装或通过 `npx` 调用项目已经验证过的完整版本。

## 分发到目标

`--from` 传入已安装或已解包的 npm 包目录。目标标识见[支持的 Agent](../reference/agents.md)。

```sh
agentweave distribute --from /path/to/installed-package --target claude --json
agentweave distribute --from /path/to/installed-package --target claude --apply
```

第一条命令返回预览。脚本可以把 JSON 里的 `revision` 传给第二条命令的 `--revision`，确保用户确认的预览仍然有效。非交互环境中，用户已经确认时可传入 `--yes`。中央仓库已有不同的同名版本时，在决定采用包内内容后加入 `--overwrite` 并重新预览。

分发范围只包括包内资源。被目标识别的资源会进入中央仓库，并带上 npm 包名和版本标签。目标无法转换的资源会在预览中提示。

## 本地 MCP 的启动

对于本地 MCP，将 MCP 配置里的 `command` 写成 `package.json` 里声明的 Node.js `bin` 名称。只靠包内文件即可运行的服务会保存到中央仓库的运行目录。需要 npm 运行依赖的服务复用已有的持久安装，传入的是已安装包的目录。远程 MCP 可以直接填写服务 URL。

## 试跑示例

也可以用 GitHub Release 里的示例安装包发起预览。`--with-npx` 允许在本机缺少兼容 CLI 时下载示例固定的 CLI 版本。

```sh
npx --package=https://github.com/bosens-China/AgentWeave/releases/download/v0.1.0/agentweave-example-bundle-0.1.0.tgz \
  agentweave-example-bundle setup --agent claude --with-npx
```

在 AgentWeave 仓库根目录把示例打包，再让 `npx` 从本地归档运行它。先用 `--agentweave` 指向现有 CLI 的构建产物。

```sh
pnpm build
npm pack ./examples/npm-bundle --pack-destination dist
npx --package="$PWD/dist/agentweave-example-bundle-0.1.0.tgz" \
  agentweave-example-bundle setup --agent claude \
  --agentweave "$PWD/packages/cli/dist/cli.mjs"
```

预览符合预期后，加 `--apply` 确认分发。已有兼容的全局或项目内安装时可以省略 `--agentweave`。示例在找不到兼容版本时，可用 `--with-npx` 明确允许下载其验证过的工具版本。
