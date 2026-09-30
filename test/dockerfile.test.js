const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Docker runtime uses the supported Node.js 24 release line", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS runtime-base$/m);
  assert.doesNotMatch(dockerfile, /^FROM node:24-bookworm-slim AS build-base$/m);
});

test("Docker image build does not install the monorepo or controlled-instance package", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /pnpm install|runtime:pack:controlled-instance/);
  assert.doesNotMatch(dockerfile, /runtime-package-install|@task-handoff\/controlled-instance/);
  assert.doesNotMatch(dockerfile, /task-handoff-controlled-instance/);
  assert.match(dockerfile, /ARG TASK_HANDOFF_IMAGE_VERSION=0\.0\.1/);
  assert.match(dockerfile, /ENV TASK_HANDOFF_IMAGE_VERSION=\$\{TASK_HANDOFF_IMAGE_VERSION\}/);
});

test("Docker profiles run as agent with passwordless container-root escalation", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /apt-get install -y --no-install-recommends[\s\S]*?\n    sudo \\/);
  assert.match(dockerfile, /printf 'agent ALL=\(root\) NOPASSWD: ALL\\n' > \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.match(dockerfile, /chmod 0440 \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.match(dockerfile, /visudo -cf \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.equal((dockerfile.match(/^USER agent$/gm) || []).length, 7);
});

test("Docker exports Codex, Obscura, OpenCode, AI, WebCap, BCap, and Browser image profiles from shared layers", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const buildScript = fs.readFileSync(path.join(root, "scripts", "docker-build-image.sh"), "utf8");

  assert.match(dockerfile, /FROM runtime-core AS profile-codex-root/);
  assert.match(dockerfile, /FROM profile-codex-root AS profile-obscura-root/);
  assert.match(dockerfile, /FROM runtime-core AS profile-opencode-root/);
  assert.match(dockerfile, /FROM profile-codex-root AS profile-ai-root/);
  assert.match(dockerfile, /FROM profile-ai-root AS profile-gui-root/);
  assert.match(dockerfile, /FROM profile-gui-root AS profile-webcap-root/);
  assert.match(dockerfile, /FROM profile-gui-root AS profile-bcap-root/);
  assert.match(dockerfile, /FROM profile-gui-root AS profile-browser-root/);
  assert.doesNotMatch(dockerfile, /ENV TASK_HANDOFF_IMAGE_(?:PROFILE|CAPABILITIES)=/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,codex/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,codex,obscura/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,opencode/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,codex,claude/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,gui-terminal,browser,web-cap,codex,claude/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,gui-terminal,browser,bcap,codex,claude/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,gui-terminal,browser,vscode-web,codex,claude/);
  assert.match(dockerfile, /ARG CODEX_CLI_PACKAGE=@openai\/codex@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /ARG OPENCODE_CLI_PACKAGE=opencode-ai@\d+\.\d+\.\d+[\s\S]*npm install -g[\s\S]*"\$OPENCODE_CLI_PACKAGE"[\s\S]*opencode --version/);
  assert.match(buildScript, /opencode\)\n\s+BUILD_TARGET="profile-opencode"\n\s+DEFAULT_IMAGE_REF="task-handoff-controlled-opencode:local"/);
  assert.match(buildScript, /obscura\)\n\s+BUILD_TARGET="profile-obscura"\n\s+DEFAULT_IMAGE_REF="task-handoff-controlled-obscura:local"/);
  assert.match(buildScript, /bcap\)\n\s+BUILD_TARGET="profile-bcap"\n\s+DEFAULT_IMAGE_REF="task-handoff-controlled-bcap:local"/);
  assert.match(buildScript, /CODEX_CLI_PACKAGE=\$\{CODEX_CLI_PACKAGE:-@openai\/codex@\d+\.\d+\.\d+\}/);
  assert.match(buildScript, /OPENCODE_CLI_PACKAGE=\$\{OPENCODE_CLI_PACKAGE:-opencode-ai@\d+\.\d+\.\d+\}/);
});

