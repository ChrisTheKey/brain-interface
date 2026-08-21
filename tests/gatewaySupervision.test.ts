import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindAddresses, collectHealth, readConfig, startGateway } from '../server/gateway.mjs';

/**
 * The gateway's independence from the backend.
 *
 * This is the regression suite for the bug that made `localhost:3000` vanish
 * on the phone. Two faults, both proven here:
 *
 *   1. the start script treated HWD-ZERO as a precondition for the gateway, so
 *      a backend that was not running meant no web server at all;
 *   2. `/api/health` answers 503 when the gateway is healthy and HWD-ZERO is
 *      not — and the readiness probe read 503 as "the gateway is dead" and
 *      killed it.
 *
 * A backend that is not running is a state to display. It is never a reason
 * for the interface to disappear.
 */

const started: { server: Server; dir: string }[] = [];

afterEach(() => {
  for (const { server, dir } of started.splice(0)) {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function gatewayWith(env: Record<string, string> = {}): Promise<{
  base: string;
  server: Server;
  config: ReturnType<typeof readConfig>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'zero-supervision-'));
  const distDir = join(dir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>brain</title>');

  const config = readConfig({
    ZERO_UI_PORT: '0',
    ZERO_UI_DIST: distDir,
    ZERO_TOKEN_FILE: join(dir, 'gateway-token'),
    ZERO_QUIET: 'true',
    // Nothing is listening on either upstream unless a test starts one.
    ZERO_API_URL: 'http://127.0.0.1:1',
    ZERO_RUNTIME_WS_URL: 'ws://127.0.0.1:1',
    ...env,
  });
  const server = startGateway(config);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  started.push({ server, dir });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, server, config };
}

describe('the gateway serves without a backend', () => {
  it('answers GET / with the interface while HWD-ZERO is down', async () => {
    const { base } = await gatewayWith();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('brain');
  });

  it('answers /api/health, and says which half is broken', async () => {
    const { base } = await gatewayWith();
    const response = await fetch(`${base}/api/health`);
    // 503 because the chain is broken — but a *body*, from a live gateway.
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.gateway).toBe('healthy');
    expect(body.zero).toBe('offline');
  });

  it('keeps serving after a proxied request to a dead upstream', async () => {
    const { base } = await gatewayWith();
    // The proxy fails, repeatedly. A gateway that dies on a refused upstream
    // connection is exactly how port 3000 disappears mid-session.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const proxied = await fetch(`${base}/api/state`);
      expect(proxied.status).toBe(502);
    }
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('keeps serving after a websocket upgrade to a dead upstream', async () => {
    const { base } = await gatewayWith();
    const port = Number(base.split(':').at(-1));
    const { connect } = await import('node:net');
    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /ws HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
            'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n',
        );
      });
      socket.on('data', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => resolve());
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 3_000);
    });
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('recovers when the backend appears later, without restarting', async () => {
    // A free port, taken by nothing yet — the backend arrives mid-life.
    const probe = createServer(() => {});
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const backendPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const { base } = await gatewayWith({
      ZERO_API_URL: `http://127.0.0.1:${backendPort}`,
      ZERO_RUNTIME_WS_URL: '',
    });

    expect((await (await fetch(`${base}/api/health`)).json()).zero).toBe('offline');

    const backend = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok","safe_mode":false}');
    });
    await new Promise<void>((resolve) =>
      backend.listen(backendPort, '127.0.0.1', () => resolve()),
    );
    try {
      // Same gateway process, no restart: health flips because it re-probes.
      const recovered = await fetch(`${base}/api/health`);
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).zero).toBe('healthy');
    } finally {
      backend.close();
    }
  });

  it('goes back to offline when the backend dies again', async () => {
    const backend = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', () => resolve()));
    const backendPort = (backend.address() as { port: number }).port;

    const { base } = await gatewayWith({
      ZERO_API_URL: `http://127.0.0.1:${backendPort}`,
      ZERO_RUNTIME_WS_URL: '',
    });
    expect((await (await fetch(`${base}/api/health`)).json()).zero).toBe('healthy');

    await new Promise<void>((resolve) => backend.close(() => resolve()));

    const after = await fetch(`${base}/api/health`);
    expect((await after.json()).zero).toBe('offline');
    // And the interface is still there — which is the whole point.
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});

describe('an absent runtime app-server is not a failure', () => {
  it('reports not_configured rather than offline', async () => {
    const config = readConfig({ ZERO_RUNTIME_WS_URL: '', ZERO_API_URL: 'http://127.0.0.1:1' });
    const { body } = await collectHealth(config);
    expect(body.websocket).toBe('not_configured');
    expect(body.runtimeConfigured).toBe(false);
  });

  it('reports offline when one is configured and down', async () => {
    const config = readConfig({
      ZERO_RUNTIME_WS_URL: 'ws://127.0.0.1:1',
      ZERO_API_URL: 'http://127.0.0.1:1',
    });
    const { body } = await collectHealth(config);
    expect(body.websocket).toBe('offline');
    expect(body.runtimeConfigured).toBe(true);
  });
});

describe('binding', () => {
  it('covers both loopback families, so localhost and 127.0.0.1 agree', () => {
    // On Android `localhost` commonly resolves to ::1 first. A gateway bound
    // only to 127.0.0.1 answers one spelling and refuses the other, from the
    // same phone.
    expect(bindAddresses({ lanMode: false })).toEqual(['127.0.0.1', '::1']);
  });

  it('covers both wildcard families in LAN mode', () => {
    expect(bindAddresses({ lanMode: true })).toEqual(['0.0.0.0', '::']);
  });

  it('starts even when the second family cannot be bound', async () => {
    // This is the case on a host without IPv6: the extra listener fails and
    // the gateway must carry on rather than refusing to start.
    const { base, server } = await gatewayWith();
    expect((await fetch(`${base}/`)).status).toBe(200);
    const bound = (server as unknown as { boundAddresses: () => unknown[] }).boundAddresses();
    expect(bound.length).toBeGreaterThanOrEqual(1);
  });

  it('never exposes an internal upstream on the LAN listener', async () => {
    const { config } = await gatewayWith({ ZERO_LAN_MODE: 'true' });
    // Only the gateway leaves loopback; both upstreams stay on 127.0.0.1.
    expect(bindAddresses(config)).toEqual(['0.0.0.0', '::']);
    expect(config.zeroApi).toMatch(/^http:\/\/127\.0\.0\.1/);
    expect(config.zeroRuntimeWs).toMatch(/^ws:\/\/127\.0\.0\.1/);
    // And LAN mode turns diagnostics off, so the topology is not published.
    expect(config.diagnostics).toBe(false);
  });
});
