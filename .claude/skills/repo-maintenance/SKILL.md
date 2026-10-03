---
name: repo-maintenance
description: This repo keeps a catalogue of its own traps — failure modes that produce no error, so you find them by symptom, not by stack trace — plus its reference pages and its decision records. Use before debugging behaviour that is wrong but not crashing, before editing shared state, and whenever you finish debugging something that cost more than an hour.
---

# Traps in this repo

Most of what has cost time here fails **silently**. There is no stack trace to
search, so the catalogue below is keyed on **the symptom you would observe**, not
on the subsystem at fault.

**Before you debug anything that misbehaves without erroring, scan this table.**
Then open exactly one file. Each page is self-contained — you will not need to
open a second one.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Traps

Failure modes that produce no error message, indexed by the symptom you
would observe. Read before debugging behaviour that is wrong but not
crashing.

| symptom | page | area | verified |
|---|---|---|---|
| the prod image tag says the new version but the server still behaves like the old one | [DEPLOYED_SERVER_RUNS_AN_OLDER_VERSION](../../../docs/traps/DEPLOYED_SERVER_RUNS_AN_OLDER_VERSION.md) | docker stacks and releases | 2026-10-03 |
| every page fails to load with proxyConnectFailure / The proxy server is refusing connections | [EVERY_PAGE_FAILS_WITH_PROXYCONNECTFAILURE](../../../docs/traps/EVERY_PAGE_FAILS_WITH_PROXYCONNECTFAILURE.md) | host-network bridge | 2026-10-03 |
| the refusal or error reply has no screenshot in Claude Code even though the server attached one | [REFUSAL_SCREENSHOT_NEVER_ARRIVES](../../../docs/traps/REFUSAL_SCREENSHOT_NEVER_ARRIVES.md) | tool call pipeline | 2026-10-03 |

## Reference

Simply true, and expensive to re-derive.

| page | summary | verified |
|---|---|---|
| [Deploying a release to the production stack](../../../docs/reference/deploying-production.md) | the order of operations that upgrades the prod server without closing the person's tabs, and how to confirm what is running | 2026-10-03 |
| [Screenshot token budget](../../../docs/reference/screenshot-token-budget.md) | what a screenshot costs an agent in tokens, the measured legibility floor, and the detail levels and flags that control it | 2026-10-03 |

## Decisions

Why the repo is the way it is. A merged decision is immutable -- supersede
it with a new one rather than editing it.

