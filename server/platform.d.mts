/** Types for the platform probe, which is plain Node ESM so it needs no build step. */

export interface HostRuntime {
  /** termux | android | linux | macos | windows */
  name: string;
  termux: boolean;
  android: boolean;
  platform: string;
  arch: string;
  arm64: boolean;
  /** `$PREFIX` under Termux, empty everywhere else. */
  prefix: string;
  /** False on Android: no sudo, no systemd, no Docker. */
  hasPrivilegeEscalation: boolean;
}

export interface WorkspacePaths {
  workspace: string;
  /** False when the workspace still has to be created. */
  exists: boolean;
  hwdZero: string;
  brainInterface: string;
}

export interface WorkspaceLookup {
  env?: Record<string, string | undefined>;
  startDir?: string;
  home?: string;
  exists?: (path: string) => boolean;
}

export declare const WORKSPACE_MEMBERS: string[];
export declare const WORKSPACE_DIR_NAME: string;

export declare function detectRuntime(
  env?: Record<string, string | undefined>,
  platform?: string,
  arch?: string,
): HostRuntime;
export declare function loopbackHosts(env?: Record<string, string | undefined>): string[];
export declare function detectWorkspaceRoot(options?: WorkspaceLookup): string | null;
export declare function canonicalPaths(options?: WorkspaceLookup): WorkspacePaths;
