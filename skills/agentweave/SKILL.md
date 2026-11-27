---
name: agentweave
description: Use the AgentWeave CLI to manage, inspect, import, create, edit, and sync Skills, MCP servers, global instructions, and plugins across local AI coding agents (Codex, Claude Code, Pi, OpenCode, Cursor, Antigravity, Cline, Windsurf, Qwen Code, OpenClaw, Kiro, Copilot CLI, Kimi Code), GitHub sources, and npm bundles. Trigger when the user wants to sync agent configs, import/export skills or MCPs, manage GitHub resource sources, or operate AgentWeave from the terminal.
---

# AgentWeave CLI

使用 `agentweave` 管理本机中央仓库中的 Skills、MCP、全局指令（instructions）和插件（plugin），并在多个 AI Coding Agent 之间同步。

## Agent 操作原则

1. **非交互调用优先使用 `--json`**：所有读取、扫描、预览类命令均支持 `--json`，便于准确解析 `id`、`revision`、`changes`、`issues`、`missing`。
2. **先预览，再变更**：同步（`sync`）、分发（`distribute`）、GitHub 更新（`github sync`）、覆盖保存（`save --overwrite`）、删除（`remove`）、修改本机原文件（`source save`）前，先不带 `--apply` / `--yes` 预览差异；涉及删除、覆盖或共享配置冲突时，先向用户确认再传 `--apply --yes` 或 `--yes`。
3. **资源与类型标识**：
   - 资源类型（`KIND`）：`skill`、`mcp`、`instructions`、`plugin`
   - 中央资源标识（`KIND:ID`）：如 `skill:code-review`、`mcp:docs`、`instructions:my-rules`、`plugin:review-kit`
   - 插件内子组件标识：`plugin:<PLUGIN_ID>/<KIND>:<COMPONENT_ID>`（同步时将 `KIND` 设为子组件类型）
   - 常用 Agent 标识：`codex`、`claude`、`pi`、`opencode`、`cursor`、`antigravity`、`cline`、`windsurf`、`qwen`、`openclaw`、`kiro`、`copilot`、`kimi-code`（以 `agentweave targets --json` 实际检测结果为准）
4. **全局选项**：`--root PATH`（或环境变量 `AGENTWEAVE_HOME`）指定中央仓库位置；`--json` 输出 JSON；`--yes` / `-y` 非交互确认；`--version` 查看版本。

---

## 命令速查

### 1. 状态、能力与目标

```sh
agentweave capabilities --json          # 查询 CLI 版本、API 版本与特性
agentweave status --json                # 查看初始化状态、中央资源、漂移、本机变化与 GitHub 状态
agentweave targets --json               # 列出已检测的 Agent 及支持的资源类型
agentweave targets <AGENT> --json       # 查看指定 Agent 的 MCP 传输方式与全局指令路径
agentweave ui [--no-open] [--port PORT] # 启动本地 Web 界面
```

### 2. 扫描本机、检查/修复原文件与导入

```sh
agentweave init --skip --json           # 非交互跳过首次导入（标记 initialized=true）
agentweave scan [AGENT ...] --json      # 扫描本机候选项(candidates)、异常项(issues)、已移除项(missing)
agentweave import <ID...> [--replace <ID> ...] --json
```

当 `scan` 返回 `candidates` 或可编辑的 `issues`（如损坏的配置）时，可直接查看或修复本机原文件：

```sh
agentweave source files <SCAN_ID> --json
agentweave source read <SCAN_ID> [--path <REL_PATH>] --json
agentweave source save <SCAN_ID> --file <LOCAL_FILE> [--path <REL_PATH>] [--revision <REV>] --yes --json
```

> `source save` 会返回更新后的扫描结果与 `updatedId`，随后可用 `agentweave import <updatedId>` 导入。

### 3. 中央仓库管理（列出、查看、创建、编辑、删除）

```sh
agentweave list --json
agentweave show <KIND:ID> --json                  # 输出完整 Resource JSON（可用于编辑后 save）
agentweave show <KIND:ID> [--file <REL_PATH>]     # 文本查看详情、插件子组件列表或指定文件内容

# 新建资源（所有类型均可重复传入 --tag TAG）
agentweave create skill <ID> --description "<DESC>" --file <BODY.md> [--tag <TAG> ...] --json
agentweave create mcp <ID> --command <PROG> [--arg <ARG> ...] [--env KEY=VALUE ...] [--tag <TAG> ...] --json
agentweave create mcp <ID> --url <URL> [--transport streamable-http|sse] [--header KEY=VALUE ...] [--tag <TAG> ...] --json
agentweave create instructions <ID> --file <RULES.md> [--tag <TAG> ...] --json

# 从 JSON 文件保存或覆盖已有资源
agentweave save <RESOURCE.json> [--overwrite --yes] --json

# 删除中央资源
agentweave remove <KIND:ID> --yes --json
```

