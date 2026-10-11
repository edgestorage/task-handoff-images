FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime-base
ARG TASK_HANDOFF_IMAGE_VERSION=0.0.1

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TASK_HANDOFF_IMAGE_VERSION=${TASK_HANDOFF_IMAGE_VERSION}
ENV TASK_HANDOFF_WEB_HOST=0.0.0.0
ENV TASK_HANDOFF_WEB_PORT=8080
ENV TASK_HANDOFF_WORKSPACE=/workspace
ENV TASK_HANDOFF_DATA_DIR=/data/task-handoff
ENV TASK_HANDOFF_APP_CATALOG_DIR=/data/task-handoff/app-catalog
ENV TASK_HANDOFF_ARTIFACT_DIR=/data/artifacts
ENV TASK_HANDOFF_APP_SESSION_DIR=/data/task-handoff/app-sessions
ENV TASK_HANDOFF_RUNTIME_DIR=/data/task-handoff/runtime
ENV TASK_HANDOFF_EVENTS_DIR=/data/task-handoff/events
ENV TASK_HANDOFF_LOG_DIR=/data/logs
ENV TASK_HANDOFF_NOVNC_ROOT=/usr/share/novnc
ENV TASK_HANDOFF_VNC_BACKEND=kasmvnc
ENV TASK_HANDOFF_CHROMIUM_EXTENSION_DIR=/opt/task-handoff/chromium-extensions
ENV CODEX_HOME=/home/agent/.codex
ENV CLAUDE_HOME=/home/agent/.claude
ENV NODE_ENV=production
ENV TASK_HANDOFF_INSTANCE_RUNTIME_ROOT=/opt/task-handoff/instance-runtime

