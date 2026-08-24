/** Types for the gateway, which is plain Node ESM so it needs no build step. */

import type { HostRuntime } from './platform.mjs';

export interface GatewayConfig {
  port: number;
  /** The first address bound; `0.0.0.0` only in LAN mode. */
  host: string;
  /** Further addresses bound to the same port (the IPv6 loopback). */
  extraHosts: string[];
  lanMode: boolean;
  runtime: HostRuntime;
  zeroApi: string;
  distDir: string;
  tokenFile: string;
  rateLimit: number;
}

export interface NetworkInterfaceEntry {
  family: string | number;
  internal: boolean;
  address: string;
}

export declare const DEFAULT_PORT: number;
export declare const DEFAULT_ZERO_API: string;

export declare function readConfig(env?: Record<string, string | undefined>): GatewayConfig;
export declare function loadOrCreateToken(tokenFile: string): string;
export declare function constantTimeEquals(a: string, b: string): boolean;
export declare function detectLanAddress(
  interfaces?: Record<string, NetworkInterfaceEntry[] | undefined>,
): string | null;
export declare function extractToken(
  req: { headers: Record<string, string | string[] | undefined> },
  url: URL | null,
): string | null;
export declare function createRateLimiter(
  limitPerMinute: number,
  now?: () => number,
): (key: string) => boolean;
export declare function resolveStaticPath(distDir: string, urlPath: string): string | null;
export declare function wantsHtml(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean;
export declare function bootPage(config: GatewayConfig): string;
export declare function startGateway(config?: GatewayConfig): import('node:http').Server;
