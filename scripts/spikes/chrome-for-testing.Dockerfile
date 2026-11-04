# TASK-078 disposable spike. Uses the production desktop image for its tools and
# sandbox, then adds the exact measured Chrome for Testing pin without changing the
# production Dockerfile or browser.
FROM main-desktop:latest
USER root
ARG TARGETARCH
COPY docker/desktop/browser-build.lock.json docker/desktop/browser-build.mjs /opt/eclipse/desktop/
RUN TARGETARCH="$TARGETARCH" node /opt/eclipse/desktop/browser-build.mjs fetch /tmp/chrome.zip \
    && mkdir -p /tmp/chrome-for-testing-extract \
    && unzip -q /tmp/chrome.zip -d /tmp/chrome-for-testing-extract \
    && case "$TARGETARCH" in amd64) browser=chrome-linux64 ;; arm64) browser=chrome-linux-arm64 ;; *) exit 1 ;; esac \
    && mkdir -p /opt/chrome-for-testing \
    && rm -rf /opt/chrome-for-testing/chrome-linux64 \
    && mv "/tmp/chrome-for-testing-extract/$browser" /opt/chrome-for-testing/chrome-linux64 \
    && rm -rf /tmp/chrome-for-testing-extract /tmp/chrome.zip \
    && chmod -R a+rX /opt/chrome-for-testing/chrome-linux64
COPY scripts/spikes/chrome-for-testing.mjs /opt/eclipse/desktop/
USER 65534:65534
CMD ["node", "/opt/eclipse/desktop/chrome-for-testing.mjs"]
