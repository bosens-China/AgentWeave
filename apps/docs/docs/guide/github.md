# GitHub 来源

AgentWeave 可以把公开 GitHub 仓库、目录或受支持的资源文件收进中央仓库。终端需要能运行 `git`。

## 添加来源

在「GitHub 来源」页点「添加来源」，粘贴 HTTPS 地址。点「检查资源」后选择要导入的项目，再确认添加。也可以从 CLI 添加，例如导入一个 Skill 目录。

预览会显示格式错误的文件和原因，有效资源仍可导入。具体规则见[导入本机资源](./getting-started.md#导入本机资源)。

```sh
agentweave github add https://github.com/openai/skills/tree/main/skills/.curated/pdf
```

## 检查与应用更新

每次打开网页会自动检查已添加的 GitHub 来源。也可以点「检查更新」。打开更新预览可看到新增、覆盖、删除和解除关联的资源。点击「确认更新」会应用这次预览。如果远端版本或中央仓库已变化，需要重新预览。对于已跟踪的资源，GitHub 新版可覆盖中央仓库里的本地编辑。

应用更新时会重新校验文件。新版本出现格式错误时，AgentWeave 会显示原因并保留中央仓库里的原版本。

如果多个 GitHub 来源共用同一项中央资源，更新后出现不同版本时会提示选择。预览会列出受影响的其他来源。取消会保留当前版本；确认更新会解除其他来源对冲突资源的关联。

```sh
agentweave github check
agentweave github sync SOURCE_ID
```

将 `SOURCE_ID` 换成检查结果中的来源标识。随后可以按需[分发到 Agent](./sync.md)。

CLI 遇到共享资源冲突时会询问是否采用新版。自动化脚本可以用 `--yes --replace-shared` 明确允许采用新版并解除冲突关联。
