import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The port helpers in `scripts/lib-zero.sh`.
 *
 * These exist because of one real failure on the phone:
 *
 *   OSError: [Errno 98] Address already in use
 *   AttributeError: 'ZeroHTTPServer' object has no attribute 'operator'
 *
 * A second HWD-ZERO was started against a port the first one held. The fix has
 * two halves — the runtime no longer crashes in its own cleanup path (tested in
 * HWD-ZERO), and the scripts no longer start the second server. That second
 * half is what is tested here: can the scripts tell *who* holds a port, and do
 * they refuse to touch anything they did not start.
 */

const TIMEOUT = 60_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const library = join(repoRoot, 'scripts', 'lib-zero.sh');

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

/** A script's executable lines. Comments explain what is *not* done. */
function code(path: string): string {
  return execFileSync('cat', [path], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

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

/** Run one library function and return what it printed. */
function callHelper(call: string, env: Record<string, string> = {}): string {
  const result = spawnSync(
    'bash',
    ['-c', `source "${library}" >/dev/null 2>&1; set +e; ${call}`],
    { encoding: 'utf8', env: { ...process.env, ...env }, cwd: repoRoot },
  );
  return `${result.stdout}`.trim();
}

/** A server that answers /api/health with the identity it is given. */
function serveHealth(port: number, body: Record<string, unknown>): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), 'zero-port-'));
  const file = join(dir, 'server.cjs');
  writeFileSync(
    file,
    [
      'const http = require("http");',
      'http.createServer((_q, r) => {',
      '  r.writeHead(200, { "content-type": "application/json" });',
      `  r.end(JSON.stringify({ ...${JSON.stringify(body)}, pid: process.pid }));`,
      `}).listen(${port}, "127.0.0.1");`,
    ].join('\n'),
  );
  const child = spawn(process.execPath, [file], { detached: true, stdio: 'ignore' });
  cleanups.push(() => {
    try {
      process.kill(child.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return child;
}

async function waitFor(check: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 200));
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

describe('who holds the port', () => {
  it('finds the listening pid with whatever tool the host has', async () => {
    // lsof and ss are separate Termux packages and neither is guaranteed;
    // /proc always is. Whichever path runs here must produce the same pid.
    const port = freePort();
    const child = serveHealth(port, { status: 'ok' });
    expect(await waitFor(() => answers(port))).toBe(true);

    expect(callHelper(`zero_port_pids ${port}`)).toBe(String(child.pid));
  }, TIMEOUT);

  it('names an HWD-ZERO as an HWD-ZERO, and a stranger as a stranger', async () => {
    const ours = freePort();
    const theirs = freePort();
    const zero = serveHealth(ours, { status: 'ok', service: 'HWD-ZERO', version: '9.9.9' });
    serveHealth(theirs, { status: 'ok', service: 'something-else' });
    expect(await waitFor(() => answers(ours))).toBe(true);
    expect(await waitFor(() => answers(theirs))).toBe(true);

    expect(callHelper(`zero_port_occupant ${ours}`)).toBe(`HWD-ZERO (pid ${zero.pid})`);
    // Answering /api/health is not the same as being ZERO. Treating it as
    // such is how a stranger on port 8000 looked like a healthy backend.
    expect(callHelper(`zero_port_occupant ${theirs}`)).toContain('something-else');
    expect(callHelper(`zero_zero_on_port ${ours}`)).toBe(String(zero.pid));
    expect(callHelper(`zero_zero_on_port ${theirs} || echo NOT_ZERO`)).toBe('NOT_ZERO');
  }, TIMEOUT);

  it('says so plainly when nothing is listening', () => {
    const port = freePort();
    expect(callHelper(`zero_zero_on_port ${port} || echo NOT_ZERO`)).toBe('NOT_ZERO');
    expect(callHelper(`zero_port_pids ${port}`)).toBe('');
  });
});

describe('releasing a port', () => {
  it('refuses to touch a process ZERO did not start', async () => {
    const port = freePort();
    const stranger = serveHealth(port, { status: 'ok', service: 'something-else' });
    expect(await waitFor(() => answers(port))).toBe(true);

    const output = callHelper(`zero_release_port ${port}`);
    expect(output).toContain('not touching it');
    // Still alive. `pkill node` would have taken this and everything else.
    expect(await answers(port)).toBe(true);
    expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
  }, TIMEOUT);

  it('refuses an HWD-ZERO that this deployment did not start', async () => {
    const port = freePort();
    serveHealth(port, { status: 'ok', service: 'HWD-ZERO' });
    expect(await waitFor(() => answers(port))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'zero-pid-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, 'hwd-zero.pid');
    writeFileSync(pidFile, '999999\n'); // some other deployment's pid

    expect(callHelper(`zero_release_port ${port} "${pidFile}"`)).toContain('not touching it');
    expect(await answers(port)).toBe(true);
  }, TIMEOUT);

  it('stops the one it did start, by pid file and never by name', async () => {
    const port = freePort();
    const mine = serveHealth(port, { status: 'ok', service: 'HWD-ZERO' });
    expect(await waitFor(() => answers(port))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'zero-pid-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, 'hwd-zero.pid');
    writeFileSync(pidFile, `${mine.pid}\n`);

    expect(callHelper(`zero_release_port ${port} "${pidFile}"`)).toContain('released port');
    expect(await waitFor(async () => !(await answers(port)), 15_000)).toBe(true);
  }, TIMEOUT);
});

describe('the runtime PATH', () => {
  it('puts $HOME/.local/bin where whisper-cli and pip scripts actually are', () => {
    // Termux does not do this itself, and every "whisper.cpp is not installed"
    // report so far has been a PATH problem rather than a missing build.
    const output = callHelper('echo "$PATH"');
    expect(output.split(':')).toContain(`${process.env['HOME']}/.local/bin`);
  });

  it('does not add it twice when sourced twice', () => {
    const output = callHelper(`source "${library}" >/dev/null 2>&1; echo "$PATH"`);
    const hits = output.split(':').filter((entry) => entry === `${process.env['HOME']}/.local/bin`);
    expect(hits).toHaveLength(1);
  });
});

describe('the doctor', () => {
  it('is valid bash and runs without changing anything', () => {
    expect(spawnSync('bash', ['-n', join(repoRoot, 'scripts', 'zero-doctor.sh')]).status).toBe(0);
    const result = spawnSync('bash', [join(repoRoot, 'scripts', 'zero-doctor.sh')], {
      encoding: 'utf8',
      cwd: repoRoot,
      timeout: 60_000,
    });
    const output = `${result.stdout}`;
    // Every line is a verdict with a remedy, not a stack trace.
    expect(output).toContain('ZERO DOCTOR');
    expect(output).toMatch(/PASS|WARN|FAIL/);
    // A diagnostic that starts things cannot be run while diagnosing.
    expect(output).not.toContain('starting');
  }, TIMEOUT);

  it('never reaches for a global process kill', () => {
    for (const name of ['zero-doctor.sh', 'zero-termux-one-shot.sh', 'zero-supervise.sh']) {
      const source = code(join(repoRoot, 'scripts', name));
      // `pkill node` on a phone takes down whatever else is running on it.
      expect(source).not.toMatch(/\b(pkill|killall)\b/);
      expect(source).not.toMatch(/kill\s+-9?\s*\$\(\s*pgrep/);
    }
  });
});

describe('the one-shot bootstrap', () => {
  const oneShot = join(repoRoot, 'scripts', 'zero-termux-one-shot.sh');

  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', oneShot]).status).toBe(0);
  });

  it('builds whisper with at most two jobs', () => {
    // A phone that compiles on every core throttles, and on 4 GB it runs out
    // of memory rather than finishing.
    const source = code(oneShot);
    expect(source).toContain('-j2');
    expect(source).not.toMatch(/-j\s*\$\(nproc\)|-j[4-9]|-j1[0-9]/);
  });

  it('stays inside Termux and never touches the system', () => {
    const source = code(oneShot);
    expect(source).not.toMatch(/\bsudo\b|\bsu -c\b|systemctl|launchctl/);
    expect(source).not.toMatch(/\b(pkill|killall)\b/);
    // Packages come from Termux's own manager, into Termux's own prefix.
    expect(source).toContain('pkg install -y');
  });

  it('refuses a model that is an error page or a truncated download', () => {
    const source = execFileSync('cat', [oneShot], { encoding: 'utf8' });
    expect(source).toContain('MIN_MODEL_BYTES');
    expect(source).toMatch(/<!doctype/i);
    // A half-downloaded model fails every voice turn with an error that says
    // nothing about the download. Deleting it is the only honest outcome.
    expect(source).toContain('rm -f "$MODEL_PATH"');
  });
});
