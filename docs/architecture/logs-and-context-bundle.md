---
title: Console and network logs, tab scoping, and the context bundle
covers: where console and network events are captured, how an entry is attributed to a tab including its iframes and popups, and how a tool reply gets its screenshot, DOM, console and network sections
verified: 2026-10-03
---

# Console and network logs, tab scoping, and the context bundle

The browser emits console and network events for every tab into shared buffers. Two
consumers read them: the list tools (`list_console_messages`, `list_network_requests`,
`clear_console_messages`) and the context bundle attached to tool replies. Both scope
entries to the calling tab by default.

Line numbers are a starting point, not an address.

## Where it lives

| file | lines | what lives there |
|---|---|---|
| `src/firefox/events/console.ts` | whole file | console buffer, 5-minute TTL; captures `entry.source.context`; `clearMessages(predicate?)` |
| `src/firefox/events/network.ts` | whole file | request buffer, 5-minute TTL; captures `req.context` |
| `src/firefox/context-tree.ts` | `ContextTree` (~47) | parent, `originalOpener` and `clientWindow` per browsing context; fed by `browsingContext.contextCreated`, backfilled once from `getTree` at connect; node TTL 5 minutes (~21) |
| `src/tab-scope.ts` | whole file | the admission rule (`scopeEntries` ~50), the shared `scope` schema fragment (`SCOPE_SCHEMA_PROPERTY` ~22), the withheld-count trailer (`hiddenNote` ~96) |
| `src/tools/network.ts`, `src/tools/console.ts` | the handler destructures | apply scope first, then the other filters |
| `src/context-bundle.ts` | ~27–120 | levels `off`/`counts`/`inline`/`full` with per-level caps, per-tool channel defaults |
| `src/context-bundle.ts` | `openContextWindow` ~171, `collectContext` ~235 | the watermark taken at tool start, and the collector |

## Attribution

An entry belongs to a tab if its context's root **is** the tab, or if following opener
links from that root reaches the tab. Frames are reached by the parent walk. **Popups are
siblings, not children**: a window opened by a page has no parent, only an opener, so the
parent walk alone never finds them. An unknown context is treated as its own root, which
degrades to plain id equality instead of hiding everything. Entries that cannot be
attributed are withheld and counted, never silently shown or silently dropped.

The node TTL matches the buffer TTL so that any live entry still has a node to walk from.

Change the rule in `src/tab-scope.ts`, not in the callers.

## Scope before everything else

Scope is applied before `limit` and the other filters. Otherwise a `limit` spends its
budget on other tabs' rows and returns fewer of yours. `scope: "all"` is the opt-out, and
labels each row with its owning tab's name.

`clear_console_messages` refuses to wipe everything when no tab resolved: a caller that
named nothing must not be able to destroy every other agent's evidence by omission.

## The bundle

Every context-capable tool can return the state it caused. Console and network are sliced
by the watermark, so a bundle reports only what *that* call produced, on *that* tab. Each
channel is best-effort: a channel failure never fails the tool. The DOM digest prefers
interactive elements and falls back to the head of the tree. Tools that already return a DOM
or a screenshot (`take_snapshot`, `query_dom`, `screenshot_page`, `screenshot_by_uid`) do
not duplicate it. The bundle is written into both `content` text and
`structuredContent.context`, because some clients render only one of them.

## The general rule

Any new reader of a shared buffer spreads `SCOPE_SCHEMA_PROPERTY` into its schema and runs
`scopeEntries` before any other filter. Comparing an entry's context to the tab id directly
is the bug this design replaced: it is right for the top-level document and wrong for every
frame and popup.
