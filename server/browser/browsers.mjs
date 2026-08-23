/**
 * The browsers ZERO can drive, and the honest differences between them.
 *
 * Three of the four are Chromium underneath, which is why Chrome, Edge and
 * Brave all work with whatever is already installed on the machine. Firefox is
 * not, and the difference is not cosmetic: Playwright cannot drive a stock
 * Firefox at all. Its automation relies on patches, so it ships its own build
 * and `npx playwright install firefox` downloads it. The Firefox in your task
 * bar stays where it is.
 *
 * That is stated here rather than discovered by an operator wondering why one
 * of the four does nothing. Every entry below says whether it uses what you
 * have or needs something fetched, and the status endpoint repeats it.
 *
 * Chrome and Edge are reached by `channel`, which is Playwright's supported
 * way to the branded install. Brave has no channel — it is Chromium, so it is
 * reached by pointing at its binary, and the paths below are where its
 * installers actually put it.
 */

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** Windows program directories, which are not always where you assume. */
function windowsRoots(env) {
  return [
    env.PROGRAMFILES ?? 'C:\\Program Files',
    env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
    env.LOCALAPPDATA ?? win32.join(env.USERPROFILE ?? 'C:\\Users\\Default', 'AppData', 'Local'),
  ];
}

/**
 * Where each browser installs itself, per platform.
 *
 * Only consulted when a channel cannot be used — for Brave always, and for the
 * others as a fallback when the branded channel is not registered (a portable
 * install, or a Linux package Playwright does not recognise).
 */
export function candidatePaths(name, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = windowsRoots(env);
    const suffix = {
      brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
      edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      firefox: ['Mozilla Firefox', 'firefox.exe'],
    }[name];
    // `win32.join` rather than the ambient `join`: on a Linux CI box the
    // ambient one produces `C:\Program Files/Google/Chrome`, which matches
    // nothing and hides the bug until someone runs it on Windows.
    return suffix ? roots.map((root) => win32.join(root, ...suffix)) : [];
  }
  if (platform === 'darwin') {
    return {
      brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      firefox: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    }[name] ?? [];
  }
  return (
    {
      brave: [
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/opt/brave.com/brave/brave-browser',
        '/snap/bin/brave',
        '/var/lib/flatpak/exports/bin/com.brave.Browser',
      ],
      chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
      edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
      firefox: ['/usr/bin/firefox', '/snap/bin/firefox'],
    }[name] ?? []
  );
}

/**
 * The four ZERO knows by name, plus plain Chromium.
 *
 * `engine` is the Playwright driver — and it is the one thing that cannot be
 * configured around. Firefox is a different browser, not a Chromium with a
 * different logo.
 */
export const BROWSERS = {
  chrome: {
    engine: 'chromium',
    channel: 'chrome',
    label: 'Google Chrome',
    /** Drives what is already installed. */
    usesInstalled: true,
  },
  edge: {
    engine: 'chromium',
    channel: 'msedge',
    label: 'Microsoft Edge',
    usesInstalled: true,
  },
  brave: {
    engine: 'chromium',
    // Brave is Chromium but is not one of Playwright's channels, so it is
    // reached by its binary. Same engine, same automation, no download.
    channel: null,
    label: 'Brave',
    usesInstalled: true,
  },
  firefox: {
    engine: 'firefox',
    channel: null,
    label: 'Firefox (Playwright build)',
    // The honest one. Playwright's automation relies on patches, so a stock
    // Firefox cannot be driven and its own build has to be fetched.
    usesInstalled: false,
    install: 'npx playwright install firefox',
    note: "Playwright cannot drive a stock Firefox — it uses its own patched build, so this one needs a download. Your installed Firefox is left alone.",
  },
  chromium: {
    engine: 'chromium',
    channel: null,
    label: 'Chromium (Playwright build)',
    usesInstalled: false,
    install: 'npx playwright install chromium',
  },
};

export const DEFAULT_BROWSER = 'chrome';

/** Every name ZERO answers to, for an error message worth reading. */
export function browserNames() {
  return Object.keys(BROWSERS);
}

export function normaliseBrowserName(raw) {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!name) return DEFAULT_BROWSER;
  const aliases = {
    'google chrome': 'chrome',
    google: 'chrome',
    'microsoft edge': 'edge',
    msedge: 'edge',
    ms: 'edge',
    'brave browser': 'brave',
    ff: 'firefox',
    mozilla: 'firefox',
    'mozilla firefox': 'firefox',
  };
  return aliases[name] ?? name;
}

/**
 * What this machine can actually do with a given browser.
 *
 * `found` is about the binary being there; `ready` also requires Playwright.
 * The two are separate because "Brave is not installed" and "Playwright is not
 * installed" want different answers from the operator.
 */
export function describeBrowser(
  name,
  { platform = process.platform, env = process.env, exists = existsSync, executablePath = '' } = {},
) {
  const key = normaliseBrowserName(name);
  const definition = BROWSERS[key];
  if (!definition) {
    return {
      name: key,
      known: false,
      reason: `not a browser ZERO knows (${browserNames().join(', ')})`,
    };
  }

  const explicit = executablePath && exists(executablePath) ? executablePath : '';
  const discovered =
    explicit || candidatePaths(key, platform, env).find((path) => exists(path)) || '';

  return {
    name: key,
    known: true,
    label: definition.label,
    engine: definition.engine,
    channel: definition.channel,
    uses_installed: definition.usesInstalled,
    // A channel is enough for Chrome and Edge; Playwright finds the branded
    // install itself, and a missing path here does not mean it is absent.
    executable: discovered,
    found: Boolean(discovered) || Boolean(definition.channel),
    install: definition.install ?? '',
    note: definition.note ?? '',
  };
}

/** Launch options for this browser, minus the ones the caller owns. */
export function launchOptionsFor(description, { executablePath = '' } = {}) {
  const options = {};
  if (executablePath) {
    options.executablePath = executablePath;
  } else if (description.channel) {
    options.channel = description.channel;
  } else if (description.executable) {
    // Brave, or a Chrome that Playwright's channel lookup did not find.
    options.executablePath = description.executable;
  }

  if (description.engine === 'chromium') {
    options.args = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'];
  } else {
    // Chromium flags are not Firefox flags, and Firefox rejects what it does
    // not know. Its equivalents are preferences.
    options.firefoxUserPrefs = {
      'browser.shell.checkDefaultBrowser': false,
      'datareporting.healthreport.uploadEnabled': false,
      'app.update.auto': false,
    };
  }
  return options;
}
