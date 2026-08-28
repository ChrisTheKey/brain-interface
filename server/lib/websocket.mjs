/**
 * Minimal RFC 6455 WebSocket client.
 *
 * The browser bridge speaks two protocols that are only available over a
 * WebSocket — the Chrome DevTools Protocol (Chrome, Brave, Edge) and
 * WebDriver BiDi (Firefox). Node's global `WebSocket` only became available
 * without a flag in Node 22.4, and this repository ships no runtime
 * dependencies, so the client is implemented here on top of `node:net` —
 * the same layer the gateway already uses for its upgrade proxy.
 *
 * Scope is deliberately the client half of the protocol and nothing more:
 * text and binary frames, fragmentation, ping/pong, close. No extensions, no
 * compression, no server role.
 */
import { connect as netConnect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

/** `Sec-WebSocket-Accept` for a client key, per RFC 6455 §4.1. */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/**
 * Encodes one client frame. Client frames are always masked — a server must
 * close the connection on an unmasked client frame, so this is not optional.
 */
export function encodeFrame(opcode, payload, mask = randomBytes(4)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = body.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode

  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = body[i] ^ mask[i % 4];

  return Buffer.concat([header, mask, masked]);
}

/**
 * Pulls whole frames out of a buffer. Returns the frames it could decode and
 * the bytes that belong to a frame that has not fully arrived yet.
 */
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('websocket frame exceeds the addressable payload size');
      }
      length = Number(big);
      cursor += 8;
    }

    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }

    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/**
 * A connected client. Emits `open`, `message` ({ data, binary }), `close`
 * ({ code, reason }) and `error`.
 */
export class WebSocketClient extends EventEmitter {
  #socket = null;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = null;
  #open = false;
  #closed = false;

  constructor(url, options = {}) {
    super();
    this.url = new URL(url);
    this.headers = options.headers ?? {};
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    /** Guard against a runaway page dumping gigabytes into a single message. */
    this.maxMessageBytes = options.maxMessageBytes ?? 32 * 1024 * 1024;
  }

  get isOpen() {
    return this.#open;
  }

  /** Resolves once the server has accepted the upgrade. */
  connect() {
    if (this.url.protocol !== 'ws:' && this.url.protocol !== 'wss:') {
      return Promise.reject(new Error(`unsupported websocket scheme: ${this.url.protocol}`));
    }
    if (this.url.protocol === 'wss:') {
      // The bridge only ever talks to a browser on loopback; TLS would mean
      // pulling in node:tls for a case that cannot occur here.
      return Promise.reject(new Error('wss:// is not supported by the browser bridge'));
    }

    const key = randomBytes(16).toString('base64');
    const port = Number(this.url.port || 80);
    const path = `${this.url.pathname}${this.url.search}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`websocket handshake timed out after ${this.handshakeTimeoutMs}ms`));
      }, this.handshakeTimeoutMs);

      const settle = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(this);
      };

      const socket = netConnect(port, this.url.hostname, () => {
        const lines = [
          `GET ${path} HTTP/1.1`,
          `Host: ${this.url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(this.headers).map(([name, value]) => `${name}: ${value}`),
        ];
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });

      this.#socket = socket;
      socket.setNoDelay(true);

      let handshake = Buffer.alloc(0);
      const onHandshakeData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end === -1) {
          if (handshake.length > 64 * 1024) {
            socket.destroy();
            settle(new Error('websocket handshake response header is too large'));
          }
          return;
        }

        const head = handshake.subarray(0, end).toString('latin1');
        const [statusLine, ...headerLines] = head.split('\r\n');
        if (!/^HTTP\/1\.1 101/.test(statusLine)) {
          socket.destroy();
          settle(new Error(`websocket upgrade refused: ${statusLine}`));
          return;
        }
        const accept = headerLines
          .find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'))
          ?.split(':')[1]
          ?.trim();
        if (accept !== acceptKey(key)) {
          socket.destroy();
          settle(new Error('websocket upgrade returned an invalid Sec-WebSocket-Accept'));
          return;
        }

        socket.off('data', onHandshakeData);
        socket.on('data', (next) => this.#ingest(next));
        this.#open = true;
        this.emit('open');
        settle(null);
        // Bytes that arrived in the same TCP segment as the handshake.
        const rest = handshake.subarray(end + 4);
        if (rest.length > 0) this.#ingest(rest);
      };

      socket.on('data', onHandshakeData);
      socket.on('error', (error) => {
        if (!this.#open) settle(error);
        else this.emit('error', error);
      });
      socket.on('close', () => {
        this.#open = false;
        if (!this.#closed) {
          this.#closed = true;
          this.emit('close', { code: 1006, reason: 'connection closed' });
        }
      });
    });
  }

  send(data) {
    if (!this.#socket || !this.#open) throw new Error('websocket is not open');
    const binary = Buffer.isBuffer(data);
    this.#socket.write(encodeFrame(binary ? OPCODE.binary : OPCODE.text, data));
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return;
    this.#closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      if (this.#open) this.#socket?.write(encodeFrame(OPCODE.close, payload));
    } catch {
      /* the socket is already gone */
    }
    this.#open = false;
    this.#socket?.end();
    this.emit('close', { code, reason });
  }

  destroy() {
    this.#closed = true;
    this.#open = false;
    this.#socket?.destroy();
  }

  #ingest(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(this.#buffer);
    } catch (error) {
      this.emit('error', error);
      this.destroy();
      return;
    }
    this.#buffer = decoded.rest;
    for (const frame of decoded.frames) this.#handleFrame(frame);
  }

  #handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.ping:
        if (this.#open) this.#socket?.write(encodeFrame(OPCODE.pong, frame.payload));
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        if (!this.#closed) {
          this.#closed = true;
          this.#open = false;
          this.#socket?.end();
          this.emit('close', { code, reason });
        }
        return;
      }
      case OPCODE.continuation:
      case OPCODE.text:
      case OPCODE.binary:
        break;
      default:
        this.emit('error', new Error(`unsupported websocket opcode 0x${frame.opcode.toString(16)}`));
        this.destroy();
        return;
    }

    if (frame.opcode !== OPCODE.continuation) this.#fragmentOpcode = frame.opcode;
    this.#fragments.push(frame.payload);

    const total = this.#fragments.reduce((sum, part) => sum + part.length, 0);
    if (total > this.maxMessageBytes) {
      this.#fragments = [];
      this.#fragmentOpcode = null;
      this.emit('error', new Error('websocket message exceeded the configured size limit'));
      this.destroy();
      return;
    }

    if (!frame.fin) return;

    const payload = Buffer.concat(this.#fragments);
    const binary = this.#fragmentOpcode === OPCODE.binary;
    this.#fragments = [];
    this.#fragmentOpcode = null;
    this.emit('message', { data: binary ? payload : payload.toString('utf8'), binary });
  }
}
