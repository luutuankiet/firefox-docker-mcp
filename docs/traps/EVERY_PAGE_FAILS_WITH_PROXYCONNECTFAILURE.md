---
symptom: "every page fails to load with proxyConnectFailure / The proxy server is refusing connections"
area: host-network bridge
verified: 2026-10-03
---

# Every page fails with proxyConnectFailure

**Symptom.** Every navigation, in every tab, ends on Firefox's "The proxy server is refusing
connections" page (`proxyConnectFailure`). Nothing in the server logs an error. It affects
the person at the VNC screen as much as the agents.

**Mechanism.** `connect_host_network` points Firefox's browser-wide SOCKS proxy at a local
pipe into a bridge running on another machine. It sets `network.proxy.type`,
`network.proxy.socks`, `network.proxy.socks_port`, `network.proxy.socks_remote_dns` and
`network.proxy.allow_hijacking_localhost` (`src/tools/bridge.ts`, `PROXY_PREFS`). If the
bridge goes away without `disconnect_host_network` being called (it exits by itself after
30 idle minutes or 4 hours, or its machine reboots), or the server restarts and loses the
pipe, those prefs stay set and point at a dead port.

This is deliberate up to a point: no startup self-heal ships, because guessing what the
person's proxy settings "should" be on boot is worse than a visible failure. Recovery is
manual and cheap.

**Fix**, any one of:

1. Agent side, with the privileged context enabled — reset the prefs:

   ```js
   set_firefox_prefs({ prefs: {
     "network.proxy.type": 5,
     "network.proxy.socks": "",
     "network.proxy.socks_port": 0,
     "network.proxy.allow_hijacking_localhost": false
   }})
   ```

   `5` is "use system proxy settings", the Firefox default.
2. Connect a new bridge. `connect_host_network` takes over from any previous bridge and
   repoints the prefs.
3. Person at the VNC screen — `about:preferences` → Network Settings → "Use system proxy
   settings". Browser chrome pages are never proxied, so this works in any wedged state.

**Verify.** `get_firefox_prefs({ names: ["network.proxy.type"] })` returns `5` and a
navigation to any public site loads.

**The general rule.** Anything that changes a browser-wide pref leaves it set when its owner
dies. When the whole browser misbehaves and nothing errors, read the prefs before restarting
anything — restarting Firefox costs the person their tabs and does not reset prefs.
