# Production runs a pinned published release

The production server image installs `@luutuankiet/firefox-docker-mcp@<version>` from npm at
build time (`docker/Dockerfile.prod`, no default version); only the dev stack bind-mounts
the working tree. Bind-mounting in production was rejected because rebuilding on the host
would silently change a running production server to whatever the checkout held, and
`npx @latest` was rejected because it upgrades production whenever anyone publishes.

## Consequences

The version is written in two defaults in `docker/docker-compose.yaml` (image tag and build
argument), and both must move together. `scripts/sync-release-version.mjs` does that on
`npm version`.
