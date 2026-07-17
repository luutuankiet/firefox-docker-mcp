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
export async function startBridge({ secret, dht: injectedDht, log = () => {} }) {
  const keyPair = keyPairFromSecret(secret);
  const dht = injectedDht || new DHT();

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
      log('client connected');
      handleSocksConnection(stream, { log });
    }
  );

  await server.listen(keyPair);

  return {
    name: nameFromPublicKey(keyPair.publicKey),
    publicKey: keyPair.publicKey,
    async close() {
      try { await server.close(); } catch { /* ignore */ }
      if (!injectedDht) {
        try { await dht.destroy(); } catch { /* ignore */ }
      }
    }
  };
}
