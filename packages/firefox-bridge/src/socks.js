import net from 'node:net';

const VER = 0x05;
const NOAUTH = 0x00;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

/**
 * Terminate a SOCKS5 CONNECT handshake arriving over `stream` (a duplex, i.e. a
 * HyperDHT NoiseSecretStream), then dial the requested target on THIS host and
 * pipe bytes both ways.
 *
 * Because this runs on the remote dev host, "localhost" and every DNS name in a
 * CONNECT request resolve inside the remote host's network. Combined with the
 * browser sending names (socks_remote_dns=true), that is what makes the
 * browser's localhost:3000 become the remote host's localhost:3000.
 */
export function handleSocksConnection(stream, { log = () => {} } = {}) {
  let phase = 'greeting';
  let buf = Buffer.alloc(0);

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      pump();
    } catch (err) {
      log('socks parse error: ' + err.message);
      stream.destroy();
    }
  };

  function reply(code) {
    // BND.ADDR/PORT are ignored by clients for a CONNECT reply; zeros are fine.
    stream.write(Buffer.from([VER, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
  }

  function pump() {
    if (phase === 'greeting') {
      if (buf.length < 2) return;
      if (buf[0] !== VER) throw new Error('not a SOCKS5 greeting');
      const n = buf[1];
      if (buf.length < 2 + n) return;
      buf = buf.subarray(2 + n);
      stream.write(Buffer.from([VER, NOAUTH]));
      phase = 'request';
    }

    if (phase === 'request') {
      if (buf.length < 4) return;
      if (buf[0] !== VER) throw new Error('bad SOCKS5 request version');
      const cmd = buf[1];
      const atyp = buf[3];
      let host;
      let offset;

      if (atyp === ATYP_IPV4) {
        if (buf.length < 10) return;
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        offset = 8;
      } else if (atyp === ATYP_DOMAIN) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('utf8');
        offset = 5 + len;
      } else if (atyp === ATYP_IPV6) {
        if (buf.length < 22) return;
        const parts = [];
        for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
        host = parts.join(':');
        offset = 20;
      } else {
        throw new Error('unsupported address type ' + atyp);
      }

      const port = buf.readUInt16BE(offset);
      const leftover = buf.subarray(offset + 2);
      buf = Buffer.alloc(0);
      phase = 'connecting';

      if (cmd !== CMD_CONNECT) {
        reply(0x07); // command not supported
        stream.destroy();
        return;
      }

      log(`connect ${host}:${port}`);
      const tcp = net.connect(port, host);

      tcp.on('connect', () => {
        reply(0x00); // succeeded
        phase = 'piping';
        stream.removeListener('data', onData);
        if (leftover.length) tcp.write(leftover);

        // pipe() both ways: it propagates end() gracefully (does NOT destroy the
        // destination), so a large response tail is flushed rather than truncated
        // under backpressure. The existing tcp 'error' handler destroys the
        // stream; mirror it so a stream error tears down the tcp side too.
        stream.pipe(tcp);
        tcp.pipe(stream);
        stream.on('error', () => tcp.destroy());
      });

      tcp.on('error', (err) => {
        log(`target error ${host}:${port}: ${err.message}`);
        if (phase !== 'piping') reply(0x05); // connection refused
        stream.destroy();
      });
    }
  }

  stream.on('data', onData);
  stream.on('error', (err) => log('stream error: ' + (err && err.message ? err.message : err)));
}
