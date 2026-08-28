import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  constantTimeEquals,
  createRateLimiter,
  detectLanAddress,
  extractToken,
  loadOrCreateToken,
  readConfig,
  resolveStaticPath,
} from '../server/gateway.mjs';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zero-gateway-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('gateway configuration', () => {
  it('stays on loopback unless LAN mode is explicitly enabled', () => {
    expect(readConfig({}).host).toBe('127.0.0.1');
    expect(readConfig({ ZERO_LAN_MODE: 'false' }).host).toBe('127.0.0.1');
    expect(readConfig({ ZERO_LAN_MODE: 'true' }).host).toBe('0.0.0.0');
  });

  it('serves the interface on port 3000 by default and keeps ZERO on loopback', () => {
    const config = readConfig({});
    expect(config.port).toBe(3000);
    expect(config.zeroApi).toBe('http://127.0.0.1:8000');
    expect(config.lanMode).toBe(false);
  });

  it('honours an explicit UI port override', () => {
    expect(readConfig({ ZERO_UI_PORT: '4000' }).port).toBe(4000);
  });
});

describe('gateway authentication', () => {
  it('generates a strong token on first run and stores it privately', () => {
    const file = join(tempDir(), 'gateway-token');
    const token = loadOrCreateToken(file);
    expect(token.length).toBeGreaterThanOrEqual(40);
    // Owner-only permissions: the token must not be world readable.
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
    // Stable across restarts.
    expect(loadOrCreateToken(file)).toBe(token);
  });

  it('compares tokens without leaking length or content by timing', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });

  it('accepts the token from header, cookie or pairing link', () => {
    const url = new URL('http://laptop:3000/?token=from-query');
    expect(extractToken({ headers: { authorization: 'Bearer from-header' } }, url)).toBe(
      'from-header',
    );
    expect(extractToken({ headers: { cookie: 'a=1; zero_token=from-cookie' } }, url)).toBe(
      'from-cookie',
    );
    expect(extractToken({ headers: {} }, url)).toBe('from-query');
    expect(extractToken({ headers: {} }, new URL('http://laptop:3000/'))).toBeNull();
  });

  it('rate limits per client and recovers in the next minute', () => {
    let now = 0;
    const allow = createRateLimiter(3, () => now);
    expect([allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false]);
    // A different client is unaffected.
    expect(allow('b')).toBe(true);
    now = 61_000;
    expect(allow('a')).toBe(true);
  });
});

describe('gateway static serving', () => {
  it('refuses paths that escape the build directory', () => {
    expect(resolveStaticPath('/srv/dist', '/../../etc/passwd')).toBeNull();
    expect(resolveStaticPath('/srv/dist', '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStaticPath('/srv/dist', '/assets/app.js')).toBe('/srv/dist/assets/app.js');
    expect(resolveStaticPath('/srv/dist', '/')).toBe('/srv/dist/index.html');
  });
});

describe('LAN address detection', () => {
  it('prefers a private IPv4 address and ignores loopback', () => {
    const address = detectLanAddress({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }],
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
    });
    expect(address).toBe('192.168.1.42');
  });

  it('returns null when the laptop has no network', () => {
    expect(detectLanAddress({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] })).toBeNull();
  });
});

describe('the Harness pipeline', () => {
  it('is written in the dialect Harness detects as v1', () => {
    // Harness picks the engine with this exact test (`isV1Yaml` in
    // app/pipeline/triggerer/trigger.go): a line starting with `spec:` means
    // the v1 engine, anything else falls through to the legacy Drone one.
    const pipeline = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '.harness', 'brain-interface.yaml'),
      'utf8',
    );
    expect(pipeline).toMatch(/^version: 1$/m);
    expect(pipeline).toMatch(/^kind: pipeline$/m);
    expect(pipeline).toMatch(/^spec:/m);
  });

  it('verifies the same four things a contributor runs locally', () => {
    const pipeline = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '.harness', 'brain-interface.yaml'),
      'utf8',
    );
    for (const command of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run build']) {
      expect(pipeline, command).toContain(command);
    }
  });
});
