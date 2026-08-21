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

  it('serves the health probe without a token, and reports ZERO as offline', async () => {
    // Health must be reachable before pairing: otherwise an unpaired phone
    // cannot tell "wrong token" from "backend down" and shows the wrong state.
    const response = await fetch(`${base}/api/health`);
    // 503, because the upstream in this fixture is not listening. The gateway
    // itself is healthy — the two facts are reported separately.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      gateway: 'healthy',
      zero: 'offline',
      lanMode: true,
    });
  });

  it('tells an unpaired caller that this origin needs a token', async () => {
    const anonymous = await (await fetch(`${base}/api/health`)).json();
    expect(anonymous.authRequired).toBe(true);
    const paired = await (
      await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(paired.authRequired).toBe(false);
  });

  it('keeps the legacy gateway health path working for the start scripts', async () => {
    const response = await fetch(`${base}/api/gateway/health`);
    expect(await response.json()).toMatchObject({ gateway: 'healthy' });
  });

  it('never leaks internal upstream addresses to a LAN client', async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    // LAN mode turns diagnostics off: a paired phone has no business learning
    // which port HWD-ZERO listens on.
    expect(body.diagnostics).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('59999');
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
