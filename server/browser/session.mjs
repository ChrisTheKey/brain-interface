/**
 * ZERO driving a real browser — in its own profile, never yours.
 *
 * The fetcher in HWD-ZERO reads a page's markup. That is enough for an article
 * and useless for anything that renders itself in JavaScript, which is most of
 * what a lead-research task actually needs to look at. This drives Chrome
 * properly: it loads, it runs, and what comes back is the text a person would
 * have seen.
 *
 * Three decisions are load-bearing.
 *
 * **Its own profile.** `.zero/browser-profile`, created empty and kept
 * separate. ZERO is never handed your logged-in Chrome, because a browser with
 * your sessions in it is a browser that acts as you — your mail, your
 * accounts, your bank — and no amount of gating afterwards takes that back.
 * Whatever ZERO logs into is ZERO's, and you can delete the directory.
 *
 * **The guard is not reimplemented here.** HWD-ZERO already decides which
 * addresses may be read, and writing those checks a second time in JavaScript
 * would mean two implementations drifting apart until one of them is wrong. So
 * every navigation is validated by asking it. If it cannot be asked, nothing
 * is opened: a browser that fails open is worse than one that fails.
 *
 * **It lives in the gateway.** Playwright cannot go into HWD-ZERO, which has
 * exactly one runtime dependency so it stays installable on a phone. And a
 * phone has no desktop Chrome to drive, so on Termux this reports unavailable
 * — which is the honest answer rather than a missing feature.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_BROWSER,
  browserNames,
  describeBrowser,
  launchOptionsFor,
  normaliseBrowserName,
} from './browsers.mjs';

/** Literal private addresses, as a cheap second net for subresources.
 *
 * The authoritative check is HWD-ZERO's, which resolves the name and inspects
 * the address it lands on. This one only catches the obvious written forms,
 * and exists because a page's own images and scripts are not worth a loopback
 * round trip each — but a page pointing an iframe at 127.0.0.1 is worth
 * stopping without one. */
