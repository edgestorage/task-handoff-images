#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <task-handoff-version>" >&2
  exit 64
fi

readonly version="$1"
readonly install_root="$(mktemp -d)"
readonly package_root="${install_root}/node_modules/@task-handoff/node-agent"
containers=()
volumes=()

cleanup() {
  if ((${#containers[@]})); then
    docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
  fi
  if ((${#volumes[@]})); then
    docker volume rm -f "${volumes[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "${install_root}"
}
trap cleanup EXIT

npm install \
  --prefix "${install_root}" \
  --ignore-scripts \
  --omit=dev \
  --no-audit \
  --no-fund \
  "@task-handoff/node-agent@${version}"

readonly bootstrap_dir="${package_root}/docker"
readonly artifact_dir="${package_root}/runtime-artifacts"
readonly artifact="${artifact_dir}/controlled-instance-runtime-${version}-linux-universal.tar.gz"
readonly manifest="${artifact_dir}/controlled-instance-runtime-${version}-linux-universal.manifest.json"
for required in entrypoint.sh instance-launcher.sh runtime-installer.mjs; do
  test -x "${bootstrap_dir}/${required}"
done
test -f "${artifact}"
test -f "${manifest}"

mapfile -t runtime_identity < <(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const key of ["version", "sha256", "platform", "arch", "launcherAbi"]) {
    if (value[key] === undefined) throw new Error(`Missing runtime identity field: ${key}`);
    process.stdout.write(`${value[key]}\n`);
  }
' "${manifest}")
test "${runtime_identity[0]}" = "${version}"

profile_capabilities() {
  case "$1" in
    codex) echo "terminal,codex" ;;
    obscura) echo "terminal,codex,obscura" ;;
    opencode) echo "terminal,opencode" ;;
    ai) echo "terminal,codex,claude" ;;
    webcap) echo "terminal,gui-terminal,browser,web-cap,codex,claude" ;;
    bcap) echo "terminal,gui-terminal,browser,bcap,codex,claude" ;;
    browser) echo "terminal,gui-terminal,browser,vscode-web,codex,claude" ;;
    *) return 1 ;;
  esac
}

