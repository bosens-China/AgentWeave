# 快速上手

AgentWeave 管理这台电脑上的用户级全局资源。CLI 和本地网页共用中央仓库，默认位置是 `~/AgentWeave`。

## 安装与启动

安装 CLI 需要 Node.js 22.13 或更高版本。可以通过 npm 安装并打开网页。

```sh
npm install -g agentweave-cli
agentweave ui
```

本地构建的 npm 安装包也可以用 `npm install -g ./agentweave-cli-0.1.0.tgz` 安装。

浏览器会打开本地管理界面。手动打开时，使用终端显示的地址，默认是 `http://127.0.0.1:10107`。在终端操作时，可以运行 `agentweave init` 开始导入。

从仓库构建安装包的步骤见[开发说明](../development.md)。

## 导入本机资源

1. 首次打开时，AgentWeave 会扫描已检测到的 Agent 全局配置。
2. 打开导入列表，勾选想收进中央仓库的资源。
3. 同名且内容相同的资源会合并，并用标签记录来源。遇到同名但内容不同的资源时，选择保留的版本。
4. 确认导入后，在中央仓库查看资源。以后可通过「扫描本机」再次导入。

导入预览会显示格式错误的文件和原因，有效资源仍可勾选。AgentWeave 会检查下列内容。

- **Skill** 检查 `SKILL.md` 的 YAML 元数据、必填的 `name` 和 `description`，以及名称与目录是否一致。[Agent Skills 规范](https://agentskills.io/specification)
- **MCP** 检查 JSON 或 TOML 能否读取，启动命令或 HTTP(S) 服务地址是否有效，以及参数、环境变量和请求头等字段的类型。
- **全局指令** 检查是否为可读取的 UTF-8 Markdown 文本。
- **插件** 检查清单和 AgentWeave 读取的组件，例如声明的 Skills 位置和 MCP 配置文件。

目标的兼容性会在分发预览中再检查。

## 新建本地资源

打开中央仓库，点「添加资源」，选择「新建 Skill」「新建 MCP」或「新建全局指令」。保存后可从中央仓库预览分发。

- **Skill** 填写标识、描述和 Markdown 正文。标识用小写字母、数字和连字符，例如 `code-review`。AgentWeave 会自动生成 `SKILL.md`。
- **MCP** 根据服务提供的方式，填写本地启动命令或远程服务地址。请求头、环境变量可在相应的连接方式中填写。
- **全局指令** 填写名称和 Markdown 正文。分发时会使用目标 Agent 的全局文件名和目录。

也可以通过 [CLI 新建本地资源](../reference/cli.md#新建本地资源)。

## 第一次分发

在中央仓库找到一个 Skill，点「分发」，选择已安装且支持 Skills 的 Agent。先看变更预览，再点「确认并同步」。

如果想让目标的一整类资源与中央仓库对齐，可以在「同步目标」里选择类别。执行前查看[同步规则](./sync.md)，了解哪些资源会出现在删除预览中。