test("Docker BCap profile installs the pinned bcap skill on the chromium base", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const optionalApps = fs.readFileSync(path.join(root, "docker", "optional-apps.sh"), "utf8");
  const bcapRootStart = dockerfile.indexOf("FROM profile-gui-root AS profile-bcap-root");
  const browserRootStart = dockerfile.indexOf("FROM profile-gui-root AS profile-browser-root");

  assert.ok(bcapRootStart >= 0 && browserRootStart > bcapRootStart);
  const bcapRoot = dockerfile.slice(bcapRootStart, browserRootStart);
  assert.match(bcapRoot, /ARG BCAP_SKILL_REPOSITORY=https:\/\/github\.com\/edgestorage\/bcap\.git/);
  assert.match(bcapRoot, /ARG BCAP_SKILL_REF=[a-f0-9]{40}/);
  assert.match(bcapRoot, /fetch --depth 1 origin "\$\{BCAP_SKILL_REF\}"/);
  assert.match(bcapRoot, /test -f \/tmp\/task-handoff-bcap-source\/SKILL\.md/);
  assert.match(bcapRoot, /install_bcap/);
  assert.doesNotMatch(bcapRoot, /code-server|install_web_cap/);
  assert.doesNotMatch(dockerfile, /TASK_HANDOFF_ENABLE_BCAP/);

  assert.match(optionalApps, /install_bcap\(\) \{[\s\S]*npm install --omit=dev --no-audit --no-fund[\s\S]*scripts\/bcap\.mjs" --help[\s\S]*\.agents\/skills[\s\S]*\.codex\/skills[\s\S]*\.claude\/skills[\s\S]*chown -R agent:agent/);
});

test("Docker installs pinned Obscura release binaries for amd64 and arm64", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const buildScript = fs.readFileSync(path.join(root, "scripts", "docker-build-image.sh"), "utf8");

  assert.match(dockerfile, /ARG OBSCURA_VERSION=\d+\.\d+\.\d+/);
  assert.match(dockerfile, /ARG OBSCURA_AMD64_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /ARG OBSCURA_ARM64_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /COPY LICENSE \/usr\/share\/doc\/obscura\/LICENSE/);
  assert.match(dockerfile, /linux-amd64\) obscura_arch="x86_64"/);
  assert.match(dockerfile, /linux-arm64\) obscura_arch="aarch64"/);
  assert.match(dockerfile, /releases\/download\/v\$\{OBSCURA_VERSION\}\/obscura-\$\{obscura_arch\}-linux\.tar\.gz/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /tar -xzf "\$\{obscura_archive\}" -C \/usr\/local\/bin obscura obscura-worker/);
  assert.match(dockerfile, /obscura --version/);
  assert.match(buildScript, /OBSCURA_VERSION=\$\{OBSCURA_VERSION:-\d+\.\d+\.\d+\}/);
});

test("Docker WebCap profile installs WebCap without code-server", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const webcapRootStart = dockerfile.indexOf("FROM profile-gui-root AS profile-webcap-root");
  const browserRootStart = dockerfile.indexOf("FROM profile-gui-root AS profile-browser-root");
  const exportedProfilesStart = dockerfile.indexOf("# Each exported target");
  const webcapRoot = dockerfile.slice(webcapRootStart, browserRootStart);
  const browserRoot = dockerfile.slice(browserRootStart, exportedProfilesStart);

  assert.ok(webcapRootStart >= 0 && browserRootStart > webcapRootStart);
  assert.match(webcapRoot, /install_web_cap/);
  assert.doesNotMatch(dockerfile, /TASK_HANDOFF_ENABLE_WEB_CAP/);
  assert.doesNotMatch(webcapRoot, /code-server/);
  assert.match(browserRoot, /code-server_\$\{CODE_SERVER_VERSION\}/);
});

test("Docker image contains no application-owned bootstrap implementation", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(dockerfile, /FROM runtime-base AS runtime-core/);
  assert.doesNotMatch(dockerfile, /runtime-package-install|@task-handoff\/controlled-instance|task-handoff-controlled-instance/);
  assert.doesNotMatch(dockerfile, /COPY docker\/(?:entrypoint|instance-launcher|runtime-installer|git-provision)/);
  assert.match(dockerfile, /COPY docker\/image-entrypoint\.sh/);
  const entrypoint = fs.readFileSync(path.join(root, "docker", "image-entrypoint.sh"), "utf8");
  assert.match(entrypoint, /No controlled-instance runtime is active; waiting for node-agent bootstrap/);
  assert.doesNotMatch(entrypoint, /instance-private-config|runtime-manifest|TASK_HANDOFF_REGISTRATION_TOKEN/);
  assert.doesNotMatch(workflow, /task-handoff-controlled-instance web --host 0\.0\.0\.0 --port 8080/);
  assert.match(workflow, /Smoke test profile environments without embedded runtime/);
});

