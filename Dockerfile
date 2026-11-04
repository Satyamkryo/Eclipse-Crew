FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app ./app
COPY components ./components
COPY public ./public
COPY lib ./lib
COPY db ./db
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY docker/desktop/mock-vendor/fixtures.mjs ./docker/desktop/mock-vendor/fixtures.mjs
COPY docker ./docker
COPY drizzle.config.ts ./
COPY components.json instrumentation.ts next.config.ts proxy.ts tsconfig.json postcss.config.mjs ./
RUN npm run build && chown -R node:node /app/.next

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /var/eclipse/artifacts /var/eclipse/memory && chown node:node /var/eclipse/artifacts /var/eclipse/memory
USER node
EXPOSE 3000
CMD ["node", "scripts/app-server.mjs", "--hostname", "0.0.0.0"]
