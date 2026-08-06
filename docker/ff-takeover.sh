#!/usr/bin/env bash
# Toggle a Firefox stack between automation and human-takeover mode.
#
# Stack selection:  STACK=prod (default) or STACK=dev, e.g. `STACK=dev $0 takeover`.
#
# Why this exists: Google and several other identity providers refuse sign-in
# on a browser advertising Marionette / remote-debugging. Drop the flags, sign
# in by hand through noVNC, then switch back. The profile lives in a named
# volume, so cookies and sessions survive both recreations.
#
# The MCP server is stopped during takeover: with Marionette off there is no
# port for it to attach to. It also has to be RECREATED (not merely started)
# afterwards, because network_mode: service:firefox pins it to the Firefox
# container's namespace by container id -- recreating Firefox invalidates it.
set -euo pipefail

cd "$(dirname "$0")/.."

STACK="${STACK:-prod}"
case "$STACK" in
  prod)
    COMPOSE_FILE=docker/docker-compose.yaml
    ARGS_VAR=FF_PROD_CUSTOM_ARGS
    MARIONETTE_VAR=FF_PROD_MARIONETTE
    FF_CONTAINER=firefox
    VNC_PORT=5800
    MCP_PORT=8931
    ;;
  dev)
    COMPOSE_FILE=docker/docker-compose.dev.yaml
    ARGS_VAR=FF_DEV_CUSTOM_ARGS
    MARIONETTE_VAR=FF_DEV_MARIONETTE
    FF_CONTAINER=firefox-dev
    VNC_PORT=5810
    MCP_PORT=8941
    ;;
  *)
    echo "unknown STACK=$STACK (expected prod or dev)" >&2
    exit 2
    ;;
esac

COMPOSE=(docker compose -f "$COMPOSE_FILE")
VNC_URL="http://$(hostname):${VNC_PORT}"

case "${1:-}" in
  takeover)
    "${COMPOSE[@]}" stop mcp
    env "${ARGS_VAR}=" "${MARIONETTE_VAR}=false" \
      "${COMPOSE[@]}" up -d --force-recreate firefox
    echo
    echo "Human takeover mode (${STACK}): Marionette and remote-debugging are OFF."
    echo "Sign in at ${VNC_URL}"
    echo "When finished:  STACK=${STACK} $0 automate"
    ;;
  automate)
    "${COMPOSE[@]}" up -d --force-recreate firefox mcp
    echo
    echo "Automation mode (${STACK}): Marionette back on, MCP server reattached."
    echo "Health: $(curl -fsS --retry 10 --retry-delay 1 --retry-all-errors \
      --max-time 5 "http://127.0.0.1:${MCP_PORT}/health" || echo 'not ready yet')"
    ;;
  status)
    docker inspect "$FF_CONTAINER" \
      --format 'FF_CUSTOM_ARGS={{range .Config.Env}}{{println .}}{{end}}' \
      | grep -E 'FF_CUSTOM_ARGS|MARIONETTE' || true
    "${COMPOSE[@]}" ps
    ;;
  *)
    echo "usage: $0 {takeover|automate|status}" >&2
    exit 2
    ;;
esac
