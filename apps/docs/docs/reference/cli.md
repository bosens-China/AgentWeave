# CLI 命令

安装后使用 `agentweave`。从源码运行时，用 `npm run cli --` 加同样的子命令。`agentweave --help` 会列出本机版本支持的用法。

## 扫描与中央仓库

| 命令                          | 用途                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `agentweave ui`               | 打开本地网页。                                           |
| `agentweave init`             | 扫描本机资源，并选择要导入的项目。                       |
| `agentweave scan [AGENT ...]` | 查看可导入资源及其导入标识。                             |
| `agentweave import ID ...`    | 导入选定项目。使用 `--replace ID` 可明确选择覆盖的版本。 |
| `agentweave list`             | 列出中央仓库中的资源。                                   |
| `agentweave save FILE`        | 从 JSON 文件保存资源。覆盖时使用 `--overwrite`。         |
| `agentweave remove KIND:ID`   | 确认后从中央仓库删除资源。                               |

## 新建本地资源

下例中的 `review.md` 只需要写 Skill 的 Markdown 正文。AgentWeave 会根据标识和描述生成 `SKILL.md` 的元数据。

```sh
agentweave create skill code-review --description "审查代码时检查常见问题" --file review.md
agentweave create mcp docs --url https://example.com/mcp
agentweave create mcp local-tool --command node --arg /path/to/server.js
agentweave create instructions my-rules --file rules.md
```

远程连接默认是 Streamable HTTP。旧版服务可加 `--transport sse`。本地启动参数用 `--arg` 逐个填写，参数本身以 `-` 开头时使用 `--arg=参数`。

## 目标与同步

| 命令                                     | 用途                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `agentweave targets [AGENT]`             | 查看 Agent 和支持的类型。指定 Agent 时显示 MCP 连接方式和全局指令路径。 |
| `agentweave profile AGENT [KIND ...]`    | 保存启动检查的类别。省略类别时清除该目标的检查范围。                    |
| `agentweave status`                      | 查看已保存范围的差异。                                                  |
| `agentweave sync AGENT KIND ...`         | 预览整类同步。使用 `--resource KIND:ID` 可选择单项。                    |
| `agentweave sync AGENT KIND ... --apply` | 在确认后应用同步。                                                      |

`AGENT` 使用表中的 [CLI 标识](./agents.md)。`KIND` 可以是 `skill`、`mcp`、`instructions` 或 `plugin`。例如，`skill:review` 指中央仓库里标识为 `review` 的 Skill。

要从插件中分发单项资源，可以使用 `--resource plugin:review-kit/skill:review`，并把同步类型设为 `skill`。

第三方项目可用 `agentweave capabilities --json` 查看兼容信息，并用 `agentweave distribute --from DIR --target AGENT` 预览分发已安装的 npm 包。完整示例和确认方式见[npm 包接入](../guide/npm-bundle.md)。

## GitHub 来源

| 命令                               | 用途                                       |
| ---------------------------------- | ------------------------------------------ |
| `agentweave github add URL`        | 检查地址并选择导入资源。                   |
| `agentweave github check`          | 查看已添加地址的更新状态。                 |
| `agentweave github sync SOURCE_ID` | 将指定 GitHub 来源的新内容同步到中央仓库。 |

## 常用选项

- `--root PATH` 指定本次命令使用的中央仓库位置。也可用 `AGENTWEAVE_HOME` 设置默认位置。
- `--json` 为支持的命令输出 JSON，便于脚本读取。可用 `agentweave targets --json` 查看示例。
- `--yes` 明确确认交互操作。执行 `sync` 时，仍需传入 `--apply` 才会应用变更。
- `agentweave ui --no-open` 只启动本地服务并打印地址。可加 `--port PORT` 使用指定端口。
