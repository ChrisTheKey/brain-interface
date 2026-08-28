/** Types for the browser bridge (plain Node ESM). */
import type { BrowserId, DetectedBrowser } from './detect.d.mts';
import type { PageContent } from './cdp.d.mts';

export { BlockedUrlError } from './guard.d.mts';

export interface BrowserBridgeConfig {
  preferred: string;
  headless: boolean;
  noSandbox: boolean;
  allowPrivate: boolean;
  idleTimeoutMs: number;
  navigationTimeoutMs: number;
  maxChars: number;
  searchEngine: string;
  env: Record<string, string | undefined>;
}

export interface ActiveBrowser {
  id: BrowserId;
  name: string;
  protocol: string;
  port: number;
  pid: number | null;
}

export interface BrowserBridgeStatus {
  browsers: DetectedBrowser[];
  preferred: string;
  headless: boolean;
  noSandbox: boolean;
  allowPrivate: boolean;
  searchEngine: string;
  active: ActiveBrowser | null;
}

export interface PageResult extends PageContent {
  requestedUrl?: string;
  browser: BrowserId;
}

export declare function readBrowserConfig(
  env?: Record<string, string | undefined>,
): BrowserBridgeConfig;

export declare class BrowserBridge {
  constructor(config?: BrowserBridgeConfig);
  readonly config: BrowserBridgeConfig;
  status(): BrowserBridgeStatus;
  launch(browserId?: string): Promise<ActiveBrowser | null>;
  open(
    url: string,
    options?: { browser?: string; maxChars?: number },
  ): Promise<PageResult>;
  read(options?: { maxChars?: number }): Promise<PageResult>;
  search(
    query: string,
    options?: { engine?: string; browser?: string; maxChars?: number },
  ): Promise<PageResult & { query: string; engine: string }>;
  close(): Promise<{ closed: boolean }>;
}
