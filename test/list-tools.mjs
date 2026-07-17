// Verify the built server registers the bridge tools and loads hyperdht at
// startup (bridge/client.js requires hyperdht at module top-level, so a clean
// start proves the createRequire path resolves).
//
// Run: node test/list-tools.mjs

import { spawn } from 'node:child_process';

const child = spawn('node', ['dist/index.js', '--enable-bridge', '--enable-privileged-context'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, NODE_ENV: 'production' },
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
function rpc(id, method, params) {
  return new Promise((resolve) => { pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
}

const fail = (m) => { console.error('LIST FAIL: ' + m); child.kill(); process.exit(1); };
setTimeout(() => fail('timeout after 15s (server may have crashed loading hyperdht)'), 15000);

await rpc(1, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'list-tools-test', version: '0.0.0' },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const res = await rpc(2, 'tools/list', {});
const names = (res.result?.tools ?? []).map((t) => t.name);

const need = ['connect_host_network', 'disconnect_host_network'];
const missing = need.filter((n) => !names.includes(n));
if (missing.length) fail('missing tools: ' + missing.join(', ') + ' | got ' + names.length + ' tools');

console.error('LIST PASS: ' + names.length + ' tools incl. ' + need.join(', '));
child.kill();
process.exit(0);
