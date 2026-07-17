#!/usr/bin/env node
import { startBridge } from './server.js';

function parseArgs(argv) {
  const args = {
    secret: process.env.FIREFOX_BRIDGE_SECRET || null,
    idleTimeout: process.env.FIREFOX_BRIDGE_IDLE_TIMEOUT ?? '30',
    maxLifetime: process.env.FIREFOX_BRIDGE_MAX_LIFETIME ?? '240',
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--secret') args.secret = argv[++i];
    else if (a.startsWith('--secret=')) args.secret = a.slice('--secret='.length);
    else if (a === '--idle-timeout') args.idleTimeout = argv[++i];
    else if (a.startsWith('--idle-timeout=')) args.idleTimeout = a.slice('--idle-timeout='.length);
    else if (a === '--max-lifetime') args.maxLifetime = argv[++i];
    else if (a.startsWith('--max-lifetime=')) args.maxLifetime = a.slice('--max-lifetime='.length);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `firefox-bridge - expose this host's localhost to the firefox-docker-mcp browser (zero-ingress P2P)

Usage:
  npx @luutuankiet/firefox-bridge --secret <shared-secret>
  FIREFOX_BRIDGE_SECRET=<secret> npx @luutuankiet/firefox-bridge

Options:
  --secret <s>          shared secret (required; or FIREFOX_BRIDGE_SECRET)
  --idle-timeout <min>  auto-exit after this many minutes with no live
                        connections (default 30; 0 disables; or
                        FIREFOX_BRIDGE_IDLE_TIMEOUT)
  --max-lifetime <min>  hard cap: always exit after this many minutes, active
                        or not - bounds bandwidth usage (default 240 = 4h;
                        0 disables; or FIREFOX_BRIDGE_MAX_LIFETIME)
  --quiet               suppress log lines

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

  // Empty string (e.g. FIREFOX_BRIDGE_IDLE_TIMEOUT set but blank) would parse
  // as 0 and silently disable the timer - fall back to defaults instead.
  if (args.idleTimeout === '') args.idleTimeout = '30';
  if (args.maxLifetime === '') args.maxLifetime = '240';
  const idleMinutes = Number(args.idleTimeout);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 0) {
    console.error('error: --idle-timeout must be a number of minutes >= 0 (0 disables)');
    process.exit(1);
  }
  const lifetimeMinutes = Number(args.maxLifetime);
  if (!Number.isFinite(lifetimeMinutes) || lifetimeMinutes < 0) {
    console.error('error: --max-lifetime must be a number of minutes >= 0 (0 disables)');
    process.exit(1);
  }

  const log = args.quiet ? () => {} : (m) => console.error(`[firefox-bridge] ${m}`);

  let bridge = null;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log('shutting down');
    if (bridge) await bridge.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  bridge = await startBridge({
    secret: args.secret,
    log,
    idleTimeoutMs: idleMinutes > 0 ? idleMinutes * 60_000 : 0,
    maxLifetimeMs: lifetimeMinutes > 0 ? lifetimeMinutes * 60_000 : 0,
    onIdle: shutdown,
  });

  console.log('');
  console.log('  firefox-bridge is live');
  console.log(`  name:   ${bridge.name}`);
  console.log('  status: waiting for the firefox-mcp side to connect with the same secret');
  console.log(
    `  idle:   ${idleMinutes > 0 ? `auto-exit after ${idleMinutes} min with no live connections` : 'auto-exit disabled (--idle-timeout 0)'}`
  );
  console.log(
    `  cap:    ${lifetimeMinutes > 0 ? `hard lifetime cap ${lifetimeMinutes} min, active or not (bandwidth guard)` : 'no lifetime cap (--max-lifetime 0)'}`
  );
  console.log('  (Ctrl-C to stop - this host has NO open inbound ports)');
  console.log('');
}

main().catch((err) => {
  console.error('[firefox-bridge] fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
