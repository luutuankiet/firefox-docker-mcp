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

## Index
| Version | Date | Theme |
|---|---|---|
| [v0.1.0](./v0.1.0.md) | 2026-04-16 | Initial release: shared browser with auto-screenshot |
