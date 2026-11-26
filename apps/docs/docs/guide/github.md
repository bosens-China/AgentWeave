# GitHub 来源

AgentWeave 可以把公开 GitHub 仓库、目录或受支持的资源文件收进中央仓库。终端需要能运行 `git`。

## 添加来源

在「GitHub 来源」页点「添加来源」，粘贴 HTTPS 地址。点「检查资源」后选择要导入的项目，再确认添加。也可以从 CLI 添加，例如导入一个 Skill 目录。

预览会显示格式错误的文件和原因，有效资源仍可导入。具体规则见[导入本机资源](./getting-started.md#导入本机资源)。

```sh
agentweave github add https://github.com/openai/skills/tree/main/skills/.curated/pdf
```

## 检查与应用更新

「检查更新」会查询已添加的 GitHub 地址，并在来源旁显示更新状态。点「同步到中央仓库」后，AgentWeave 会拉取该地址的新内容。对于已跟踪的资源，GitHub 新版可覆盖中央仓库里的本地编辑。

应用更新时会重新校验文件。新版本出现格式错误时，AgentWeave 会显示原因并保留中央仓库里的原版本。

如果多个 GitHub 来源共用同一项中央资源，更新后出现不同版本时会提示选择。选「保留中央版本」可以取消这次更新。选「使用 GitHub 版本」会更新当前来源，并解除其他来源对冲突资源的关联。

```sh
agentweave github check
agentweave github sync SOURCE_ID
```

将 `SOURCE_ID` 换成检查结果中的来源标识。随后可以按需[分发到 Agent](./sync.md)。

CLI 遇到共享资源冲突时会询问是否采用新版。自动化脚本可以用 `--replace-shared` 明确允许采用新版并解除冲突关联。
