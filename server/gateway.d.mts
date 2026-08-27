/** Types for the gateway, which is plain Node ESM so it needs no build step. */
import type { BrowserBridge, BrowserBridgeConfig } from './browser/bridge.d.mts';
import type { FishConfig } from './fishAudio.d.mts';

export interface GatewayConfig {
  port: number;
  host: string;
  lanMode: boolean;
  zeroApi: string;
  distDir: string;
  tokenFile: string;
  rateLimit: number;
  /** Fish Audio, which the gateway proxies so the key stays out of the bundle. */
  fish: FishConfig;
  /** The browser bridge — ZERO's internet access. */
  browser: BrowserBridgeConfig;
  /** Largest JSON body the gateway's own endpoints accept. */
  maxBodyBytes: number;
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

export declare class HttpError extends Error {
  constructor(message: string, status?: number);
  readonly status: number;
}

export declare function readJsonBody(
  req: import('node:http').IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>>;

/** The server also carries the browser bridge it owns, so it can be closed. */
export declare function startGateway(
  config?: GatewayConfig,
): import('node:http').Server & { browserBridge: BrowserBridge };
