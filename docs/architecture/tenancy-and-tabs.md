---
title: Tenancy, tab names and per-tab operations
covers: how agents get ids, how tabs are claimed and named, how an agent acts on a tab without stealing focus, and where per-tab viewport lives
verified: 2026-10-03
---

# Tenancy, tab names and per-tab operations

Several agents and one person share one browser. The model is `ps aux` on a shared box:
everyone can see everything, ownership is recorded and shown, and the only hard
enforcement is the refusal of writes to a tab nobody named (see the tool call pipeline
page).

Line numbers are a starting point, not an address.

## Where it lives

| file | lines | what lives there |
|---|---|---|
| `src/tenancy.ts` | ~185–534 | `TenancyRegistry`: agent ids, claims, cursors, last-writer actions, viewports. One module singleton, `tenancy` (~534) |
| `src/tenancy.ts` | ~136–185 | `TAB_WORDS` (208 nouns), `tabIdPrefix`, `tabName` |
| `src/tenancy.ts` | ~92–125 | `UNOWNED_COLOR` (`#9e9e9e`), agent colour palette, `mintAgentId` |
| `src/tenancy.ts` | ~554–620 | `formatEnvelope`: the identity line on every reply, including tab geometry |
| `src/tools/tenancy-tools.ts` | whole file | `claim_tab`, `release_tab`, `list_agents` |
| `src/firefox/tab-marker.ts` | whole file | the badge (`__ff_mcp_tab_badge__`) and favicon drawn into each tab so ownership is visible over VNC |
| `src/firefox/tab-digest.ts` | whole file | the 600-character text summary attached to refusals |
| `src/firefox/bidi-ops.ts` | whole file | per-tab navigate, script call, screenshot, viewport (`setViewportInContext` ~195), readiness wait; `isBiDiUnavailable` (~24) classifies when to fall back |
| `src/firefox/bidi-input.ts` | whole file | click / fill / drag / upload against a tab without focusing it |
| `src/firefox/pages.ts` | whole file | background open and close of tabs, with classic fallbacks |
| `src/utils/tab-routing.ts` | `onTabOrFocused` | the shared "background first, classic if BiDi is unavailable" router |

## Tab names are selectors

Each tab answers to one word (`copper`, `maple`). The word starts from a hash of the window
handle, so a tab keeps its name across a server restart, and the registry walks forward
through the vocabulary on collision, so two live tabs never share one. A word is released
when its tab closes. Names resolve case-insensitively as `tab:` selectors; old hex
prefixes still resolve through `tabIdPrefix`.

Agent ids are still hex (`agt_…`).

## What is in memory only

The registry is not persisted. A server restart re-mints every agent id and drops every
claim; tab *names* survive only because they are re-derived from the handle.

## Viewport is per tab

`set_viewport_size` uses `browsingContext.setViewport`, which names one tab.
`scope: "window"` opts into the old selenium window resize, which reshapes every tab and the
person's VNC view. A viewport override outlives `release_tab`, and the envelope reports
geometry on every reply so the next holder is told. Emulation stops at layout; see the
decision record on per-tab viewport.

When setting the viewport, `devicePixelRatio` is always sent, as an explicit `null` on reset.
The browser reads an omitted ratio as "keep the last one", so leaving it out makes `reset`
fail to reset.

## The general rule

Anything that acts on a tab goes through the BiDi per-tab path first, and falls back to the
focus-moving path only when `isBiDiUnavailable` says so. A new tool that calls the classic
path directly will drag the person off the page they are reading.
