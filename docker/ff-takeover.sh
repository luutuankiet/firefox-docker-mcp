#!/usr/bin/env bash
# Toggle the dev Firefox container between automation and human-takeover mode.
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
COMPOSE=(docker compose -f docker/docker-compose.dev.yaml)
VNC_URL="http://$(hostname):5810"

case "${1:-}" in
  takeover)
    "${COMPOSE[@]}" stop mcp
    FF_DEV_CUSTOM_ARGS="" FF_DEV_MARIONETTE=false \
      "${COMPOSE[@]}" up -d --force-recreate firefox
    echo
    echo "Human takeover mode: Marionette and remote-debugging are OFF."
    echo "Sign in at ${VNC_URL}"
    echo "When finished:  $0 automate"
    ;;
  automate)
    "${COMPOSE[@]}" up -d --force-recreate firefox mcp
    echo
    echo "Automation mode: Marionette back on, MCP server reattached."
    echo "Health: $(curl -fsS --retry 10 --retry-delay 1 --retry-all-errors \
      --max-time 5 http://127.0.0.1:8931/health || echo 'not ready yet')"
    ;;
  status)
    docker inspect firefox-dev \
      --format 'FF_CUSTOM_ARGS={{range .Config.Env}}{{println .}}{{end}}' \
      | grep -E 'FF_CUSTOM_ARGS|MARIONETTE' || true
    "${COMPOSE[@]}" ps
    ;;
  *)
    echo "usage: $0 {takeover|automate|status}" >&2
    exit 2
    ;;
esac
