/**
 * Host platform facts the ZERO runtime needs to know about.
 *
 * Termux on an Android phone is a first-class target here, next to Windows,
 * macOS and desktop Linux. Everything in this file is a pure function over an
 * injected environment so the detection can be tested without an actual phone.
 *
 * Two things make Termux different from desktop Linux, and both are handled
 * here rather than being scattered through the scripts:
 *
 *   1. There is no `/usr`. Termux installs into `$PREFIX`
 *      (`/data/data/com.termux/files/usr`) and `$HOME` is
 *      `/data/data/com.termux/files/home`. Neither path contains a user name,
 *      so nothing needs to be hardcoded per device.
 *   2. `localhost` is not reliably IPv4. Android resolvers hand out `::1`
 *      first, so a server bound to `127.0.0.1` alone can be unreachable from
 *      the very same phone's browser. See `loopbackHosts()`.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Repositories that make up a ZERO workspace. Both must be present. */
export const WORKSPACE_MEMBERS = ['HWD-ZERO', 'brain-interface'];

/** Canonical workspace directory name under `$HOME`. */
export const WORKSPACE_DIR_NAME = 'ZERO-WORKSPACE';

/**
 * Describes the machine ZERO is running on.
 *
 * `termux` is deliberately derived from `$PREFIX`/`$TERMUX_VERSION` rather
 * than from `process.platform`: Termux's Node reports `android`, but so does a
 * Node built for a plain Android container, and only Termux gives us a usable
 * `$PREFIX`.
 */
export function detectRuntime(env = process.env, platform = process.platform, arch = process.arch) {
  const prefix = typeof env.PREFIX === 'string' ? env.PREFIX : '';
  const termux =
    prefix.includes('com.termux') ||
    typeof env.TERMUX_VERSION === 'string' ||
    (typeof env.TERMUX_APP_PACKAGE_NAME === 'string' && env.TERMUX_APP_PACKAGE_NAME.length > 0);
  const android = platform === 'android' || termux;

  return {
    /** Short name used in every status line: termux | linux | macos | windows | android. */
    name: termux ? 'termux' : platform === 'android' ? 'android' : normalisePlatform(platform),
    termux,
    android,
    platform,
    arch,
    /** True for the Galaxy S25 Ultra and every other 64-bit ARM device. */
    arm64: arch === 'arm64',
    prefix: termux ? prefix : '',
    /** Termux ships no `sudo`, no `systemd`, no Docker — nothing may depend on them. */
    hasPrivilegeEscalation: !android,
  };
}

function normalisePlatform(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

/**
 * Loopback addresses the gateway should listen on.
 *
 * On Android, `http://localhost:3000` typed into Chrome resolves to `::1`
 * before `127.0.0.1`. Binding both keeps the URL in the mission ("open
 * http://localhost:3000") working without ever leaving loopback — unlike
 * `0.0.0.0`, which would put the interface on the mobile network.
 */
export function loopbackHosts(env = process.env) {
  const primary = '127.0.0.1';
  if (String(env.ZERO_DISABLE_IPV6 ?? '').toLowerCase() === 'true') return [primary];
  return [primary, '::1'];
}

/**
 * Finds the ZERO workspace: the directory that holds both `HWD-ZERO` and
 * `brain-interface`.
 *
 * Search order, first hit wins:
 *   1. `$ZERO_WORKSPACE`, when it is set and complete.
 *   2. The ancestors of this checkout — the normal case, because
 *      `brain-interface` sits inside the workspace.
 *   3. `$HOME/ZERO-WORKSPACE`, the canonical location.
 *
 * Returns `null` when no complete workspace exists; callers report that rather
 * than inventing a path.
 */
export function detectWorkspaceRoot({
  env = process.env,
  startDir = process.cwd(),
  home = homedir(),
  exists = existsSync,
} = {}) {
  const candidates = [];
  if (typeof env.ZERO_WORKSPACE === 'string' && env.ZERO_WORKSPACE.trim() !== '') {
    candidates.push(resolve(env.ZERO_WORKSPACE.trim()));
  }
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    candidates.push(dir);
    if (dirname(dir) === dir) break;
  }
  if (home) candidates.push(join(home, WORKSPACE_DIR_NAME));

  for (const candidate of candidates) {
    if (WORKSPACE_MEMBERS.every((member) => exists(join(candidate, member)))) return candidate;
  }
  return null;
}

/**
 * The canonical paths, resolved or predicted.
 *
 * When no workspace exists yet the returned paths point at
 * `$HOME/ZERO-WORKSPACE/…` and `exists` is false — that is what setup creates.
 */
export function canonicalPaths({
  env = process.env,
  startDir = process.cwd(),
  home = homedir(),
  exists = existsSync,
} = {}) {
  const detected = detectWorkspaceRoot({ env, startDir, home, exists });
  const workspace = detected ?? join(home, WORKSPACE_DIR_NAME);
  return {
    workspace,
    exists: detected !== null,
    hwdZero: join(workspace, 'HWD-ZERO'),
    brainInterface: join(workspace, 'brain-interface'),
  };
}
