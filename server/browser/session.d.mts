/** Types for the browser session, which is plain Node ESM. */

export interface BrowserConfig {
  enabled: boolean;
  localOnly: boolean;
  /** Root of ZERO's own profiles; each browser gets a directory beneath it. */
  profileRoot: string;
  /** Which browser: chrome, edge, brave, firefox or chromium. */
  browser: string;
  executablePath: string;
  headless: boolean;
  idleMs: number;
  navTimeoutMs: number;
  /** Where to ask whether an address may be read. */
  guardUrl: string;
  maxChars: number;
  proxy: string;
}

export interface BrowserStatus {
  provider: string;
  browser: string;
  label: string;
  /** `chromium` or `firefox` — the one thing no setting can change. */
  engine: string;
  channel: string | null;
  /** True when it drives the browser already on the machine. */
  uses_installed: boolean;
  install: string;
  note: string;
  playwright: boolean;
  found: boolean;
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  running: boolean;
  headless: boolean;
  /** "configured" or "none" — never the address, which can carry credentials. */
  proxy: string;
  profile: string;
  own_profile: boolean;
  pages_opened: number;
  idle_ms: number;
}

export interface OpenedPage {
  url: string;
  final_url: string;
  status: number;
  title: string;
  text: string;
  truncated: boolean;
  chars: number;
}

export const BROWSER_ERRORS: {
  UNAVAILABLE: string;
  UNKNOWN: string;
  NOT_INSTALLED: string;
  DISABLED: string;
  LOCAL_ONLY: string;
  LAUNCH_FAILED: string;
  REFUSED: string;
  GUARD_UNREACHABLE: string;
  TIMEOUT: string;
  NAVIGATION: string;
};

export function loadBrowserConfig(
  env?: Record<string, string | undefined>,
  root?: string,
): BrowserConfig;

export function browserUnavailableReason(config: BrowserConfig): string | null;

/** Ask HWD-ZERO whether this address may be read. Fails closed. */
export function assertAllowed(
  url: string,
  config: BrowserConfig,
  fetchImpl?: typeof fetch,
): Promise<boolean>;

export interface SessionOptions {
  playwright?: unknown;
  fetchImpl?: typeof fetch;
  browser?: string;
}

export class BrowserSession {
  constructor(config: BrowserConfig, options?: SessionOptions);
  readonly running: boolean;
  readonly browserName: string;
  readonly profileDir: string;
  readonly idleMs: number;
  status(): Promise<BrowserStatus>;
  open(url: string): Promise<OpenedPage>;
  close(): Promise<boolean>;
}

export interface PoolStatus {
  default: string;
  browsers: BrowserStatus[];
  running: string[];
}

/** One session per browser, launched on demand and closed when idle. */
export class BrowserPool {
  constructor(config: BrowserConfig, options?: SessionOptions);
  session(name?: string): BrowserSession;
  status(): Promise<PoolStatus>;
  open(url: string, name?: string): Promise<OpenedPage>;
  close(name?: string): Promise<string[]>;
}