readonly image_profiles="${TASK_HANDOFF_IMAGE_PROFILES:-codex obscura opencode ai webcap bcap browser}"
for profile in ${image_profiles}; do
  profile_capabilities "${profile}" >/dev/null
  safe_version="${version//./-}"
  name="task-handoff-compat-${profile}-${safe_version}"
  data_volume="${name}-data"
  home_volume="${name}-home"
  workspace_volume="${name}-workspace"
  runtime_volume="${name}-runtime"
  private_config="${install_root}/${name}-private-config.json"
  capabilities="$(profile_capabilities "${profile}")"
  containers+=("${name}")
  volumes+=("${data_volume}" "${home_volume}" "${workspace_volume}" "${runtime_volume}")

  node -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.argv[1], `${JSON.stringify({
      version: 1,
      instanceId: process.argv[2],
      instanceCredential: "compatibility-test-credential",
      environment: {},
      updatedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
  ' "${private_config}" "${name}"

  docker run -d \
    --name "${name}" \
    --user 0:0 \
    --no-healthcheck \
    --shm-size 1gb \
    --security-opt seccomp=unconfined \
    --add-host host.docker.internal:host-gateway \
    --tmpfs /tmp:rw,nosuid,nodev,exec,mode=1777 \
    -p 127.0.0.1::8080 \
    --mount "type=bind,src=${private_config},dst=/run/task-handoff/instance-private-config.json,readonly" \
    --mount "type=bind,src=${bootstrap_dir},dst=/run/task-handoff/bootstrap,readonly" \
    --mount "type=volume,src=${data_volume},dst=/data" \
    --mount "type=volume,src=${home_volume},dst=/home/agent" \
    --mount "type=volume,src=${workspace_volume},dst=/workspace" \
    --mount "type=volume,src=${runtime_volume},dst=/opt/task-handoff/instance-runtime" \
    --entrypoint /bin/bash \
    -e TASK_HANDOFF_CONTROL_MODE=controlled \
    -e TASK_HANDOFF_NODE_AGENT_URL=http://host.docker.internal:1 \
    -e TASK_HANDOFF_INSTANCE_ID="${name}" \
    -e TASK_HANDOFF_INSTANCE_NAME="Compatibility ${profile}" \
    -e TASK_HANDOFF_PROJECT_ID=compatibility-project \
    -e TASK_HANDOFF_NODE_ID=compatibility-node \
    -e TASK_HANDOFF_RUNTIME_ID=compatibility-docker \
    -e TASK_HANDOFF_IMAGE_ID="compatibility-${profile}" \
    -e TASK_HANDOFF_IMAGE_PROFILE="${profile}" \
    -e TASK_HANDOFF_IMAGE_CAPABILITIES="${capabilities}" \
    -e TASK_HANDOFF_INSTANCE_LAUNCHER=/run/task-handoff/bootstrap/instance-launcher.sh \
    -e TASK_HANDOFF_CHAT_BRIDGES=none \
    -e TASK_HANDOFF_WORKSPACE=/workspace \
    -e TASK_HANDOFF_WORKSPACE_MODE=git-clone \
    -e TASK_HANDOFF_SKIP_WORKSPACE_BOOTSTRAP=true \
    "task-handoff-controlled-${profile}:ci-amd64" \
    /run/task-handoff/bootstrap/entrypoint.sh task-handoff web >/dev/null

  for attempt in $(seq 1 30); do
    if docker logs "${name}" 2>&1 | grep -q "No controlled-instance runtime is active"; then
      break
    fi
    if [ "${attempt}" -eq 30 ]; then
      docker logs "${name}"
      exit 1
    fi
    sleep 1
  done

  before_id="$(docker inspect --format '{{.Id}}' "${name}")"
  docker exec --user 0 "${name}" install -d -o root -g root -m 0755 /opt/task-handoff/instance-runtime/incoming
  docker cp "${artifact}" "${name}:/opt/task-handoff/instance-runtime/incoming/runtime.tar.gz"
  docker exec --user 0 "${name}" node /run/task-handoff/bootstrap/runtime-installer.mjs install \
    --artifact /opt/task-handoff/instance-runtime/incoming/runtime.tar.gz \
    --version "${runtime_identity[0]}" \
    --sha256 "${runtime_identity[1]}" \
    --platform "${runtime_identity[2]}" \
    --arch "${runtime_identity[3]}" \
    --launcher-abi "${runtime_identity[4]}"
  docker exec --user 0 "${name}" rm -f /opt/task-handoff/instance-runtime/incoming/runtime.tar.gz
  docker restart "${name}" >/dev/null
  test "$(docker inspect --format '{{.Id}}' "${name}")" = "${before_id}"

  endpoint="$(docker port "${name}" 8080/tcp | head -n 1)"
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://${endpoint}/api/health" >/dev/null; then
      break
    fi
    if [ "${attempt}" -eq 60 ]; then
      docker logs "${name}"
      exit 1
    fi
    sleep 1
  done
  test "$(docker exec "${name}" printenv TASK_HANDOFF_IMAGE_PROFILE)" = "${profile}"
  test "$(docker exec "${name}" printenv TASK_HANDOFF_IMAGE_CAPABILITIES)" = "${capabilities}"
  docker exec --user agent "${name}" node /run/task-handoff/bootstrap/runtime-installer.mjs verify-active >/dev/null

  docker rm -f "${name}" >/dev/null
  containers=("${containers[@]:0:${#containers[@]}-1}")
  docker volume rm "${data_volume}" "${home_volume}" "${workspace_volume}" "${runtime_volume}" >/dev/null
  volumes=("${volumes[@]:0:${#volumes[@]}-4}")
done
