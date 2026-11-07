# Build from the repository root:  docker build -f apps/web/Dockerfile .

ARG NODE_VERSION=22

# ── Build the static site ───────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build
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

# Optional build-time settings (see .env.example). Empty means "use the defaults".
ARG VITE_SIGNALING_URL=""
ARG VITE_STUN_URLS=""
# (TURN credentials are NOT build settings: the server issues short-lived ones at runtime.)
ENV VITE_SIGNALING_URL=${VITE_SIGNALING_URL} \
    VITE_STUN_URLS=${VITE_STUN_URLS}

COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web
RUN npm run build --workspace @hopline/web

# ── Serve with nginx (unprivileged: runs as non-root on port 8080) ──────────
FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
# Latest Alpine security patches (the upstream image can lag behind).
USER root
RUN apk upgrade --no-cache
USER 101
# Where nginx forwards the /ws signaling WebSocket. Substituted into the template at container start.
ENV SIGNALING_UPSTREAM=server:8787
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/nginx-health >/dev/null || exit 1
