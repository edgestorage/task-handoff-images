# TaskHandoff Images

TaskHandoff Node Agent 受管 Docker 实例使用的公开 Linux 基础镜像。这是
[TaskHandoff](https://github.com/edgestorage/task-handoff) 的镜像侧仓库：应用
主仓拥有控制平面和 Node Agent，本仓库拥有这些 agent 运行的基础镜像。本仓库从
共享分层构建十一种 profile：

| 镜像 | 能力 |
| --- | --- |
| `task-handoff-controlled-base` | 仅 Terminal，不预装 AI CLI、浏览器、VNC 或桌面环境 |
| `task-handoff-controlled-desktop-minimal` | Terminal、Xvfb、Openbox、Tint2、jgmenu、xterm 和 X11 工具 |
| `task-handoff-controlled-desktop-xfce` | Terminal 和完整 X11 Xfce 会话 |
| `task-handoff-controlled-codex` | Terminal、Codex |
| `task-handoff-controlled-obscura` | Terminal、Codex、Obscura |
| `task-handoff-controlled-rea` | Terminal、Codex、REA、Linux 逆向工具链 |
| `task-handoff-controlled-opencode` | Terminal、OpenCode |
| `task-handoff-controlled-ai` | Terminal、Codex、Claude |
| `task-handoff-controlled-webcap` | GUI Terminal、Browser、WebCap、Codex、Claude |
| `task-handoff-controlled-bcap` | GUI Terminal、Browser、BCap、Codex、Claude |
| `task-handoff-controlled-browser` | GUI Terminal、Browser、VS Code Web、Codex、Claude |

这些镜像提供操作系统依赖、开发工具和 profile 元数据，不包含 TaskHandoff
controlled-instance 应用。创建容器时，Node Agent 会挂载其权威 bootstrap
bundle，把目标 controlled-instance runtime artifact 安装到持久化 runtime
volume，再启动该 runtime。

Codex、OpenCode 和 Claude 使用制品仓库中的 native package：镜像下载固定平台
tarball、校验完整性，并预置到
`/data/task-handoff/managed-apps/native/<app-id>/`，不会执行全局
`npm install`。新建实例的数据卷会继承这份预置内容；已有数据卷不会被镜像
更新覆盖，需要通过 App management 安装或更新这些应用。

Base、Desktop Minimal 和 Desktop Xfce 刻意不预置 Codex、OpenCode、Claude、
Chromium、KasmVNC、noVNC、WebCap、BCap、code-server 或 Remote Desktop。它们
在 market 中只声明 `terminal` capability；AI CLI 和 Remote Desktop 应在实例
创建后通过 App management 安装。

REA profile 会安装 REA 本体，并配好 `reverse-engineer-anything` agent skill 和
Codex MCP 注册；同时预装 REA 可直接驱动的 Linux 工具链：Chromium（网站分析）、
JDK 21（Ghidra 与 JADX）、pwntools（离线 ELF 与 crash 记录分析）、mitmproxy
（原生抓包）。分析引擎本体不打包，需自行提供 Ghidra（`GHIDRA_INSTALL_DIR`）、
IDA（`REA_IDA_MCP_CONFIG`）、headless JADX（`REA_JADX_MCP_JAR`）、binwalk
（`REA_BINWALK_COMMAND`）和 unblob（`REA_UNBLOB_COMMAND`）。

## 本地构建

构建默认的 Browser profile：

```sh
./scripts/docker-build-image.sh
```

通过 `TASK_HANDOFF_IMAGE_PROFILE` 选择其他 profile：

```sh
TASK_HANDOFF_IMAGE_PROFILE=codex ./scripts/docker-build-image.sh
TASK_HANDOFF_IMAGE_PROFILE=base ./scripts/docker-build-image.sh
TASK_HANDOFF_IMAGE_PROFILE=desktop-minimal ./scripts/docker-build-image.sh
TASK_HANDOFF_IMAGE_PROFILE=desktop-xfce ./scripts/docker-build-image.sh
```

按 market 顺序支持 `base`、`desktop-minimal`、`desktop-xfce`、`codex`、
`obscura`、`rea`、`opencode`、`ai`、`webcap`、`bcap` 和 `browser`。
`TASK_HANDOFF_IMAGE_REF` 可以覆盖本地镜像 tag。工具版本默认固定；其他版本
构建参数只用于本地测试。

## 桌面会话

Remote Desktop 是可选受管 App，不打进这些镜像。Linux 上它优先尝试现有 X11
`DISPLAY`，验证认证、采集 visual、SHM、Damage、XFixes、RandR、Composite 和
XTest；已有窗口管理器时直接复用。可连接但没有窗口管理器的 X server 会启动
发现的桌面会话，现有 display 不可用时才创建由 Remote Desktop 持有的 Xvfb。

标准 X11 会话从 `/usr/local/share/xsessions` 和 `/usr/share/xsessions` 发现。
标记为隐藏、格式错误、不可执行或 `TryExec` 缺失的条目会被忽略；标准会话通过
`dbus-run-session` 启动。安装多个有效会话时，用
`TASK_HANDOFF_DESKTOP_SESSION` 指定 session id、`Name` 或任一 `DesktopNames`；
仍无法唯一确定时返回 `REMOTE_DESKTOP_DESKTOP_UNAVAILABLE`。

Desktop Minimal 不提供标准 X11 session entry，使用内置 Openbox、Tint2 和 jgmenu
回退桌面。Desktop Xfce 提供标准 `xfce.desktop` 会话。已接管的 X server 不会被
终止，Remote Desktop 只停止自己创建的 Xvfb 或桌面进程组。

## 发布

本仓使用 `vX.Y.Z` 版本线。Pull Request 和发布只构建受变更影响的 profile，
包括继承了变更共享层的 profile。发布时为这些镜像构建 Linux amd64 和 arm64
版本，发布不可变的 `docker-sha-<commit>` tag，再提升为当前版本 tag。稳定版本
同时更新受影响镜像的 `latest`，alpha 和 beta 版本更新对应 channel。未变化的
镜像保留原有 tag，不要求具备每一个仓库版本。若某个 profile 尚无 `latest`，
发布流程会自动把它加入首次构建。

受影响 profile 的依赖图维护在 `scripts/resolve-changed-image-profiles.mjs`。
新增或重命名 Dockerfile stage/profile 时，必须同步更新该依赖图及其测试。

发布前，CI 会从 npm 解析 `@task-handoff/node-agent` 的精确稳定 `latest` 和前一
个稳定版本，分别安装两版包，并使用包内 bootstrap 与 controlled-instance
runtime artifact 启动受影响的候选镜像。两版都完成原容器安装、重启和健康
检查后才能发布。

## Market catalog

发布完成后，CI 从 registry 读取各 profile 的 tag、多架构 manifest digest、
平台 digest、压缩体积和发布时间，结合 `market/profiles.json` 里的产品元数据
（名称、描述、capability、optional app）生成 market catalog，并部署到
GitHub Pages：<https://images.thandoff.com>。

- `market/v1/catalog.json`：TaskHandoff 控制面板消费的完整目录，字段与
  `MarketCatalogSnapshotSchema` 一致，`source` 为 `remote`。
- `market/v1/images/<slug>.json`：单镜像条目，便于审计局部变更。
- `market/v1/catalog.sig`：配置签名密钥后生成的 ed25519 分离签名。

本地生成（默认 `pages/` 输出目录）：

```sh
DOCKERHUB_USERNAME=<namespace> node scripts/build-market-catalog.mjs
```

CI 通过 `Market Catalog Pages` workflow 执行：发布 tag 或手动指定版本的
Docker workflow 成功后会自动触发，也可以 `workflow_dispatch` 手动触发。
部署始终从 `main` 分支发起，因为 `github-pages` environment 只允许该分支
部署，tag 触发的发布 workflow 不能自己部署 Pages。首次启用需要在仓库设置里把
Pages 的来源设为 GitHub Actions，并把 `images.thandoff.com` CNAME 指向
`edgestorage.github.io`。

可选仓库配置：`TASK_HANDOFF_CATALOG_SIGNING_KEY` secret 保存 ed25519 私钥
（PEM、base64 PKCS#8 或文件路径），`TASK_HANDOFF_CATALOG_SIGNING_KEY_ID`
变量保存密钥标识。未配置时发布未签名目录，应用侧在未内置公钥时仍会通过
HTTPS 和仓库 allowlist 校验目录。

`market/profiles.json` 的 profile 列表和 capability 必须与 Dockerfile 的
`io.task-handoff.image.*` label 保持一致，测试会强制校验。

## 相关仓库

- [`edgestorage/task-handoff`](https://github.com/edgestorage/task-handoff)：
  TaskHandoff 应用主仓，拥有控制平面、Node Agent 及消费这些镜像的
  controlled-instance runtime。
- `edgestorage/task-handoff-images`（本仓库）：构建并发布基础镜像，维护
  market catalog。
- [`edgestorage/task-handoff-docs`](https://github.com/edgestorage/task-handoff-docs)：
  面向用户的文档。

GUI 和 browser profile 还会构建
[`edgestorage/web-cap`](https://github.com/edgestorage/web-cap) 和
[`edgestorage/bcap`](https://github.com/edgestorage/bcap) 两个 skill。

每个镜像都带有指回本仓库的 `org.opencontainers.image.source`，Docker Hub
仓库页的源码关联就来自这个 label。

## 所有权边界

本仓库拥有基础系统包、镜像 profile、镜像元数据和镜像发布流程。TaskHandoff
应用主仓拥有 Node Agent bootstrap、runtime installer、私有配置模型、runtime
artifact、实例生命周期及传入每个受管容器的权威 capability snapshot。本仓的
OCI capability label 只描述构建制品，应用不能把它当作运行态来源。不得把这些
应用侧权威实现复制到本仓库。

## 许可证

Apache License 2.0，详见 `LICENSE` 和 `NOTICE`。
