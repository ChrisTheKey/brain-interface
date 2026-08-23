import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/start-zero-termux.sh`, exercised as a program.
 *
 * Shell is where this bug lived, so shell is where the regression test belongs.
 * Every case here runs the real script against a real port, with the backend
 * deliberately absent — the situation that used to end in
 * ERR_CONNECTION_REFUSED.
 */

/** These start real processes and wait on real sockets, so 5s is far too small. */
const TIMEOUT = 120_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'start-zero-termux.sh');
const library = join(repoRoot, 'scripts', 'lib-zero.sh');

/** A port nothing is using, found by binding and releasing it. */
function freePort(): number {
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})`,
    ],
    { encoding: 'utf8' },
  );
  return Number(output);
}

let workspace: string;
let uiPort: number;

/** Run the start script inside an isolated copy of the repository. */
function runScript(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [join(workspace, 'scripts', 'start-zero-termux.sh'), ...args], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      ZERO_UI_PORT: String(uiPort),
      // Both upstreams point at a port nothing listens on: the backend is
      // deliberately, definitively absent.
      ZERO_API_URL: 'http://127.0.0.1:1',
      ZERO_RUNTIME_WS_URL: 'ws://127.0.0.1:1',
      ZERO_RUNTIME_DIR: join(workspace, 'no-such-runtime'),
      ...extraEnv,
    },
  });
}

function stopScript(): void {
  runScript(['--stop']);
}

/** A shell file with its comments removed, so a scan reads code only. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s#(?![{(]).*$/, ''))
    .join('\n');
}

/** The gateway detaches, so give it a moment before declaring it absent. */
async function fetchWithRetry(url: string, attempts = 10): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw last;
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'zero-start-'));
  mkdirSync(join(workspace, 'scripts'), { recursive: true });
  mkdirSync(join(workspace, 'server'), { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'dist'), { recursive: true });

  for (const name of ['lib-zero.sh', 'start-zero-termux.sh']) {
    writeFileSync(
      join(workspace, 'scripts', name),
      readFileSync(join(repoRoot, 'scripts', name), 'utf8'),
      { mode: 0o755 },
    );
  }
  // The whole server tree, not just gateway.mjs: the gateway imports its own
  // modules now, and a fixture that copies one file starts a gateway that
  // cannot resolve them — which looks exactly like the start script failing.
  cpSync(join(repoRoot, 'server'), join(workspace, 'server'), { recursive: true });
  // A prebuilt bundle, so the script has nothing to build.
  writeFileSync(join(workspace, 'dist', 'index.html'), '<!doctype html><title>brain</title>');
  writeFileSync(join(workspace, 'index.html'), '<!doctype html>');
  writeFileSync(join(workspace, 'package.json'), '{"name":"probe","type":"module"}');
  uiPort = freePort();
});

afterEach(() => {
  stopScript();
});

afterAll(() => {
  stopScript();
  rmSync(workspace, { recursive: true, force: true });
});

