# The server joins the browser's network namespace

Marionette and WebDriver BiDi bind to `127.0.0.1` inside whatever network namespace Firefox
runs in, and no Firefox pref rebinds them (`marionette.port` sets the port only). So the MCP
server runs in its own container with `network_mode: "service:firefox"` and reaches them as
loopback; only the MCP HTTP port and VNC are published.

## Considered options

- **Host networking** (the original layout, now in `docker/archive/`). Works, but the
  browser owns host ports and the server has to run on the host, launched per client.
- **Publishing the ports from a bridge network.** Docker forwards to the container's bridge
  address, which a loopback-bound socket never accepts.
- **A VPN sidecar owning the namespace, server elsewhere.** Tested: the ports bound to the
  sidecar's loopback, refused from the host, reachable only by entering the namespace.
- **A remote server with a relay plus a `--marionette-host` flag.** Needs a TCP relay, a code
  change in the geckodriver argument builder in `src/firefox/core.ts`, and an unverified
  rewrite of the BiDi `webSocketUrl`. Rejected as the most moving parts for the least gain.

## Consequences

Only the namespace owner may declare `dns:` and `ports:`, so the server's port is listed on
the `firefox` service. Recreating Firefox requires recreating the server, whose namespace is
pinned to the old container.
