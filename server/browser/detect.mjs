/**
 * Browser detection.
 *
 * The bridge drives the browsers that are really installed on this machine —
 * Chrome, Firefox, Brave and Edge. Nothing is assumed: a browser only exists
 * for the bridge if its executable is on disk (or on PATH), and every entry
 * the interface shows carries the path it was found at.
 *
 * Two families, two protocols:
 *   chromium (Chrome, Brave, Edge) → Chrome DevTools Protocol
 *   gecko    (Firefox)             → WebDriver BiDi
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';

/**
 * The browsers the bridge supports, with the candidate executables per
 * platform. Order inside a platform is preference order.
 */
export const BROWSERS = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    family: 'chromium',
    candidates: {
      linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
        '/snap/bin/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ],
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
    },
    onPath: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  },
  {
    id: 'brave',
    name: 'Brave',
    family: 'chromium',
    candidates: {
      linux: [
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/opt/brave.com/brave/brave-browser',
        '/snap/bin/brave',
      ],
      darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      win32: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ],
    },
    onPath: ['brave-browser', 'brave'],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    family: 'chromium',
    candidates: {
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      win32: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    },
    onPath: ['microsoft-edge', 'microsoft-edge-stable'],
  },
  {
    id: 'firefox',
    name: 'Mozilla Firefox',
    family: 'gecko',
    candidates: {
      linux: ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/snap/bin/firefox', '/opt/firefox/firefox'],
      darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
      win32: [
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
      ],
    },
    onPath: ['firefox', 'firefox-esr'],
  },
];

export const BROWSER_IDS = BROWSERS.map((browser) => browser.id);

function expandHome(path, home = homedir()) {
  return path.startsWith('~') ? join(home, path.slice(1)) : path;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // On Windows the executable bit is meaningless; existence is the test.
    return process.platform === 'win32' && existsSync(path);
  }
}

/** Resolves a bare command name against PATH, honouring PATHEXT on Windows. */
export function resolveOnPath(command, env = process.env, platform = osPlatform()) {
  const entries = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const suffixes =
    platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of entries) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Every supported browser with the executable it was found at. Browsers that
 * are not installed are returned with `installed: false` rather than dropped,
 * so the interface can show what is missing instead of silently shrinking.
 */
export function detectBrowsers(options = {}) {
  const platform = options.platform ?? osPlatform();
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? isExecutable;
  const fromPath = options.resolveOnPath ?? ((command) => resolveOnPath(command, env, platform));
  // `ZERO_BROWSER_CHROME_PATH` and friends pin an executable the standard
  // locations do not cover (a portable build, a Flatpak wrapper, a container).
  const override = (id) => {
    const value = env[`ZERO_BROWSER_${id.toUpperCase()}_PATH`];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  };

  return BROWSERS.map((browser) => {
    const pinned = override(browser.id);
    const candidates = (browser.candidates[platform] ?? []).map((path) => expandHome(path, home));
    let executable = pinned ?? candidates.find((path) => exists(path)) ?? null;
    if (!executable) {
      for (const command of browser.onPath) {
        const resolved = fromPath(command);
        if (resolved) {
          executable = resolved;
          break;
        }
      }
    }
    return {
      id: browser.id,
      name: browser.name,
      family: browser.family,
      protocol: browser.family === 'chromium' ? 'cdp' : 'webdriver-bidi',
      installed: executable !== null,
      executable,
      ...(pinned ? { pinned: true } : {}),
    };
  });
}

/** An OS-assigned free TCP port on loopback. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port available'))));
    });
  });
}

/** Isolated profile directory, so the bridge never touches your real profile. */
export function profileDirectory(browserId, root = join(tmpdir(), 'zero-brain-browser')) {
  return join(root, browserId);
}

/**
 * Command line for a browser, with remote control enabled on `port`.
 * Chromium exposes the DevTools Protocol; Firefox's remote agent exposes
 * WebDriver BiDi. Both are bound to loopback by the browser itself.
 */
export function launchArguments(browser, { port, profileDir, headless = false, noSandbox = false }) {
  if (browser.family === 'chromium') {
    return [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      ...(headless ? ['--headless=new', '--disable-gpu'] : []),
      // Chromium refuses to start its own sandbox as root (containers, CI).
      // Never a default: turning the browser sandbox off is a real downgrade.
      ...(noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      'about:blank',
    ];
  }
  return [
    '--remote-debugging-port',
    String(port),
    '--profile',
    profileDir,
    '--new-instance',
    '--no-remote',
    ...(headless ? ['--headless'] : []),
  ];
}
