/** Types for the browser registry, which is plain Node ESM. */

export interface BrowserDefinition {
  engine: 'chromium' | 'firefox';
  channel: string | null;
  label: string;
  /** True when it drives the browser already installed on the machine. */
  usesInstalled: boolean;
  install?: string;
  note?: string;
}

export interface BrowserDescription {
  name: string;
  known: boolean;
  label?: string;
  engine?: 'chromium' | 'firefox';
  channel?: string | null;
  uses_installed?: boolean;
  executable?: string;
  found?: boolean;
  install?: string;
  note?: string;
  reason?: string;
}

export const BROWSERS: Record<string, BrowserDefinition>;
export const DEFAULT_BROWSER: string;

export function browserNames(): string[];
export function normaliseBrowserName(raw: string | null | undefined): string;
export function candidatePaths(
  name: string,
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
): string[];
export function describeBrowser(
  name: string,
  options?: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    exists?: (path: string) => boolean;
    executablePath?: string;
  },
): BrowserDescription;
export function launchOptionsFor(
  description: BrowserDescription,
  options?: { executablePath?: string },
): Record<string, unknown>;
