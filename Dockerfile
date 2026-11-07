# All-in-one image: web app + signaling server in ONE container on ONE port.
# Use it for single-service hosts (Fly.io, Railway, Koyeb, Render's Docker runtime, any VPS):
#   docker build -t hopline .
#   docker run -p 8787:8787 hopline        → http://localhost:8787
# For the two-container setup (nginx + server), use docker-compose.yml instead.

ARG NODE_VERSION=22

# ── Build the web app ───────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS web-build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @hopline/web

ARG VITE_SIGNALING_URL=""
ARG VITE_STUN_URLS=""
# (TURN credentials are NOT build settings: the server issues short-lived ones at runtime — set TURN_* at run time.)
ENV VITE_SIGNALING_URL=${VITE_SIGNALING_URL} \
    VITE_STUN_URLS=${VITE_STUN_URLS}

COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web
RUN npm run build --workspace @hopline/web

# ── Production dependencies for the server only ─────────────────────────────
FROM node:${NODE_VERSION}-alpine AS server-deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --workspace @hopline/server

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SERVE_WEB=true \
    TRUST_PROXY=0
# TRUST_PROXY: set to 1 (or the number of proxies) ONLY when the container is reachable solely through a
# reverse proxy/load balancer (e.g. Render, Fly, Railway). With 0, X-Forwarded-For is ignored and can't be
# spoofed.
WORKDIR /app

# Latest Alpine security patches; drop package managers the server never uses (smaller attack surface).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Files stay owned by root: the app user can read but never modify its own code.
COPY --from=server-deps /app/node_modules ./node_modules
COPY packages/protocol ./packages/protocol
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/src ./apps/server/src
COPY --from=web-build /app/apps/web/dist ./apps/web/dist

USER node
EXPOSE 8787

# Hosts usually inject PORT; the check follows whatever it is.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "apps/server/src/index.js"]
