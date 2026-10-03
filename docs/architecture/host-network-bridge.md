---
title: Host-network bridge
covers: how the shared browser reaches localhost on a different machine, the firefox-bridge package, connect_host_network and disconnect_host_network, takeover, idle exit
verified: 2026-10-03
---

# Host-network bridge

`connect_host_network` lets the shared browser open `localhost:<port>` on some other
machine — a dev box, a container — with no inbound port open on either side. That machine
runs `npx @luutuankiet/firefox-bridge --secret <s>`; the server connects to it peer to peer
over HyperDHT and points Firefox's SOCKS proxy at a local pipe.

Line numbers are a starting point, not an address.

## Where it lives

| file | lines | what lives there |
|---|---|---|
| `packages/firefox-bridge/src/server.js` | `startBridge` ~16 | the remote end: HyperDHT server, firewall, SOCKS5, idle and lifetime timers |
| `packages/firefox-bridge/src/socks.js` | whole file | the SOCKS5 implementation; DNS and `localhost` resolve on the bridge's machine |
| `packages/firefox-bridge/src/cli.js` | whole file | flags `--idle-timeout` (default 30 min) and `--max-lifetime` (default 240 min); `0` disables |
| `packages/firefox-bridge/src/seed.js` | whole file | secret → key pair derivation |
| `src/bridge/client.ts` | whole file | the server end: a dumb byte pipe on `127.0.0.1` into the DHT stream. `hyperdht` is CommonJS with native deps, loaded via `createRequire` and marked external in `tsup.config.ts` |
| `src/tools/bridge.ts` | `handleConnectHostNetwork` ~83, `handleDisconnectHostNetwork` ~179 | pref flip, takeover, restore |
| `src/bridge/prefs.ts`, `src/firefox/pref-utils.ts` | — | reading and writing Firefox prefs through the privileged context |

The bridge package is plain ESM with no build step and is published separately, so it
stays a tiny `npx` install with no selenium.

## How identity works

Both ends derive the **same** key pair from the one shared secret
(`sha256('firefox-bridge/v1\n' + secret)` as the seed). The bridge's firewall admits only a
peer presenting that same public key. There is no key exchange beyond the secret.

HyperDHT's firewall callback returns **true to reject** and false to allow. The comment at
the callback in `server.js` records this; it reads backwards.

## Lifecycle

- **One bridge at a time**, because the proxy is a browser-wide pref. A second connect is a
  **takeover**: the new tunnel is probed first, the old one is closed only after Firefox has
  been repointed, and the original pref baseline is carried across. Prefs are never
  re-read mid-takeover, which would capture the bridge's own prefs as the person's baseline.
- **The bridge exits on its own** after 30 minutes with zero open streams, and after 4
  hours regardless of activity. Keep-alive streams defeat idle detection; the hard cap
  bounds bandwidth. Nobody behind an agent layer can be relied on to call disconnect.
- **Disconnect restores** the baseline prefs.

## Tests

`packages/firefox-bridge/test/smoke.mjs` runs an isolated DHT and checks a body round-trips.
`idle.mjs` and `lifetime.mjs` spawn the CLI with 3-second timers and assert a clean
unattended exit.

## The general rule

The bridge changes browser-wide state for everyone sharing the browser. Any change here
must leave the proxy prefs restorable from a state where the bridge has already died.
