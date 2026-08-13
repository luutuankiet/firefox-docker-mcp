/**
 * Keeps the workspace packages on one version and refuses to tag a release
 * that has no notes.
 *
 * Wired to npm's `version` lifecycle hook, so it runs after package.json has
 * been bumped but BEFORE npm creates the commit and tag. Exiting non-zero here
 * aborts the whole `npm version` run, which means a mistake never reaches
 * origin and there is no stray tag to clean up.
 *
 * Both checks mirror what publish.yml already enforces, just seven minutes
 * earlier:
 *   - the build job asserts the tag matches BOTH package.json files, and
 *     skips release + publish when it does not;
 *   - the release job feeds releases/v<version>.md to
 *     `gh release create --notes-file`, which fails loudly if absent.
 *
 * Usage: npm version patch   (or minor / major)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BRIDGE = 'packages/firefox-bridge/package.json';
const CONSTANTS = 'src/config/constants.ts';
const COMPOSE = 'docker/docker-compose.yaml';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

// 1. Check notes BEFORE touching anything, so an abort leaves no dirty file.
const notes = `releases/v${version}.md`;
if (!existsSync(notes)) {
  console.error(
    `\n✗ Missing ${notes}\n\n` +
      '  publish.yml feeds that file to `gh release create --notes-file`, so the\n' +
      '  release job fails without it. Write the notes and add a row to\n' +
      '  releases/README.md, then re-run this command.\n\n' +
      '  Nothing was written, committed or tagged.\n'
  );
  process.exit(1);
}
console.log(`✓ ${notes} present`);

// 2. Workspace packages move in lockstep.
const bridgeRaw = readFileSync(BRIDGE, 'utf8');
const bridge = JSON.parse(bridgeRaw);
if (bridge.version === version) {
  console.log(`✓ ${BRIDGE} already at ${version}`);
} else {
  const previous = bridge.version;
  bridge.version = version;
  // Match the file's own indentation so the diff stays to a single line.
  const indent = (/^(\s+)/.exec(bridgeRaw.split('\n')[1] ?? '') ?? [, '  '])[1];
  writeFileSync(BRIDGE, JSON.stringify(bridge, null, indent.length) + '\n');
  console.log(`✓ ${BRIDGE} ${previous} → ${version}`);
}

// 3. The version the server reports about itself.
//
// This drifted silently from 0.7.0 through three releases, because nothing read
// it back: the startup banner, the health endpoint and the MCP handshake all
// showed a version the code had not been for weeks. A wrong version string is
// worse than none - it is the first thing anyone checks when a deploy looks
// stale, and it sent one investigation down the wrong path entirely.
const constantsRaw = readFileSync(CONSTANTS, 'utf8');
const versionLine = /(export const SERVER_VERSION = ')([^']+)(';)/;
const constantsMatch = versionLine.exec(constantsRaw);
if (!constantsMatch) {
  console.error(`\n✗ Could not find SERVER_VERSION in ${CONSTANTS}\n`);
  process.exit(1);
}
if (constantsMatch[2] === version) {
  console.log(`✓ ${CONSTANTS} already at ${version}`);
} else {
  writeFileSync(CONSTANTS, constantsRaw.replace(versionLine, `$1${version}$3`));
  console.log(`✓ ${CONSTANTS} ${constantsMatch[2]} → ${version}`);
}

// 4. The production image tag AND the version baked into it.
//
// Those are two separate `${MCP_VERSION:-...}` defaults in one file: one names
// the image, the other is the build argument Dockerfile.prod hands to
// `npm install -g`. Bumping only the first produces an image LABELLED with the
// new version that contains the old release - a deploy that reports success,
// passes a smoke test, and ships nothing. Both are rewritten here so they
// cannot disagree.
const composeRaw = readFileSync(COMPOSE, 'utf8');
const defaults = /\$\{MCP_VERSION:-([^}]+)\}/g;
const found = [...composeRaw.matchAll(defaults)].map((m) => m[1]);
if (found.length === 0) {
  console.error(`\n✗ Could not find any \${MCP_VERSION:-...} default in ${COMPOSE}\n`);
  process.exit(1);
}
if (found.every((v) => v === version)) {
  console.log(`✓ ${COMPOSE} already at ${version} (${found.length} defaults)`);
} else {
  writeFileSync(COMPOSE, composeRaw.replace(defaults, `\${MCP_VERSION:-${version}}`));
  console.log(`✓ ${COMPOSE} ${[...new Set(found)].join(', ')} → ${version} (${found.length} defaults)`);
}
