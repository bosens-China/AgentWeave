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

代码可直接推送到 `main`。GitHub Actions 检查通过后，Release Please 根据上次发布以来的提交创建或更新发布 PR。确认版本和更新日志后，合并发布 PR；合并后的检查通过时，系统创建 Git 标签和 GitHub Release，并发布 `agentweave-cli`。普通代码推送不会直接发布 npm。

| 提交消息示例                                         | 版本变化                       |
| ---------------------------------------------------- | ------------------------------ |
| `fix(cli): 修复参数处理`                             | 补丁版本，例如 `0.1.0 → 0.1.1` |
| `perf: 加快资源扫描`                                 | 补丁版本                       |
| `feat: 支持分发 npm 包`                              | 小版本，例如 `0.1.0 → 0.2.0`   |
| `feat!: 调整分发接口` 或带 `BREAKING CHANGE:` 的提交 | 大版本，例如 `0.1.0 → 1.0.0`   |
| `docs:`、`chore:` 等常规维护                         | 跳过发版                       |

一次纳入多个提交时取最高的版本变化。使用 Squash Merge 时，把 PR 标题写成以上格式，并保留为最终提交的标题。自动创建的发布 PR 首次运行检查可能需要仓库维护者在 PR 页面点击批准工作流。

### 发布配置

在 `agentweave-cli` 的 npm 设置中配置 GitHub Actions Trusted Publisher：owner 为 `bosens-China`，仓库为 `AgentWeave`，Workflow filename 为 `release.yml`，Environment name 留空，允许 `npm publish`。参见 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。GitHub 仓库还需要允许 Actions 创建 PR。

CI 使用 GitHub OIDC 授权。如果 npm 发布任务失败，先确认该版本是否已经出现在 npm；未发布时，在对应的 Actions 运行中重新运行失败的任务。

## 编辑和预览文档

运行 `npm run docs:dev` 后，打开 `http://127.0.0.1:10108`。文档改动会在本地预览里更新。`npm run docs:build` 将静态文件输出到 `apps/docs/dist`，可用 `npm run docs:preview` 查看构建结果。
