/** Types for the gateway, which is plain Node ESM so it needs no build step. */

export interface GatewayConfig {
  port: number;
  host: string;
  lanMode: boolean;
  zeroApi: string;
  distDir: string;
  tokenFile: string;
  rateLimit: number;
  upstreamTimeoutMs: number;
}

export interface NetworkInterfaceEntry {
  family: string | number;
  internal: boolean;
  address: string;
}

export interface UpstreamStatus {
  reachable: boolean;
  checkedAt: number;
  error?: string;
}

export declare const DEFAULT_PORT: number;
export declare const DEFAULT_ZERO_API: string;
export declare const WS_PATHS: string[];

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
export declare function isWebSocketPath(pathname: string): boolean;
export declare function isTermux(env?: Record<string, string | undefined>): boolean;
export declare function createUpstreamProbe(
  target: string,
  timeoutMs: number,
  now?: () => number,
): () => Promise<UpstreamStatus>;
export declare function startGateway(config?: GatewayConfig): import('node:http').Server;
