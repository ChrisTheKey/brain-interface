import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  canonicalPaths,
  detectRuntime,
  detectWorkspaceRoot,
  loopbackHosts,
} from '../server/platform.mjs';

const TERMUX_PREFIX = '/data/data/com.termux/files/usr';
const TERMUX_HOME = '/data/data/com.termux/files/home';

/** A fake filesystem: only the listed paths exist. */
function only(...paths: string[]) {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

describe('host detection', () => {
  it('recognises Termux on a Galaxy from $PREFIX alone', () => {
    const runtime = detectRuntime({ PREFIX: TERMUX_PREFIX }, 'android', 'arm64');
    expect(runtime.name).toBe('termux');
    expect(runtime.termux).toBe(true);
    expect(runtime.android).toBe(true);
    expect(runtime.arm64).toBe(true);
    expect(runtime.prefix).toBe(TERMUX_PREFIX);
  });

  it('recognises Termux from $TERMUX_VERSION when $PREFIX is not exported', () => {
    expect(detectRuntime({ TERMUX_VERSION: '0.118.0' }, 'android', 'arm64').termux).toBe(true);
  });

  it('reports that Android has no sudo, systemd or Docker to depend on', () => {
    expect(detectRuntime({ PREFIX: TERMUX_PREFIX }, 'android', 'arm64').hasPrivilegeEscalation)
      .toBe(false);
    expect(detectRuntime({}, 'linux', 'x64').hasPrivilegeEscalation).toBe(true);
  });

  it('leaves the desktop platforms untouched', () => {
    expect(detectRuntime({}, 'win32', 'x64').name).toBe('windows');
    expect(detectRuntime({}, 'darwin', 'arm64').name).toBe('macos');
    expect(detectRuntime({}, 'linux', 'x64').name).toBe('linux');
    expect(detectRuntime({}, 'win32', 'x64').termux).toBe(false);
  });
});

describe('loopback addresses', () => {
  it('covers both families so Android can resolve localhost either way', () => {
    // Android hands out ::1 before 127.0.0.1; an IPv4-only bind is the classic
    // "blank page on the phone that is running the server".
    expect(loopbackHosts({})).toEqual(['127.0.0.1', '::1']);
  });

  it('can be pinned to IPv4 on a device without IPv6 loopback', () => {
    expect(loopbackHosts({ ZERO_DISABLE_IPV6: 'true' })).toEqual(['127.0.0.1']);
  });

  it('never offers a non-loopback address', () => {
    for (const host of loopbackHosts({})) {
      expect(['127.0.0.1', '::1']).toContain(host);
    }
  });
});

describe('workspace detection', () => {
  const workspace = join(TERMUX_HOME, 'ZERO-WORKSPACE');
  const complete = only(join(workspace, 'HWD-ZERO'), join(workspace, 'brain-interface'));

  it('finds the workspace by walking up from this checkout', () => {
    expect(
      detectWorkspaceRoot({
        env: {},
        startDir: join(workspace, 'brain-interface'),
        home: TERMUX_HOME,
        exists: complete,
      }),
    ).toBe(workspace);
  });

  it('falls back to the canonical $HOME/ZERO-WORKSPACE', () => {
    expect(
      detectWorkspaceRoot({ env: {}, startDir: '/somewhere/else', home: TERMUX_HOME, exists: complete }),
    ).toBe(workspace);
  });

  it('honours an explicit ZERO_WORKSPACE', () => {
    const custom = '/storage/emulated/0/ZERO';
    expect(
      detectWorkspaceRoot({
        env: { ZERO_WORKSPACE: custom },
        startDir: '/somewhere/else',
        home: TERMUX_HOME,
        exists: only(join(custom, 'HWD-ZERO'), join(custom, 'brain-interface')),
      }),
    ).toBe(custom);
  });

  it('requires both repositories — a lone brain-interface is not a workspace', () => {
    expect(
      detectWorkspaceRoot({
        env: {},
        startDir: join(workspace, 'brain-interface'),
        home: TERMUX_HOME,
        exists: only(join(workspace, 'brain-interface')),
      }),
    ).toBeNull();
  });

  it('predicts the canonical paths before setup has created them', () => {
    const paths = canonicalPaths({
      env: {},
      startDir: '/somewhere/else',
      home: TERMUX_HOME,
      exists: () => false,
    });
    expect(paths.exists).toBe(false);
    expect(paths.workspace).toBe(workspace);
    expect(paths.hwdZero).toBe(join(workspace, 'HWD-ZERO'));
    expect(paths.brainInterface).toBe(join(workspace, 'brain-interface'));
    // No device-specific user name anywhere in the canonical layout.
    expect(paths.workspace.startsWith(TERMUX_HOME)).toBe(true);
  });
});
