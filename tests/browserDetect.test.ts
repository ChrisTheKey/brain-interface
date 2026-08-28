import { describe, expect, it } from 'vitest';
import {
  BROWSER_IDS,
  detectBrowsers,
  launchArguments,
  BROWSERS,
  resolveOnPath,
} from '../server/browser/detect.mjs';
import { deserialize } from '../server/browser/bidi.mjs';
import { extractionExpression } from '../server/browser/extract.mjs';

describe('browser detection', () => {
  it('covers exactly the four browsers the bridge drives', () => {
    expect(BROWSER_IDS).toEqual(['chrome', 'brave', 'edge', 'firefox']);
  });

  it('finds an installed browser at its platform location', () => {
    const detected = detectBrowsers({
      platform: 'darwin',
      env: {},
      exists: (path: string) => path === '/Applications/Firefox.app/Contents/MacOS/firefox',
      resolveOnPath: () => null,
    });
    const firefox = detected.find((browser) => browser.id === 'firefox');
    expect(firefox?.installed).toBe(true);
    expect(firefox?.protocol).toBe('webdriver-bidi');
    // Firefox is the only one that is not a Chromium; the rest speak CDP.
    expect(detected.filter((browser) => browser.protocol === 'cdp')).toHaveLength(3);
  });

  it('falls back to PATH when no known location matches', () => {
    const detected = detectBrowsers({
      platform: 'linux',
      env: {},
      exists: () => false,
      resolveOnPath: (command: string) =>
        command === 'brave-browser' ? '/usr/local/bin/brave-browser' : null,
    });
    expect(detected.find((browser) => browser.id === 'brave')).toMatchObject({
      installed: true,
      executable: '/usr/local/bin/brave-browser',
    });
  });

  it('reports a browser that is not installed rather than dropping it', () => {
    const detected = detectBrowsers({
      platform: 'linux',
      env: {},
      exists: () => false,
      resolveOnPath: () => null,
    });
    expect(detected).toHaveLength(4);
    expect(detected.every((browser) => browser.installed === false)).toBe(true);
    expect(detected.every((browser) => browser.executable === null)).toBe(true);
  });

  it('honours an explicit executable override', () => {
    const detected = detectBrowsers({
      platform: 'linux',
      env: { ZERO_BROWSER_EDGE_PATH: '/opt/custom/msedge' },
      exists: () => false,
      resolveOnPath: () => null,
    });
    expect(detected.find((browser) => browser.id === 'edge')).toMatchObject({
      installed: true,
      executable: '/opt/custom/msedge',
      pinned: true,
    });
  });

  it('resolves a command against PATH', () => {
    const found = resolveOnPath(
      'firefox',
      { PATH: '/nowhere:/usr/bin' },
      'linux',
    );
    // Only asserts the search shape: the file may or may not exist here.
    expect(found === null || found.endsWith('/firefox')).toBe(true);
  });
});

describe('launch arguments', () => {
  const chrome = BROWSERS.find((browser) => browser.id === 'chrome')!;
  const firefox = BROWSERS.find((browser) => browser.id === 'firefox')!;

  it('gives Chromium a debugging port and an isolated profile', () => {
    const args = launchArguments(chrome, { port: 4711, profileDir: '/tmp/zero-chrome' });
    expect(args).toContain('--remote-debugging-port=4711');
    expect(args).toContain('--user-data-dir=/tmp/zero-chrome');
    // The browser sandbox stays on unless it is explicitly turned off.
    expect(args).not.toContain('--no-sandbox');
  });

  it('gives Firefox its own remote-agent flags', () => {
    const args = launchArguments(firefox, { port: 4712, profileDir: '/tmp/zero-firefox' });
    expect(args.join(' ')).toContain('--remote-debugging-port 4712');
    expect(args).toContain('--profile');
    expect(args).toContain('--no-remote');
  });

  it('only disables the browser sandbox when asked', () => {
    const args = launchArguments(chrome, {
      port: 1,
      profileDir: '/tmp/x',
      headless: true,
      noSandbox: true,
    });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--no-sandbox');
  });
});

describe('WebDriver BiDi values', () => {
  it('turns BiDi’s tagged representation back into a plain page result', () => {
    // BiDi returns objects as key/value pairs; CDP returns plain JSON. The
    // bridge has to hand both families the same shape.
    const value = deserialize({
      type: 'object',
      value: [
        ['title', { type: 'string', value: 'ZERO' }],
        ['characters', { type: 'number', value: 128 }],
        ['truncated', { type: 'boolean', value: false }],
        [
          'links',
          {
            type: 'array',
            value: [
              {
                type: 'object',
                value: [
                  ['text', { type: 'string', value: 'docs' }],
                  ['href', { type: 'string', value: 'https://example.com' }],
                ],
              },
            ],
          },
        ],
      ],
    });
    expect(value).toEqual({
      title: 'ZERO',
      characters: 128,
      truncated: false,
      links: [{ text: 'docs', href: 'https://example.com' }],
    });
  });

  it('handles the special numbers BiDi encodes as strings', () => {
    expect(deserialize({ type: 'number', value: 'NaN' })).toBeNaN();
    expect(deserialize({ type: 'number', value: 'Infinity' })).toBe(Number.POSITIVE_INFINITY);
    expect(deserialize({ type: 'null' })).toBeNull();
  });
});

describe('page extraction script', () => {
  it('carries the caller’s limits into the injected expression', () => {
    const expression = extractionExpression({ maxChars: 2500, maxLinks: 7 });
    expect(expression).toContain('const MAX_CHARS = 2500');
    expect(expression).toContain('const MAX_LINKS = 7');
    // Navigation chrome is stripped before the text is measured.
    expect(expression).toContain('nav,footer,header,aside');
  });

  it('hides noise in place instead of cloning the element', () => {
    // A detached clone has no layout, so innerText loses the line break
    // between a heading and the paragraph under it. Hiding and restoring
    // keeps the block structure the agent reads.
    const expression = extractionExpression();
    expect(expression).toContain("style.display = 'none'");
    expect(expression).not.toContain('cloneNode');
  });

  it('contains no backtick, which would terminate the injected expression', () => {
    // The script is built as a template literal; a stray backtick inside it
    // is a syntax error in this file, not in the page.
    expect(extractionExpression()).not.toContain('`');
  });
});
