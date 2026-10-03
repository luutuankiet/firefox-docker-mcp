---
title: Deploying a release to the production stack
summary: the order of operations that upgrades the prod server without closing the person's tabs, and how to confirm what is running
verified: 2026-10-03
---

# Deploying a release to the production stack

Publishing (tag → CI → npm) is described in `releases/README.md`. This page starts after
the new version is on npm.

## Steps

```
cd docker
docker compose build mcp
docker compose up -d --no-deps mcp
docker exec firefox-mcp npm ls -g --depth=0
```

- **`mcp` is the service name**; `firefox-mcp` is the container name. `docker compose build
  firefox-mcp` fails with `no such service`. `docker compose config --services` lists
  `firefox` and `mcp`.
- **`--no-deps` is what keeps Firefox running**, so the person's tabs and signed-in profile
  survive the deploy. Without it Compose may recreate `firefox` too.
- The version comes from `${MCP_VERSION:-<default>}` in `docker/docker-compose.yaml`; the
  release script already bumped the default. Set `MCP_VERSION` in `docker/.env` only to pin
  something else.
- **Confirm with the last command, not with the image tag.** The tag is a label; the
  installed package is what runs.
- MCP clients or proxies holding a session to the old server need to reconnect.

## Rolling back

Set `MCP_VERSION` to the previous release and repeat the same steps. The image for the old
version is usually still in the local image cache, so the build is instant.

## When Firefox itself must be recreated

Changing the `firefox` service (prefs, image, ports) recreates the browser and closes every
tab. Recreate `mcp` afterwards as well: it joined the old container's network namespace,
and a plain restart does not rejoin the new one.
