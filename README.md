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
 VNC web UI (:5800)          MCP server (stdio)
      │                              │
      └──────────┐    ┌──────────────┘
                 ▼    ▼
           Firefox (Docker)
           Marionette :2828
```

Firefox runs in Docker. The human connects via noVNC at `localhost:5800`. The agent connects via MCP tools through Marionette. Same tabs, same cookies, same page state. Marionette is single-session, so access is turn-based — not concurrent.

## Quick Start

### 1. Run Firefox in Docker

```bash
cd docker/
docker compose up -d
```

Open `http://localhost:5800` in your browser — you should see Firefox.

### 2. Run the MCP server

```bash
npx @luutuankiet/firefox-docker-mcp --connect-existing --marionette-port 2828
```

### 3. Configure your MCP client

Add to your MCP client config (e.g. Claude Code `settings.json`):

```json
{
  "mcpServers": {
    "firefox": {
      "command": "npx",
      "args": [
        "firefox-docker-mcp",
        "--connect-existing",
        "--marionette-port", "2828"
      ]
    }
  }
}
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

## License

MIT (fork of [Mozilla firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp), also MIT)
