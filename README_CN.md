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

支持 `codex`、`opencode`、`ai`、`webcap` 和 `browser`。
`TASK_HANDOFF_IMAGE_REF` 可以覆盖本地镜像 tag。工具版本默认固定；其他版本
构建参数只用于本地测试。

## 发布

本仓使用 `vX.Y.Z` 版本线。每次发布构建并冒烟测试 Linux
amd64 和 arm64 镜像，发布不可变的 `docker-sha-<commit>` tag，再提升为版本
tag。稳定版本同时更新 `latest`，alpha 和 beta 版本更新对应 channel。

发布前，CI 会从 npm 解析 `@task-handoff/node-agent` 的精确稳定 `latest` 和前一
个稳定版本，分别安装两版包，并使用包内 bootstrap 与 controlled-instance
runtime artifact 启动五个候选镜像。两版都完成原容器安装、重启和健康检查后
才能发布。

## 所有权边界

本仓库拥有基础系统包、镜像 profile、镜像元数据和镜像发布流程。TaskHandoff
应用主仓拥有 Node Agent bootstrap、runtime installer、私有配置模型、runtime
artifact、实例生命周期及传入每个受管容器的权威 capability snapshot。本仓的
OCI capability label 只描述构建制品，应用不能把它当作运行态来源。不得把这些
应用侧权威实现复制到本仓库。

## 许可证

Apache License 2.0，详见 `LICENSE` 和 `NOTICE`。
