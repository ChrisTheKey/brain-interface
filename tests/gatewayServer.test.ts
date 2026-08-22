import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { loadOrCreateToken, readConfig, startGateway } from '../server/gateway.mjs';

let server: Server;
let base: string;
let token: string;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'zero-gw-server-'));
  const distDir = join(workDir, 'dist');
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>brain</title>');
  writeFileSync(join(distDir, 'assets', 'app.js'), 'export const ok = true;');

  const tokenFile = join(workDir, 'gateway-token');
  token = loadOrCreateToken(tokenFile);

  const config = readConfig({
    ZERO_LAN_MODE: 'true',
    ZERO_UI_PORT: '0',
    ZERO_UI_DIST: distDir,
    ZERO_TOKEN_FILE: tokenFile,
    ZERO_API_URL: 'http://127.0.0.1:59999',
  });
  server = startGateway(config);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  rmSync(workDir, { recursive: true, force: true });
});

/** Performs a raw WebSocket handshake and returns the status line. */
function upgrade(path: string, cookie: string): Promise<string> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `host: 127.0.0.1:${port}\r\n` +
          'upgrade: websocket\r\n' +
          'connection: Upgrade\r\n' +
          'sec-websocket-version: 13\r\n' +
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          `cookie: ${cookie}\r\n\r\n`,
      );
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes('\r\n')) {
        socket.destroy();
        resolve(received.split('\r\n')[0] ?? '');
      }
    });
    socket.on('close', () => resolve(received.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(received.split('\r\n')[0] ?? '');
    }, 3_000);
  });
}

describe('gateway server (LAN mode)', () => {
  it('refuses unauthenticated access', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('unauthorized');
  });

  it('serves the health probe without a token', async () => {
    const response = await fetch(`${base}/api/gateway/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ gateway: 'ok', lanMode: true });
  });

  it('pairs the device on the first authenticated load', async () => {
    const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
    expect(response.status).toBe(200);
    // Without this cookie the phone would fail to load the bundle.
    expect(response.headers.get('set-cookie')).toContain('zero_token=');
    expect(await response.text()).toContain('brain');
  });

  it('accepts the cookie for follow-up asset requests', async () => {
    const response = await fetch(`${base}/assets/app.js`, {
      headers: { cookie: `zero_token=${encodeURIComponent(token)}` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('export const ok');
  });

  it('rejects a wrong token', async () => {
    const response = await fetch(`${base}/?token=not-the-token`);
    expect(response.status).toBe(401);
  });

  it('reports an unreachable HWD-ZERO instead of pretending', async () => {
    const response = await fetch(`${base}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('zero_api_unreachable');
  });

  it('stays up and keeps serving the interface while HWD-ZERO is down', async () => {
    // The upstream in this suite is a port nothing listens on. The gateway is
    // the last thing that may fail with it: the operator being offline must be
    // something the interface can render, not a blank screen.
    const health = await fetch(`${base}/api/gateway/health`);
    expect(health.status).toBe(200);
    const payload = await health.json();
    expect(payload.upstream.reachable).toBe(false);
    expect(payload.websocketPaths).toEqual(['/ws/events', '/ws/voice']);

    const page = await fetch(`${base}/?token=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('brain');
  });

  it('answers a websocket upgrade with 502 when the operator is unreachable', async () => {
    const status = await upgrade('/ws/voice', `zero_token=${encodeURIComponent(token)}`);
    // A silent socket destroy looks like a network glitch and makes the client
    // reconnect hot; 502 tells it to back off.
    expect(status).toContain('502');
  });

  it('refuses an unauthenticated upgrade before it reaches HWD-ZERO', async () => {
    expect(await upgrade('/ws/events', 'zero_token=wrong')).toContain('401');
  });

  it('refuses an upgrade on any path other than the two it serves', async () => {
    const status = await upgrade('/ws/admin', `zero_token=${encodeURIComponent(token)}`);
    expect(status).toContain('404');
  });

  it('tells a client that forgot to upgrade to upgrade', async () => {
    const response = await fetch(`${base}/ws/events`, {
      headers: { cookie: `zero_token=${encodeURIComponent(token)}` },
    });
    expect(response.status).toBe(426);
    expect((await response.json()).error).toBe('upgrade_required');
  });

  it('never serves files outside the build directory', async () => {
    const response = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd?token=${token}`);
    const body = await response.text();
    expect(body).not.toContain('root:');
    expect(body).toContain('brain');
  });
});
