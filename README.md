# firefox-docker-mcp

A shared browser for humans and AI agents. Two entrypoints, one session.

**Human** opens the browser via VNC web UI — clicks around, navigates, sees exactly what the agent sees. **Agent** drives the same browser via MCP tools — every action returns a screenshot so it can verify its own work. Both operate on the same Firefox instance, turn by turn.

Built for agents that need to close their own verification loop: check a frontend you just changed, confirm a local dev server is rendering correctly, validate a public site's behavior — then hand the browser to a human when judgment is needed.

**One MCP call = one browser action + one screenshot returned.**

## How It Works

```
 Human (browser)              AI Agent (MCP client)
      │                              │
      ▼                              ▼
 VNC web UI (:5800)          MCP over HTTP (:8931)
      │                              │
      │                    ┌─────────▼─────────┐
      │                    │  MCP server       │
      │                    │  (own container,  │
      │                    │   joins the net-  │
      │                    │   work namespace) │
      │                    └─────────┬─────────┘
      └──────────┐    ┌──────────────┘
                 ▼    ▼
           Firefox (Docker)
           Marionette :2828 (loopback only)
```

Firefox runs in Docker. The human connects via noVNC at `localhost:5800`. The agent connects over streamable HTTP on `:8931`. Same tabs, same cookies, same page state.

Marionette binds loopback and cannot be told otherwise, which is why the server runs in its own container that *joins* Firefox's network namespace rather than talking to it over the network. Multiple agents share the browser through per-tab ownership (see `claim_tab` / `list_pages`), so concurrent agents stay out of each other's tabs.

## Quick Start

### 1. Start the stack

```bash
cp docker/.env.example docker/.env   # then set MCP_PROD_HTTP_TOKEN to a random string
docker compose -f docker/docker-compose.yaml up -d
```

That brings up Firefox and the MCP server together. Open `http://localhost:5800` for the browser; `http://localhost:8931/health` should answer `{"ok":true,...}`.

The server image is pinned to a published release. To move it, set `MCP_VERSION` in `docker/.env` and rebuild.

### 2. Configure your MCP client

```json
{
  "mcpServers": {
    "firefox": {
      "type": "http",
      "url": "http://localhost:8931/mcp",
      "headers": { "Authorization": "Bearer <MCP_PROD_HTTP_TOKEN>" }
    }
  }
}
```

### Alternative: server on the host, over stdio

If you would rather run the browser alone and start the server per client, run any Firefox container that exposes Marionette on the host and point the published package at it:

```json
{
  "mcpServers": {
    "firefox": {
      "command": "npx",
      "args": [
        "@luutuankiet/firefox-docker-mcp",
        "--connect-existing",
        "--marionette-port", "2828",
        "--enable-privileged-context"
      ]
    }
  }
}
```

### Signing in to sites that reject automation

Google and several other identity providers refuse sign-in on a browser advertising Marionette. Drop the automation flags, sign in by hand through noVNC, then switch back — the profile is a named volume, so the session survives:

```bash
./docker/ff-takeover.sh takeover   # flags off, sign in at :5800
./docker/ff-takeover.sh automate   # flags back on, server reattached
```

## What Makes This Different

