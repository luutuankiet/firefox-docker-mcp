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
