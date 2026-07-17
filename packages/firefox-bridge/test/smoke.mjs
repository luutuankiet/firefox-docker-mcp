// Self-contained end-to-end smoke test for the bridge transport.
//
// Uses an ISOLATED local DHT (own bootstrap node) so it needs no internet and
// is deterministic. Proves the full chain: DHT introduction -> firewall admits
// the same-secret peer -> SOCKS5 exit dials a local origin -> bytes pipe back.
//
// Run: node test/smoke.mjs   (from packages/firefox-bridge, after npm install)

import DHT from 'hyperdht';
import http from 'node:http';
import { startBridge } from '../src/server.js';
import { keyPairFromSecret } from '../src/seed.js';

const SECRET = 'smoke-test-shared-secret-123';
const BODY = 'hello-bridge-42';

function fail(msg) {
  console.error('SMOKE FAIL: ' + msg);
  process.exit(1);
}

// Minimal awaitable reader over a duplex stream.
function makeReader(stream) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  function drain() {
    while (waiters.length && buf.length >= waiters[0].n) {
      const w = waiters.shift();
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  }
  stream.on('data', (d) => { buf = Buffer.concat([buf, d]); drain(); });
  return (n) => new Promise((resolve) => { waiters.push({ n, resolve }); drain(); });
}

async function main() {
  const bootstrap = DHT.bootstrapper(49737, '127.0.0.1');
  await bootstrap.ready();
  const boot = [{ host: '127.0.0.1', port: 49737 }];

  const origin = http.createServer((req, res) => res.end(BODY));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const oport = origin.address().port;

  const serverDht = new DHT({ bootstrap: boot });
  const bridge = await startBridge({ secret: SECRET, dht: serverDht, log: (m) => console.error('  [bridge] ' + m) });
  console.error('bridge name: ' + bridge.name);

  const clientDht = new DHT({ bootstrap: boot });
  const keyPair = keyPairFromSecret(SECRET);
  const stream = clientDht.connect(keyPair.publicKey, { keyPair });

  const timer = setTimeout(() => fail('timeout after 20s'), 20000);

  await new Promise((resolve, reject) => {
    stream.on('open', resolve);
    stream.on('error', reject);
  });

  const read = makeReader(stream);

  // SOCKS5 greeting -> expect no-auth.
  stream.write(Buffer.from([0x05, 0x01, 0x00]));
  const g = await read(2);
  if (g[0] !== 0x05 || g[1] !== 0x00) fail('bad greeting reply ' + g.toString('hex'));

  // CONNECT 127.0.0.1:oport (IPv4).
  const req = Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, (oport >> 8) & 0xff, oport & 0xff]);
  stream.write(req);
  const rep = await read(10);
  if (rep[0] !== 0x05 || rep[1] !== 0x00) fail('CONNECT refused, reply ' + rep.toString('hex'));

  // Speak HTTP through the tunnel.
  stream.write(Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));

  let acc = Buffer.alloc(0);
  await new Promise((resolve) => {
    stream.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      if (acc.toString().includes(BODY)) resolve();
    });
    stream.on('end', resolve);
    stream.on('close', resolve);
  });

  clearTimeout(timer);
  if (!acc.toString().includes(BODY)) fail('response missing body. got:\n' + acc.toString().slice(0, 400));

  console.error('SMOKE PASS: fetched "' + BODY + '" through the bridge');

  await bridge.close();
  await clientDht.destroy();
  await serverDht.destroy();
  origin.close();
  await bootstrap.destroy();
  process.exit(0);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
