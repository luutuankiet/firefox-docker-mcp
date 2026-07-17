# @luutuankiet/firefox-bridge

Zero-ingress P2P bridge that makes a remote dev host's `localhost` reachable from
the [firefox-docker-mcp](https://github.com/luutuankiet/firefox-docker-mcp)
browser, no matter what network either side sits on.

## Why

The shared Firefox container can only see its own host's network. When you run a
dev app on some other host's `localhost:3000` (your laptop, a DinD container, a
client VM), the browser can't reach it. This bridge fixes that at the browser
level: the browser's `localhost` becomes the remote host's `localhost`.

## How it works

- Both ends derive an identical ed25519 keypair from one shared secret
  (`sha256("firefox-bridge/v1\n" + secret)` -> `HyperDHT.keyPair(seed)`).
- This host announces a HyperDHT server under that key and firewalls it to admit
  only a peer presenting the same key. The public DHT does introduction and NAT
  holepunching only; the data path is a direct, Noise-encrypted P2P stream
  (with a decentralized blind-relay fallback when both ends are symmetric-NAT).
- Incoming streams are handed to an in-process SOCKS5 exit that dials the
  requested target on THIS host. The firefox-mcp side runs the SOCKS client and
  flips the browser's proxy prefs to point at it.

No inbound ports are opened on either end. Identity is symmetric: knowing the
secret is necessary and sufficient. Nothing is exchanged beyond that one secret.

## Usage

```sh
npx @luutuankiet/firefox-bridge --secret my-long-shared-secret
# or
FIREFOX_BRIDGE_SECRET=my-long-shared-secret npx @luutuankiet/firefox-bridge
```

Then, on the firefox-mcp side, call the `connect_host_network` tool with the
same secret. One bridge at a time.

## License

MIT
