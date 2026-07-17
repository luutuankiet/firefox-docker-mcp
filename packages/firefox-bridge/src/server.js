import DHT from 'hyperdht';
import { keyPairFromSecret } from './seed.js';
import { nameFromPublicKey } from './name.js';
import { handleSocksConnection } from './socks.js';

function keyEquals(a, b) {
  return Buffer.from(a).equals(Buffer.from(b));
}

/**
 * Start the bridge exit server on a remote dev host.
 *
 * Returns { name, publicKey, close }. The process must stay alive for the
 * server to keep announcing; the CLI wires SIGINT/SIGTERM to close().
 */
export async function startBridge({ secret, dht: injectedDht, log = () => {}, idleTimeoutMs = 0, onIdle = null, maxLifetimeMs = 0 }) {
  const keyPair = keyPairFromSecret(secret);
  const dht = injectedDht || new DHT();

  // Idle self-cleanup: track live noise streams; when the count stays at zero
  // for idleTimeoutMs, call onIdle (the CLI wires this to process shutdown).
  // Armed at listen time so a bridge nobody ever connects to also cleans up,
  // and re-armed each time the last stream closes.
  let activeStreams = 0;
  let idleTimer = null;
  let closed = false;
  const disarmIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const armIdle = () => {
    if (!idleTimeoutMs || typeof onIdle !== 'function' || closed) return;
    disarmIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (activeStreams === 0 && !closed) {
        log(`no live connections for ${idleTimeoutMs / 60000} min - idle self-cleanup`);
        onIdle();
      }
    }, idleTimeoutMs);
  };
  // Hard lifetime cap: exits regardless of activity. An idle-but-open
  // keep-alive stream defeats the idle timer forever; this bounds the
  // process's (and the DHT announce's) bandwidth footprint no matter what.
  let lifetimeTimer = null;
  const armLifetime = () => {
    if (!maxLifetimeMs || typeof onIdle !== 'function' || closed) return;
    lifetimeTimer = setTimeout(() => {
      lifetimeTimer = null;
      if (!closed) {
        log(`max lifetime of ${maxLifetimeMs / 60000} min reached - shutting down`);
        onIdle();
      }
    }, maxLifetimeMs);
  };

  const server = dht.createServer(
    {
      // hyperdht firewall contract (verified against lib/server.js): return TRUE
      // to REJECT, FALSE to allow. Admit ONLY a peer whose public key equals our
      // seed-derived key. The legitimate client derives the same keypair from the
      // shared secret and presents exactly this key; everyone else is dropped
      // before any bytes flow.
      firewall(remotePublicKey) {
        return !keyEquals(remotePublicKey, keyPair.publicKey);
      }
    },
    (stream) => {
      // Defense in depth: re-verify identity after the handshake completes.
      if (!keyEquals(stream.remotePublicKey, keyPair.publicKey)) {
        stream.destroy();
        return;
      }
      activeStreams++;
      disarmIdle();
      log('client connected');
      stream.on('close', () => {
        activeStreams--;
        if (activeStreams <= 0) {
          activeStreams = 0;
          armIdle();
        }
      });
      handleSocksConnection(stream, { log });
    }
  );

  await server.listen(keyPair);

  armIdle();
  armLifetime();

  return {
    name: nameFromPublicKey(keyPair.publicKey),
    publicKey: keyPair.publicKey,
    async close() {
      closed = true;
      disarmIdle();
      if (lifetimeTimer) { clearTimeout(lifetimeTimer); lifetimeTimer = null; }
      try { await server.close(); } catch { /* ignore */ }
      if (!injectedDht) {
        try { await dht.destroy(); } catch { /* ignore */ }
      }
    }
  };
}
