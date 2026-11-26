# 同步资源

AgentWeave 以中央仓库为基准，对齐本机 Agent 的用户级全局配置。编辑或删除中央资源时，改动只保存到中央仓库。向目标应用改动需要单独执行同步。

## 分发单项资源

在中央仓库选择一个资源，点「分发」，选择目标并预览。单项分发的改动范围是你选中的资源。打开插件详情后，也可以只分发其中的 Skill 或 MCP。

下面的命令预览把 `review` 分发给 Claude Code，第二条在终端确认后应用。

```sh
agentweave sync claude skill --resource skill:review
agentweave sync claude skill --resource skill:review --apply
```

## 对齐整类资源

在「同步目标」选择 Agent 和资源类别。预览列出新增、覆盖和删除，用户确认后才改动目标配置。

例如，Claude Code 的 Skills 已纳入同步，你后来又手动装了一个中央仓库里没有的 Skill。下次整类同步会把该 Skill 列为待删除项。想保留它时，可以先从本机导入中央仓库，再重新预览。

以下命令先保存 Claude Code 的全局 Skills 同步范围，再预览差异。

```sh
agentweave profile claude skill
agentweave sync claude skill
agentweave sync claude skill --apply
```

保存过范围的目标会在打开网页或运行 `agentweave status` 时检查差异。多个 Agent 共用同一个位置时，预览会列出可能受影响的 Agent。

## 同步完整插件

AgentWeave 按 Codex 插件结构解析资源。分发到其他 Agent 时，会转换可用的插件组件，并在预览中列出无法转换的组件。完整插件和独立组件的支持情况见[支持的 Agent](../reference/agents.md)。