### 4. 启动检查范围与同步分发

```sh
agentweave profile --json                         # 列出当前已保存的启动检查范围
agentweave profile <AGENT> <KIND...> --json       # 设置指定 Agent 的检查类别
agentweave profile <AGENT> --json                 # 清除指定 Agent 的检查类别

# 预览整类同步（不改动目标）
agentweave sync <AGENT> <KIND...> --json
# 预览单项或插件子组件分发
agentweave sync <AGENT> <KIND> --resource <KIND:ID> --json
agentweave sync <AGENT> skill --resource plugin:<PLUGIN_ID>/skill:<SKILL_ID> --json
# 确认后应用同步
agentweave sync <AGENT> <KIND...> [--resource <KIND:ID> ...] --apply --yes --json
```

### 5. GitHub 来源管理

```sh
agentweave github list --json                     # 离线列出已添加的 GitHub 来源与 SOURCE_ID
agentweave github preview <URL> --json            # 预览仓库内可导入资源、revision 与候选 ID
# 非交互精确导入（无需冲突交互；覆盖冲突项用 --replace <ID>）
agentweave github add <URL> [ID ...] [--replace <ID> ...] [--revision <REV>] --json
agentweave github check --json                    # 联网检查所有已添加来源的更新状态
agentweave github sync <SOURCE_ID> --json         # 预览更新变更（不传 --yes 时仅返回预览）
agentweave github sync <SOURCE_ID> --yes [--replace-shared] --json
```

### 6. npm 包分发

```sh
agentweave distribute --from <PKG_DIR> --target <AGENT> [--overwrite] --json
agentweave distribute --from <PKG_DIR> --target <AGENT> [--overwrite] --apply --yes --json
```

---

## 常见操作配方

### A. 导入某 Agent 资源并同步到另一个 Agent

1. `agentweave scan cursor --json` 获取候选 `id`（若 `status === "conflict"` 需确认是否覆盖）。
2. `agentweave import <ID> --json`（覆盖用 `--replace <ID>`）。
3. `agentweave sync codex skill --resource skill:<NAME> --json` 预览差异。
4. 确认无误后执行 `agentweave sync codex skill --resource skill:<NAME> --apply --yes --json`。

### B. 修改已有中央资源

1. `agentweave show mcp:docs --json > /tmp/mcp-docs.json` 导出完整 JSON。
2. 编辑 `/tmp/mcp-docs.json`（修改 `name`、`tags`、`config`、`text` 或 `files` 中的 base64 内容）。
3. `agentweave save /tmp/mcp-docs.json --overwrite --yes --json` 写回中央仓库。

### C. 修复扫描出的异常项（`issues`）并导入

1. `agentweave scan --json` 查看 `issues` 中 `editable: true` 的条目 `id` 与 `reason`。
2. `agentweave source read <ISSUE_ID> --json` 获取原始 `content` 和 `revision`（插件先用 `source files <ISSUE_ID> --json` 找文件路径，再加 `--path`）。
3. 将修复后的内容写入临时文件，执行 `agentweave source save <ISSUE_ID> --file <FIXED_FILE> --revision <REV> --yes --json`。
4. 使用返回的 `updatedId` 执行 `agentweave import <updatedId> --json`。

### D. 恢复本机被移除的资源（`missing`）

1. `agentweave scan --json`（或 `agentweave status --json`）读取 `missing` 中的 `targetId`、`kind`、`key`。
2. 预览恢复：`agentweave sync <targetId> <kind> --resource <key> --json`。
3. 确认后应用：`agentweave sync <targetId> <kind> --resource <key> --apply --yes --json`。

### E. 非交互添加 GitHub 资源

1. `agentweave github preview <URL> --json` 获取 `revision` 与 `candidates`。
2. 选择无冲突项的 `id`（以及用户确认覆盖的冲突项用 `--replace <id>`），执行：
   `agentweave github add <URL> <ID1> --replace <ID2> --revision <REV> --json`
