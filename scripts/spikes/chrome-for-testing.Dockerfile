# TASK-078 disposable spike. Uses the production desktop image for its tools and
# sandbox, then adds the exact measured Chrome for Testing pin without changing the
# production Dockerfile or browser.
FROM main-desktop:latest
USER root
COPY docker/desktop/browser-build.lock.json docker/desktop/browser-build.mjs /opt/eclipse/desktop/
RUN node /opt/eclipse/desktop/browser-build.mjs fetch /tmp/chrome.zip \
    && mkdir -p /opt/chrome-for-testing \
    && unzip -q /tmp/chrome.zip -d /opt/chrome-for-testing \
    && rm /tmp/chrome.zip \
    && chmod -R a+rX /opt/chrome-for-testing
COPY scripts/spikes/chrome-for-testing.mjs /opt/eclipse/desktop/
USER 65534:65534
CMD ["node", "/opt/eclipse/desktop/chrome-for-testing.mjs"]
