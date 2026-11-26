# 开发说明

## 准备环境

源码开发使用 pnpm workspace。支持 Node.js 22.18 起的 22.x、24.11 起的 24.x，以及从 26 起的版本。在仓库根目录运行下面的命令安装依赖，并启用项目的预提交检查。

```sh
npm run setup
```

## Workspace 结构

| 目录                | 内容                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `packages/cli`      | TypeScript CLI、Hono 本地 API 和 Agent 适配。开发时由 `tsx` 运行，发布时由 `tsdown` 构建。 |
| `apps/web`          | React TSX 管理界面，由 Vite 构建，使用 UnoCSS 和 Ant Design 默认主题。                     |
| `packages/protocol` | CLI 和网页共用的 API 类型。                                                                |
| `apps/docs`         | 使用 Rspress 构建的文档站。Markdown 源文件位于 `apps/docs/docs`。                          |

## 本地开发

在仓库根目录运行以下命令。依赖已安装时，直接运行 `pnpm dev`。

```sh
pnpm install
pnpm dev
```

打开 [本地网页](http://127.0.0.1:5173)。Vite 在 `127.0.0.1:5173` 提供网页，并把 `/api` 请求转发给 `127.0.0.1:10107` 的 Hono。按 `Ctrl+C` 停止开发服务。需要分别启动时，可用 `pnpm dev:web` 和 `pnpm dev:api`。

### CLI 和网页

CLI 与 Hono 共用 `packages/cli/src/service.ts` 的业务入口。CLI 解析命令参数并显示结果，Hono 解析 HTTP 请求并返回 JSON。资源校验、仓库存取、导入和分发规则都由共享业务层处理。

```sh
pnpm cli --help
pnpm cli list
```

CLI 可独立运行。默认情况下，CLI 和网页读写同一个 `~/AgentWeave` 仓库。若通过 `AGENTWEAVE_HOME` 指定其他仓库路径，要对两边使用相同的值。

运行 `pnpm typecheck` 检查类型，运行 `pnpm test` 验证业务流程。`pnpm format` 可格式化源码和文档。

## 构建 CLI 安装包

```sh
npm run pack:cli
npm install -g ./dist/agentweave-cli-0.1.0.tgz
agentweave ui
```

安装包同时包含编译后的 CLI 和网页。也可以用 `npm run build` 构建仓库里的 CLI 和网页，再用 `npm run ui` 直接打开本地界面。

## 自动发布 npm 版本

GitHub Actions 会检查指向 `main` 的 PR。PR 通过审核和检查并合入受保护的 `main` 后，semantic-release 根据上一个发布标签以来的提交消息，决定是否发布新版。发布包的 `package.json`、Git 标签和 GitHub Release 使用同一个版本号。发布目标是 `agentweave-cli`。

| 提交消息示例                                         | 版本变化                       |
| ---------------------------------------------------- | ------------------------------ |
| `fix(cli): 修复参数处理`                             | 补丁版本，例如 `0.1.0 → 0.1.1` |
| `perf: 加快资源扫描`                                 | 补丁版本                       |
| `feat: 支持分发 npm 包`                              | 小版本，例如 `0.1.0 → 0.2.0`   |
| `feat!: 调整分发接口` 或带 `BREAKING CHANGE:` 的提交 | 大版本，例如 `0.1.0 → 1.0.0`   |
| `docs:`、`chore:` 等常规维护                         | 跳过发版                       |

一次纳入多个提交时取最高的版本变化。使用 Squash Merge 时，把 PR 标题写成以上格式，并保留为最终提交的标题。

### 首次发布设置

1. 将源码推到 GitHub。在 `main` 的分支保护中要求 PR 审核和 `Check` 状态检查，并约束绕过权限。
2. 在用于首发的 `main` 提交上运行 `pnpm pack:cli`，核对安装包中的版本和文件。用有包发布权限且启用了 2FA 的 npm 账户完成首发。
3. npm 包建立后，到包设置添加 GitHub Actions Trusted Publisher。填写真实 GitHub owner 和仓库名，Workflow filename 使用 `release.yml`，Environment name 留空，允许 `npm publish`。 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
4. 确认 npm 上可以查到首发版本，再给用于打包的 `main` 提交打上同版本标签并推送。以首发 `0.1.0` 为例，标签为 `v0.1.0`。后续 PR 合入后自动发布。

首发以 `0.1.0` 为例，在审核包内容并决定发布时执行以下命令。

```sh
npm login --registry https://registry.npmjs.org/
npm publish ./dist/agentweave-cli-0.1.0.tgz --access public --registry https://registry.npmjs.org/
```

CI 使用 GitHub OIDC 授权。发布包的仓库地址来自 `packages/cli/package.json`。如果发布任务报错，先核对相应版本是否已出现在 npm，以及 Git 标签是否已创建，再决定如何重试。

## 编辑和预览文档

运行 `npm run docs:dev` 后，打开 `http://127.0.0.1:10108`。文档改动会在本地预览里更新。`npm run docs:build` 将静态文件输出到 `apps/docs/dist`，可用 `npm run docs:preview` 查看构建结果。
