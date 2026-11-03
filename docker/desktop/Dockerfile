# Existing pinned Node image verifies the reviewed package archives at build time.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS package_archives
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64|arm64) ;; \
      *) echo "Eclipse Crew supports x86-64 (amd64) and 64-bit ARM (arm64); this machine is ${TARGETARCH:-unknown}." >&2; exit 1 ;; \
    esac
WORKDIR /opt/package-fetch
# One reviewed lock per CPU; a missing or unmeasured architecture fails closed.
COPY ubuntu-packages*.lock.json fetch-packages.mjs ./
RUN TARGETARCH="$TARGETARCH" node fetch-packages.mjs
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ARG TARGETARCH

# All archives are hash-locked. Apt only orders local files, with no network.
RUN --network=none --mount=type=bind,from=package_archives,source=/debs,target=/debs,ro \
    mkdir -p /var/cache/apt/archives \
    && for archive in /debs/*.deb; do \
         filename="$(dpkg-deb --show --showformat='${Package}_${Version}_${Architecture}.deb' "$archive" | sed 's/:/%3a/g')"; \
         cp "$archive" "/var/cache/apt/archives/$filename"; \
       done \
    && DEBIAN_FRONTEND=noninteractive apt-get --no-download install -y --no-install-recommends /debs/*.deb \
    && mkdir -p /opt/eclipse/desktop \
    && printf '%s\n' "$TARGETARCH" > /opt/eclipse/desktop/image-arch \
    && chmod 644 /opt/eclipse/desktop/image-arch \
    && dpkg-query -W -f='${binary:Package}\t${Version}\n' > /opt/eclipse/desktop/ubuntu-packages.tsv \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
    && ! command -v sudo

# Node's signed SHASUMS256.txt (release key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356)
# supplies the arm64 hash; both archives are pinned per CPU.
RUN case "$TARGETARCH" in \
      amd64) url='https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz'; hash='48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75' ;; \
      arm64) url='https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-arm64.tar.xz'; hash='eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8' ;; \
    esac \
    && curl --fail --location --proto '=https' --tlsv1.2 --max-time 300 "$url" -o /tmp/node.tar.xz \
    && printf '%s  %s\n' "$hash" /tmp/node.tar.xz | sha256sum --check --strict \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HOME=/tmp
WORKDIR /opt/eclipse/desktop
COPY browser-build.lock.json browser-build.mjs ./
# The arm64 archive unpacks as chrome-linux-arm64; normalize both CPUs to chrome-linux64
# so every executable, resource and profile path stays identical.
RUN case "$TARGETARCH" in \
      amd64) directory=chrome-linux64 ;; \
      arm64) directory=chrome-linux-arm64 ;; \
    esac \
    && TARGETARCH="$TARGETARCH" node browser-build.mjs fetch /tmp/chrome.zip \
    && mkdir -p /opt/chrome-for-testing /tmp/chrome-extract \
    && unzip -q /tmp/chrome.zip -d /tmp/chrome-extract \
    && mv "/tmp/chrome-extract/$directory" /opt/chrome-for-testing/chrome-linux64 \
    && rm -rf /tmp/chrome-extract /tmp/chrome.zip
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY check-tools.mjs smoke.mjs bootstrap.py agent-store.mjs agent-admin.mjs supervisor.mjs session-manager.mjs session-worker.mjs cookie-snapshot.mjs vnc-session.mjs rfb-bridge.mjs seccomp_profile.json controller-schema.mjs controller.mjs controller-channel.mjs file-server.mjs inbox-writer.mjs outbox-reader.mjs file-tools.mjs doc-search.mjs checkpoint-tools.mjs checkpoint-restore.mjs page-snapshot.mjs teach-capture.mjs teach-safety.mjs netns-enter.py egress-relay.mjs shell-runner.mjs desktop-config.mjs agent-audio.mjs ./
COPY mock-vendor ./mock-vendor
COPY desktop-config ./desktop-config
RUN chmod 755 desktop-config/browser-focus.sh desktop-config/open-files.sh desktop-config/open-terminal.sh
RUN cp /etc/passwd /opt/eclipse/desktop/base-passwd \
    && cp /etc/group /opt/eclipse/desktop/base-group \
    && mkdir -p /downloads \
    && chmod 755 /downloads
USER 65534:65534
CMD ["sleep", "infinity"]
