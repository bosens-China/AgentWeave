# GitHub 来源

AgentWeave 可以把公开 GitHub 仓库、目录或受支持的资源文件收进中央仓库。终端需要能运行 `git`。

## 添加来源

打开「中央仓库」的「GitHub 来源」页签，点击「添加 GitHub 仓库」。粘贴 HTTPS 地址，点击「预览资源」，再勾选要导入的项目。添加后，点击来源列表中的资源数量可查看该来源在中央仓库中的资源。

也可以从 CLI 添加，例如导入一个 Skill 目录。

预览会显示格式错误的文件和原因，有效资源仍可导入。具体规则见[导入本机资源](./getting-started.md#导入本机资源)。

```sh
agentweave github add https://github.com/openai/skills/tree/main/skills/.curated/pdf
```

## 检查与应用更新

每次打开网页会自动检查已添加的 GitHub 来源。也可在「GitHub 来源」页签点击「检查更新」。点击「预览更新」可查看新增、覆盖、删除和解除关联的资源。点击「确认更新」会应用预览中的变更。如果远端版本或中央仓库已变化，请重新预览。GitHub 新版可覆盖中央仓库中已跟踪资源的本地编辑。

应用更新时会重新校验文件。新版本出现格式错误时，AgentWeave 会显示原因并保留中央仓库里的原版本。

如果多个 GitHub 来源共用同一项中央资源，更新后出现不同版本时会提示选择。预览会列出受影响的其他来源。取消会保留当前版本；确认更新会解除其他来源对冲突资源的关联。

```sh
agentweave github check
agentweave github sync SOURCE_ID
```

将 `SOURCE_ID` 换成检查结果中的来源标识。随后可以按需[分发到 Agent](./sync.md)。

CLI 遇到共享资源冲突时会询问是否采用新版。自动化脚本可以用 `--yes --replace-shared` 明确允许采用新版并解除冲突关联。
