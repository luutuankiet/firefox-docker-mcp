---
title: Tool call pipeline
covers: where a tool gets registered, where the tab for a call is decided, where refusals, the context bundle and screenshot downscaling happen
verified: 2026-10-03
---

# Tool call pipeline

Every tool call passes through one handler in `src/index.ts` (1,172 lines). Handlers in
`src/tools/` do the browser work; everything that applies to *all* tools — identity,
tab resolution, refusals, the state bundle, image size — is decided here, once, so a tool
added later inherits it without remembering to.

Line numbers below are a starting point, not an address. Jump roughly there and confirm by
what the code says; if a range is off by more than a screen, fix it here and re-date.

## Registering a tool

| file | lines | what lives there |
|---|---|---|
| `src/tools/<family>.ts` | — | the tool definition (`name`, `description`, `inputSchema`) and its `handle…` function |
| `src/tools/index.ts` | whole file | barrel re-export; a new tool file must be added here |
| `src/index.ts` | ~202–290 | `toolHandlers` map: name → handler |
| `src/index.ts` | ~329–410 | `baseTools` array: the definitions advertised to clients; gated tools are conditional spreads on CLI flags such as `enableScript` and `enablePrivilegedContext` |

A tool must appear in **both** `toolHandlers` and `baseTools`. One without the other is
either invisible or unanswerable.

`withTenancySchema` (~308) adds the shared `tab` / agent arguments to every definition, and
the context-bundle knobs from `src/context-bundle.ts` are added the same way. Handlers never
see those arguments: they are stripped before dispatch, so each handler keeps the argument
shape it was written with.

## One call, in order

The `CallToolRequestSchema` handler starts at ~557.

1. **Identity.** The caller's agent id is minted or looked up in `src/tenancy.ts`.
2. **Screenshot budget.** `resolveScreenshotEdge` (~584) picks the long-edge cap for this
   call: an explicitly requested picture and an auto-attached one have different budgets.
3. **Tab resolution** (~600–780). The target tab comes from, in order: a named `tab`
   argument, the agent's cursor, or the focused tab as a fallback. The source is recorded,
   because the refusal gate keys on it.
4. **The refusal gate.** A write (`MUTATION_TOOLS`, ~460) whose tab came from the
   **fallback** is refused (`targetIsFallback`, ~768), with a text digest of the tab and a
   screenshot attached. Naming an unowned tab on a write claims it.
5. **Background routing.** Tools in `BACKGROUND_CAPABLE_TOOLS` (~509) run against the
   target tab over BiDi without focusing it. Others fall back to the classic
   focus-the-tab path.
6. **The handler runs.**
7. **`finalize`** (~800–910) records a last-writer breadcrumb when
   `changesPageContent()` (~553) holds, repaints the VNC ownership marks, and writes the
   identity envelope.
8. **Context bundle** (~919). For context-capable tools that did not error,
   `collectContext()` adds screenshot / DOM digest / console / network, sliced to what this
   call caused.
9. **Downscale** (~952, ~960). `shrinkImageBlocks` runs on the final result, so screenshot
   tools, the bundle and the refusal picture all obey one rule.

`changesPageContent()` excludes `TAB_AGNOSTIC_TOOLS` (~532, e.g. `new_page`, whose
resolved tab is a bystander) and the ownership tools `claim_tab` / `release_tab`.
Without that exclusion the breadcrumb accuses agents of touching tabs they never changed,
usually the person's.

## Transports

`startTransports()` (~980) serves stdio, or streamable HTTP with one transport per MCP
session and a `/health` endpoint (~1060). Production uses HTTP on 8931 behind a bearer
token; the old stdio path still works for running the server on a host next to a
host-networked browser.

## The general rule

If a behaviour should hold for every tool, put it in this handler, not in the tools. Each
cross-cutting rule here (refusal, bundle, downscale) replaced a per-handler version that a
newer tool had forgotten.
