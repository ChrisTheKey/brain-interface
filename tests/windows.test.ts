import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ZERO on Windows.
 *
 * The scripts are PowerShell, so the interesting half of this file only runs
 * where a PowerShell is available — `pwsh` on any platform, `powershell.exe`
 * on Windows, or whatever `ZERO_PWSH` points at. Those tests parse every
 * script with PowerShell's own parser and then *call* the library functions,
 * which is the only honest way to test shell: reading it and agreeing with
 * yourself is not a test.
 *
 * The static assertions run everywhere, because what they check is what must
 * never appear in these files at all: a global process kill, a permanent
 * execution-policy change, a firewall edit, a `git reset --hard`. Those are
 * about intent, and intent is legible in the source.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = join(repoRoot, 'scripts');
const TIMEOUT = 120_000;

const WINDOWS_SCRIPTS = [
  'lib-zero.ps1',
  'zero-windows-one-shot.ps1',
  'zero-windows-start.ps1',
  'zero-windows-stop.ps1',
  'zero-windows-status.ps1',
  'zero-windows-doctor.ps1',
  'zero-windows-supervise.ps1',
];

/** A PowerShell to drive the tests with, if this machine has one. */
function findPowerShell(): string | null {
  const candidates = [process.env['ZERO_PWSH'], 'pwsh', 'powershell'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && Number(probe.stdout.trim()) >= 5) return candidate;
  }
  return null;
}

const powershell = findPowerShell();
const withPowerShell = powershell ? describe : describe.skip;

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

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Run a snippet with the library dot-sourced, and read back what it emitted.
 *
 * The snippet writes JSON to stdout; anything else it prints is ignored, so a
 * stray warning from a cmdlet does not fail the parse.
 */
