#!/usr/bin/env bash
# Rebuild the server and swap it into the running dev stack.
#
# Only the MCP container restarts -- Firefox keeps running, so the browser
# session, open tabs and profile state all survive the reload.
set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"

npm run build
docker compose -f docker/docker-compose.dev.yaml restart mcp

# Give the server a moment to bind before reporting health.
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8941/health >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:8941/health
    echo
    exit 0
  fi
  sleep 0.5
done

echo "mcp did not become healthy; last 40 log lines:" >&2
docker compose -f docker/docker-compose.dev.yaml logs --tail 40 mcp >&2
exit 1