const PRIVATE_LITERAL =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc|\[?fd|\[?fe80)/i;

/** Closed after this long unused. A headless Chrome nobody remembers starting
 * is a gigabyte of RAM and a surprise in Task Manager. */
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

const DEFAULT_NAV_TIMEOUT = 30_000;

export const BROWSER_ERRORS = {
  UNAVAILABLE: 'browser_unavailable',
  UNKNOWN: 'browser_unknown',
  NOT_INSTALLED: 'browser_not_installed',
  DISABLED: 'browser_disabled',
  LOCAL_ONLY: 'local_only',
  LAUNCH_FAILED: 'browser_launch_failed',
  REFUSED: 'browser_url_refused',
  GUARD_UNREACHABLE: 'browser_guard_unreachable',
  TIMEOUT: 'browser_timeout',
  NAVIGATION: 'browser_navigation_failed',
};

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

export function loadBrowserConfig(env = process.env, root = process.cwd()) {
  return {
    enabled: flag(env.ZERO_BROWSER_ENABLED, false),
    localOnly: flag(env.ZERO_LOCAL_ONLY, false),
    // A profile of ZERO's own. Never `--user-data-dir` pointed at yours, and
    // there is deliberately no setting that would let it be. One directory per
    // browser, so switching from Chrome to Brave does not hand Brave whatever
    // Chrome had collected.
    profileRoot: (env.ZERO_BROWSER_PROFILE ?? '').trim() || join(root, '.zero', 'browser-profile'),
    // Which browser, by name. `channel` is derived from it rather than set
    // here: Brave has no channel and Firefox is not a Chromium at all.
    browser: normaliseBrowserName(env.ZERO_BROWSER ?? env.ZERO_BROWSER_CHANNEL ?? DEFAULT_BROWSER),
    executablePath: (env.ZERO_BROWSER_PATH ?? '').trim(),
    headless: !flag(env.ZERO_BROWSER_HEADFUL, false),
    idleMs: Number(env.ZERO_BROWSER_IDLE_MS ?? DEFAULT_IDLE_MS) || DEFAULT_IDLE_MS,
    navTimeoutMs: Number(env.ZERO_BROWSER_TIMEOUT_MS ?? DEFAULT_NAV_TIMEOUT) || DEFAULT_NAV_TIMEOUT,
    // Where to ask whether an address may be read.
    guardUrl: (env.ZERO_API_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, ''),
    maxChars: Number(env.ZERO_BROWSER_MAX_CHARS ?? 40_000) || 40_000,
    // Chromium does not read the shell's proxy variables the way curl does,
    // so a machine that only reaches the internet through one — a corporate
    // laptop, a container — needs telling.
    proxy: (env.ZERO_BROWSER_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? '').trim(),
  };
}

export function browserUnavailableReason(config) {
  if (config.localOnly) return BROWSER_ERRORS.LOCAL_ONLY;
  if (!config.enabled) return BROWSER_ERRORS.DISABLED;
  return null;
}

/** Ask HWD-ZERO whether this address may be read. Fails closed. */
export async function assertAllowed(url, config, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(`${config.guardUrl}/api/web/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    // The runtime is the only thing that knows the policy. Without it there is
    // no safe answer, so there is no answer.
    const refusal = new Error(`the address guard could not be reached: ${error?.message ?? error}`);
    refusal.code = BROWSER_ERRORS.GUARD_UNREACHABLE;
    throw refusal;
  }
  if (response.ok) return true;
  let detail = '';
  try {
    detail = ((await response.json()) ?? {}).error ?? '';
  } catch {
    detail = '';
  }
  const refusal = new Error(detail || `the address was refused (${response.status})`);
  refusal.code = BROWSER_ERRORS.REFUSED;
  throw refusal;
}

export class BrowserSession {
  #config;
  #context = null;
  #page = null;
  #idleTimer = null;
  #launching = null;
  #playwright;
  #playwrightGiven;
  #fetchImpl;
  #lastUsedAt = 0;
  #opened = 0;
  #browser;

  constructor(config, options = {}) {
    this.#config = config;
    // One session drives one browser. A second browser is a second session
    // with its own profile, which is what the pool below is for.
    this.#browser = normaliseBrowserName(options.browser ?? config.browser ?? DEFAULT_BROWSER);
    // Injected in tests. Passing it explicitly — null included — is the whole
    // answer: an injected null means "this machine has no Playwright", which is
    // not the same as never having been asked.
    this.#playwrightGiven = Object.hasOwn(options, 'playwright');
    this.#playwright = options.playwright ?? null;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get running() {
    return this.#context !== null;
  }

  get browserName() {
    return this.#browser;
  }

  /** This browser's own profile. Never shared, never the operator's. */
  get profileDir() {
    return join(this.#config.profileRoot, this.#browser);
  }

  #describe() {
    return describeBrowser(this.#browser, {
      executablePath: this.#config.executablePath,
    });
  }

  async #module() {
    if (this.#playwrightGiven || this.#playwright) return this.#playwright;
    try {
      this.#playwright = await import('playwright-core');
      return this.#playwright;
    } catch {
      return null;
    }
  }

  async status() {
    const description = this.#describe();
    const configReason = browserUnavailableReason(this.#config);
    const module = configReason ? null : await this.#module();
    // Three separate facts, kept separate because they want three different
    // answers: the browser is not switched on, Playwright is not installed,
    // or that particular browser is not on this machine.
    let reason = configReason;
    if (!reason && !description.known) reason = BROWSER_ERRORS.UNKNOWN;
    if (!reason && module === null) reason = BROWSER_ERRORS.UNAVAILABLE;
    if (!reason && !description.found) reason = BROWSER_ERRORS.NOT_INSTALLED;

    return {
      provider: 'playwright',
      browser: this.#browser,
      label: description.label ?? this.#browser,
      engine: description.engine ?? 'unknown',
      channel: description.channel ?? null,
      // Chrome, Edge and Brave use what is already there. Firefox cannot —
      // Playwright's automation relies on patches, so it brings its own.
      uses_installed: description.uses_installed ?? false,
      install: description.install ?? '',
      note: description.note ?? '',
      // A phone has no desktop browser to drive; saying so beats a feature
      // that silently is not there.
      playwright: module !== null,
      found: description.found ?? false,
      enabled: this.#config.enabled,
      ready: reason === null,
      reason,
      running: this.running,
      headless: this.#config.headless,
      proxy: this.#config.proxy ? 'configured' : 'none',
      // Shown on purpose: the operator should be able to see it is not theirs,
      // and delete it.
      profile: this.profileDir,
      own_profile: true,
      pages_opened: this.#opened,
      idle_ms: this.#config.idleMs,
    };
  }

  async #launch() {
    if (this.#context) return this.#context;
    if (this.#launching) return this.#launching;
    const reason = browserUnavailableReason(this.#config);
    if (reason) {
      const refusal = new Error(
        reason === BROWSER_ERRORS.LOCAL_ONLY
          ? 'ZERO_LOCAL_ONLY is set; no browser is started'
          : 'the browser is switched off (ZERO_BROWSER_ENABLED)',
      );
      refusal.code = reason;
      throw refusal;
    }
    const description = this.#describe();
    if (!description.known) {
      const refusal = new Error(
        `${this.#browser} is not a browser ZERO knows (${browserNames().join(', ')})`,
      );
      refusal.code = BROWSER_ERRORS.UNKNOWN;
      throw refusal;
    }
    const module = await this.#module();
    if (!module) {
      const refusal = new Error(
        'playwright-core is not installed, so there is no browser to drive on this machine',
      );
      refusal.code = BROWSER_ERRORS.UNAVAILABLE;
      throw refusal;
    }
    if (!description.found) {
      const refusal = new Error(
        description.install
          ? `${description.label} is not installed here — ${description.install}`
          : `${description.label} was not found on this machine`,
      );
      refusal.code = BROWSER_ERRORS.NOT_INSTALLED;
      throw refusal;
    }

    this.#launching = (async () => {
      const profileDir = this.profileDir;
      if (!existsSync(profileDir)) {
        mkdirSync(profileDir, { recursive: true });
      }
      const options = {
        headless: this.#config.headless,
        // Nothing is granted. A research browser has no business with the
        // microphone, the camera or where the machine is.
        permissions: [],
        acceptDownloads: false,
        // Engine-specific: Chromium flags are not Firefox flags, and Firefox
        // refuses what it does not recognise.
        ...launchOptionsFor(description, { executablePath: this.#config.executablePath }),
      };
      if (this.#config.proxy) options.proxy = { server: this.#config.proxy };

      const engine = module[description.engine];
      if (!engine) {
        const refusal = new Error(`playwright-core has no ${description.engine} driver`);
        refusal.code = BROWSER_ERRORS.UNAVAILABLE;
        throw refusal;
      }
      try {
        // Persistent, so a login ZERO makes survives — and it is ZERO's login,
        // in ZERO's directory, not one of yours.
        this.#context = await engine.launchPersistentContext(profileDir, options);
      } catch (error) {
        const refusal = new Error(
          `${description.label} could not be started: ${error?.message ?? error}`,
        );
        refusal.code = BROWSER_ERRORS.LAUNCH_FAILED;
        throw refusal;
      }
      this.#context.setDefaultNavigationTimeout(this.#config.navTimeoutMs);
      await this.#guardRequests();
      this.#page = this.#context.pages()[0] ?? (await this.#context.newPage());
      return this.#context;
    })();

    try {
      return await this.#launching;
    } finally {
      this.#launching = null;
    }
  }

  /** Stop the page reaching inward, whatever it links to. */
  async #guardRequests() {
    await this.#context.route('**/*', async (route, request) => {
      let host = '';
      try {
        host = new URL(request.url()).hostname;
      } catch {
        await route.abort();
        return;
      }
      if (PRIVATE_LITERAL.test(host)) {
        // An iframe or a script pointed at this machine. The authoritative
        // guard is HWD-ZERO's; this catches the written forms without a
        // loopback round trip for every image on the page.
        await route.abort();
        return;
      }
      if (request.isNavigationRequest() && request.frame() === this.#page?.mainFrame()) {
        try {
          await assertAllowed(request.url(), this.#config, this.#fetchImpl);
        } catch {
          await route.abort();
          return;
        }
      }
      await route.continue();
    });
  }

  #touch() {
    this.#lastUsedAt = Date.now();
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      void this.close();
    }, this.#config.idleMs);
    // The gateway must be able to exit without waiting for this.
    this.#idleTimer.unref?.();
  }

  /**
   * Open one page and read it.
   *
   * The extraction is the browser's own `innerText` — the text a person would
   * have seen, after the scripts ran. That is the entire reason to drive a
   * browser rather than fetch the markup, and it also means there is no second
   * HTML parser here to disagree with the one in HWD-ZERO.
   */
  async open(url) {
    await assertAllowed(url, this.#config, this.#fetchImpl);
    await this.#launch();
    this.#touch();
    const page = this.#page;
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.#config.navTimeoutMs,
      });
    } catch (error) {
      const failure = new Error(`could not open ${url}: ${error?.message ?? error}`);
      failure.code = /timeout/i.test(String(error?.message))
        ? BROWSER_ERRORS.TIMEOUT
        : BROWSER_ERRORS.NAVIGATION;
      throw failure;
    }
    const title = await page.title().catch(() => '');
    const text = await page
      .evaluate(() => document.body?.innerText ?? '')
      .catch(() => '');
    this.#opened += 1;
    this.#touch();
    const cleaned = text.replace(/\n{3,}/g, '\n\n').trim().slice(0, this.#config.maxChars);
    return {
      url,
      final_url: page.url(),
      status: response?.status() ?? 0,
      title,
      text: cleaned,
      truncated: text.length > this.#config.maxChars,
      chars: cleaned.length,
    };
  }

  async close() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    if (!context) return false;
    try {
      await context.close();
    } catch {
      /* already gone */
    }
    return true;
  }

  /** For diagnostics: how long since the browser was last used. */
  get idleMs() {
    return this.#lastUsedAt ? Date.now() - this.#lastUsedAt : 0;
  }
}

