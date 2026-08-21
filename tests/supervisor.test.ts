import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/zero-supervise.sh` — the thing that keeps HWD-ZERO alive.
 *
 * Termux has no service manager, so "keep it running" has to be something ZERO
 * does for itself. These tests use a stand-in backend (a two-line node server)
 * rather than HWD-ZERO, because what is under test is the supervision, not the
 * operator: does it notice a death, does it restart, does it stop when it
 * should, and does it refuse to hammer a backend that is genuinely broken.
 */

const TIMEOUT = 120_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supervisor = join(repoRoot, 'scripts', 'zero-supervise.sh');

function freePort(): number {
  return Number(
    execFileSync(
      process.execPath,
      [
        '-e',
        `const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})`,
      ],
      { encoding: 'utf8' },
    ),
  );
}

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

/** A workspace with the scripts, an alive "gateway" pid, and a stand-in backend. */
function makeWorkspace(backendPort: number): {
  dir: string;
  gateway: ChildProcess;
  pidDir: string;
  logDir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'zero-supervisor-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const name of ['lib-zero.sh', 'zero-supervise.sh']) {
    writeFileSync(join(dir, 'scripts', name), readFileSync(join(repoRoot, 'scripts', name), 'utf8'), {
      mode: 0o755,
    });
  }
  const pidDir = join(dir, '.zero', 'run');
  const logDir = join(dir, '.zero', 'logs');
  mkdirSync(pidDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // The supervisor exits when the gateway is gone, so it needs a live one.
  const gateway = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  writeFileSync(join(pidDir, 'gateway.pid'), `${gateway.pid}\n`);
  cleanups.push(() => {
    try {
      process.kill(gateway.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  void backendPort;
  return { dir, gateway, pidDir, logDir };
}

/**
 * The command the supervisor (re)starts: a server that answers /api/health.
 *
 * Written to a file rather than passed with `node -e`, because the command
 * travels through `sh -c` and a JSON body full of quotes does not survive that
 * intact. The supervisor adds its own `exec`, so this must not.
 */
function backendCommand(dir: string, port: number): string {
  const file = join(dir, 'stand-in-backend.cjs');
  writeFileSync(
    file,
    [
      'const http = require("http");',
      'http.createServer((_q, r) => {',
      '  r.writeHead(200, { "content-type": "application/json" });',
      '  r.end(JSON.stringify({ status: "ok" }));',
      `}).listen(${port}, "127.0.0.1");`,
    ].join('\n'),
  );
  return `${process.execPath} ${file}`;
}

function startSupervisor(
  dir: string,
  backendPort: number,
  env: Record<string, string> = {},
): ChildProcess {
  const child = spawn('bash', [join(dir, 'scripts', 'zero-supervise.sh')], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ZERO_SUPERVISE_CMD: backendCommand(dir, backendPort),
      ZERO_SUPERVISE_INTERVAL: '1',
      ZERO_RUNTIME_DIR: dir,
      ZERO_API_URL: `http://127.0.0.1:${backendPort}`,
      ...env,
    },
  });
  cleanups.push(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
  });
  return child;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
  } catch {
    return false;
  }
}

describe('scripts/zero-supervise.sh', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', supervisor], { encoding: 'utf8' }).status).toBe(0);
  });

  it('starts a backend that is not running', async () => {
    const port = freePort();
    const { dir, pidDir } = makeWorkspace(port);
    startSupervisor(dir, port);

    expect(await waitFor(() => answers(port))).toBe(true);
    expect(existsSync(join(pidDir, 'hwd-zero.pid'))).toBe(true);
  }, TIMEOUT);

  it('records the real process, not the shell that launched it', async () => {
    // Without `exec` the pid file names a wrapper, and stopping that wrapper
    // orphans the server it started — a process silently lost.
    const port = freePort();
    const { dir, pidDir } = makeWorkspace(port);
    startSupervisor(dir, port);
    await waitFor(() => answers(port));

    const pid = Number(readFileSync(join(pidDir, 'hwd-zero.pid'), 'utf8').trim());
    process.kill(pid, 'SIGKILL');
    // Killing the tracked pid must actually stop the backend.
    expect(await waitFor(async () => !(await answers(port)), 10_000)).toBe(true);
  }, TIMEOUT);

  it('restarts the backend after it dies', async () => {
    const port = freePort();
    const { dir, pidDir } = makeWorkspace(port);
    startSupervisor(dir, port);
    await waitFor(() => answers(port));

    const first = Number(readFileSync(join(pidDir, 'hwd-zero.pid'), 'utf8').trim());
    process.kill(first, 'SIGKILL');
    await waitFor(async () => !(await answers(port)), 10_000);

    expect(await waitFor(() => answers(port))).toBe(true);
    const second = Number(readFileSync(join(pidDir, 'hwd-zero.pid'), 'utf8').trim());
    expect(second).not.toBe(first);
  }, TIMEOUT);

  it('gives up rather than hammering a backend that cannot start', async () => {
    const port = freePort();
    const { dir, logDir } = makeWorkspace(port);
    // A command that exits immediately: a broken install, not a crash loop
    // worth retrying forever. Hammering it hides the error.
    startSupervisor(dir, port, {
      ZERO_SUPERVISE_CMD: 'exit 1',
      ZERO_SUPERVISE_MAX_RESTARTS: '2',
    });

    const log = join(logDir, 'supervisor.log');
    expect(
      await waitFor(
        () => existsSync(log) && readFileSync(log, 'utf8').includes('giving up'),
        30_000,
      ),
    ).toBe(true);
    const contents = readFileSync(log, 'utf8');
    // It said where to look instead of failing silently.
    expect(contents).toContain('BACKEND OFFLINE');
    expect(contents.match(/restart \d+\/2/g)?.length).toBe(2);
  }, TIMEOUT);

  it('exits when the gateway is gone, leaving no orphan loop', async () => {
    const port = freePort();
    const { dir, gateway, pidDir } = makeWorkspace(port);
    startSupervisor(dir, port);
    await waitFor(() => answers(port));

    process.kill(gateway.pid!, 'SIGKILL');
    // A supervisor that outlived ZERO would keep respawning a backend nobody
    // is talking to.
    expect(
      await waitFor(() => !existsSync(join(pidDir, 'supervisor.pid')), 20_000),
    ).toBe(true);
  }, TIMEOUT);

  it('never kills by process name', () => {
    const source = readFileSync(supervisor, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    for (const pattern of [/\bpkill\b/, /\bkillall\b/]) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('does not run under errexit', () => {
    // `lib-zero.sh` turns on `set -e` for its callers. A supervisor that exits
    // when a check fails is not a supervisor.
    const source = readFileSync(supervisor, 'utf8');
    expect(source).toMatch(/set \+e/);
    expect(source.indexOf('set +e')).toBeGreaterThan(source.indexOf('lib-zero.sh'));
  });
});
