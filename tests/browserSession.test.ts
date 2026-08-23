import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_ERRORS,
  BrowserSession,
  assertAllowed,
  browserUnavailableReason,
  loadBrowserConfig,
} from '../server/browser/session.mjs';

/**
 * ZERO driving a browser.
 *
 * What is worth testing here is not that Chrome can open a page — it can. It
 * is that ZERO cannot be talked into opening the wrong one, that the browser
 * is never handed the operator's own profile, and that a guard it cannot reach
 * means nothing opens rather than everything.
 *
 * Real navigation is not exercised: this container reaches HTTPS only through
 * a proxy whose certificate Chromium does not trust, and plain Playwright with
 * none of this code fails there identically. That part is verified on the
 * machine that has a Chrome.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zero-browser-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in for HWD-ZERO's address guard. */
function guard(answer: (url: string) => { status: number; body: unknown }): Promise<{
  url: string;
  asked: string[];
  stop: () => void;
}> {
  const asked: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      asked.push(String(payload.url ?? ''));
      const { status, body } = answer(String(payload.url ?? ''));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      cleanups.push(() => server.close());
      ready({ url: `http://127.0.0.1:${port}`, asked, stop: () => server.close() });
    });
  });
}

describe('the profile ZERO browses in', () => {
  it('is its own, and never the operator\'s', () => {
    const config = loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true' }, '/home/someone/zero');
    // A browser holding your sessions is a browser that acts as you — your
    // mail, your accounts, your bank. That is not something a gate later can
    // take back, so it is never offered.
    expect(config.profileDir).toBe(join('/home/someone/zero', '.zero', 'browser-profile'));
    expect(config.profileDir).not.toMatch(/Default|User Data|Chrome\/Profile/);
  });

  it('drives the Chrome already on the machine rather than a second one', () => {
    // "Connect to Chrome" means the one that is there, not 150 MB downloaded
    // beside it.
    expect(loadBrowserConfig({}, '/x').channel).toBe('chrome');
  });

  it('is off until it is switched on, and local-only beats everything', () => {
    expect(browserUnavailableReason(loadBrowserConfig({}, '/x'))).toBe(BROWSER_ERRORS.DISABLED);
    expect(
      browserUnavailableReason(
        loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true', ZERO_LOCAL_ONLY: 'true' }, '/x'),
      ),
    ).toBe(BROWSER_ERRORS.LOCAL_ONLY);
  });
});

describe('the address guard, which is not reimplemented here', () => {
  it('asks the runtime and takes yes for an answer', async () => {
    const stub = await guard(() => ({ status: 200, body: { ok: true } }));
    const config = loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true', ZERO_API_URL: stub.url }, '/x');
    await expect(assertAllowed('https://example.com/', config)).resolves.toBe(true);
    expect(stub.asked).toEqual(['https://example.com/']);
  });

  it('takes no for an answer, with the runtime\'s reason', async () => {
    const stub = await guard(() => ({
      status: 403,
      body: { error: '127.0.0.1 resolves to 127.0.0.1, which is not on the public internet' },
    }));
    const config = loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true', ZERO_API_URL: stub.url }, '/x');
    await expect(assertAllowed('http://127.0.0.1:8000/api/system/stop', config)).rejects.toThrow(
      /not on the public internet/,
    );
  });

  it('fails closed when the runtime cannot be asked', async () => {
    // The runtime is the only thing that knows the policy. Without it there is
    // no safe answer, so there is no answer — a browser that fails open is
    // worse than one that fails.
    const config = loadBrowserConfig(
      { ZERO_BROWSER_ENABLED: 'true', ZERO_API_URL: 'http://127.0.0.1:1' },
      '/x',
    );
    await expect(assertAllowed('https://example.com/', config)).rejects.toMatchObject({
      code: BROWSER_ERRORS.GUARD_UNREACHABLE,
    });
  });

  it('refuses before Chrome is ever started', async () => {
    // The point of checking first: a refused address costs no browser launch,
    // and a browser that never launched cannot have loaded anything.
    const stub = await guard(() => ({ status: 403, body: { error: 'refused' } }));
    const workspace = scratch();
    const session = new BrowserSession(
      loadBrowserConfig(
        { ZERO_BROWSER_ENABLED: 'true', ZERO_API_URL: stub.url },
        workspace,
      ),
      // If it tried to launch, this would throw a different error entirely.
      { playwright: { chromium: { launchPersistentContext: () => { throw new Error('launched'); } } } },
    );
    await expect(session.open('http://127.0.0.1:8000/api/system/stop')).rejects.toThrow(/refused/);
    expect(existsSync(join(workspace, '.zero', 'browser-profile'))).toBe(false);
  });
});

describe('what it says about itself', () => {
  it('reports unavailable rather than pretending, when there is no Chrome', async () => {
    const session = new BrowserSession(
      loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true' }, scratch()),
      { playwright: null },
    );
    const status = await session.status();
    // On a phone there is no desktop Chrome to drive. Saying so beats a
    // feature that silently is not there.
    expect(status.provider).toBe('playwright');
    expect(status.own_profile).toBe(true);
    expect(status.running).toBe(false);
  });

  it('names local-only as the reason before looking for a browser at all', async () => {
    const session = new BrowserSession(
      loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true', ZERO_LOCAL_ONLY: 'true' }, scratch()),
    );
    const status = await session.status();
    expect(status.ready).toBe(false);
    expect(status.reason).toBe(BROWSER_ERRORS.LOCAL_ONLY);
  });

  it('never puts a proxy address in the status', async () => {
    const session = new BrowserSession(
      loadBrowserConfig(
        { ZERO_BROWSER_ENABLED: 'true', ZERO_BROWSER_PROXY: 'http://user:secret@proxy.internal:8080' },
        scratch(),
      ),
      { playwright: null },
    );
    const status = await session.status();
    // A proxy URL can carry credentials. That it exists is useful; what it is
    // is nobody's business but the machine's.
    expect(status.proxy).toBe('configured');
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('closes cleanly even when it never opened', async () => {
    const session = new BrowserSession(loadBrowserConfig({}, scratch()));
    await expect(session.close()).resolves.toBe(false);
  });
});
