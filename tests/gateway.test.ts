import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  constantTimeEquals,
  createRateLimiter,
  createUpstreamProbe,
  detectLanAddress,
  extractToken,
  isTermux,
  isWebSocketPath,
  loadOrCreateToken,
  readConfig,
  resolveStaticPath,
  WS_PATHS,
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

describe('gateway websocket routing', () => {
  it('exposes exactly the two sockets the interface speaks', () => {
    expect(WS_PATHS).toEqual(['/ws/events', '/ws/voice']);
    expect(isWebSocketPath('/ws/events')).toBe(true);
    expect(isWebSocketPath('/ws/voice')).toBe(true);
  });

  it('refuses to forward any other upgrade upstream', () => {
    expect(isWebSocketPath('/ws')).toBe(false);
    expect(isWebSocketPath('/ws/anything')).toBe(false);
    expect(isWebSocketPath('/ws/events/../admin')).toBe(false);
    expect(isWebSocketPath('/api/state')).toBe(false);
  });
});

describe('upstream health', () => {
  it('reports HWD-ZERO as down rather than failing the gateway with it', async () => {
    // Nothing is listening on this port, so the probe has to resolve, not throw.
    const probe = createUpstreamProbe('http://127.0.0.1:59998', 250);
    const status = await probe();
    expect(status.reachable).toBe(false);
    expect(status.error).toBeTruthy();
  });

  it('caches the probe so a polling UI cannot hammer a dead operator', async () => {
    let now = 1_000;
    const probe = createUpstreamProbe('http://127.0.0.1:59998', 100, () => now);
    const first = await probe();
    const second = await probe();
    expect(second.checkedAt).toBe(first.checkedAt);
    now += 5_000;
    const third = await probe();
    expect(third.checkedAt).toBeGreaterThan(first.checkedAt);
  });
});

describe('Termux', () => {
  it('recognises the phone so the start script can print the right hint', () => {
    expect(isTermux({ TERMUX_VERSION: '0.118.0' })).toBe(true);
    expect(isTermux({ PREFIX: '/data/data/com.termux/files/usr' })).toBe(true);
    expect(isTermux({})).toBe(false);
  });
});
