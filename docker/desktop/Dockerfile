# Existing pinned Node image verifies the reviewed package archives at build time.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS package_archives
WORKDIR /opt/package-fetch
COPY ubuntu-packages.lock.json fetch-packages.mjs ./
RUN node fetch-packages.mjs
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64

# All archives are hash-locked. Apt only orders local files, with no network.
RUN --network=none --mount=type=bind,from=package_archives,source=/debs,target=/debs,ro \
    mkdir -p /var/cache/apt/archives \
    && for archive in /debs/*.deb; do \
         filename="$(dpkg-deb --show --showformat='${Package}_${Version}_${Architecture}.deb' "$archive" | sed 's/:/%3a/g')"; \
         cp "$archive" "/var/cache/apt/archives/$filename"; \
       done \
    && DEBIAN_FRONTEND=noninteractive apt-get --no-download install -y --no-install-recommends /debs/*.deb \
    && mkdir -p /opt/eclipse/desktop \
    && dpkg-query -W -f='${binary:Package}\t${Version}\n' > /opt/eclipse/desktop/ubuntu-packages.tsv \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
    && ! command -v sudo

RUN curl --fail --location --proto '=https' --tlsv1.2 --max-time 180 \
      https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && printf '%s\n' '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75  /tmp/node.tar.xz' | sha256sum --check --strict \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz

RUN curl --fail --location --proto '=https' --tlsv1.2 --max-time 300 \
      'https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/1731633/chrome-linux.zip?generation=1793382328373231' -o /tmp/chromium.zip \
    && test "$(stat -c %s /tmp/chromium.zip)" = 254612164 \
    && printf '%s\n' '65eedec10a9948b2168e37ba70a6ada69a9c5d9bf3078e2733a371fd1f011d15  /tmp/chromium.zip' | sha256sum --check --strict \
    && mkdir -p /opt/chromium \
    && unzip -q /tmp/chromium.zip -d /opt/chromium \
    && rm /tmp/chromium.zip

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HOME=/tmp
WORKDIR /opt/eclipse/desktop
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY check-tools.mjs smoke.mjs bootstrap.py agent-store.mjs agent-admin.mjs supervisor.mjs session-manager.mjs session-worker.mjs cookie-snapshot.mjs vnc-session.mjs rfb-bridge.mjs seccomp_profile.json controller-schema.mjs controller.mjs controller-channel.mjs file-server.mjs inbox-writer.mjs outbox-reader.mjs file-tools.mjs checkpoint-tools.mjs checkpoint-restore.mjs page-snapshot.mjs teach-capture.mjs teach-safety.mjs ./
COPY mock-vendor ./mock-vendor
RUN cp /etc/passwd /opt/eclipse/desktop/base-passwd \
    && cp /etc/group /opt/eclipse/desktop/base-group \
    && mkdir -p /downloads \
    && chmod 755 /downloads
USER 65534:65534
CMD ["sleep", "infinity"]
