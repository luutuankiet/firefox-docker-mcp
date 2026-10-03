# The host-network bridge is built directly on HyperDHT

Reaching `localhost` on another machine uses about 200 lines of glue on `hyperdht` (MIT): a
peer-to-peer connection with hole punching, a public DHT used only for introduction and
never in the data path, and no infrastructure we run. Both ends derive one key pair from a
shared secret, so there is no key exchange beyond that secret. The bridge ships as a
separate package so it installs on arbitrary hosts with `npx` and without selenium.

## Considered options

SSH tunnels and relay-class tools (frp-like servers, hosted tunnel services) need either an
open inbound port or infrastructure someone has to run. A mesh VPN needs the VPN on every
host. A browser proxy add-on adds a moving part inside the shared profile. `holesail` has the
right shape but is AGPL-3.0, so it was used as a design reference only.

## Consequences

One bridge at a time, because the proxy is a browser-wide pref; a second connect takes over.
The bridge exits by itself on idle and after a hard lifetime cap, because nobody behind an
agent layer can be relied on to disconnect.
