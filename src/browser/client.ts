/**
 * Client for the browser bridge on the gateway.
 *
 *   interface  ──▶  /api/browser/*  ──▶  Chrome | Firefox | Brave | Edge
 *
 * Same origin, no credential: the gateway that served this bundle is the one
 * that owns the browser. The interface uses this to *show* what ZERO's
 * internet access actually is — which browsers exist on the machine, which one
 * is running — and to let the operator open or close it by hand. ZERO itself
 * does not go through here; it reaches the same bridge over MCP.
 */

export type BrowserId = 'chrome' | 'firefox' | 'brave' | 'edge';

export interface DetectedBrowser {
  id: BrowserId;
  name: string;
  family: 'chromium' | 'gecko';
  protocol: 'cdp' | 'webdriver-bidi';
  installed: boolean;
  executable: string | null;
  /** True when the path came from a `ZERO_BROWSER_<ID>_PATH` override. */
  pinned?: boolean;
}

export interface ActiveBrowser {
  id: BrowserId;
  name: string;
  protocol: string;
  port: number;
  pid: number | null;
}

export interface BrowserStatus {
  browsers: DetectedBrowser[];
  preferred: string;
  headless: boolean;
  noSandbox: boolean;
  allowPrivate: boolean;
  searchEngine: string;
  active: ActiveBrowser | null;
}

export interface PageResult {
  url: string;
  requestedUrl?: string;
  title: string;
  description: string;
  text: string;
  truncated: boolean;
  characters: number;
  links: { text: string; href: string }[];
  browser: BrowserId;
}

/** What the gateway can do beyond proxying, reported by its health probe. */
export interface GatewayFeatures {
  fishAudio: boolean;
  browser: BrowserId[];
  /** The exact command ZERO needs for the browser MCP server. */
  browserMcp?: { command: string; args: string[] };
}

export interface GatewayHealth {
  gateway: string;
  lanMode: boolean;
  zeroApi: string;
  authRequired: boolean;
  features?: GatewayFeatures;
}

export class BrowserBridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BrowserBridgeError';
  }
}

export interface BrowserClientOptions {
  /** Gateway endpoint; same-origin `/api/browser` by default. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export class BrowserBridgeClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BrowserClientOptions = {}) {
    this.endpoint = (options.endpoint ?? '/api/browser').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** What the gateway itself supports. Public route — no token required. */
  async health(): Promise<GatewayHealth> {
    const response = await this.fetchImpl('/api/gateway/health', {
      headers: { accept: 'application/json' },
    });
    return this.unwrap<GatewayHealth>(response);
  }

  status(): Promise<BrowserStatus> {
    return this.get<BrowserStatus>('/status');
  }

  launch(browser?: BrowserId): Promise<{ active: ActiveBrowser }> {
    return this.post<{ active: ActiveBrowser }>('/launch', browser ? { browser } : {});
  }

  open(url: string, options: { browser?: BrowserId; maxChars?: number } = {}): Promise<PageResult> {
    return this.post<PageResult>('/open', { url, ...options });
  }

  read(options: { maxChars?: number } = {}): Promise<PageResult> {
    return this.post<PageResult>('/read', options);
  }

  search(
    query: string,
    options: { engine?: string; browser?: BrowserId; maxChars?: number } = {},
  ): Promise<PageResult & { query: string; engine: string }> {
    return this.post<PageResult & { query: string; engine: string }>('/search', {
      query,
      ...options,
    });
  }

  close(): Promise<{ closed: boolean }> {
    return this.post<{ closed: boolean }>('/close', {});
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      headers: { accept: 'application/json' },
    });
    return this.unwrap<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return this.unwrap<T>(response);
  }

  private async unwrap<T>(response: Response): Promise<T> {
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: string; message?: string })
      | null;
    if (!response.ok) {
      throw new BrowserBridgeError(
        payload?.message ?? payload?.error ?? `the gateway returned HTTP ${response.status}`,
        response.status,
        payload?.error,
      );
    }
    if (payload === null) {
      throw new BrowserBridgeError('the gateway returned no body', response.status);
    }
    return payload;
  }
}
