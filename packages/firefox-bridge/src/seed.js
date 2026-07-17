import { createHash } from 'node:crypto';
import DHT from 'hyperdht';

/**
 * Derive a deterministic ed25519 keypair from a shared secret.
 *
 * BOTH ends of the bridge run this with the SAME secret, so both derive the
 * IDENTICAL keypair. That is the entire identity model: the server announces
 * under this keypair's public key and firewalls to it; the client connects to
 * that same public key while presenting the same key. Anyone who does not know
 * the secret cannot derive the key, cannot find the announced server, and
 * cannot pass the firewall. No key exchange happens beyond the one secret.
 *
 * The namespace prefix domain-separates this seed from any other use of the
 * same secret string elsewhere.
 */
export function keyPairFromSecret(secret) {
  if (!secret || typeof secret !== 'string' || secret.length < 8) {
    throw new Error('secret must be a string of at least 8 characters');
  }
  const seed = createHash('sha256').update('firefox-bridge/v1\n' + secret).digest();
  return DHT.keyPair(seed);
}