LABEL org.opencontainers.image.version=${TASK_HANDOFF_IMAGE_VERSION}
LABEL org.opencontainers.image.source=https://github.com/edgestorage/task-handoff-images
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    python3 \
    sudo \
    tini \
    vim \
    zsh \
  && rm -rf /var/lib/apt/lists/*
RUN if id -u agent >/dev/null 2>&1; then \
    true; \
  elif id -u node >/dev/null 2>&1; then \
    usermod -l agent -d /home/agent -m -s /bin/bash node \
    && groupmod -n agent node; \
  else \
    useradd -m -u 1000 -s /bin/bash agent; \
  fi \
  && mkdir -p /home/agent/.codex /home/agent/.claude \
  && printf 'agent ALL=(root) NOPASSWD: ALL\n' > /etc/sudoers.d/task-handoff-agent \
  && chmod 0440 /etc/sudoers.d/task-handoff-agent \
  && visudo -cf /etc/sudoers.d/task-handoff-agent

FROM runtime-base AS runtime-core
COPY docker/image-entrypoint.sh /usr/local/bin/task-handoff-image-entrypoint
COPY docker/healthcheck.sh /usr/local/bin/task-handoff-healthcheck

RUN chmod +x /usr/local/bin/task-handoff-image-entrypoint /usr/local/bin/task-handoff-healthcheck \
  && mkdir -p \
    /workspace \
    /data/task-handoff/app-catalog \
    /data/task-handoff/app-sessions \
    /data/task-handoff/runtime \
    /opt/task-handoff/instance-runtime/releases \
    /opt/task-handoff/instance-runtime/staging \
    /data/artifacts \
    /data/logs \
    /home/agent/.codex \
    /home/agent/.claude \
  && chown -R agent:agent /workspace /data /home/agent /app \
  && chmod 0755 /opt/task-handoff/instance-runtime /opt/task-handoff/instance-runtime/releases /opt/task-handoff/instance-runtime/staging
RUN rm -rf /tmp/.X11-unix \
  && mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix

# Install profile layers before volatile metadata so profile builds share all
# expensive application, CLI, and system package layers.
FROM runtime-core AS profile-codex-root
ARG CODEX_CLI_PACKAGE=@openai/codex@0.153.4
RUN npm_config_update_notifier=false npm install -g --include=optional --no-audit --no-fund --loglevel=warn "$CODEX_CLI_PACKAGE" \
  && codex --version

FROM profile-codex-root AS profile-obscura-root
ARG TARGETOS
ARG TARGETARCH
ARG OBSCURA_VERSION=0.2.3
ARG OBSCURA_AMD64_SHA256=1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec
ARG OBSCURA_ARM64_SHA256=5ecf980bca3060236a7a86ec7ed83d943e6598ee87caa46d20325d90bc75f979
COPY LICENSE /usr/share/doc/obscura/LICENSE
RUN set -eux; \
  case "${TARGETOS:-linux}-${TARGETARCH:-amd64}" in \
    linux-amd64) obscura_arch="x86_64"; obscura_sha256="${OBSCURA_AMD64_SHA256}" ;; \
    linux-arm64) obscura_arch="aarch64"; obscura_sha256="${OBSCURA_ARM64_SHA256}" ;; \
    *) echo "Unsupported Obscura Docker target: ${TARGETOS:-linux}-${TARGETARCH:-amd64}" >&2; exit 1 ;; \
  esac; \
  obscura_archive="/tmp/obscura-${obscura_arch}-linux.tar.gz"; \
  curl -fsSL -o "${obscura_archive}" \
    "https://github.com/h4ckf0r0day/obscura/releases/download/v${OBSCURA_VERSION}/obscura-${obscura_arch}-linux.tar.gz"; \
  echo "${obscura_sha256}  ${obscura_archive}" | sha256sum -c -; \
  tar -xzf "${obscura_archive}" -C /usr/local/bin obscura obscura-worker; \
  rm -f "${obscura_archive}"; \
  obscura --version

FROM profile-codex-root AS profile-rea-root
ARG REA_AGENTS_PACKAGE=rea-agents@6.3.0
ARG TARGETOS
ARG TARGETARCH
ARG TEMURIN_JDK_RELEASE=jdk-21.0.12.1%2B1
ARG TEMURIN_JDK_BUILD=21.0.12.1_1
ARG TEMURIN_JDK_AMD64_SHA256=ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94
ARG TEMURIN_JDK_ARM64_SHA256=23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223
ENV JAVA_HOME=/opt/java/temurin-21
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    mitmproxy \
    python3-pwntools \
  ; \
  rm -rf /var/lib/apt/lists/*; \
  case "${TARGETOS:-linux}-${TARGETARCH:-amd64}" in \
    linux-amd64) temurin_arch="x64"; temurin_sha256="${TEMURIN_JDK_AMD64_SHA256}" ;; \
    linux-arm64) temurin_arch="aarch64"; temurin_sha256="${TEMURIN_JDK_ARM64_SHA256}" ;; \
    *) echo "Unsupported Temurin JDK Docker target: ${TARGETOS:-linux}-${TARGETARCH:-amd64}" >&2; exit 1 ;; \
  esac; \
  temurin_archive="/tmp/temurin-jdk.tar.gz"; \
  curl -fsSL -o "${temurin_archive}" \
    "https://github.com/adoptium/temurin21-binaries/releases/download/${TEMURIN_JDK_RELEASE}/OpenJDK21U-jdk_${temurin_arch}_linux_hotspot_${TEMURIN_JDK_BUILD}.tar.gz"; \
  echo "${temurin_sha256}  ${temurin_archive}" | sha256sum -c -; \
  mkdir -p "${JAVA_HOME}"; \
  tar -xzf "${temurin_archive}" -C "${JAVA_HOME}" --strip-components=1; \
  rm -f "${temurin_archive}"; \
  ln -sf "${JAVA_HOME}/bin/java" /usr/local/bin/java; \
  ln -sf "${JAVA_HOME}/bin/javac" /usr/local/bin/javac; \
  chromium --version; \
  java -version; \
  javac -version; \
  mitmdump --version; \
  python3 -c 'import pwnlib'

RUN set -eux; \
  npm_config_update_notifier=false npm install -g --include=optional --no-audit --no-fund --loglevel=warn "$REA_AGENTS_PACKAGE"; \
  rea --version; \
  HOME=/home/agent CODEX_HOME=/home/agent/.codex rea setup --client codex --yes --format json >/tmp/task-handoff-rea-setup.json; \
  rea doctor --client codex --format json >/dev/null; \
  test -f /home/agent/.codex/config.toml; \
  test -f /home/agent/.agents/skills/reverse-engineer-anything/SKILL.md; \
  rm -f /tmp/task-handoff-rea-setup.json; \
  chown -R agent:agent /home/agent/.codex /home/agent/.agents

FROM runtime-core AS profile-opencode-root
ARG OPENCODE_CLI_PACKAGE=opencode-ai@1.18.29
RUN npm_config_update_notifier=false npm install -g --include=optional --no-audit --no-fund --loglevel=warn "$OPENCODE_CLI_PACKAGE" \
  && opencode --version

FROM profile-codex-root AS profile-ai-root
ARG CLAUDE_CODE_VERSION=2.1.183
RUN set -eux; \
  npm_config_update_notifier=false timeout 180s npm install -g --include=optional --no-audit --no-fund --loglevel=verbose \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
  claude --version

FROM profile-ai-root AS profile-gui-root
ARG KASMVNC_VERSION=1.4.0
ARG TARGETOS
ARG TARGETARCH
ARG TASK_HANDOFF_ENABLE_CC_SWITCH=0
ARG CC_SWITCH_VERSION=3.16.3
ARG CC_SWITCH_DEB_URL=
ARG CC_SWITCH_COMMAND=cc-switch
ARG CHROMIUM_EXTENSION_URLS=
ARG CHROMIUM_EXTENSION_IDS=
ARG CHROMIUM_EXTENSION_UPDATE_URL=https://clients2.google.com/service/update2/crx
ARG WEB_CAPABILITY_VERSION=0.0.7
ARG WEB_CAP_EXTENSION_VERSION=0.0.7
ARG WEB_CAP_EXTENSION_URL=
ARG WEB_CAP_SKILL_REPOSITORY=https://github.com/edgestorage/web-cap.git
ARG WEB_CAP_SKILL_REF=v0.0.7

ENV TASK_HANDOFF_ENABLE_CC_SWITCH=${TASK_HANDOFF_ENABLE_CC_SWITCH}
ENV TASK_HANDOFF_CC_SWITCH_COMMAND=${CC_SWITCH_COMMAND}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    imagemagick \
    novnc \
    openbox \
    picom \
    ssl-cert \
    unzip \
    websockify \
    x11vnc \
    x11-xserver-utils \
    xterm \
    xz-utils \
    xvfb \
  && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
  case "${TARGETOS:-linux}-${TARGETARCH:-amd64}" in \
    linux-amd64) kasmvnc_arch="amd64" ;; \
    linux-arm64) kasmvnc_arch="arm64" ;; \
    *) echo "Unsupported KasmVNC Docker target: ${TARGETOS:-linux}-${TARGETARCH:-amd64}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/kasmvncserver.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${kasmvnc_arch}.deb"; \
  apt-get update; \
  apt-get install -y --no-install-recommends /tmp/kasmvncserver.deb; \
  rm -f /tmp/kasmvncserver.deb; \
  rm -rf /var/lib/apt/lists/*; \
  command -v vncserver; \
  dpkg-query -W kasmvncserver
COPY docker/optional-apps.sh /tmp/task-handoff-optional-apps.sh
RUN set -eux; \
  . /tmp/task-handoff-optional-apps.sh; \
  set_optional_app_defaults; \
  install_chromium_extensions; \
  case "${TASK_HANDOFF_ENABLE_CC_SWITCH}" in \
    1|true|TRUE|yes|YES|on|ON) \
      if [ -z "${CC_SWITCH_DEB_URL}" ]; then \
        echo "CC_SWITCH_DEB_URL is required when TASK_HANDOFF_ENABLE_CC_SWITCH=1" >&2; \
        exit 1; \
      fi; \
      curl -fsSL -o /tmp/cc-switch.deb "${CC_SWITCH_DEB_URL}"; \
      apt-get update; \
      apt-get install -y --no-install-recommends /tmp/cc-switch.deb; \
      rm -f /tmp/cc-switch.deb; \
      rm -rf /var/lib/apt/lists/*; \
      command -v "${CC_SWITCH_COMMAND}"; \
      ;; \
    *) \
      echo "Skipping optional cc-switch install."; \
      ;; \
  esac

FROM profile-gui-root AS profile-webcap-root
RUN set -eux; \
  git init /tmp/task-handoff-web-cap-source; \
  git -C /tmp/task-handoff-web-cap-source remote add origin "${WEB_CAP_SKILL_REPOSITORY}"; \
  git -C /tmp/task-handoff-web-cap-source sparse-checkout set skills/web-cap; \
  git -C /tmp/task-handoff-web-cap-source fetch --depth 1 origin "${WEB_CAP_SKILL_REF}"; \
  git -C /tmp/task-handoff-web-cap-source checkout --detach FETCH_HEAD; \
  test -f /tmp/task-handoff-web-cap-source/skills/web-cap/SKILL.md; \
  cp -R /tmp/task-handoff-web-cap-source/skills/web-cap /tmp/task-handoff-web-cap-skill; \
  rm -rf /tmp/task-handoff-web-cap-source; \
  . /tmp/task-handoff-optional-apps.sh; \
  install_web_cap

FROM profile-gui-root AS profile-bcap-root
ARG BCAP_SKILL_REPOSITORY=https://github.com/edgestorage/bcap.git
ARG BCAP_SKILL_REF=8df543022d4fb0f63106d6f72a1b0f149385ae48
RUN set -eux; \
  git init /tmp/task-handoff-bcap-source; \
  git -C /tmp/task-handoff-bcap-source remote add origin "${BCAP_SKILL_REPOSITORY}"; \
  git -C /tmp/task-handoff-bcap-source fetch --depth 1 origin "${BCAP_SKILL_REF}"; \
  git -C /tmp/task-handoff-bcap-source checkout --detach FETCH_HEAD; \
  test -f /tmp/task-handoff-bcap-source/SKILL.md; \
  rm -rf /tmp/task-handoff-bcap-source/.git; \
  rm -rf /tmp/task-handoff-bcap-skill; \
  mv /tmp/task-handoff-bcap-source /tmp/task-handoff-bcap-skill; \
  . /tmp/task-handoff-optional-apps.sh; \
  install_bcap

FROM profile-gui-root AS profile-browser-root
ARG CODE_SERVER_VERSION=4.125.0
RUN set -eux; \
  case "${TARGETOS:-linux}-${TARGETARCH:-amd64}" in \
    linux-amd64) code_server_arch="amd64" ;; \
    linux-arm64) code_server_arch="arm64" ;; \
    *) echo "Unsupported code-server Docker target: ${TARGETOS:-linux}-${TARGETARCH:-amd64}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/code-server.deb "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${code_server_arch}.deb"; \
  dpkg -i /tmp/code-server.deb; \
  rm -f /tmp/code-server.deb; \
  code-server --version

# Each exported target has its own immutable profile declaration and build
# identity while inheriting the shared filesystem layers above.
FROM profile-codex-root AS profile-codex
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-codex:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=codex
LABEL io.task-handoff.image.capabilities=terminal,codex

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-obscura-root AS profile-obscura
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-obscura:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=obscura
LABEL io.task-handoff.image.capabilities=terminal,codex,obscura

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-rea-root AS profile-rea
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-rea:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=rea
LABEL io.task-handoff.image.capabilities=terminal,codex,rea

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-opencode-root AS profile-opencode
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-opencode:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=opencode
LABEL io.task-handoff.image.capabilities=terminal,opencode

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-ai-root AS profile-ai
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-ai:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=ai
LABEL io.task-handoff.image.capabilities=terminal,codex,claude

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-webcap-root AS profile-webcap
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-webcap:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=webcap
LABEL io.task-handoff.image.capabilities=terminal,gui-terminal,browser,web-cap,codex,claude

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-bcap-root AS profile-bcap
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-bcap:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=bcap
LABEL io.task-handoff.image.capabilities=terminal,gui-terminal,browser,bcap,codex,claude

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-browser-root AS profile-browser
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-browser:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=browser
LABEL io.task-handoff.image.capabilities=terminal,gui-terminal,browser,vscode-web,codex,claude

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-image-entrypoint"]
CMD ["task-handoff", "web"]
