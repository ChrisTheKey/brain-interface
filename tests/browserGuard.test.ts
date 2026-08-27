import { describe, expect, it } from 'vitest';
import {
  assertNavigable,
  BlockedUrlError,
  isPrivateAddress,
  searchUrl,
  SEARCH_ENGINES,
} from '../server/browser/guard.mjs';

/** A public name resolves publicly; `rebind.example` points back at loopback. */
const resolve = async (hostname: string): Promise<{ address: string }[]> =>
  hostname === 'rebind.example' ? [{ address: '127.0.0.1' }] : [{ address: '93.184.216.34' }];

describe('private address detection', () => {
  it('recognises every range that must never be reachable from a page', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      'localhost',
      '::1',
      '::ffff:127.0.0.1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('leaves public addresses alone', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('navigation policy', () => {
  it('allows a public https URL', async () => {
    const url = await assertNavigable('https://example.com/page?q=1', { resolve });
    expect(url.href).toBe('https://example.com/page?q=1');
  });

  it('refuses the loopback services the gateway exists to protect', async () => {
    // HWD-ZERO on :8000 is exactly what a page must never be able to reach.
    await expect(assertNavigable('http://127.0.0.1:8000/api', { resolve })).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertNavigable('http://localhost:3000/', { resolve })).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertNavigable('http://zero.local/', { resolve })).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('refuses schemes that are not http(s)', async () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'data:text/html,<b>x']) {
      await expect(assertNavigable(url, { resolve })).rejects.toBeInstanceOf(BlockedUrlError);
    }
  });

  it('refuses a public name that resolves to a private address', async () => {
    // DNS rebinding: the hostname passes the textual check and still lands
    // on loopback, so the resolved addresses have to be checked too.
    await expect(assertNavigable('https://rebind.example/', { resolve })).rejects.toThrow(
      /resolves to a local address/,
    );
  });

  it('lets an operator lift the restriction deliberately', async () => {
    const url = await assertNavigable('http://127.0.0.1:8000/api', {
      resolve,
      allowPrivate: true,
    });
    expect(url.hostname).toBe('127.0.0.1');
  });
});

describe('search', () => {
  it('builds an encoded query for every supported engine', () => {
    for (const engine of Object.keys(SEARCH_ENGINES)) {
      expect(searchUrl('zero brain & agents', engine)).toContain(
        encodeURIComponent('zero brain & agents'),
      );
    }
  });

  it('refuses an unknown engine and an empty query', () => {
    expect(() => searchUrl('x', 'nope')).toThrow(BlockedUrlError);
    expect(() => searchUrl('   ', 'google')).toThrow(BlockedUrlError);
  });
});
