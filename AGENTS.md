# firefox-docker-mcp

One Firefox, shared by a person and several AI agents at once. The browser runs in
Docker with a VNC web UI for the person; this MCP server drives the same browser over
WebDriver BiDi for the agents. One tool call performs one browser action and returns the
state it caused — screenshot, DOM digest, console and network — so an agent can verify a
frontend change without a human. Forked from Mozilla's `firefox-devtools-mcp` and published
as `@luutuankiet/firefox-docker-mcp`, plus a companion `@luutuankiet/firefox-bridge`.

## Hard constraints

- **The browser is shared and the person comes first.** Tenancy is soft: agents get an
  identity and claim tabs, but can see every tab. A write whose tab was only guessed from
  focus is refused, never warned. Nothing an agent does may steal focus from, close, or
  restart the person's tab; `restart_firefox` is never a first resort.
- **Marionette and BiDi bind to loopback inside Firefox's network namespace.** No pref
  rebinds them. The server reaches them by joining that namespace (`network_mode:
  "service:firefox"`), not over a network.
- **Production runs a published npm release, never the working tree.** Dev bind-mounts
  the source; prod bakes a pinned version into its image.
- **Every image an agent receives is paid for in context.** Screenshots are downscaled
  at the dispatcher's response boundary; anything that must survive an error goes in text.

## Layout

```
src/index.ts              tool registry, per-call pipeline, stdio + HTTP transports
src/tools/                one file per tool family; schemas + handlers
src/firefox/              BiDi/Marionette driver, per-tab ops, snapshot engine, log buffers
src/tenancy.ts            agent ids, tab claims, word tab names, viewports
src/context-bundle.ts     the state bundle attached to tool replies
src/tab-scope.ts          which log entries belong to which tab
src/bridge/               client side of the host-network bridge
packages/firefox-bridge/  the bridge CLI published separately (plain ESM, no build)
docker/                   prod + dev compose stacks, prod Dockerfile, helper scripts
releases/                 one narrative notes file per version; publish reads it
scripts/                  release-version sync, docs index generator
test/, test-e2e.mjs       standalone node scripts against a built server
```

## Commands

```
npm run build          # tsup -> dist/
npm run typecheck      # tsc --noEmit
node test-e2e.mjs      # needs a running browser with Marionette on 2828
node test/list-tools.mjs
cd packages/firefox-bridge && node test/smoke.mjs   # also idle.mjs, lifetime.mjs
./docker/dev-reload.sh # rebuild + swap the dev server, browser keeps running
```

There is no test runner and no `npm test`; the tests are scripts that exit non-zero on
failure. Cut a release with `npm version`, never by hand — see `releases/README.md`.

<!-- The appendable seam. Everything ABOVE this comment belongs to the project and
     is never touched on a re-run; everything below is the standard block. Append
     it to whatever AGENTS.md already says. Never replace. The literal string
     "Standard block." on the first line is what check 2 of audit.sh looks for. -->

<!-- Standard block. Everything above belongs to this project; everything below is
     the pointer every repo laid out this way carries. -->

## Documentation

Indexed in [docs/README.md](docs/README.md). Every page is self-contained — it
assumes you opened that one file and have nothing else loaded.

| where | what | read it |
|---|---|---|
| [architecture/](docs/architecture/) | where behaviour lives, one page per area | before going looking for something |
| [traps/](docs/traps/) | failure modes with no error message, indexed by symptom | before debugging something wrong but not crashing |
| [reference/](docs/reference/) | simply true, expensive to re-derive | when you need the detail |
| [adr/](docs/adr/) | why the repo is the way it is | before changing something that looks odd |

## Before you wrap up

Leave the repo holding what this session cost you to find out. Four rules.

1. **Sort it, and expect most of it to go nowhere.** A next action is an issue. A
   durable, expensive-to-re-derive fact is a page. A choice that was hard to
   reverse, surprising without context and a real trade-off is a decision record
   under `docs/adr/`. Status, dates, version pins and plans are none of those —
   delete them.
2. **A doc is the last resort.** Type error → test → comment at the site → doc.
   Name the single line you would have commented instead; if you can name it,
   comment it and stop.
3. **Verify against running code before writing, and date the page `verified:`.**
   Anything remembered from earlier in the session is stale until re-read. Deleting
   a draft because the problem is already fixed is a success.
4. **Append, never rewrite.** Supersede a merged decision record with a new one
   naming what it replaces. A trap filename is an identifier quoted elsewhere:
   edit the body, never the name.

Then run `scripts/gen-docs-index.sh`. Never hand-maintain an index.