function runPwsh(body: string, env: Record<string, string> = {}): unknown {
  const file = join(scratch('zero-ps-'), 'probe.ps1');
  writeFileSync(
    file,
    [
      `. "${join(scriptsDir, 'lib-zero.ps1').replace(/\\/g, '\\\\')}"`,
      '$ErrorActionPreference = "Continue"',
      'function Emit { param($Value) Write-Output ("<<<" + ($Value | ConvertTo-Json -Depth 6 -Compress) + ">>>") }',
      body,
    ].join('\n'),
  );
  const result = spawnSync(powershell!, ['-NoProfile', '-File', file], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: TIMEOUT,
    env: { ...process.env, ...env },
  });
  const match = /<<<([\s\S]*?)>>>/.exec(result.stdout ?? '');
  if (!match) {
    throw new Error(`no output from PowerShell.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return JSON.parse(match[1]!);
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

/** A server that answers /api/health with the identity it is given. */
function serveHealth(port: number, body: Record<string, unknown>): ChildProcess {
  const dir = scratch('zero-health-');
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
  });
  return child;
}

async function waitForHealth(port: number, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

/**
 * Executable lines only.
 *
 * Comments are where these scripts explain what they deliberately do *not*
 * do - "no taskkill", "never reset --hard" - so scanning the raw file for
 * those words would fail on the very sentences promising them.
 */
function code(name: string): string {
  return readFileSync(join(scriptsDir, name), 'utf8')
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

// ------------------------------------------------------------------ presence

describe('windows support ships as its own scripts', () => {
  it('has every script the ThinkPad needs', () => {
    const present = readdirSync(scriptsDir);
    for (const name of WINDOWS_SCRIPTS) expect(present).toContain(name);
  });

  it('leaves the Termux and Linux scripts alone', () => {
    // Windows is an addition, never a replacement. The phone still starts the
    // same way it did before any of this existed.
    const present = readdirSync(scriptsDir);
    for (const name of [
      'lib-zero.sh',
      'zero-termux-one-shot.sh',
      'start-zero-termux.sh',
      'zero-doctor.sh',
      'zero-supervise.sh',
      'zero-go.sh',
      'stop-zero.sh',
    ]) {
      expect(present).toContain(name);
    }
  });

  it('is not a second ZERO runtime', () => {
    // HWD-ZERO stays canonical. These scripts start it; they never replace it.
    const oneShot = code('zero-windows-one-shot.ps1');
    const start = code('zero-windows-start.ps1');
    expect(start).toContain('zero.server');
    for (const source of [oneShot, start]) {
      expect(source).not.toMatch(/fastapi|uvicorn|flask|express\(/i);
    }
  });
});

// -------------------------------------------------------------- what is banned

describe('what these scripts may never do', () => {
  it('never kills by name, and never kills globally', () => {
    // `taskkill /F /IM python.exe` on a development laptop takes down whatever
    // else is running: a build, a language server, someone's notebook.
    for (const name of WINDOWS_SCRIPTS) {
      const source = code(name);
      expect(source, name).not.toMatch(/taskkill/i);
      expect(source, name).not.toMatch(/Stop-Process\s+(-Name|-ProcessName)/i);
      expect(source, name).not.toMatch(/Get-Process\s+-Name\s+\w+\s*\|\s*Stop-Process/i);
      expect(source, name).not.toMatch(/\b(pkill|killall)\b/);
    }
  });

  it('never changes Windows itself', () => {
    for (const name of WINDOWS_SCRIPTS) {
      const source = code(name);
      // Execution policy is set per invocation by the caller, never globally.
      expect(source, name).not.toMatch(/Set-ExecutionPolicy/i);
      expect(source, name).not.toMatch(/netsh\s+advfirewall|New-NetFirewallRule|Set-NetFirewallProfile/i);
      expect(source, name).not.toMatch(/Set-MpPreference|Add-MpPreference|DisableRealtimeMonitoring/i);
      expect(source, name).not.toMatch(/Set-ItemProperty\s+-Path\s+["']?HK(LM|CU):/i);
      expect(source, name).not.toMatch(/ConsentPromptBehaviorAdmin|EnableLUA/i);
      expect(source, name).not.toMatch(/Start-Process\s+.*-Verb\s+RunAs/i);
    }
  });

  it('never discards the operator\'s uncommitted work', () => {
    // A bootstrap that resets a working tree to save a fetch has made a trade
    // nobody asked it to make.
    const source = code('zero-windows-one-shot.ps1');
    expect(source).not.toMatch(/reset\s+--hard/);
    expect(source).not.toMatch(/clean\s+-[a-z]*f/);
    expect(source).not.toMatch(/checkout\s+--force|checkout\s+-f\b/);
    // Fast-forward only, and the dirty case is detected before any pull.
    expect(source).toContain('--ff-only');
    expect(source).toContain('status --porcelain');
  });

  it('binds loopback, and reaches the LAN only when asked', () => {
    for (const name of WINDOWS_SCRIPTS) {
      expect(code(name), name).not.toContain('0.0.0.0');
    }
    expect(code('zero-windows-start.ps1')).toContain('$Lan');
  });

  it('builds whisper conservatively', () => {
    // A laptop that compiles on every core throttles, and on a small machine
    // runs out of memory instead of finishing.
    const source = code('zero-windows-one-shot.ps1');
    expect(source).toContain('-j 2');
    expect(source).not.toMatch(/-j\s*\$\(nproc\)|-j\s*[4-9]\b|-j\s*1[0-9]\b/);
  });

  it('installs in user scope and never bypasses a prompt', () => {
    const source = code('zero-windows-one-shot.ps1');
    expect(source).toContain('--scope user');
    expect(source).not.toMatch(/-Verb\s+RunAs/i);
  });

  it('logs where the rest of ZERO logs, and never logs audio', () => {
    const library = code('lib-zero.ps1');
    expect(library).toContain('gateway.log');
    expect(library).toContain('hwd-zero.log');
    expect(library).toContain('voice.log');
    expect(library).toContain('supervisor.log');
    for (const name of WINDOWS_SCRIPTS) {
      // Nothing here should be reading a transcript, let alone writing one.
      expect(code(name), name).not.toMatch(/transcript.*Add-Content|Add-Content.*transcript/i);
    }
  });
});

// ---------------------------------------------------------------- the parser

withPowerShell('powershell validates its own scripts', () => {
  it('parses every script without a single error', () => {
    // PowerShell's own parser, not a regex: unbalanced quotes and misplaced
    // braces in shell are exactly the class of bug that only shows up on the
    // machine that cannot afford it.
    for (const name of WINDOWS_SCRIPTS) {
      const result = spawnSync(
        powershell!,
        [
          '-NoProfile',
          '-Command',
          `$e=$null;$t=$null;` +
            `[System.Management.Automation.Language.Parser]::ParseFile("${join(scriptsDir, name).replace(/\\/g, '\\\\')}",[ref]$t,[ref]$e)|Out-Null;` +
            `if($e){$e|ForEach-Object{"{0}: {1}" -f $_.Extent.StartLineNumber,$_.Message}}`,
        ],
        { encoding: 'utf8', timeout: TIMEOUT },
      );
      expect(`${name}: ${result.stdout.trim()}`).toBe(`${name}: `);
    }
  }, TIMEOUT);

  it('declares only parameters PowerShell 5.1 understands', () => {
    // The ThinkPad ships with 5.1. `??`, `?.` and ternaries are 7+ and would
    // fail to parse there, which is the one failure mode a bootstrap cannot
    // recover from.
    for (const name of WINDOWS_SCRIPTS) {
      const source = code(name);
      expect(source, name).not.toMatch(/\?\?[=]?\s/);
      expect(source, name).not.toMatch(/\$\w+\?\./);
      expect(source, name).not.toMatch(/-AsHashtable|-SkipHttpErrorCheck/);
    }
  });
});

// --------------------------------------------------------------- pure logic

withPowerShell('paths and the workspace', () => {
  it('finds the workspace from where the scripts are, not from a username', () => {
    const result = runPwsh('Emit (Get-ZeroPaths)') as Record<string, string>;
    expect(result['Root']).toBeTruthy();
    expect(result['Workspace']).toBeTruthy();
    expect(result['GatewayPid']).toContain('gateway.pid');
    expect(result['VoiceLog']).toContain('voice.log');
    // No username is ever written down; every path is derived.
    for (const name of WINDOWS_SCRIPTS) {
      expect(code(name), name).not.toMatch(/C:\\Users\\[A-Za-z]/);
    }
  });

  it('honours ZERO_WORKSPACE and ZERO_RUNTIME_DIR', () => {
    const workspace = scratch('zero-ws-');
    const result = runPwsh('Emit (Get-ZeroPaths)', {
      ZERO_WORKSPACE: workspace,
      ZERO_RUNTIME_DIR: join(workspace, 'elsewhere'),
    }) as Record<string, string>;
    expect(result['Workspace']).toBe(workspace);
    expect(result['RuntimeDir']).toBe(join(workspace, 'elsewhere'));
  });

  it('finds HWD-ZERO next to brain-interface under any of its names', () => {
    const workspace = scratch('zero-ws-');
    mkdirSync(join(workspace, 'hwd-zero', 'zero'), { recursive: true });
    const result = runPwsh('Emit (Resolve-ZeroRuntimeDir)', { ZERO_WORKSPACE: workspace }) as string;
    expect(result).toBe(join(workspace, 'hwd-zero'));
  });

  it('names the canonical location when there is no checkout to find', () => {
    const workspace = scratch('zero-ws-');
    const result = runPwsh('Emit (Resolve-ZeroRuntimeDir)', { ZERO_WORKSPACE: workspace }) as string;
    // An actionable answer beats an empty one: this is the path to clone into.
    expect(result).toBe(join(workspace, 'HWD-ZERO'));
  });

  it('quotes arguments with spaces, which Windows paths always have', () => {
    // Start-Process joins an array with spaces and quotes nothing. One
    // unquoted argument is how the supervisor was once handed `python` as its
    // entire start command, with the rest silently discarded.
    const result = runPwsh(
      `Emit (ConvertTo-ZeroArgumentList -ArgumentList @('-File','C:\\Program Files\\ZERO\\s.ps1','-Cmd','py -m zero.server','--quiet'))`,
    ) as string[];
    expect(result).toEqual([
      '-File',
      '"C:\\Program Files\\ZERO\\s.ps1"',
      '-Cmd',
      '"py -m zero.server"',
      '--quiet',
    ]);
  });
});

withPowerShell('port discovery', () => {
  it('reads the listening pid out of netstat, which every Windows has', () => {
    // Get-NetTCPConnection is preferred and this is the fallback: the module
    // can be absent or blocked, and netstat never is.
    const lines = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4242',
      '  TCP    [::1]:8000             [::]:0                 LISTENING       4242',
      '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       777',
      '  TCP    127.0.0.1:58000        127.0.0.1:8000         ESTABLISHED     999',
      '  UDP    0.0.0.0:8000           *:*                                    123',
    ];
    // Joined rather than compared as an array: ConvertTo-Json unwraps a
    // single-element array, so a string is the unambiguous form here.
    const body = `$lines = @(${lines.map((line) => `'${line}'`).join(',')})`;
    const pidsOn = (port: number) =>
      runPwsh(`${body}; Emit ((@(ConvertFrom-ZeroNetstat -Lines $lines -Port ${port})) -join ',')`);
    expect(pidsOn(8000)).toBe('4242');
    expect(pidsOn(3000)).toBe('777');
    // An established connection to 8000 is not a listener on it, and UDP is
    // not TCP. Counting either would name the wrong process.
    expect(pidsOn(9999)).toBe('');
  });

  it('knows whether a port is actually accepting connections', async () => {
    const port = freePort();
    serveHealth(port, { status: 'ok' });
    expect(await waitForHealth(port)).toBe(true);
    expect(runPwsh(`Emit (Test-ZeroPortBusy -Port ${port})`)).toBe(true);
    expect(runPwsh(`Emit (Test-ZeroPortBusy -Port ${freePort()})`)).toBe(false);
  }, TIMEOUT);
});

withPowerShell('identity, and the single instance it protects', () => {
  it('adopts an HWD-ZERO and refuses to adopt anything else', async () => {
    const ours = freePort();
    const theirs = freePort();
    const zero = serveHealth(ours, {
      status: 'ok',
      service: 'HWD-ZERO',
      runtime: 'ZeroSession',
      version: '9.9.9',
      started_at: '2026-01-01T00:00:00Z',
      runtime_ready: true,
    });
    serveHealth(theirs, { status: 'ok', service: 'something-else' });
    expect(await waitForHealth(ours)).toBe(true);
    expect(await waitForHealth(theirs)).toBe(true);

    const found = runPwsh(`Emit (Get-ZeroServiceOnPort -Port ${ours})`) as Record<string, unknown>;
    expect(found['Service']).toBe('HWD-ZERO');
    expect(found['ProcessId']).toBe(zero.pid);
    expect(found['Version']).toBe('9.9.9');
    // Answering /api/health is not the same as being ZERO. Treating it as such
    // is how a stranger on port 8000 looked like a healthy backend.
    expect(runPwsh(`Emit ($null -ne (Get-ZeroServiceOnPort -Port ${theirs}))`)).toBe(false);
  }, TIMEOUT);

  it('treats any HTTP status as an answer, including 503', async () => {
    // The gateway answers 503 precisely when it is healthy and the backend is
    // not. A helper that calls that "down" makes a start script kill a working
    // gateway - which is exactly what once happened.
    const port = freePort();
    const dir = scratch('zero-503-');
    const file = join(dir, 'server.cjs');
    writeFileSync(
      file,
      [
        'const http = require("http");',
        'http.createServer((_q, r) => {',
        '  r.writeHead(503, { "content-type": "application/json" });',
        '  r.end(JSON.stringify({ gateway: "healthy", zero: "offline" }));',
        `}).listen(${port}, "127.0.0.1");`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, [file], { detached: true, stdio: 'ignore' });
    cleanups.push(() => {
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`);
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 150));
      }
    }
    expect(runPwsh(`Emit (Test-ZeroHttp -Url 'http://127.0.0.1:${port}/api/health')`)).toBe(true);
    expect(
      runPwsh(`Emit (Get-ZeroHealthField -Url 'http://127.0.0.1:${port}/api/health' -Field 'gateway')`),
    ).toBe('healthy');
  }, TIMEOUT);
});

