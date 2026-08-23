/** Types for the browser session, which is plain Node ESM. */

export interface BrowserConfig {
  enabled: boolean;
  localOnly: boolean;
  /** ZERO's own profile directory. Never the operator's. */
  profileDir: string;
  channel: string;
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
  installed: boolean;
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  running: boolean;
  channel: string;
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

export class BrowserSession {
  constructor(config: BrowserConfig, options?: { playwright?: unknown; fetchImpl?: typeof fetch });
  readonly running: boolean;
  readonly idleMs: number;
  status(): Promise<BrowserStatus>;
  open(url: string): Promise<OpenedPage>;
  close(): Promise<boolean>;
}