This is a fork of [Mozilla's firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp) with one change: **mutation tools auto-append a screenshot to their response.**

Upstream requires 3 MCP round-trips per interaction (action + screenshot + read). This fork does it in 1. The agent sees the result of every action immediately — no extra calls, no blind spots.

### Auto-Screenshot Tools

These tools return their normal text result **plus** a screenshot:

| Tool | Action |
|------|--------|
| `navigate_page` | Go to URL |
| `new_page` | Open tab |
| `click_by_uid` | Click element |
| `hover_by_uid` | Hover element |
| `fill_by_uid` | Type into input |
| `drag_by_uid_to_uid` | Drag and drop |
| `fill_form_by_uid` | Fill multiple fields |
| `upload_file_by_uid` | Upload file |
| `accept_dialog` / `dismiss_dialog` | Handle browser dialogs |
| `navigate_history` | Back / forward |
| `set_viewport_size` | Resize viewport |

All other tools (standalone screenshot, DOM snapshot, console, network, etc.) work identically to upstream. Full tool reference: [firefox-devtools-mcp docs](https://github.com/mozilla/firefox-devtools-mcp#readme).

### Added Tools (v0.2.0)

Token-efficient inspection + motion capture, built for agents that need to reconstruct page state faithfully rather than just snapshot it:

| Tool | Action |
|------|--------|
| `query_dom` | Query the DOM with CSS selectors — 9 modes (`outline`, `text`, `html`, `outer`, `attr`, `styles`, `table`, `count`, `json`). Returns raw structure (e.g. SVG `tspan` / `foreignObject`) that `take_snapshot` collapses. |
| `scroll_page` | Scroll the viewport or a target element (`top` / `bottom` / `by` / element). Falls back to the largest inner scrollable container on app-shell layouts and names the scroller it drove. Returns scroll metrics plus a screenshot. |
| `page_info` | Page ground truth: URL, title, readyState, viewport, pending viewport images, body visibility, frames, scrollable containers. Cheap text-only diagnostic. |
| `evaluate_script` | Execute arbitrary JavaScript in the page context. **Requires `--enable-script`** (off by default). |
| `start_recording` | Begin a screenshot-polled screen recording — buffers frames in memory and suppresses per-call screenshots while active. Auto-stops at the frame cap or a duration cap. |
| `stop_recording` | Stop the recording — writes PNG frames + an animated GIF to `~/.firefox-devtools-mcp/recordings/<timestamp>/` and returns evenly-sampled frames inline. |

## Use Cases

- **Frontend verification loop** — Agent edits code, tunnels local dev server to the browser, navigates to it, screenshots to confirm the change looks right
- **Public site interaction** — Agent fills forms, clicks through flows, reads results — all with visual confirmation
- **Human handoff** — Agent gets stuck or hits a CAPTCHA; human takes over in the VNC UI, resolves it, hands back
- **Debug sessions** — Human and agent collaboratively inspect a page, with the agent snapshotting the DOM and the human eyeballing the layout

## CLI Options

```
--connect-existing     Connect to running Firefox (recommended for Docker)
--marionette-port      Marionette port (default: 2828)
--headless             Run Firefox headless
--viewport WxH         Set viewport (e.g. 390x844)
--firefox-path PATH    Custom Firefox binary path
--enable-script        Enable evaluate_script tool
--start-url URL        Initial URL to open
```

## Token Budget

Screenshot token cost scales with viewport size. Use `set_viewport_size` to switch viewports at runtime — no container restart needed.

Claude vision formula: `(width x height) / 750 = tokens per screenshot`

| Viewport | Size | Tokens/screenshot | 50 interactions |
|----------|------|-------------------|-----------------|
| Mobile | 390x844 | ~439 | ~22K |
| Tablet | 768x1024 | ~1,049 | ~52K |
| Laptop | 1280x720 | ~1,229 | ~61K |
| Desktop | 1920x1080 | ~2,765 | ~138K |

Pick the viewport that fits your task. Debugging a mobile layout? Switch to 390x844. Verifying a dashboard? Use 1280x720. The Docker display canvas is 1920x1080 — large enough to fit any of these.

## Development

```bash
npm install
npm run build
npm run dev          # watch mode with tsx
node test-e2e.mjs   # end-to-end test
```

A second, isolated stack runs the server from the working tree instead of a
published release, on its own ports (`8941`, VNC `5810`) and its own profile
volume, so it never disturbs a running production stack:

```bash
docker compose -f docker/docker-compose.dev.yaml up -d
./docker/dev-reload.sh                 # rebuild + swap the server, browser keeps running
STACK=dev ./docker/ff-takeover.sh status
```

## License

MIT (fork of [Mozilla firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp), also MIT)
