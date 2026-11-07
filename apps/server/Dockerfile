# Build from the repository root:  docker build -f apps/server/Dockerfile .

ARG NODE_VERSION=22

# ── Dependencies: production packages for the server workspace only ─────────
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Every workspace manifest is copied so npm can validate the lockfile; only the server's deps are installed.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --workspace @hopline/server

# ── Runtime: minimal image, non-root user ───────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    SERVE_WEB=false
WORKDIR /app

# Latest Alpine security patches; drop package managers the server never uses (smaller attack surface).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Files stay owned by root: the app user can read but never modify its own code.
COPY --from=deps /app/node_modules ./node_modules
COPY packages/protocol ./packages/protocol
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/src ./apps/server/src

USER node
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "apps/server/src/index.js"]
