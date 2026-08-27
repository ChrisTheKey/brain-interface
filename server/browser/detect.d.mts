/** Types for browser detection (plain Node ESM, no build step). */

export type BrowserId = 'chrome' | 'firefox' | 'brave' | 'edge';
export type BrowserFamily = 'chromium' | 'gecko';

export interface BrowserDefinition {
  id: BrowserId;
  name: string;
  family: BrowserFamily;
  candidates: Record<string, string[]>;
  onPath: string[];
}

export interface DetectedBrowser {
  id: BrowserId;
  name: string;
  family: BrowserFamily;
  protocol: 'cdp' | 'webdriver-bidi';
  installed: boolean;
  executable: string | null;
  /** True when the path came from a `ZERO_BROWSER_<ID>_PATH` override. */
  pinned?: boolean;
}

export interface DetectOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
  resolveOnPath?: (command: string) => string | null;
}

export interface LaunchOptions {
  port: number;
  profileDir: string;
  headless?: boolean;
  noSandbox?: boolean;
}

export declare const BROWSERS: BrowserDefinition[];
export declare const BROWSER_IDS: BrowserId[];

export declare function resolveOnPath(
  command: string,
  env?: Record<string, string | undefined>,
  platform?: string,
): string | null;
export declare function detectBrowsers(options?: DetectOptions): DetectedBrowser[];
export declare function findFreePort(): Promise<number>;
export declare function profileDirectory(browserId: string, root?: string): string;
export declare function launchArguments(
  browser: BrowserDefinition,
  options: LaunchOptions,
): string[];
