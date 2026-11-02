# Same pinned Node image as the app. No packages are installed; the proxy uses built-in modules only.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
COPY proxy.mjs registry.mjs desktop-proxy.mjs addresses.mjs canary.mjs events.mjs /opt/egress/
USER 65534:65534
# 4320: app routes (/v1/forward, /v1/teach-asr, /v1/policy, /v1/events). 4321: per-agent browser proxy.
EXPOSE 4320 4321
CMD ["node", "/opt/egress/proxy.mjs"]
