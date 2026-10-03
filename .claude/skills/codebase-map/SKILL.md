---
name: codebase-map
description: Where behaviour lives in this repo — a per-area map of which files and line ranges own what, so you can open the right file instead of searching for it. Use before hunting for where something is implemented, before adding a feature that touches existing behaviour, and when a change seems to need edits in more places than expected.
---

# Where things live

This repo is large enough that finding the right file costs more than reading it.
The pages below are maps: for each area, which files own it and roughly where in
them.

**Pick the area, open that one page, then go straight to the file.** Do not read
every page — that defeats the point.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Where things live

One page per area of the system. Read before going looking for where
something is implemented.

| page | covers | verified |
|---|---|---|
| [Docker stacks, production and dev](../../../docs/architecture/docker-stacks.md) | how the browser and server containers are wired, which compose file is prod and which is dev, how the prod image gets its server version, how a person signs in to sites that block automation | 2026-10-03 |
| [Host-network bridge](../../../docs/architecture/host-network-bridge.md) | how the shared browser reaches localhost on a different machine, the firefox-bridge package, connect_host_network and disconnect_host_network, takeover, idle exit | 2026-10-03 |
| [Console and network logs, tab scoping, and the context bundle](../../../docs/architecture/logs-and-context-bundle.md) | where console and network events are captured, how an entry is attributed to a tab including its iframes and popups, and how a tool reply gets its screenshot, DOM, console and network sections | 2026-10-03 |
| [Tenancy, tab names and per-tab operations](../../../docs/architecture/tenancy-and-tabs.md) | how agents get ids, how tabs are claimed and named, how an agent acts on a tab without stealing focus, and where per-tab viewport lives | 2026-10-03 |
| [Tool call pipeline](../../../docs/architecture/tool-call-pipeline.md) | where a tool gets registered, where the tab for a call is decided, where refusals, the context bundle and screenshot downscaling happen | 2026-10-03 |

<!-- END GENERATED INDEX -->

The same table, browsable, is [docs/README.md](../../../docs/README.md).

## How to read a line range

Every entry is `file — lines — what lives there`. **The line numbers are a
starting point, not an address.** They drift with every commit that touches the
file above them, and nothing regenerates them.

So: jump to roughly that line, then confirm you are in the right place by what the
code says, not by the number. If a range is off by more than a screen or two, fix
it in the page and re-date it — that is a one-line edit and it is how the map
stays worth having.

Line ranges are given at all because the files that matter most here are big:
`src/index.ts`, 1,172 lines, where every tool call is registered, routed, refused or bundled; `src/firefox/index.ts` at 694 and `src/tenancy.ts` at 620 follow. "It's in `src/index.ts`" is not an
answer.

## What this map does not tell you

It tells you **where**, not **why it is dangerous**. Several of the areas below
have failure modes that produce no error message. Those are catalogued
separately, by symptom, in the `repo-maintenance` skill and in
[docs/README.md](../../../docs/README.md). If you are about to change shared state
or anything on the per-call pipeline in `src/index.ts` (tab resolution and the refusal gate) or anything that changes a browser-wide pref, look there first.

## Keeping it accurate

A map that lies is worse than none, because it sends people confidently to the
wrong file. Two habits keep it honest:

- **Re-date what you touch.** If you worked in an area and the page was right,
  bump `verified:`. If it was wrong, fix it and bump.
- **Add an area when you create one, not later.** A new subsystem with no page is
  invisible; the next person re-derives its shape from scratch.

To add a page, follow the same rules as any other doc — see the `repo-maintenance`
skill. Frontmatter for an area page is `title`, `covers` (what someone would be
looking for, phrased as they would phrase it), and `verified`. Then run
``scripts/gen-docs-index.sh``; the block above is generated and hand edits to it
are overwritten.
