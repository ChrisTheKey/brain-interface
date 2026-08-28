/** Types for the browser bridge's URL policy (plain Node ESM). */

export declare class BlockedUrlError extends Error {
  constructor(message: string, url: string);
  readonly url: string;
}

export interface NavigableOptions {
  allowPrivate?: boolean;
  /** Injectable resolver so the policy is testable without DNS. */
  resolve?: (hostname: string) => Promise<{ address: string }[] | { address: string }>;
}

export declare function isPrivateAddress(address: string): boolean;
export declare function assertNavigable(
  rawUrl: string,
  options?: NavigableOptions,
): Promise<URL>;

export declare const SEARCH_ENGINES: Record<string, (query: string) => string>;
export declare function searchUrl(query: string, engine?: string): string;
