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
git push && git push --tags
```

## Index
| Version | Date | Theme |
|---|---|---|
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
