# TaskHandoff Images

Public Linux base images for TaskHandoff Node Agent-managed Docker instances.
The repository builds five profiles from shared layers:

| Image | Capabilities |
| --- | --- |
| `task-handoff-controlled-codex` | Terminal and Codex |
| `task-handoff-controlled-opencode` | Terminal and OpenCode |
| `task-handoff-controlled-ai` | Terminal, Codex, and Claude |
| `task-handoff-controlled-webcap` | GUI terminal, browser, WebCap, Codex, and Claude |
| `task-handoff-controlled-browser` | GUI terminal, browser, VS Code Web, Codex, and Claude |

These images provide operating-system packages, developer tools, and profile
metadata. They do not contain the TaskHandoff controlled-instance application.
At container creation time, Node Agent mounts its authoritative bootstrap
bundle, installs the desired controlled-instance runtime artifact into a
persistent runtime volume, and starts that runtime.

## Local build

Build the default Browser profile:

```sh
./scripts/docker-build-image.sh
```

Select another profile with `TASK_HANDOFF_IMAGE_PROFILE`:

```sh
TASK_HANDOFF_IMAGE_PROFILE=codex ./scripts/docker-build-image.sh
```

Supported values are `codex`, `opencode`, `ai`, `webcap`, and `browser`.
`TASK_HANDOFF_IMAGE_REF` overrides the local image tag. Tool versions are
pinned by default; override their build arguments only for local testing.

## Releases

Tags use the repository's `vX.Y.Z` version line. Each release builds and
smoke-tests Linux amd64 and arm64 images, publishes an immutable
`docker-sha-<commit>` tag, and promotes it to the release tag. Stable releases
also update `latest`; alpha and beta releases update their matching channel.

Before publication, CI resolves the exact stable `latest` and preceding stable
version of `@task-handoff/node-agent` from npm. It installs both packages and
uses their bundled bootstrap and controlled-instance runtime artifacts to start
all five candidate image profiles. Publication is blocked unless both versions
install, restart the same container, and pass the runtime health check.

## Ownership boundary

The image repository owns base packages, image profiles, image metadata, and
image publication. The TaskHandoff application repository owns the Node Agent
bootstrap, runtime installer, private configuration model, runtime artifacts,
instance lifecycle, and the authoritative capability snapshot passed to each
managed container. OCI capability labels in this repository describe the
built artifact; the application does not use them as runtime state. Do not copy
application-owned files into this repository.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
