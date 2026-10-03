---
title: Docker stacks, production and dev
covers: how the browser and server containers are wired, which compose file is prod and which is dev, how the prod image gets its server version, how a person signs in to sites that block automation
verified: 2026-10-03
---

# Docker stacks, production and dev

Two compose stacks of the same shape run side by side. Each has a `firefox` service
(the `jlesage/firefox` image: Firefox, Xvfb, noVNC) that **owns** the network namespace,
and an `mcp` service that **joins** it with `network_mode: "service:firefox"`. The server
reaches Marionette and BiDi on loopback inside that namespace; only the MCP HTTP port and
VNC are published.

## Files

| file | what it is |
|---|---|
| `docker/docker-compose.yaml` | **prod**, compose project `firefox`. MCP on 8931, VNC 5800/5900. Server image `firefox-docker-mcp:${MCP_VERSION:-<release>}` |
| `docker/docker-compose.dev.yaml` | **dev**, project `firefox-dev`. MCP on 8941, VNC 5810/5910. Working tree bind-mounted at `/app` |
| `docker/Dockerfile.prod` | `node:22-bookworm-slim`, a baked geckodriver, and `npm install -g @luutuankiet/firefox-docker-mcp@${MCP_VERSION}`. No default version, by design |
| `docker/Dockerfile.mcp` | the dev server image |
| `docker/dev-reload.sh` | build, restart only the dev `mcp` container, curl its `/health` |
| `docker/ff-takeover.sh` | `STACK=prod\|dev`; `takeover` drops the automation flags so a person can sign in to sites that reject automated browsers, `automate` puts them back. The profile volume survives both |
| `docker/smoke.sh` | smoke check against a running stack |
| `docker/archive/docker-compose.host-stdio.yaml` | the retired host-network layout, kept for reference |
| `docker/.env.example` | template for the gitignored `docker/.env` (bearer tokens) |

## Shapes that are deliberate

- **Only the namespace owner may declare `dns:` and `ports:`.** Docker hard-errors with
  "conflicting options: dns and the network mode" if the joining service sets them. So
  `ports:` lists 8931 on the `firefox` service even though the `mcp` service binds it.
- **The compose `name:` is load-bearing.** Without it, Compose derives the project name
  from the directory (`docker`), which is the retired stack's project. Both files declare a
  service called `firefox`, so Compose would adopt and replace the wrong running container.
- **The `mcp` container's namespace is pinned to the Firefox container's id.** When
  Firefox is recreated (takeover does this), the `mcp` container must be recreated too,
  not merely restarted.
- **Restarting `mcp` does not touch Firefox.** That is what keeps the person's tabs and
  signed-in profile alive through a server deploy.
- **Popups open as tabs.** `browser.link.open_newwindow=3` and its `.restriction=0` are set
  through the image's `FF_PREF_*` variables. On a single-canvas VNC display a real popup
  window cannot be closed or moved; as a tab, `window.opener`, `postMessage` and
  `window.close()` still work.
- **The prod image is not built on `jlesage/firefox`.** That image is Alpine (musl) and
  geckodriver ships glibc builds only.

Service names are `firefox` and `mcp`; container names are `firefox`/`firefox-mcp` (prod) and
`firefox-dev`/`firefox-dev-mcp` (dev). `docker compose` commands take the **service** name.

## The general rule

A change that only the server needs is deployed by recreating `mcp` alone. Anything that
recreates `firefox` costs the person their open tabs, so it needs a reason.
