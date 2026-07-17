---
name: connect-through-firefox-bridge
description: Use when you need the shared Firefox (firefox-docker-mcp) MCP browser to load a web app running on YOUR OWN host's localhost - a dev server, a preview build, an app in your container/VM - that the browser cannot otherwise reach because it lives on a different network. Bridges your localhost into the browser over a secure P2P tunnel so you can navigate/screenshot/verify your frontend.
---

# Connect through the Firefox bridge

The firefox-docker-mcp browser runs on its own host and can only see its own
network. Your dev app on `localhost:3000` (your laptop, a container, a VM) is
invisible to it. This skill makes the browser's `localhost` become **your**
host's `localhost`, so you can drive your own frontend through the shared
browser.

## When to use
- "Open my local app in the browser" / "screenshot my dev server" and the
  firefox-mcp browser can't reach your `localhost`.
- You get connection failures navigating to `http://localhost:<port>` through
  firefox-mcp even though your app is up on your machine.

## Prerequisites
- The firefox-mcp server is running with `--enable-bridge` **and**
  `--enable-privileged-context` (ask the operator if `connect_host_network`
  isn't in the tool list).
- Node >= 20 on the host where your dev app runs (to run the bridge).
- A shared secret string you and the browser operator agree on (>= 8 chars).
  Anyone with the secret can reach whatever the bridge exits to, so treat it
  like a password and use a fresh one per session.

## Steps

### 1. Start the bridge on YOUR host (where the dev app runs)
Run this on the same host/network as your `localhost` app - NOT on the browser's
host:
```sh
npx @luutuankiet/firefox-bridge --secret <your-shared-secret>
# or: FIREFOX_BRIDGE_SECRET=<secret> npx @luutuankiet/firefox-bridge
```
It prints a cosmetic name (e.g. `silent-sable-kestrel`) and waits. No inbound
ports are opened - it connects outbound only, so it works behind NAT/firewalls.
Leave it running for the whole session.

### 2. Connect the browser via the MCP tool
Call the `connect_host_network` tool on firefox-mcp with the SAME secret:
```json
{ "secret": "<your-shared-secret>" }
```
It probes reachability first - if the secret is wrong or the bridge isn't
running, it fails fast (~12s) without touching the browser. On success the
browser's SOCKS proxy is pointed at the tunnel.

### 3. Navigate to your localhost
Use `navigate_page` (or any browser tool) with your app's URL as if you were on
your own machine:
```json
{ "url": "http://localhost:3000/" }
```
DNS and `localhost` resolve on YOUR host, so `http://localhost:3000`,
`http://127.0.0.1:8080`, internal hostnames, etc. all work. Screenshot / snapshot
/ click as normal.

### 4. Disconnect when done
```
disconnect_host_network   (no arguments)
```
This restores the browser's original proxy settings and tears the tunnel down.
Then stop the `npx @luutuankiet/firefox-bridge` process on your host (Ctrl-C) -
or just walk away: since v0.4.0 it auto-exits after 30 minutes with no live
connections (`--idle-timeout <min>`, `0` disables).

## Rules & gotchas
- **Reconnect = takeover (v0.4.0+).** If a bridge is already active,
  `connect_host_network` establishes and verifies the NEW tunnel first, then
  closes the old one automatically - no `disconnect_host_network` needed in
  between. If the new connect fails, the old bridge stays intact.
- **Same secret both ends.** Identity is derived entirely from the secret; a
  mismatch simply won't connect (no partial/insecure state).
- **Always disconnect.** While connected, the browser routes localhost traffic
  through the tunnel. If you forget and the bridge dies, the browser can't reach
  localhost until someone disconnects or resets its proxy prefs.
- **Cache can mislead.** After disconnect, re-navigating the exact same URL may
  serve from cache. Add a cache-busting query (`?t=123`) to force a real request
  when verifying the tunnel is down.
- **The bridge process must stay up** for the duration - it's the exit point on
  your host. It self-terminates after 30 idle minutes and hard-caps at 4 hours
  total by default (bandwidth guard); pass `--idle-timeout 0` /
  `--max-lifetime 0` for marathon sessions.

## Mental model
```
[ your dev app ]        [ firefox-mcp browser ]
 localhost:3000              (its own host)
      ^                            |
      |  SOCKS5 exit               | SOCKS proxy pref
 [ firefox-bridge ] <--- P2P Noise stream (HyperDHT) ---> [ local pipe ]
  (your host)          introduction+holepunch via public DHT   (browser host)
```
The public DHT only does introduction + NAT holepunching; your data flows over a
direct, end-to-end-encrypted P2P stream (with a decentralized relay fallback).
No third-party server sees your traffic; neither side opens an inbound port.
