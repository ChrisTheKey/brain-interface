import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootPage,
  constantTimeEquals,
  createRateLimiter,
  detectLanAddress,
  extractToken,
  loadOrCreateToken,
  readConfig,
  resolveStaticPath,
  wantsHtml,
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

  it('binds every loopback family so http://localhost:3000 works on Android', () => {
    // The Galaxy's browser resolves `localhost` to ::1 first. Binding only
    // 127.0.0.1 is what makes the page come up blank on the phone that is
    // running the gateway.
    const config = readConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.extraHosts).toEqual(['::1']);
  });

  it('never widens LAN mode to IPv6 — the wildcard bind stays a single address', () => {
    const config = readConfig({ ZERO_LAN_MODE: 'true' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.extraHosts).toEqual([]);
  });

  it('reports the host it is running on', () => {
    const termux = readConfig({ PREFIX: '/data/data/com.termux/files/usr' });
    expect(termux.runtime.termux).toBe(true);
    expect(readConfig({}).runtime.termux).toBe(false);
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

describe('boot page', () => {
  it('answers a browser with a page and an API client with JSON', () => {
    expect(wantsHtml({ headers: { accept: 'text/html,application/xhtml+xml' } })).toBe(true);
    expect(wantsHtml({ headers: { accept: 'application/json' } })).toBe(false);
    expect(wantsHtml({ headers: {} })).toBe(false);
  });

  it('tells a Termux user the command that builds the interface', () => {
    const page = bootPage(readConfig({ PREFIX: '/data/data/com.termux/files/usr' }));
    expect(page).toContain('<!doctype html>');
    expect(page).toContain('scripts/setup-termux.sh');
    expect(page).toContain('termux');
  });

  it('gives a desktop user the desktop command instead', () => {
    expect(bootPage(readConfig({}))).toContain('npm run build');
  });
});
