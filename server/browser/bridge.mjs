/**
 * The browser bridge — ZERO's access to the internet.
 *
 *     ZERO  ──MCP──▶  gateway /api/browser/*  ──▶  BrowserBridge
 *                                                       │
 *                            ┌──────────────────────────┴────────────────┐
 *                            ▼                                           ▼
 *                  Chrome / Brave / Edge                            Firefox
 *                  (DevTools Protocol)                          (WebDriver BiDi)
 *                            └──────────────────┬────────────────────────┘
 *                                               ▼
 *                                         the internet
 *
 * The bridge owns one browser process at a time. It launches the browser with
 * an isolated profile and a loopback-bound control port, opens one tab, and
 * exposes exactly three operations on it: open a URL, read the current page,
 * run a search. Every navigation goes through `assertNavigable`, so a page
 * can never be used to reach HWD-ZERO or anything else on this machine.
 *
 * Nothing here is a headless scraper stack: it is the browser the operator
 * already has, driven through its own official remote-control protocol.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { detectBrowsers, findFreePort, launchArguments, profileDirectory } from './detect.mjs';
import { CdpSession, waitForDevTools } from './cdp.mjs';
import { BidiSession, createBidiSession } from './bidi.mjs';
import { assertNavigable, BlockedUrlError, searchUrl } from './guard.mjs';

export { BlockedUrlError };

export function readBrowserConfig(env = process.env) {
  return {
    /** Browser used when a request does not name one. */
    preferred: (env.ZERO_BROWSER ?? 'chrome').trim().toLowerCase(),
    headless: String(env.ZERO_BROWSER_HEADLESS ?? '').toLowerCase() === 'true',
    /** Only for containers that run as root; the browser sandbox stays on otherwise. */
    noSandbox: String(env.ZERO_BROWSER_NO_SANDBOX ?? '').toLowerCase() === 'true',
    /** Deliberate escape hatch; off by default (see guard.mjs). */
    allowPrivate: String(env.ZERO_BROWSER_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    /** Close the browser after this long without a request. 0 disables it. */
    idleTimeoutMs: Number(env.ZERO_BROWSER_IDLE_MS ?? 300_000),
    navigationTimeoutMs: Number(env.ZERO_BROWSER_NAV_TIMEOUT_MS ?? 30_000),
    maxChars: Number(env.ZERO_BROWSER_MAX_CHARS ?? 12_000),
    searchEngine: (env.ZERO_BROWSER_SEARCH_ENGINE ?? 'duckduckgo').trim().toLowerCase(),
    env,
  };
}

export class BrowserBridge {
  #session = null;
  #process = null;
  #active = null;
  #profileDir = null;
  #idleTimer = null;
  #starting = null;

  constructor(config = readBrowserConfig()) {
    this.config = config;
  }

  /** What is installed, and what is running right now. */
  status() {
    const browsers = detectBrowsers({ env: this.config.env });
    return {
      browsers,
      preferred: this.config.preferred,
      headless: this.config.headless,
      noSandbox: this.config.noSandbox,
      allowPrivate: this.config.allowPrivate,
      searchEngine: this.config.searchEngine,
      active: this.#active
        ? {
            id: this.#active.id,
            name: this.#active.name,
            protocol: this.#active.protocol,
            port: this.#active.port,
            pid: this.#process?.pid ?? null,
          }
        : null,
    };
  }

