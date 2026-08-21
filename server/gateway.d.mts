/** Types for the gateway, which is plain Node ESM so it needs no build step. */

export interface GatewayConfig {
  port: number;
  host: string;
  lanMode: boolean;
  /** HWD-ZERO's HTTP API on loopback. */
  zeroApi: string;
  /** ZERO's runtime WebSocket on loopback — a different port, so a separate value. */
  zeroRuntimeWs: string;
  distDir: string;
  tokenFile: string;
  rateLimit: number;
  /** Expose internal upstream addresses in the health payload. */
  diagnostics: boolean;
  healthTimeoutMs: number;
}

export interface NetworkInterfaceEntry {
  family: string | number;
  internal: boolean;
  address: string;
}

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

export interface WsRoute {
  target: string;
  path: string;
  upstream: 'zeroApi' | 'zeroRuntimeWs';
}

export interface GatewayHealthBody {
  gateway: 'healthy';
  zero: 'healthy' | 'offline';
  websocket: 'healthy' | 'offline';
  lanMode: boolean;
  authRequired: boolean;
  publicPaths: { api: string; ws: string; events: string };
  diagnostics?: {
    zeroApi: string;
    zeroRuntimeWs: string;
    zeroDetail: string;
    websocketDetail: string;
  };
}

export declare const DEFAULT_PORT: number;
export declare const DEFAULT_ZERO_API: string;
export declare const DEFAULT_ZERO_RUNTIME_WS: string;
export declare const PUBLIC_API_BASE: string;
export declare const PUBLIC_WS_PATH: string;
export declare const PUBLIC_EVENTS_WS_PATH: string;

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
export declare function resolveWsRoute(pathname: string, config: GatewayConfig): WsRoute | null;
export declare function upstreamAddress(target: string): {
  hostname: string;
  port: number;
  secure: boolean;
};
export declare function probeHttp(
  target: string,
  path: string,
  timeoutMs?: number,
): Promise<ProbeOutcome>;
export declare function probeSocket(target: string, timeoutMs?: number): Promise<ProbeOutcome>;
export declare function collectHealth(
  config: GatewayConfig,
  extra?: Record<string, unknown>,
): Promise<{ status: number; body: GatewayHealthBody }>;
export declare function startGateway(config?: GatewayConfig): import('node:http').Server;
