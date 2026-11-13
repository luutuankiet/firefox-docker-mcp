#!/usr/bin/env bash
# Rebuild the server and swap it into the running dev stack.
#
# Only the MCP container restarts -- Firefox keeps running, so the browser
# session, open tabs and profile state all survive the reload.
set -euo pipefail

cd "$(dirname "$0")/.."

# The stack publishes on FF_PUBLISH_ADDR from docker/.env (loopback by default),
# so health checks must dial that address, not a hard-coded 127.0.0.1.
FF_PUBLISH_ADDR="$(sed -n 's/^FF_PUBLISH_ADDR=//p' docker/.env 2>/dev/null | tail -n 1)"
HOST_ADDR="${FF_PUBLISH_ADDR:-127.0.0.1}"

export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"

npm run build
docker compose -f docker/docker-compose.dev.yaml restart mcp

# Give the server a moment to bind before reporting health.
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://${HOST_ADDR}:8941/health >/dev/null 2>&1; then
    curl -fsS http://${HOST_ADDR}:8941/health
    echo
    exit 0
  fi
  sleep 0.5
done

echo "mcp did not become healthy; last 40 log lines:" >&2
docker compose -f docker/docker-compose.dev.yaml logs --tail 40 mcp >&2
exit 1
