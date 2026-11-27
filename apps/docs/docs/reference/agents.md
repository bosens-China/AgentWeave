# 支持的 Agent

以下能力适用于本机的用户级全局配置。CLI 用下表的标识选择目标，网页显示 Agent 名称。

| Agent              | CLI 标识      | Skills | MCP  | 全局指令 | 完整插件 |
| ------------------ | ------------- | ------ | ---- | -------- | -------- |
| Codex              | `codex`       | 支持   | 支持 | 支持     | 支持     |
| Claude Code        | `claude`      | 支持   | 支持 | 支持     | 支持     |
| Pi                 | `pi`          | 支持   | 支持 | 支持     | 本地包   |
| OpenCode           | `opencode`    | 支持   | 支持 | 支持     | —        |
| Cursor             | `cursor`      | 支持   | 支持 | —        | 支持     |
| Antigravity 桌面版 | `antigravity` | 支持   | 支持 | 支持     | 支持     |
| Cline              | `cline`       | 支持   | 支持 | 支持     | —        |
| Windsurf           | `windsurf`    | 支持   | 支持 | 支持     | —        |
| Qwen Code          | `qwen`        | 支持   | 支持 | 支持     | —        |
| OpenClaw           | `openclaw`    | 支持   | —    | —        | —        |
| Kiro               | `kiro`        | 支持   | 支持 | 支持     | —        |
| GitHub Copilot CLI | `copilot`     | 支持   | 支持 | 支持     | —        |
| Kimi Code          | `kimi-code`   | 支持   | 支持 | 支持     | —        |

Codex 和 Claude Code 的完整插件安装与卸载需要各自的 CLI。Pi 由 AgentWeave 管理可读取的本地包，Pi 自己管理 npm 和 Git 包。

运行 `agentweave targets` 可查看当前版本的支持情况，指定 Agent（如 `agentweave targets claude`）可查看 MCP 连接方式和本机的全局指令路径。网页的「同步状态」也会显示这些信息。

## MCP 连接方式

AgentWeave 以 MCP `2026-07-28` 规范的两种标准连接方式为基准。本地服务使用启动命令（stdio），远程服务使用 Streamable HTTP。Agent 与服务在连接时决定使用的协议版本。[MCP 官方规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

Claude Code、Cursor、Cline、Windsurf、Qwen Code 和 Kimi Code 的适配器也可转换旧版 HTTP + SSE 配置。无法转换的连接方式和字段会在同步预览中提示。

## 用户级全局指令

中央仓库存放 Markdown 正文。以下是各目标的默认路径。配置目录可由对应 Agent 的环境变量调整，实际路径以「同步状态」为准。

| Agent              | 默认路径                                              |
| ------------------ | ----------------------------------------------------- |
| Codex              | `~/.codex/AGENTS.override.md` 或 `~/.codex/AGENTS.md` |
| Claude Code        | `~/.claude/CLAUDE.md`                                 |
| Pi                 | `~/.pi/agent/AGENTS.md`                               |
| OpenCode           | `~/.config/opencode/AGENTS.md`                        |
| Antigravity 桌面版 | `~/.gemini/GEMINI.md`                                 |
| Cline              | `~/.agents/AGENTS.md`                                 |
| Windsurf           | `~/.codeium/windsurf/memories/global_rules.md`        |
| Qwen Code          | `~/.qwen/QWEN.md`                                     |
| Kiro               | `~/.kiro/steering/AGENTS.md`                          |
| GitHub Copilot CLI | `~/.copilot/copilot-instructions.md`                  |
| Kimi Code          | `~/.kimi-code/AGENTS.md`                              |

Codex 优先读有内容的 `AGENTS.override.md`，同步时写入当前生效的文件。中央仓库没有指令且选择整类同步时，两处已有文件都会列在删除预览中，清理后 Codex 也就无法从另一份文件回退读到旧指令。[Codex 全局指令说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
