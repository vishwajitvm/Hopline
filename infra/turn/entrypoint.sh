#!/bin/sh
# Starts coturn with Hopline's hardened settings. Refuses to start with a missing or weak secret: with
# `use-auth-secret` and an empty secret, anyone could mint valid relay credentials.
set -eu

if [ "${#TURN_SECRET}" -lt 16 ]; then
  echo "hopline-turn: TURN_SECRET must be set to at least 16 random characters (see .env.example)." >&2
  exit 1
fi
if [ -z "${TURN_EXTERNAL_IP:-}" ]; then
  echo "hopline-turn: TURN_EXTERNAL_IP must be set to this machine's public IP address." >&2
  exit 1
fi

MIN_PORT="${TURN_MIN_PORT:-49160}"
MAX_PORT="${TURN_MAX_PORT:-49360}"

# Current coturn keeps its admin CLI and DTLS off unless enabled (--cli / --dtls); TLS is disabled explicitly.
# shellcheck disable=SC2086  # TURN_EXTRA_ARGS is intentionally word-split into separate flags
exec turnserver -n --log-file=stdout --fingerprint \
  --listening-port=3478 --min-port="$MIN_PORT" --max-port="$MAX_PORT" \
  --realm="${TURN_REALM:-hopline}" \
  --use-auth-secret --static-auth-secret="$TURN_SECRET" \
  --external-ip="$TURN_EXTERNAL_IP" \
  --no-tls --no-multicast-peers --no-tcp-relay \
  --user-quota=32 --total-quota=1200 --stale-nonce=600 \
  --max-bps="${TURN_MAX_BPS:-0}" \
  --denied-peer-ip=0.0.0.0-0.255.255.255 \
  --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=100.64.0.0-100.127.255.255 \
  --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.0.0.0-192.0.0.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 \
  --denied-peer-ip=198.18.0.0-198.19.255.255 \
  --denied-peer-ip=224.0.0.0-255.255.255.255 \
  --denied-peer-ip=::1 \
  --denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255 \
  --denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff \
  --denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  ${TURN_EXTRA_ARGS:-}
