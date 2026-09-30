# TaskHandoff Images

TaskHandoff Node Agent 受管 Docker 实例使用的公开 Linux 基础镜像。本仓库从共享分层构建五个 profile：

| 镜像 | 能力 |
| --- | --- |
| `task-handoff-controlled-codex` | Terminal、Codex |
| `task-handoff-controlled-opencode` | Terminal、OpenCode |
| `task-handoff-controlled-ai` | Terminal、Codex、Claude |
| `task-handoff-controlled-webcap` | GUI Terminal、Browser、WebCap、Codex、Claude |
| `task-handoff-controlled-browser` | GUI Terminal、Browser、VS Code Web、Codex、Claude |

这些镜像提供操作系统依赖、开发工具和 profile 元数据，不包含 TaskHandoff
controlled-instance 应用。创建容器时，Node Agent 会挂载其权威 bootstrap
bundle，把目标 controlled-instance runtime artifact 安装到持久化 runtime
volume，再启动该 runtime。

## 本地构建

构建默认的 Browser profile：

```sh
./scripts/docker-build-image.sh
```

通过 `TASK_HANDOFF_IMAGE_PROFILE` 选择其他 profile：

```sh
TASK_HANDOFF_IMAGE_PROFILE=codex ./scripts/docker-build-image.sh
```

支持 `codex`、`obscura`、`opencode`、`ai`、`webcap` 和 `browser`。
`TASK_HANDOFF_IMAGE_REF` 可以覆盖本地镜像 tag。工具版本默认固定；其他版本
构建参数只用于本地测试。

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

CI 在发布 tag 的 Docker workflow 末尾自动执行，也可以从 `Market Catalog
Pages` workflow 手动重跑。首次启用需要在仓库设置里把 Pages 的来源设为
GitHub Actions，并把 `images.thandoff.com` CNAME 指向 `edgestorage.github.io`。

可选仓库配置：`TASK_HANDOFF_CATALOG_SIGNING_KEY` secret 保存 ed25519 私钥
（PEM、base64 PKCS#8 或文件路径），`TASK_HANDOFF_CATALOG_SIGNING_KEY_ID`
变量保存密钥标识。未配置时发布未签名目录，应用侧在未内置公钥时仍会通过
HTTPS 和仓库 allowlist 校验目录。

`market/profiles.json` 的 profile 列表和 capability 必须与 Dockerfile 的
`io.task-handoff.image.*` label 保持一致，测试会强制校验。

## 所有权边界

本仓库拥有基础系统包、镜像 profile、镜像元数据和镜像发布流程。TaskHandoff
应用主仓拥有 Node Agent bootstrap、runtime installer、私有配置模型、runtime
artifact、实例生命周期及传入每个受管容器的权威 capability snapshot。本仓的
OCI capability label 只描述构建制品，应用不能把它当作运行态来源。不得把这些
应用侧权威实现复制到本仓库。

## 许可证

Apache License 2.0，详见 `LICENSE` 和 `NOTICE`。
