# Release Notes Index

Append-only narrative release notes for `firefox-docker-mcp`.

## Authoring
- **One file per release.** Name: `vX.Y.Z.md`. No overwrites.
- **Audience:** human first, then agents picking up context six months later.
- **Structure:** TL;DR, Why, Highlights table, How it works, Config, Files changed.
- **Voice:** pitch, not changelog. If a line could be a commit subject, cut it.

## Publishing
The `publish.yml` workflow reads `releases/${{ github.ref_name }}.md` via
`gh release create --notes-file` when a tag is pushed. Missing file = workflow fails loudly.

**Cut a release with `npm version patch|minor|major` — never bump by hand.** The `version`
lifecycle hook runs `scripts/sync-release-version.mjs`, which syncs
`packages/firefox-bridge/package.json` to the same version and aborts if this directory has
no `vX.Y.Z.md` for it. Both are hard requirements of `publish.yml`: the build job asserts the
tag matches **both** package.json files, and the release job needs the notes file. The hook
runs before npm commits or tags, so a failure leaves nothing to clean up.

```
# write releases/vX.Y.Z.md + add the index row FIRST, then:
npm version patch
git push origin main
git push origin vX.Y.Z   # never --tags: this clone carries upstream-fork tags
```

**Never `git push --tags` from this repo.** The clone still holds the tag history of the
project this was forked from, including versions numbered above our own release line.
Pushing them all sends tags that `publish.yml` would try to publish as this package.
GitHub refuses to create workflow runs for a push of more than three tags, which is the
only reason that has never actually happened — and that same rule silently suppresses the
real release's workflow too. Push one tag, by name.

## Index
| Version | Date | Theme |
|---|---|---|
| [v0.10.1](./v0.10.1.md) | 2026-08-14 | A release that says which release it is: version string and both prod compose defaults now written by the release script |
| [v0.10.0](./v0.10.0.md) | 2026-08-14 | Your tab's logs, and only your tab's: per-tab console and network scoping, iframes and popups included |
| [v0.9.0](./v0.9.0.md) | 2026-08-08 | Tabs you can say out loud, sized the way you asked: word names as selectors, per-tab viewports with presets |
| [v0.8.0](./v0.8.0.md) | 2026-08-08 | Screenshots at the size an agent actually reads: measured legibility floor, ~4x fewer image tokens |
| [v0.7.1](./v0.7.1.md) | 2026-08-08 | A borrowed tab is now a refusal, not a warning: fallback writes blocked, ownership visible in VNC |
| [v0.7.0](./v0.7.0.md) | 2026-08-06 | One browser, many agents: tab tenancy, background tab operations, bulk context in every reply |
| [v0.6.1](./v0.6.1.md) | 2026-07-30 | A "Leave page?" prompt can no longer wedge the server: pref suppression + navigation watchdog |
| [v0.6.0](./v0.6.0.md) | 2026-07-18 | Native JSON: structuredContent across every data tool, escape noise gone |
| [v0.5.0](./v0.5.0.md) | 2026-07-18 | Readiness-gated screenshots, app-shell scrolling, compact responses, page_info |
| [v0.4.0](./v0.4.0.md) | 2026-07-18 | Self-managing connections: takeover on connect + idle auto-exit on the bridge |
| [v0.3.0](./v0.3.0.md) | 2026-07-17 | Host-network bridge: browse any remote host's localhost (P2P, zero-ingress) |
| [v0.2.0](./v0.2.0.md) | 2026-07-17 | Max access: query_dom, scroll_page, evaluate_script, screen recording |
| [v0.1.2](./v0.1.2.md) | 2026-04-16 | Fix OIDC provenance publish |
| [v0.1.1](./v0.1.1.md) | 2026-04-16 | CI pipeline test + infra polish |
| [v0.1.0](./v0.1.0.md) | 2026-04-16 | Initial release: shared browser with auto-screenshot |