  /**
   * Starts (or reuses) a browser. Passing a different browser id than the one
   * running replaces it, so switching from Chrome to Firefox is one call.
   */
  async launch(browserId) {
    const wanted = (browserId ?? this.config.preferred).trim().toLowerCase();
    if (this.#active?.id === wanted && this.#session?.isOpen) {
      this.#armIdleTimer();
      return this.status().active;
    }
    if (this.#starting) await this.#starting.catch(() => undefined);
    if (this.#active?.id === wanted && this.#session?.isOpen) {
      this.#armIdleTimer();
      return this.status().active;
    }

    this.#starting = this.#start(wanted);
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async #start(browserId) {
    await this.close();

    const browser = detectBrowsers({ env: this.config.env }).find((entry) => entry.id === browserId);
    if (!browser) {
      throw new Error(
        `unknown browser "${browserId}" — known: ${detectBrowsers({ env: this.config.env })
          .map((entry) => entry.id)
          .join(', ')}`,
      );
    }
    if (!browser.installed) {
      throw new Error(
        `${browser.name} is not installed on this machine (set ZERO_BROWSER_${browser.id.toUpperCase()}_PATH to point at it)`,
      );
    }

    const port = await findFreePort();
    const profileDir = profileDirectory(browser.id);
    mkdirSync(profileDir, { recursive: true });
    const args = launchArguments(browser, {
      port,
      profileDir,
      headless: this.config.headless,
      noSandbox: this.config.noSandbox,
    });

    const child = spawn(browser.executable, args, {
      stdio: 'ignore',
      detached: false,
    });
    child.on('error', () => undefined);
    this.#process = child;
    this.#profileDir = profileDir;

    try {
      if (browser.family === 'chromium') {
        const version = await waitForDevTools(port);
        const session = new CdpSession({
          webSocketDebuggerUrl: version.webSocketDebuggerUrl,
          timeoutMs: this.config.navigationTimeoutMs,
        });
        await session.open();
        this.#session = session;
        this.#active = { ...browser, port, version: version.Browser ?? null };
      } else {
        const handshake = await createBidiSession(port);
        const session = new BidiSession({
          webSocketUrl: handshake.webSocketUrl,
          sessionId: handshake.sessionId,
          timeoutMs: this.config.navigationTimeoutMs,
        });
        await session.open();
        this.#session = session;
        this.#active = { ...browser, port, version: handshake.capabilities?.browserVersion ?? null };
      }
    } catch (error) {
      await this.close();
      throw new Error(`could not control ${browser.name}: ${error.message}`);
    }

    this.#armIdleTimer();
    return this.status().active;
  }

  /** Opens a URL and returns what the page says. */
  async open(url, { browser, maxChars } = {}) {
    const target = await assertNavigable(url, { allowPrivate: this.config.allowPrivate });
    await this.launch(browser);
    const session = this.#session;
    if (!session) throw new Error('no browser session');

    await session.navigate(target.href);
    const page = await session.read({ maxChars: maxChars ?? this.config.maxChars });
    this.#armIdleTimer();
    return { ...page, requestedUrl: target.href, browser: this.#active.id };
  }

  /** Re-reads the page that is currently open, without navigating. */
  async read({ maxChars } = {}) {
    const session = this.#session;
    if (!session?.isOpen) throw new Error('no page is open — call open first');
    const page = await session.read({ maxChars: maxChars ?? this.config.maxChars });
    this.#armIdleTimer();
    return { ...page, browser: this.#active.id };
  }

  /** Runs a web search and returns the result page's links and text. */
  async search(query, { engine, browser, maxChars } = {}) {
    const url = searchUrl(query, engine ?? this.config.searchEngine);
    const page = await this.open(url, { browser, maxChars });
    return { ...page, query, engine: engine ?? this.config.searchEngine };
  }

  /** Closes the tab, the browser and the timers. Safe to call repeatedly. */
  async close() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    try {
      await this.#session?.close();
    } catch {
      /* already gone */
    }
    this.#session = null;

    const child = this.#process;
    this.#process = null;
    this.#active = null;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // The profile is scratch state for this bridge only; it never holds the
    // operator's own browsing data.
    if (this.#profileDir) {
      rmSync(this.#profileDir, { recursive: true, force: true });
      this.#profileDir = null;
    }
    return { closed: true };
  }

  #armIdleTimer() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (!this.config.idleTimeoutMs) return;
    this.#idleTimer = setTimeout(() => {
      void this.close();
    }, this.config.idleTimeoutMs);
    // An idle browser must not hold the gateway process open.
    this.#idleTimer.unref?.();
  }
}
