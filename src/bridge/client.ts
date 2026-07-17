/**
 * firefox-mcp side of the host-network bridge.
 *
 * Runs a DHT client plus a local TCP listener that is a DUMB byte pipe. Firefox
 * is pointed at this listener via SOCKS proxy prefs; each browser connection
 * opens one Noise stream to the remote firefox-bridge, which runs the actual
 * SOCKS5 exit. So DNS and localhost resolve on the REMOTE host - that is what
 * makes the browser's localhost become the remote host's localhost.
 *
 * hyperdht is CJS with native deps (sodium) - loaded via createRequire and kept
 * external in tsup, the same pattern as gifenc/pngjs in tools/recording.ts.
 */
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DHT = nodeRequire('hyperdht') as any;

function keyPairFromSecret(secret: string) {
  // Must match packages/firefox-bridge/src/seed.js exactly so both ends derive
  // the identical keypair from the shared secret.
  const seed = createHash('sha256').update('firefox-bridge/v1\n' + secret).digest();
  return DHT.keyPair(seed);
}

export interface BridgeClient {
  socksHost: string;
  socksPort: number;
  close(): Promise<void>;
}

const PROBE_TIMEOUT_MS = 12000;

export async function startBridgeClient(opts: {
  secret: string;
  log?: (m: string) => void;
}): Promise<BridgeClient> {
  const log = opts.log || (() => {});
  const keyPair = keyPairFromSecret(opts.secret);
  const dht = new DHT();

  const teardown = async () => {
    try {
      await dht.destroy();
    } catch {
      // ignore
    }
  };

  // Probe first: verify the remote bridge is reachable with this secret BEFORE
  // we bind a listener or flip any browser prefs. A wrong secret derives a
  // different key with no server announced, so the probe never opens. Fully
  // destroy the probe on success (not a half-close) so no zombie stream lingers.
  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe: any = dht.connect(keyPair.publicKey, { keyPair });
    const timer = setTimeout(() => {
      probe.destroy();
      reject(
        new Error(
          'Could not reach the remote bridge within 12s. Is `npx @luutuankiet/firefox-bridge --secret ...` running on the remote host with the SAME secret?'
        )
      );
    }, PROBE_TIMEOUT_MS);
    probe.on('open', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve();
    });
    probe.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  }).catch(async (err) => {
    await teardown();
    throw err;
  });

  // Live sockets, tracked so close() can force-destroy them (net.Server.close()
  // only stops accepting; it waits for existing connections otherwise).
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: any = dht.connect(keyPair.publicKey, { keyPair });

    // Duplex pipe both ways. pipe() propagates end() gracefully (it does NOT
    // destroy the destination), so a large response tail is flushed rather than
    // truncated under backpressure - which the manual destroy-on-close wiring
    // got wrong.
    socket.pipe(stream);
    stream.pipe(socket);

    const onErr = () => {
      socket.destroy();
      stream.destroy();
    };
    socket.on('error', onErr);
    stream.on('error', onErr);
    // When the browser side fully closes, tear down its stream. We do NOT
    // destroy the socket on stream 'close' - that would race the flush above.
    socket.on('close', () => {
      sockets.delete(socket);
      stream.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  }).catch(async (err) => {
    await teardown();
    throw err;
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardown();
    throw new Error('failed to bind local SOCKS listener');
  }
  const socksPort = addr.port;
  log(`local SOCKS listener on 127.0.0.1:${socksPort}`);

  return {
    socksHost: '127.0.0.1',
    socksPort,
    async close() {
      // Stop accepting, force-destroy live sockets so server.close() can settle
      // promptly (Firefox keep-alive would otherwise hold it open), then tear
      // down the DHT which kills all noise streams.
      server.close();
      for (const s of sockets) s.destroy();
      sockets.clear();
      await teardown();
    },
  };
}
