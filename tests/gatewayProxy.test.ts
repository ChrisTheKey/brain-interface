import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHealth, readConfig, resolveWsRoute, startGateway } from '../server/gateway.mjs';

/**
 * End-to-end proxying, against real upstreams.
 *
 * This is the pair of tests the old gateway did not have, and their absence is
 * why nobody noticed that the browser was never routed through `/ws` at all:
 * everything else can pass while the one path that carries ZERO's events is
 * broken. Both upstreams here are genuine servers on ephemeral loopback ports —
 * no mocks, and no assumption about which port HWD-ZERO happens to use.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface Started {
  server: Server;
  port: number;
}

function listen(server: Server): Promise<Started> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

/** A minimal but genuine WebSocket upstream: real 101, then echoes bytes. */
function websocketUpstream(expectedPath: string): Server {
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end('upgrade required');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.url !== expectedPath) {
      socket.write(`HTTP/1.1 400 Bad Request\r\n\r\npath=${req.url}`);
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${accept}\r\n` +
        `x-zero-upstream-path: ${req.url}\r\n\r\n`,
    );
    // Echo whatever arrives, so the test can prove frames flow both ways.
    socket.on('data', (chunk) => socket.write(chunk));
  });
  return server;
}

/** Opens a raw upgrade against the gateway and returns the handshake + echo. */
function openUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ raw: string; echo: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = netConnect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `host: 127.0.0.1:${port}`,
        'upgrade: websocket',
        'connection: Upgrade',
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version: 13',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    let buffer = '';
    let sentPing = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no upgrade answer for ${path}: ${buffer}`));
    }, 4_000);

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!sentPing && buffer.includes('\r\n\r\n')) {
        if (!buffer.startsWith('HTTP/1.1 101')) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ raw: buffer, echo: '' });
          return;
        }
        sentPing = true;
        socket.write('zero-ping');
        return;
      }
      if (sentPing && buffer.includes('zero-ping')) {
        clearTimeout(timer);
        socket.destroy();
        const [raw, echo] = buffer.split('zero-ping');
        resolve({ raw: raw ?? '', echo: 'zero-ping' + (echo ?? '') });
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

let api: Started;
let runtime: Started;
let gateway: Server;
let gatewayPort: number;
let workDir: string;
let config: ReturnType<typeof readConfig>;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'zero-proxy-'));
  const distDir = join(workDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>brain</title>');

  // HWD-ZERO's HTTP API plus its operator event socket, on one port.
  const apiServer = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', safe_mode: false }));
      return;
    }
    if (req.url === '/api/agents') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.2.0', agents: [], projects: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  const eventUpstream = websocketUpstream('/ws/events');
  apiServer.on('upgrade', (req, socket, head) =>
    eventUpstream.emit('upgrade', req, socket, head),
  );
  api = await listen(apiServer);

  // ZERO's runtime app-server: a *different* port, listening at its own root.
  runtime = await listen(websocketUpstream('/'));

  config = readConfig({
    ZERO_UI_PORT: '0',
    ZERO_UI_DIST: distDir,
    ZERO_TOKEN_FILE: join(workDir, 'gateway-token'),
    ZERO_API_URL: `http://127.0.0.1:${api.port}`,
    ZERO_RUNTIME_WS_URL: `ws://127.0.0.1:${runtime.port}`,
    ZERO_DIAGNOSTICS: 'true',
  });
  gateway = startGateway(config);
  await new Promise<void>((resolve) => gateway.once('listening', () => resolve()));
  const address = gateway.address();
  gatewayPort = typeof address === 'object' && address ? address.port : 0;
});

afterAll(() => {
  gateway?.close();
  api?.server.close();
  runtime?.server.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('gateway HTTP proxy', () => {
  it('forwards /api/* to HWD-ZERO', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/agents`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: '0.2.0' });
  });

  it('reports a healthy chain with the three facts kept apart', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ gateway: 'healthy', zero: 'healthy', websocket: 'healthy' });
    // The browser is told the public paths, never the internal ones.
    expect(body.publicPaths).toEqual({
      api: '/api',
      ws: '/ws',
      events: '/ws/events',
      voice: '/ws/voice',
    });
  });

  it('serves the interface even while ZERO is down, and says so', async () => {
    const offline = { ...config, zeroApi: 'http://127.0.0.1:1', zeroRuntimeWs: 'ws://127.0.0.1:1' };
    const { status, body } = await collectHealth(offline);
    // Not 200: `curl` and the start scripts must be able to see this too.
    expect(status).toBe(503);
    expect(body).toMatchObject({ gateway: 'healthy', zero: 'offline', websocket: 'offline' });
  });
});

describe('gateway WebSocket proxy', () => {
  it('routes /ws to the runtime upstream with a real 101 upgrade', async () => {
    const { raw, echo } = await openUpgrade(gatewayPort, '/ws');
    expect(raw).toContain('HTTP/1.1 101');
    expect(raw.toLowerCase()).toContain('sec-websocket-accept:');
    // `/ws` is a gateway name; the runtime listens at its own root.
    expect(raw).toContain('x-zero-upstream-path: /');
    // Frames flow both ways — this is a socket, not a polling imitation.
    expect(echo).toContain('zero-ping');
  });

  it('routes /ws/events to HWD-ZERO, not to the runtime port', async () => {
    const { raw } = await openUpgrade(gatewayPort, '/ws/events');
    expect(raw).toContain('HTTP/1.1 101');
    expect(raw).toContain('x-zero-upstream-path: /ws/events');
  });

  it('refuses an unknown socket path instead of piping it somewhere', async () => {
    const { raw } = await openUpgrade(gatewayPort, '/ws/not-a-route');
    expect(raw).toContain('404');
  });

  it('answers with 502 rather than a silent close when ZERO is not listening', async () => {
    const dead = readConfig({
      ZERO_UI_PORT: '0',
      ZERO_UI_DIST: join(workDir, 'dist'),
      ZERO_TOKEN_FILE: join(workDir, 'gateway-token'),
      ZERO_RUNTIME_WS_URL: 'ws://127.0.0.1:1',
    });
    const server = startGateway(dead);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const { raw } = await openUpgrade(port, '/ws');
      expect(raw).toContain('502');
    } finally {
      server.close();
    }
  });
});

describe('WebSocket routing', () => {
  it('does not let /ws swallow /ws/events, which is a prefix of it', () => {
    const routes = readConfig({
      ZERO_API_URL: 'http://127.0.0.1:8000',
      ZERO_RUNTIME_WS_URL: 'ws://127.0.0.1:8787',
    });
    expect(resolveWsRoute('/ws', routes)).toMatchObject({
      upstream: 'zeroRuntimeWs',
      path: '/',
    });
    expect(resolveWsRoute('/ws/events', routes)).toMatchObject({
      upstream: 'zeroApi',
      path: '/ws/events',
    });
    // Voice is HWD-ZERO's too — it is the runtime, and voice is one of its
    // capabilities rather than a service beside it.
    expect(resolveWsRoute('/ws/voice', routes)).toMatchObject({
      upstream: 'zeroApi',
      path: '/ws/voice',
    });
    expect(resolveWsRoute('/websocket', routes)).toBeNull();
    expect(resolveWsRoute('/', routes)).toBeNull();
  });

  it('keeps the upstream path the runtime URL declares', () => {
    const routes = readConfig({ ZERO_RUNTIME_WS_URL: 'ws://127.0.0.1:8787/rpc' });
    expect(resolveWsRoute('/ws', routes)?.path).toBe('/rpc');
  });
});