test("Docker build context includes files read by the test suite", () => {
  const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
  const ignoredEntries = dockerignore
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"));

  assert.ok(!ignoredEntries.includes(".github"), ".github workflows are required by release workflow tests");
});

test("Docker CI builds amd64 and arm64 concurrently and publishes a multi-architecture image", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /strategy:\n\s+fail-fast: false\n\s+matrix:/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(workflow, /arch: amd64\n\s+platform: linux\/amd64\n\s+runner: ubuntu-latest/);
  assert.match(workflow, /arch: arm64\n\s+platform: linux\/arm64\n\s+runner: ubuntu-24\.04-arm/);
  assert.doesNotMatch(workflow, /docker\/setup-qemu-action/);
  assert.match(workflow, /scope=docker-image-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /target: profile-codex/);
  assert.match(workflow, /target: profile-obscura/);
  assert.match(workflow, /target: profile-opencode/);
  assert.match(workflow, /target: profile-ai/);
  assert.match(workflow, /target: profile-webcap/);
  assert.match(workflow, /target: profile-bcap/);
  assert.match(workflow, /target: profile-browser/);
  assert.match(workflow, /run_profile obscura codex obscura obscura-worker/);
  assert.match(workflow, /docker exec task-handoff-obscura-ci obscura --version/);
  assert.match(workflow, /sha_tag="docker-sha-\$\{GITHUB_SHA\}-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-amd64"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-arm64"/);
  assert.match(workflow, /Immutable image already exists; preserving/);
  assert.match(workflow, /Immutable multi-architecture image already exists; preserving/);
  assert.doesNotMatch(workflow, /branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow, /refs\/heads\/main/);
  assert.match(workflow, /Publish immutable commit image\n\s+if: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| inputs\.image_version != '' \}\}/);
  assert.match(workflow, /promote-release:\n\s+if:.*refs\/tags\/v.*\n\s+needs: \[detect-changes, publish-multiarch-image\]/);
  assert.match(workflow, /REQUESTED_IMAGE_VERSION: \$\{\{ inputs\.image_version \}\}/);
  assert.match(workflow, /version="v\$\{REQUESTED_IMAGE_VERSION\}"/);
  assert.match(workflow, /release_version="\$\{version#v\}"/);
  assert.match(workflow, /if \[\[ "\$release_version" != \*-\* \]\]; then/);
  assert.match(workflow, /docker run -d --name/);
  assert.doesNotMatch(workflow, /docker run --rm -d/);
  assert.doesNotMatch(workflow, /Immutable source image was not published within/);
});