/**
 * One session per browser, created on demand.
 *
 * ZERO can be connected to Chrome, Edge, Brave and Firefox at once without
 * running four of them: a browser is launched the first time it is asked for
 * and closes itself when it goes idle, so "connected" costs a config entry
 * rather than a gigabyte.
 *
 * Each keeps its own profile directory. Handing Brave whatever Chrome had
 * collected would defeat the point of separate browsers, and mixing them is
 * exactly the kind of thing nobody notices until a session turns up somewhere
 * it should not have.
 */
export class BrowserPool {
  #config;
  #options;
  #sessions = new Map();

  constructor(config, options = {}) {
    this.#config = config;
    this.#options = options;
  }

  /** The session for one browser, made if it does not exist yet. */
  session(name) {
    const key = normaliseBrowserName(name ?? this.#config.browser);
    let existing = this.#sessions.get(key);
    if (!existing) {
      existing = new BrowserSession(this.#config, { ...this.#options, browser: key });
      this.#sessions.set(key, existing);
    }
    return existing;
  }

  /** What every browser ZERO knows can do on this machine. */
  async status() {
    const browsers = [];
    for (const name of browserNames()) {
      browsers.push(await this.session(name).status());
    }
    return {
      default: normaliseBrowserName(this.#config.browser),
      // Ordered so the operator reads what works before what does not.
      browsers: browsers.sort((left, right) => Number(right.ready) - Number(left.ready)),
      running: browsers.filter((entry) => entry.running).map((entry) => entry.browser),
    };
  }

  open(url, name) {
    return this.session(name).open(url);
  }

  /** Close one, or every one. Returns the names that were actually running. */
  async close(name) {
    if (name) {
      const closed = await this.session(name).close();
      return closed ? [normaliseBrowserName(name)] : [];
    }
    const closed = [];
    for (const [key, session] of this.#sessions) {
      if (await session.close()) closed.push(key);
    }
    return closed;
  }
}
