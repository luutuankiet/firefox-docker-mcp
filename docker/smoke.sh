#!/usr/bin/env bash
# End-to-end check of the dev stack over the HTTP transport.
#
# Covers the things that actually broke while building it: multiple concurrent
# sessions (a single shared transport silently serves exactly one), recovery
# from a stale session id, and a real Marionette round-trip across the shared
# network namespace.
set -uo pipefail

# Same .env Compose feeds the container, so the smoke test always uses whatever
# token the running server was actually started with.
ENV_FILE="$(dirname "$0")/.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

URL="${MCP_URL:-http://127.0.0.1:8931}"
TOKEN="${MCP_HTTP_TOKEN:-firefox-dev}"
HDRS=(-H "Authorization: Bearer ${TOKEN}"
      -H 'Content-Type: application/json'
      -H 'Accept: application/json, text/event-stream')

rpc() { # rpc <session-id|-> <json>
  local sid="$1" body="$2"
  if [ "$sid" = "-" ]; then
    curl -s --max-time 180 -X POST "${URL}/mcp" "${HDRS[@]}" -d "$body"
  else
    curl -s --max-time 180 -X POST "${URL}/mcp" "${HDRS[@]}" \
      -H "mcp-session-id: ${sid}" -d "$body"
  fi
}

open_session() {
  local hdrfile
  hdrfile=$(mktemp)
  curl -s -D "$hdrfile" --max-time 20 -X POST "${URL}/mcp" "${HDRS[@]}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
    >/dev/null
  grep -i '^mcp-session-id' "$hdrfile" | tr -d '\r' | awk '{print $2}'
  rm -f "$hdrfile"
}

# Strips SSE framing and reports the interesting fields without dumping a
# multi-megabyte base64 screenshot into the terminal.
summarise() {
  sed -n 's/^data: //p' | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const r = JSON.parse(s);
    if (r.error) { console.log("  JSONRPC ERROR:", JSON.stringify(r.error).slice(0, 300)); return; }
    if (r.result?.tools) { console.log("  tools=" + r.result.tools.length); return; }
    console.log("  isError=" + Boolean(r.result?.isError));
    for (const c of r.result?.content ?? []) {
      console.log(c.type === "image"
        ? `  [image ${c.mimeType} ${c.data.length}b base64]`
        : "  " + String(c.text).replace(/\s+/g, " ").slice(0, 200));
    }
  } catch {
    console.log("  RAW:", s.slice(0, 200) || "(empty)");
  }
});'
}

echo "== health =="
curl -s --max-time 5 "${URL}/health"; echo

echo "== two independent sessions =="
S1=$(open_session); echo "  session1=${S1:-FAILED}"
S2=$(open_session); echo "  session2=${S2:-FAILED}"
[ -n "$S1" ] && [ -n "$S2" ] && [ "$S1" != "$S2" ] \
  && echo "  OK distinct sessions" || echo "  FAIL"

rpc "$S1" '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

echo "== tools/list =="
rpc "$S1" '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | summarise

echo "== unknown session id (expect -32001 Session not found) =="
rpc "deadbeef-0000-0000-0000-000000000000" \
  '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}' | head -c 200; echo

echo "== bridge tools present (non-tailnet fallback) =="
rpc "$S1" '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}' \
  | sed -n 's/^data: //p' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=JSON.parse(s).result.tools.map(t=>t.name).filter(x=>/bridge|host_network/.test(x));console.log("  "+(n.join(", ")||"NONE — bridge missing"))}catch{console.log("  parse failed")}})'

echo "== navigate_page (Marionette round-trip across shared netns) =="
rpc "$S1" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"navigate_page","arguments":{"url":"https://example.com"}}}' | summarise

echo "== container DNS (MagicDNS + public, from Firefox netns) =="
docker exec firefox-dev-mcp sh -c \
  'getent hosts thinkpad >/dev/null && echo "  thinkpad OK" || echo "  thinkpad FAIL"; \
   getent hosts github.com >/dev/null && echo "  github.com OK" || echo "  github.com FAIL"'

echo "== final health =="
curl -s --max-time 5 "${URL}/health"; echo