test("Release tags inject the repository version into Docker images", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /if \[\[ "\$GITHUB_REF" == refs\/tags\/v\* \]\]; then/);
  assert.match(workflow, /version="\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(workflow, /REQUESTED_IMAGE_VERSION: \$\{\{ inputs\.image_version \}\}/);
  assert.match(workflow, /elif \[\[ -n "\$\{REQUESTED_IMAGE_VERSION\}" \]\]; then/);
  assert.match(workflow, /codex-image-ref=\$\{DOCKERHUB_CODEX_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /obscura-image-ref=\$\{DOCKERHUB_OBSCURA_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /opencode-image-ref=\$\{DOCKERHUB_OPENCODE_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /ai-image-ref=\$\{DOCKERHUB_AI_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /webcap-image-ref=\$\{DOCKERHUB_WEBCAP_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /bcap-image-ref=\$\{DOCKERHUB_BCAP_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /browser-image-ref=\$\{DOCKERHUB_BROWSER_IMAGE_NAME\}:\$\{tag\}/);
  assert.doesNotMatch(workflow, /require\('\.\/package\.json'\)\.version/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_VERSION=\$\{\{ steps\.image-version\.outputs\.value \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.codex-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.obscura-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.opencode-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.ai-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.webcap-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.bcap-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.browser-image-ref \}\}/);
  assert.match(workflow, /Verify image metadata[\s\S]*org\.opencontainers\.image\.version[\s\S]*EXPECTED_VERSION/);
  assert.match(workflow, /controlled-instance absence/);
  assert.match(workflow, /test ! -e \/usr\/local\/bin\/task-handoff-controlled-instance/);
  assert.match(dockerfile, /ARG TASK_HANDOFF_IMAGE_VERSION=0\.0\.1/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS runtime-base[\s\S]*ARG TASK_HANDOFF_IMAGE_VERSION=0\.0\.1[\s\S]*ENV TASK_HANDOFF_IMAGE_VERSION=\$\{TASK_HANDOFF_IMAGE_VERSION\}/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.version=\$\{TASK_HANDOFF_IMAGE_VERSION\}/);
  assert.match(workflow, /Immutable Docker release already exists/);
});

test("Docker fetches the Web Cap skill from its versioned upstream source", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /ARG WEB_CAP_SKILL_REPOSITORY=https:\/\/github\.com\/edgestorage\/web-cap\.git/);
  assert.match(dockerfile, /ARG WEB_CAP_SKILL_REF=v0\.0\.7/);
  assert.match(dockerfile, /sparse-checkout set skills\/web-cap/);
  assert.match(dockerfile, /test -f \/tmp\/task-handoff-web-cap-source\/skills\/web-cap\/SKILL\.md/);
  assert.doesNotMatch(dockerfile, /COPY \.agents\/skills\/web-cap/);
});

test("Docker installs Claude Code through the same canonical package managed at runtime", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /npm install -g --include=optional[^\n]*\\\n\s+"@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"/);
  assert.doesNotMatch(dockerfile, /@anthropic-ai\/claude-code-linux-/);
  assert.doesNotMatch(dockerfile, /claude_native_package/);
});

test("Docker workflow runs repository contract tests", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");
  assert.match(workflow, /detect-changes:[\s\S]*node --test test\/\*\.test\.js/);
});

test("Docker workflow builds and publishes only affected image profiles", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /resolve-changed-image-profiles\.mjs --base "\$base" --head "\$GITHUB_SHA"/);
  assert.match(workflow, /git describe --tags --abbrev=0 "\$\{GITHUB_SHA\}\^"/);
  assert.match(workflow, /No latest tag found for \$\{image\}; scheduling its initial build/);
  assert.match(workflow, /if: \$\{\{ contains\(fromJSON\(needs\.detect-changes\.outputs\.profiles\), 'obscura'\) \}\}[\s\S]*target: profile-obscura/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_PROFILES: \$\{\{ needs\.detect-changes\.outputs\.profiles_space \}\}/);
  assert.match(workflow, /mapfile -t profiles < <\(node -e[\s\S]*needs\.detect-changes\.outputs\.profiles/);
  assert.match(workflow, /initial_profiles[\s\S]*tags\+=\(--tag "\$\{image\}:latest"\)/);
});

test("Docker publication is gated by current and N-1 published TaskHandoff runtimes", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");
  const resolver = fs.readFileSync(path.join(root, "scripts", "resolve-task-handoff-versions.mjs"), "utf8");
  const compatibility = fs.readFileSync(path.join(root, "scripts", "test-task-handoff-compatibility.sh"), "utf8");

  assert.match(workflow, /Resolve published TaskHandoff compatibility versions/);
  assert.match(workflow, /Test current and N-1 TaskHandoff compatibility/);
  assert.ok(workflow.indexOf("Test current and N-1 TaskHandoff compatibility") < workflow.indexOf("Publish immutable commit image"));
  assert.match(resolver, /"@task-handoff\/node-agent"/);
  assert.match(resolver, /\{ channel: "current", version: latest \}/);
  assert.match(resolver, /\{ channel: "n-1", version: stableVersions\[latestIndex - 1\] \}/);
  assert.match(compatibility, /npm install[\s\S]*"@task-handoff\/node-agent@\$\{version\}"/);
  assert.match(compatibility, /TASK_HANDOFF_IMAGE_PROFILES:-codex obscura opencode ai webcap bcap browser/);
  assert.match(compatibility, /runtime-installer\.mjs install/);
  assert.match(compatibility, /docker restart/);
  assert.match(compatibility, /\/api\/health/);
  assert.match(compatibility, /test "\$\(docker inspect --format '\{\{\.Id\}\}' "\$\{name\}"\)" = "\$\{before_id\}"/);
});
