import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_ERRORS,
  BrowserPool,
  BrowserSession,
  assertAllowed,
  browserUnavailableReason,
  loadBrowserConfig,
} from '../server/browser/session.mjs';
import {
  browserNames,
  candidatePaths,
  describeBrowser,
  launchOptionsFor,
  normaliseBrowserName,
} from '../server/browser/browsers.mjs';

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
    expect(config.profileRoot).toBe(join('/home/someone/zero', '.zero', 'browser-profile'));
    expect(config.profileRoot).not.toMatch(/Default|User Data|Chrome\/Profile/);
  });

  it('gives each browser its own directory', () => {
    const config = loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true' }, '/home/someone/zero');
    const chrome = new BrowserSession(config, { browser: 'chrome', playwright: null });
    const brave = new BrowserSession(config, { browser: 'brave', playwright: null });
    // Handing Brave whatever Chrome collected would defeat the point of
    // separate browsers, and a session turning up where it should not have is
    // exactly the kind of thing nobody notices until it matters.
    expect(chrome.profileDir).not.toBe(brave.profileDir);
    expect(chrome.profileDir.endsWith('chrome')).toBe(true);
    expect(brave.profileDir.endsWith('brave')).toBe(true);
  });

  it('drives the browser already on the machine rather than a second one', () => {
    // "Connect to Chrome" means the one that is there, not 150 MB downloaded
    // beside it.
    expect(loadBrowserConfig({}, '/x').browser).toBe('chrome');
    expect(describeBrowser('chrome').channel).toBe('chrome');
    expect(describeBrowser('edge').channel).toBe('msedge');
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


// ------------------------------------------------------------ the four names

describe('the browsers ZERO answers to', () => {
  it('knows Chrome, Edge, Brave and Firefox', () => {
    expect(browserNames()).toEqual(
      expect.arrayContaining(['chrome', 'edge', 'brave', 'firefox']),
    );
  });

  it('takes the names people actually type', () => {
    expect(normaliseBrowserName('Microsoft Edge')).toBe('edge');
    expect(normaliseBrowserName('msedge')).toBe('edge');
    expect(normaliseBrowserName('Brave Browser')).toBe('brave');
    expect(normaliseBrowserName('Mozilla Firefox')).toBe('firefox');
    expect(normaliseBrowserName('  CHROME ')).toBe('chrome');
    expect(normaliseBrowserName('')).toBe('chrome');
  });

  it('says plainly which ones use the browser you already have', () => {
    // The distinction that matters, and the one an operator would otherwise
    // discover by wondering why Firefox does nothing.
    expect(describeBrowser('chrome').uses_installed).toBe(true);
    expect(describeBrowser('edge').uses_installed).toBe(true);
    expect(describeBrowser('brave').uses_installed).toBe(true);
    expect(describeBrowser('firefox').uses_installed).toBe(false);
    expect(describeBrowser('firefox').install).toContain('playwright install firefox');
    expect(describeBrowser('firefox').note).toMatch(/cannot drive a stock Firefox/i);
  });

  it('reaches Chrome and Edge by channel, and Brave by its binary', () => {
    // Brave is Chromium but is not one of Playwright's channels, so it is
    // found on disk instead. Same engine, same automation, still no download.
    expect(describeBrowser('chrome').channel).toBe('chrome');
    expect(describeBrowser('edge').channel).toBe('msedge');
    expect(describeBrowser('brave').channel).toBe(null);

    const found = describeBrowser('brave', {
      platform: 'linux',
      exists: (path: string) => path === '/usr/bin/brave-browser',
    });
    expect(found.found).toBe(true);
    expect(found.executable).toBe('/usr/bin/brave-browser');
  });

  it('knows Firefox is a different engine, not a Chromium with a logo', () => {
    expect(describeBrowser('firefox').engine).toBe('firefox');
    for (const name of ['chrome', 'edge', 'brave']) {
      expect(describeBrowser(name).engine, name).toBe('chromium');
    }
  });

  it('gives Firefox preferences and Chromium flags, never the other way round', () => {
    // Firefox rejects arguments it does not recognise, so handing it
    // --no-first-run is a launch that fails for a reason nobody would guess.
    const chromium = launchOptionsFor(describeBrowser('chrome'));
    expect(chromium['args']).toContain('--no-first-run');
    expect(chromium).not.toHaveProperty('firefoxUserPrefs');

    const firefox = launchOptionsFor(describeBrowser('firefox'));
    expect(firefox).not.toHaveProperty('args');
    expect(firefox['firefoxUserPrefs']).toMatchObject({
      'browser.shell.checkDefaultBrowser': false,
    });
  });

  it('looks where each installer actually puts things, per platform', () => {
    const windows = candidatePaths('brave', 'win32', { PROGRAMFILES: 'C:\\Program Files' });
    // Built with Windows separators even when the test runs on Linux, or the
    // path matches nothing and the bug hides until someone runs Windows.
    expect(windows[0]).toBe(
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    );
    expect(candidatePaths('brave', 'darwin')[0]).toContain('/Applications/Brave Browser.app');
    expect(candidatePaths('brave', 'linux')).toContain('/usr/bin/brave-browser');
    expect(candidatePaths('edge', 'linux')).toContain('/usr/bin/microsoft-edge');
  });

  it('refuses a name it does not know instead of guessing', () => {
    const unknown = describeBrowser('safari');
    expect(unknown.known).toBe(false);
    expect(unknown.reason).toContain('chrome');
  });
});

describe('several browsers at once', () => {
  it('gives each its own session and never mixes them', async () => {
    const pool = new BrowserPool(loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true' }, scratch()), {
      playwright: null,
    });
    const chrome = pool.session('chrome');
    const brave = pool.session('Brave Browser');
    expect(chrome.browserName).toBe('chrome');
    expect(brave.browserName).toBe('brave');
    // Asking twice is the same browser, not a second one.
    expect(pool.session('chrome')).toBe(chrome);
    expect(chrome.profileDir).not.toBe(brave.profileDir);
  });

  it('reports every browser and what this machine can do with each', async () => {
    const pool = new BrowserPool(loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true' }, scratch()), {
      playwright: null,
    });
    const status = await pool.status();
    expect(status.default).toBe('chrome');
    expect(status.browsers.map((entry) => entry.browser).sort()).toEqual(
      ['brave', 'chrome', 'chromium', 'edge', 'firefox'].sort(),
    );
    // Playwright is absent in this fixture, so nothing claims to be ready.
    for (const entry of status.browsers) {
      expect(entry.ready, entry.browser).toBe(false);
      expect(entry.reason, entry.browser).toBeTruthy();
    }
    expect(status.running).toEqual([]);
  });

  it('closes one without closing the others, and all of them on request', async () => {
    const pool = new BrowserPool(loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true' }, scratch()), {
      playwright: null,
    });
    pool.session('chrome');
    pool.session('edge');
    // Nothing was launched, so nothing reports as closed — the honest answer
    // rather than a cheerful one.
    await expect(pool.close('chrome')).resolves.toEqual([]);
    await expect(pool.close()).resolves.toEqual([]);
  });

  it('still refuses an address before launching, whichever browser was asked for', async () => {
    const stub = await guard(() => ({ status: 403, body: { error: 'refused' } }));
    const pool = new BrowserPool(
      loadBrowserConfig({ ZERO_BROWSER_ENABLED: 'true', ZERO_API_URL: stub.url }, scratch()),
      {
        playwright: {
          chromium: { launchPersistentContext: () => { throw new Error('launched'); } },
          firefox: { launchPersistentContext: () => { throw new Error('launched'); } },
        },
      },
    );
    for (const name of ['chrome', 'edge', 'brave', 'firefox']) {
      await expect(pool.open('http://127.0.0.1:8000/api/system/stop', name)).rejects.toThrow(
        /refused/,
      );
    }
    // Four browsers, four refusals, and not one of them started.
    expect(stub.asked).toHaveLength(4);
  });
});