withPowerShell('pid files, and what may be stopped', () => {
  it('reads a live pid and ignores a dead one', () => {
    const dir = scratch('zero-pid-');
    const live = join(dir, 'live.pid');
    const dead = join(dir, 'dead.pid');
    const junk = join(dir, 'junk.pid');
    writeFileSync(live, `${process.pid}\n`);
    writeFileSync(dead, '999999\n');
    writeFileSync(junk, 'not-a-pid\n');
    expect(runPwsh(`Emit (Get-ZeroLivePid -Path '${live}')`)).toBe(process.pid);
    expect(runPwsh(`Emit (Get-ZeroLivePid -Path '${dead}')`)).toBe(null);
    expect(runPwsh(`Emit (Get-ZeroLivePid -Path '${junk}')`)).toBe(null);
    expect(runPwsh(`Emit (Get-ZeroLivePid -Path '${join(dir, 'absent.pid')}')`)).toBe(null);
  });

  it('removes a stale pid file and leaves a live one alone', () => {
    const dir = scratch('zero-pid-');
    const live = join(dir, 'live.pid');
    const dead = join(dir, 'dead.pid');
    writeFileSync(live, `${process.pid}\n`);
    writeFileSync(dead, '999999\n');
    // A stale file must never look like a running service, and must never
    // cause a kill of whatever recycled that pid in the meantime.
    expect(runPwsh(`Emit @((Clear-ZeroStalePid -Path '${dead}'), (Test-Path '${dead}'))`)).toEqual([
      true,
      false,
    ]);
    expect(runPwsh(`Emit @((Clear-ZeroStalePid -Path '${live}'), (Test-Path '${live}'))`)).toEqual([
      false,
      true,
    ]);
  });

  it('refuses a pid that is not one of ours', () => {
    // Windows recycles pids. The process wearing one now may be something the
    // operator cares about, so ownership is proved before anything is stopped.
    expect(runPwsh(`Emit (Test-ZeroOwnedProcess -ProcessId 0 -Kind 'gateway')`)).toBe(false);
    expect(runPwsh(`Emit (Test-ZeroOwnedProcess -ProcessId 999999 -Kind 'gateway')`)).toBe(false);
    // node is the gateway's executable; this test runner is not the gateway.
    expect(runPwsh(`Emit (Test-ZeroOwnedProcess -ProcessId ${process.pid} -Kind 'hwd-zero')`)).toBe(false);
  });

  it('leaves a recycled pid alone rather than stopping it', () => {
    const dir = scratch('zero-pid-');
    const file = join(dir, 'hwd-zero.pid');
    // This test process is alive and is emphatically not HWD-ZERO.
    writeFileSync(file, `${process.pid}\n`);
    const result = runPwsh(
      `Emit (Stop-ZeroTracked -PidFile '${file}' -Name 'hwd-zero' -Kind 'hwd-zero')`,
    ) as Record<string, unknown>;
    expect(result['Stopped']).toBe(false);
    expect(result['Reason']).toBe('foreign');
    // Still running: nothing was killed.
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('reports a stale pid file as stale rather than as a stop', () => {
    const dir = scratch('zero-pid-');
    const file = join(dir, 'gateway.pid');
    writeFileSync(file, '999999\n');
    const result = runPwsh(
      `Emit (Stop-ZeroTracked -PidFile '${file}' -Name 'gateway' -Kind 'gateway')`,
    ) as Record<string, unknown>;
    expect(result['Reason']).toBe('stale');
  });
});

withPowerShell('whisper on Windows', () => {
  it('looks where a Windows build actually puts the binary', () => {
    const joined = runPwsh(
      `Emit ((Get-ZeroWhisperCandidates -HomeDir 'C:\\Users\\Someone') -join '|')`,
    ) as string;
    // A CMake build lands in build\bin\Release; Ninja and MinGW land in
    // build\bin. Both are normal, so both are looked at.
    expect(joined).toContain('whisper.cpp\\build\\bin\\Release\\whisper-cli.exe');
    expect(joined).toContain('whisper.cpp\\build\\bin\\whisper-cli.exe');
    expect(joined).toContain('.local\\bin\\whisper-cli.exe');
  });

  it('takes ZERO_WHISPER_BIN over anything it might find', () => {
    const dir = scratch('zero-whisper-');
    const binary = join(dir, 'whisper-cli');
    writeFileSync(binary, '#!/bin/sh\necho "usage: whisper-cli"\n', { mode: 0o755 });
    expect(runPwsh('Emit (Get-ZeroWhisperBinary)', { ZERO_WHISPER_BIN: binary })).toBe(binary);
  });

  it('proves the binary runs instead of trusting that it exists', () => {
    const dir = scratch('zero-whisper-');
    const real = join(dir, 'whisper-cli');
    const broken = join(dir, 'not-whisper');
    writeFileSync(real, '#!/bin/sh\necho "usage: whisper-cli [options] file"\nexit 1\n', { mode: 0o755 });
    // Runs, says nothing, is not whisper: a build for the wrong architecture
    // looks exactly like this and fails the moment audio arrives.
    writeFileSync(broken, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const good = runPwsh(`Emit (Test-ZeroWhisperBinary -Path '${real}')`) as Record<string, unknown>;
    const bad = runPwsh(`Emit (Test-ZeroWhisperBinary -Path '${broken}')`) as Record<string, unknown>;
    expect(good['Ok']).toBe(true);
    expect(bad['Ok']).toBe(false);
    expect(runPwsh(`Emit (Test-ZeroWhisperBinary -Path '${join(dir, 'absent')}').Ok`)).toBe(false);
  }, TIMEOUT);

  it('refuses a model that is truncated or an error page', () => {
    const dir = scratch('zero-model-');
    const good = join(dir, 'ggml-tiny.bin');
    const small = join(dir, 'small.bin');
    const page = join(dir, 'page.bin');
    writeFileSync(good, Buffer.alloc(25_000_000, 1));
    writeFileSync(small, Buffer.alloc(4096, 1));
    writeFileSync(page, Buffer.concat([Buffer.from('<!DOCTYPE html><html>Not Found</html>'), Buffer.alloc(25_000_000, 1)]));

    expect((runPwsh(`Emit (Test-ZeroWhisperModel -Path '${good}')`) as Record<string, unknown>)['Ok']).toBe(true);
    // Both of these arrive with a success exit code, and both then fail every
    // voice turn with an error that says nothing about the download.
    expect((runPwsh(`Emit (Test-ZeroWhisperModel -Path '${small}')`) as Record<string, unknown>)['Reason']).toBe(
      'truncated',
    );
    expect((runPwsh(`Emit (Test-ZeroWhisperModel -Path '${page}')`) as Record<string, unknown>)['Reason']).toBe(
      'html',
    );
    expect((runPwsh(`Emit (Test-ZeroWhisperModel -Path '${join(dir, 'nope.bin')}')`) as Record<string, unknown>)['Reason']).toBe(
      'missing',
    );
  }, TIMEOUT);
});

withPowerShell('the supervisor', () => {
  it('backs off, and the backoff stays bounded', () => {
    const steps = runPwsh('Emit @(1..8 | ForEach-Object { Get-ZeroBackoffSeconds -Attempt $_ })');
    expect(steps).toEqual([1, 2, 5, 10, 15, 15, 15, 15]);
  });

  it('adopts an existing runtime rather than starting a second', () => {
    const source = code('zero-windows-supervise.ps1');
    expect(source).toContain('Get-ZeroServiceOnPort');
    expect(source).toContain('Get-ZeroBackoffSeconds');
    // The gateway is the anchor: a supervisor that outlived ZERO would keep
    // respawning a backend nobody is talking to.
    expect(source).toContain('GatewayPid');
  });

  it('takes its start command from a file, never from a quoted argument', () => {
    // The command contains spaces and, on Windows, paths with spaces. One lost
    // quote turned it into `python` with no error anywhere.
    expect(code('zero-windows-supervise.ps1')).toContain('supervise.cmd');
    expect(code('zero-windows-start.ps1')).toContain('supervise.cmd');
  });
});

withPowerShell('the doctor', () => {
  it('runs, reports verdicts, and changes nothing', () => {
    const before = readdirSync(scriptsDir).sort();
    const result = spawnSync(powershell!, ['-NoProfile', '-File', join(scriptsDir, 'zero-windows-doctor.ps1')], {
      encoding: 'utf8',
      cwd: repoRoot,
      timeout: TIMEOUT,
      env: { ...process.env, ZERO_UI_PORT: String(freePort()), ZERO_API_URL: `http://127.0.0.1:${freePort()}` },
    });
    const output = `${result.stdout}`;
    expect(output).toContain('ZERO DOCTOR');
    expect(output).toMatch(/PASS|WARN|FAIL/);
    // A diagnostic that starts things cannot be run while diagnosing.
    expect(output).not.toMatch(/gateway started|hwd-zero started/);
    expect(readdirSync(scriptsDir).sort()).toEqual(before);
    // Nothing serving means FAIL, and FAIL means a non-zero exit.
    expect(result.status).toBe(1);
  }, TIMEOUT);

  it('says plainly that it cannot test the microphone', () => {
    // It is the one thing PowerShell genuinely cannot answer, and an INFO is
    // the honest form of that - not a PASS, and not a FAIL either.
    const source = code('zero-windows-doctor.ps1');
    expect(source).toMatch(/browser microphone support cannot be tested from PowerShell/);
    expect(source).toMatch(/Info 'browser microphone/);
  });
});
