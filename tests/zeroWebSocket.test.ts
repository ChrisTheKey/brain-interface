import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateToken,
  readConfig,
  startGateway,
  upstreamSearch,
  ZERO_WS_PATH,
} from '../server/gateway.mjs';
import {
  acceptKey,
  decodeFrames,
  encodeFrame,
  OPCODE,
  WebSocketClient,
} from '../server/lib/websocket.mjs';
import { resolveZeroWsUrl } from '../src/config';

describe('resolving the ZERO endpoint in the browser', () => {
  it('leaves an absolute endpoint alone', () => {
    const location = { protocol: 'http:', host: '192.168.1.20:3000' };
    expect(resolveZeroWsUrl('ws://127.0.0.1:8787', location)).toBe('ws://127.0.0.1:8787');
    expect(resolveZeroWsUrl('wss://zero.example:9000', location)).toBe('wss://zero.example:9000');
  });

  it('resolves a path against the origin that served the page', () => {
    // This is the whole point: on a phone, `ws://127.0.0.1:8787` means the
    // phone's own loopback. `/zero-ws` means the gateway it loaded from.
    expect(resolveZeroWsUrl('/zero-ws', { protocol: 'http:', host: '192.168.1.20:3000' })).toBe(
      'ws://192.168.1.20:3000/zero-ws',
    );
    expect(resolveZeroWsUrl('/zero-ws', { protocol: 'http:', host: '127.0.0.1:3000' })).toBe(
      'ws://127.0.0.1:3000/zero-ws',
    );
  });

  it('uses wss when the page itself is served over https', () => {
    expect(resolveZeroWsUrl('/zero-ws', { protocol: 'https:', host: 'zero.local' })).toBe(
      'wss://zero.local/zero-ws',
    );
  });

  it('keeps the configured path when there is no page to resolve against', () => {
    expect(resolveZeroWsUrl('/zero-ws')).toBe('/zero-ws');
    expect(resolveZeroWsUrl('/zero-ws', { protocol: 'http:', host: '' })).toBe('/zero-ws');
  });
});

/* -------------------------------------------------------------------------- */

let gateway: Server;
let appServer: Server;
let token: string;
let port: number;
let workDir: string;
/** What the app-server actually received, so the rewrite is verified. */
let seen: { host?: string; path?: string } = {};

/** Stands in for `codex app-server --listen ws://…`: answers `initialize`. */
function startFakeAppServer(): Server {
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    seen = { host: req.headers.host, path: req.url };
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`,
    );
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = Buffer.from(rest);
      for (const frame of frames) {
        if (frame.opcode !== OPCODE.text) continue;
        const message = JSON.parse(frame.payload.toString('utf8'));
        if (message.method !== 'initialize') continue;
        socket.write(
          encodeFrame(
            OPCODE.text,
            JSON.stringify({ id: message.id, result: { userAgent: 'ZERO/test' } }),
            Buffer.alloc(4),
          ),
        );
      }
    });
  });
  return server;
}

async function initialize(url: string, headers?: Record<string, string>): Promise<unknown> {
  const client = new WebSocketClient(url, headers ? { headers } : {});
  await client.connect();
  try {
    const answer = new Promise<string>((resolve) =>
      client.on('message', ({ data }: { data: string }) => resolve(data)),
    );
    client.send(JSON.stringify({ id: 1, method: 'initialize' }));
    const raw = await Promise.race([
      answer,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 5_000)),
    ]);
    return JSON.parse(raw);
  } finally {
    client.close();
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'zero-ws-'));
  mkdirSync(join(workDir, 'dist'), { recursive: true });
  writeFileSync(join(workDir, 'dist', 'index.html'), '<!doctype html><title>brain</title>');
  const tokenFile = join(workDir, 'token');
  token = loadOrCreateToken(tokenFile);

  appServer = startFakeAppServer();
  await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', () => resolve()));
  const appPort = (appServer.address() as { port: number }).port;

  // LAN mode is exactly the phone's situation: nothing is trusted by address.
  gateway = startGateway(
    readConfig({
      ZERO_LAN_MODE: 'true',
      ZERO_UI_PORT: '0',
      ZERO_UI_DIST: join(workDir, 'dist'),
      ZERO_TOKEN_FILE: tokenFile,
      ZERO_APP_SERVER_URL: `ws://127.0.0.1:${appPort}`,
    }),
  );
  await new Promise<void>((resolve) => gateway.once('listening', () => resolve()));
  port = (gateway.address() as { port: number }).port;
});

afterAll(() => {
  gateway?.close();
  appServer?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('the gateway carries the ZERO app-server', () => {
  it('refuses the upgrade without a token', async () => {
    // The app-server can start threads and run commands — the LAN never gets
    // to reach it just because it can reach the gateway.
    await expect(initialize(`ws://127.0.0.1:${port}${ZERO_WS_PATH}`)).rejects.toThrow(/401/);
  });

  it('carries a real JSON-RPC exchange when the pairing token is present', async () => {
    const response = await initialize(`ws://127.0.0.1:${port}${ZERO_WS_PATH}?token=${token}`);
    expect(response).toEqual({ id: 1, result: { userAgent: 'ZERO/test' } });
  });

  it('accepts the cookie the pairing link sets, which is how the phone runs', async () => {
    const response = await initialize(`ws://127.0.0.1:${port}${ZERO_WS_PATH}`, {
      Cookie: `zero_token=${token}`,
    });
    expect(response).toEqual({ id: 1, result: { userAgent: 'ZERO/test' } });
  });

  it('hands the app-server its own address and root path, not the phone-facing ones', async () => {
    await initialize(`ws://127.0.0.1:${port}${ZERO_WS_PATH}?token=${token}`);
    expect(seen.path).toBe('/');
    expect(seen.host).toMatch(/^127\.0\.0\.1:\d+$/);
    // Never the host the browser addressed the gateway with.
    expect(seen.host).not.toBe(`127.0.0.1:${port}`);
  });

  it('refuses an upgrade on a path that is neither route', async () => {
    await expect(
      initialize(`ws://127.0.0.1:${port}/elsewhere?token=${token}`),
    ).rejects.toThrow();
  });
});

describe('the pairing token stays with the gateway', () => {
  it('is stripped from the query before anything goes upstream', () => {
    // The token authenticates the device to the gateway. HWD-ZERO and the
    // app-server must never see it — same rule as the authorization header.
    expect(upstreamSearch('?token=secret')).toBe('');
    expect(upstreamSearch('?token=secret&cursor=42')).toBe('?cursor=42');
    expect(upstreamSearch('?cursor=42')).toBe('?cursor=42');
    expect(upstreamSearch('')).toBe('');
  });
});