- [The server joins the browser's network namespace](../../../docs/adr/0001-server-joins-the-browser-network-namespace.md)
- [Production runs a pinned published release](../../../docs/adr/0002-production-runs-a-pinned-published-release.md)
- [Soft tenancy, with writes to a guessed tab refused](../../../docs/adr/0003-soft-tenancy-with-refused-fallback-writes.md)
- [The host-network bridge is built directly on HyperDHT](../../../docs/adr/0004-host-network-bridge-on-hyperdht.md)
- [Viewport emulation is per tab and stops at layout](../../../docs/adr/0005-viewport-is-per-tab-and-stops-at-layout.md)
- [Project notes live in docs/, not in a private notes directory](../../../docs/adr/0006-project-notes-promoted-into-docs.md)

<!-- END GENERATED INDEX -->

The same tables, browsable, are [docs/README.md](../../../docs/README.md).

## Adding a trap

Write one when you have just spent real time on something that would have taken
minutes if someone had told you. Three tests, all must pass:

1. **It has a symptom.** If a fact is merely true, it is reference, not a trap.
   *If it has a symptom it is a trap; if it is just true it is reference.*
2. **Nothing cheaper catches it.** A doc is the *last* resort, because it only
   works if someone reads it. Stop at the first rung that holds:

   | rung | use when | this repo |
   |---|---|---|
   | make it a **type error** | the mistake is expressible in the type system | `npm run typecheck` |
   | make it a **test** | the mistake is an assertable behaviour | there is no test runner; tests are node scripts that exit non-zero: `node test-e2e.mjs`, `node test/list-tools.mjs`, `packages/firefox-bridge/test/*.mjs` |
   | **comment at the site** | there is exactly one line where someone could get it wrong | yes, the norm; e.g. the firewall polarity comment in `packages/firefox-bridge/src/server.js` |
   | **a doc** | the mistake can be made from any of several files, or from a file that does not exist yet | the catalogue above |

   Before adding one, say out loud which single line you would have commented
   instead — if you can name it, comment it and stop.
3. **It is not already in the table.** Extend the existing file. Two docs on one
   fact is how a catalogue rots.

Then:

- **Filename is the identifier.** `SCREAMING_SNAKE.md`, describing the symptom,
  not the fix. It is quoted in code comments and commit messages, so it never
  gets renamed — if the understanding changes, edit the body.
- **`symptom:` is the search key.** The string a frustrated person would paste
  into a search box, not a topic name. If the console prints something, put the
  console text verbatim.
- **Date it.** `verified:` is the day someone last confirmed it in the running
  code. An undated trap is a claim with no expiry.
- **Regenerate the index**: ``scripts/gen-docs-index.sh``. The block above is
  generated; hand edits to it are overwritten.

## Writing the body

The reader is a maintainer six months from now who opened this one file from a
search result and has **no other context loaded**. Not you, not this session.

- Resolve every reference inline. No "see the other doc", no ticket numbers, no
  "as discussed". If a line number matters, quote the code.
- Publishing tone. It is a page on the project's documentation site, not a note
  to self.
- Lead with the symptom, then the mechanism, then the fix, then how to verify.
  Someone in the middle of a bug reads the first two lines and stops.
- Include the **evidence** — measured numbers, observed values, verbatim code. A
  trap without evidence gets argued with.
- **Say what is deliberate.** Half of what looks like a bug in a mature codebase
  is a trade someone made on purpose. Write down which, and what the trade was.

## The other collections

`docs/` holds five kinds of page, all generated into the same index by the same
script, all governed by the rules above:

| directory | what belongs there | frontmatter |
|---|---|---|
| `docs/traps/` | it has a symptom | `symptom`, `area`, `verified` |
| `docs/architecture/` | where behaviour lives — one page per area | `title`, `covers`, `verified` |
| `docs/reference/` | simply true, no symptom, worth not re-deriving | `title`, `summary`, `verified` |
| `docs/adr/` | **why the repo is the way it is** — a decision record | none; the `# ` heading is the entry |
| `docs/*.md` | a long-form guide belonging to no single area | `title`, `summary`, `verified` |

The architecture pages are the `codebase-map` skill's index; read that skill
before adding one. The escalation ladder does **not** apply to them — a map is not
a warning. Everything else does: date it, resolve references inline, regenerate
the index.

### Decision records

`docs/adr/NNNN-kebab-slug.md`, sequential, created lazily. Offer one only when
**all three** hold:

1. **hard to reverse** — if it is easy to reverse, skip it; you will just reverse it
2. **surprising without context** — otherwise the code explains itself
3. **the result of a real trade-off** — if there was no genuine alternative, there
   is nothing to record beyond "we did the obvious thing"

One to three sentences is a complete record: the context, what was decided, why.

**A merged record is immutable.** Superseding means a *new* file that names what
it replaces; the old one stays readable, because the reason a decision was made is
not invalidated by the decision changing.

This is the one destination that is append-only and unrecoverable. A trap can be
rewritten later; a rationale never written is gone.

## Removing a trap

**Before trusting a page, check it is still true.** These describe code, and code
moves. If the underlying cause is fixed, **delete the file** and say so in the
commit message. Do not leave it with a "fixed in vX" note — a stale trap costs a
reader the same time as a real one, and costs the catalogue its credibility, which
is the only thing making anyone open the next page. If the fix came with a comment
at the site, that comment is now the record.