describe('scripts/start-zero-termux.sh', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', script], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('bash', ['-n', library], { encoding: 'utf8' }).status).toBe(0);
  }, TIMEOUT);

  it('brings the interface up with no backend at all', () => {
    const result = runScript(['--background']);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    // The headline is honest about the backend...
    expect(result.stdout).toContain('ZERO ONLINE · BACKEND OFFLINE');
    // ...and it did not claim the backend was fine.
    expect(result.stdout).not.toContain('ZERO READY');
    // Both spellings of loopback are advertised.
    expect(result.stdout).toContain(`http://127.0.0.1:${uiPort}`);
    expect(result.stdout).toContain(`http://localhost:${uiPort}`);
  }, TIMEOUT);

  it('proves port 3000 answers before saying anything is online', async () => {
    runScript(['--background']);
    const root = await fetchWithRetry(`http://127.0.0.1:${uiPort}/`);
    expect(root.status).toBe(200);
    const health = await fetchWithRetry(`http://127.0.0.1:${uiPort}/api/health`);
    expect(health.status).toBe(503);
    expect((await health.json()).gateway).toBe('healthy');
  }, TIMEOUT);

  it('writes a pid file and a log', () => {
    runScript(['--background']);
    const pidFile = join(workspace, '.zero', 'run', 'gateway.pid');
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(join(workspace, '.zero', 'logs', 'gateway.log'))).toBe(true);
  }, TIMEOUT);

  it('survives the shell that started it, in background mode', async () => {
    const result = runScript(['--background']);
    expect(result.status).toBe(0);
    // The script has exited. The gateway must not have gone with it.
    expect((await fetchWithRetry(`http://127.0.0.1:${uiPort}/`)).status).toBe(200);
  }, TIMEOUT);

  it('is idempotent: a second start finds the first and does not duplicate it', () => {
    runScript(['--background']);
    const pidFile = join(workspace, '.zero', 'run', 'gateway.pid');
    const first = readFileSync(pidFile, 'utf8').trim();

    const second = runScript(['--background']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already running');
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(first);
  }, TIMEOUT);

  it('clears a stale pid file instead of trusting it', () => {
    const pidFile = join(workspace, '.zero', 'run', 'gateway.pid');
    mkdirSync(dirname(pidFile), { recursive: true });
    // A pid that cannot be running: max_pid + 1 territory, never assigned.
    writeFileSync(pidFile, '4194304\n');

    const result = runScript(['--background']);
    expect(result.stdout).toContain('stale gateway pid file');
    expect(result.status).toBe(0);
    expect(readFileSync(pidFile, 'utf8').trim()).not.toBe('4194304');
  }, TIMEOUT);

  it('refuses a port held by a process it does not own, and kills nothing', async () => {
    const { createServer } = await import('node:net');
    const squatter = createServer(() => {});
    const port = await new Promise<number>((resolveServer) =>
      squatter.listen(0, '127.0.0.1', () =>
        resolveServer((squatter.address() as { port: number }).port),
      ),
    );

    try {
      const result = runScript(['--background'], { ZERO_UI_PORT: String(port) });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('did not start');
      // Still listening: ZERO never kills a process it does not own.
      expect(squatter.listening).toBe(true);
    } finally {
      squatter.close();
    }
  }, TIMEOUT);

  it('--stop stops what it started and removes the pid file', async () => {
    runScript(['--background']);
    const pidFile = join(workspace, '.zero', 'run', 'gateway.pid');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());

    const stopped = runScript(['--stop']);
    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toContain('gateway stopped');
    expect(existsSync(pidFile)).toBe(false);

    // Really gone, and the port is free again.
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, TIMEOUT);

  it('--stop on a stale pid file kills nothing', () => {
    const pidFile = join(workspace, '.zero', 'run', 'gateway.pid');
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, '4194304\n');
    const result = runScript(['--stop']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('stale');
    expect(existsSync(pidFile)).toBe(false);
  }, TIMEOUT);

  it('contains no global process kill', () => {
    // `pkill node` on a phone takes out whatever else the user is running, so
    // every kill must go through a pid file. Comments discuss these commands;
    // only executable lines are scanned.
    for (const pattern of [/\bpkill\b/, /\bkillall\b/, /kill\s+-9?\s*-1\b/]) {
      expect(codeOf(script)).not.toMatch(pattern);
    }
  }, TIMEOUT);

  it('depends on no init system', () => {
    // Termux has none of these, and needing one is how a start script becomes
    // "works on my laptop".
    for (const forbidden of [/\bsystemctl\b/, /\blaunchctl\b/, /\bsudo\b/, /\bsc\.exe\b/]) {
      expect(codeOf(script)).not.toMatch(forbidden);
    }
  }, TIMEOUT);

  it('binds the LAN only when asked', () => {
    const result = runScript(['--background', '--lan']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('LAN');
    // The upstreams stay on loopback regardless of LAN mode.
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('ZERO_API_URL=$ZERO_API_URL');
  }, TIMEOUT);
});
