# coturn with current Alpine security patches applied, plus a safe entrypoint.
#   docker compose --profile turn up -d --build
FROM coturn/coturn:alpine

USER root
# The upstream image lags behind Alpine security fixes; pull them in at build time.
RUN apk upgrade --no-cache
COPY --chmod=0755 entrypoint.sh /usr/local/bin/hopline-turn-entrypoint
USER nobody:nogroup

ENTRYPOINT ["/usr/local/bin/hopline-turn-entrypoint"]
