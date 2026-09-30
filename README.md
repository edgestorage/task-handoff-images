# TaskHandoff Images

Public Linux base images for TaskHandoff Node Agent-managed Docker instances.
The repository builds six profiles from shared layers:

| Image | Capabilities |
| --- | --- |
| `task-handoff-controlled-codex` | Terminal and Codex |
| `task-handoff-controlled-obscura` | Terminal, Codex, and Obscura |
| `task-handoff-controlled-opencode` | Terminal and OpenCode |
| `task-handoff-controlled-ai` | Terminal, Codex, and Claude |
| `task-handoff-controlled-webcap` | GUI terminal, browser, WebCap, Codex, and Claude |
| `task-handoff-controlled-bcap` | GUI terminal, browser, BCap, Codex, and Claude |
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

Supported values are `codex`, `obscura`, `opencode`, `ai`, `webcap`, `bcap`,
and `browser`.
`TASK_HANDOFF_IMAGE_REF` overrides the local image tag. Tool versions are
pinned by default; override their build arguments only for local testing.

## Releases

Tags use the repository's `vX.Y.Z` version line. Pull requests and releases
build only image profiles affected by the changes, including profiles that
inherit a changed shared layer. A release publishes Linux amd64 and arm64
images under an immutable `docker-sha-<commit>` tag and promotes only those
images to the release tag. Stable releases also update each affected image's
`latest`; alpha and beta releases update their matching channel. Unchanged
images retain their existing tags and are not required to publish every
repository release version. A release automatically builds any profile that
does not have a `latest` tag yet.

The affected-profile dependency graph is maintained in
`scripts/resolve-changed-image-profiles.mjs`. Update that graph and its tests
whenever a Dockerfile stage or profile is added or renamed.

Before publication, CI resolves the exact stable `latest` and preceding stable
version of `@task-handoff/node-agent` from npm. It installs both packages and
uses their bundled bootstrap and controlled-instance runtime artifacts to start
the affected candidate image profiles. Publication is blocked unless both
versions install, restart the same container, and pass the runtime health check.

## Market catalog

After publication, CI reads each profile's tags, multi-architecture manifest
digests, platform digests, compressed sizes, and publish times from the
registry, merges them with the product metadata in `market/profiles.json`
(names, descriptions, capabilities, optional apps), and deploys the market
catalog to GitHub Pages at <https://images.thandoff.com>.

- `market/v1/catalog.json` is the catalog consumed by the TaskHandoff control
  plane; it matches `MarketCatalogSnapshotSchema` with `source` set to `remote`.
- `market/v1/images/<slug>.json` holds one image document for per-image audits.
- `market/v1/catalog.sig` carries the detached ed25519 signature once a signing
  key is configured.

Generate the site locally (default output directory `pages/`):

```sh
DOCKERHUB_USERNAME=<namespace> node scripts/build-market-catalog.mjs
```

CI runs this at the end of the Docker workflow for release tags, and the
`Market Catalog Pages` workflow can rerun it manually. The first deployment
requires setting the repository's Pages source to GitHub Actions and pointing
the `images.thandoff.com` CNAME at `edgestorage.github.io`.

Optional repository configuration: the `TASK_HANDOFF_CATALOG_SIGNING_KEY`
secret holds an ed25519 private key (PEM, base64 PKCS#8, or file path), and the
`TASK_HANDOFF_CATALOG_SIGNING_KEY_ID` variable holds its key identifier. Without
them the catalog is published unsigned; the application still verifies HTTPS
and the repository allowlist unless a public key is pinned.

The profile list and capabilities in `market/profiles.json` must stay in sync
with the Dockerfile `io.task-handoff.image.*` labels; tests enforce this.

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
