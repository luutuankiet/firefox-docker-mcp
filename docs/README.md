# Documentation

Every page here is written for a maintainer six months from now who opened
exactly this file from a search result and has nothing else loaded.

This index is generated. Run `scripts/gen-docs-index.sh` after adding or
renaming a page; `--check` fails if it is stale.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Where things live

One page per area of the system. Read before going looking for where
something is implemented.

| page | covers | verified |
|---|---|---|
| [Docker stacks, production and dev](architecture/docker-stacks.md) | how the browser and server containers are wired, which compose file is prod and which is dev, how the prod image gets its server version, how a person signs in to sites that block automation | 2026-10-03 |
| [Host-network bridge](architecture/host-network-bridge.md) | how the shared browser reaches localhost on a different machine, the firefox-bridge package, connect_host_network and disconnect_host_network, takeover, idle exit | 2026-10-03 |
| [Console and network logs, tab scoping, and the context bundle](architecture/logs-and-context-bundle.md) | where console and network events are captured, how an entry is attributed to a tab including its iframes and popups, and how a tool reply gets its screenshot, DOM, console and network sections | 2026-10-03 |
| [Tenancy, tab names and per-tab operations](architecture/tenancy-and-tabs.md) | how agents get ids, how tabs are claimed and named, how an agent acts on a tab without stealing focus, and where per-tab viewport lives | 2026-10-03 |
| [Tool call pipeline](architecture/tool-call-pipeline.md) | where a tool gets registered, where the tab for a call is decided, where refusals, the context bundle and screenshot downscaling happen | 2026-10-03 |

## Traps

Failure modes that produce no error message, indexed by the symptom you
would observe. Read before debugging behaviour that is wrong but not
crashing.

| symptom | page | area | verified |
|---|---|---|---|
| the prod image tag says the new version but the server still behaves like the old one | [DEPLOYED_SERVER_RUNS_AN_OLDER_VERSION](traps/DEPLOYED_SERVER_RUNS_AN_OLDER_VERSION.md) | docker stacks and releases | 2026-10-03 |
| every page fails to load with proxyConnectFailure / The proxy server is refusing connections | [EVERY_PAGE_FAILS_WITH_PROXYCONNECTFAILURE](traps/EVERY_PAGE_FAILS_WITH_PROXYCONNECTFAILURE.md) | host-network bridge | 2026-10-03 |
| the refusal or error reply has no screenshot in Claude Code even though the server attached one | [REFUSAL_SCREENSHOT_NEVER_ARRIVES](traps/REFUSAL_SCREENSHOT_NEVER_ARRIVES.md) | tool call pipeline | 2026-10-03 |

## Reference

Simply true, and expensive to re-derive.

| page | summary | verified |
|---|---|---|
| [Deploying a release to the production stack](reference/deploying-production.md) | the order of operations that upgrades the prod server without closing the person's tabs, and how to confirm what is running | 2026-10-03 |
| [Screenshot token budget](reference/screenshot-token-budget.md) | what a screenshot costs an agent in tokens, the measured legibility floor, and the detail levels and flags that control it | 2026-10-03 |

## Decisions

Why the repo is the way it is. A merged decision is immutable -- supersede
it with a new one rather than editing it.

- [The server joins the browser's network namespace](adr/0001-server-joins-the-browser-network-namespace.md)
- [Production runs a pinned published release](adr/0002-production-runs-a-pinned-published-release.md)
- [Soft tenancy, with writes to a guessed tab refused](adr/0003-soft-tenancy-with-refused-fallback-writes.md)
- [The host-network bridge is built directly on HyperDHT](adr/0004-host-network-bridge-on-hyperdht.md)
- [Viewport emulation is per tab and stops at layout](adr/0005-viewport-is-per-tab-and-stops-at-layout.md)
- [Project notes live in docs/, not in a private notes directory](adr/0006-project-notes-promoted-into-docs.md)

<!-- END GENERATED INDEX -->
