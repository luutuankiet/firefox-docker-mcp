#!/usr/bin/env node
import { startBridge } from './server.js';

function parseArgs(argv) {
  const args = { secret: process.env.FIREFOX_BRIDGE_SECRET || null, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--secret') args.secret = argv[++i];
    else if (a.startsWith('--secret=')) args.secret = a.slice('--secret='.length);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `firefox-bridge - expose this host's localhost to the firefox-docker-mcp browser (zero-ingress P2P)

Usage:
  npx @luutuankiet/firefox-bridge --secret <shared-secret>
  FIREFOX_BRIDGE_SECRET=<secret> npx @luutuankiet/firefox-bridge

Give the SAME secret to the firefox-mcp connect_host_network tool. Both ends
derive an identical identity from the secret; nothing else is exchanged. No
inbound ports are opened on this host - the connection is established outbound
only, so it works behind NAT and firewalls.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.secret) {
    console.error('error: --secret <shared-secret> is required (or set FIREFOX_BRIDGE_SECRET)');
    process.exit(1);
  }

  const log = args.quiet ? () => {} : (m) => console.error(`[firefox-bridge] ${m}`);
  const bridge = await startBridge({ secret: args.secret, log });

  console.log('');
  console.log('  firefox-bridge is live');
  console.log(`  name:   ${bridge.name}`);
  console.log('  status: waiting for the firefox-mcp side to connect with the same secret');
  console.log('  (Ctrl-C to stop - this host has NO open inbound ports)');
  console.log('');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log('shutting down');
    await bridge.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[firefox-bridge] fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
