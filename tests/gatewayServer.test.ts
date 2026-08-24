import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('never serves files outside the build directory', async () => {
    const response = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd?token=${token}`);
    const body = await response.text();
    expect(body).not.toContain('root:');
    expect(body).toContain('brain');
  });
});

describe('gateway server (same-device loopback mode)', () => {
  let loopback: Server;
  let loopbackBase: string;

  beforeAll(async () => {
    const config = readConfig({
      ZERO_UI_PORT: '0',
      // No dist directory: a fresh Termux install, before the build.
      ZERO_UI_DIST: join(workDir, 'not-built'),
      ZERO_TOKEN_FILE: join(workDir, 'loopback-token'),
      PREFIX: '/data/data/com.termux/files/usr',
    });
    loopback = startGateway(config);
    await new Promise<void>((resolve) => loopback.once('listening', () => resolve()));
    const address = loopback.address();
    loopbackBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => {
    loopback?.close();
  });

  it('trusts the device it runs on — no token, no pairing', async () => {
    const response = await fetch(`${loopbackBase}/api/gateway/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ gateway: 'ok', lanMode: false, authRequired: false });
    // Reports the host, so the doctor script does not have to guess.
    expect(body.termux).toBe(true);
    expect(body.uiBuilt).toBe(false);
    // Only addresses that really came up are listed.
    expect(body.addresses).toContain('127.0.0.1');
    for (const address of body.addresses) expect(['127.0.0.1', '::1']).toContain(address);
  });

  it('shows a page explaining the missing build instead of a raw JSON error', async () => {
    const response = await fetch(`${loopbackBase}/`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('INTERFACE NOT BUILT');
    expect(body).toContain('setup-termux.sh');
  });

  it('still answers API clients with JSON', async () => {
    const response = await fetch(`${loopbackBase}/`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('ui_not_built');
  });
});
