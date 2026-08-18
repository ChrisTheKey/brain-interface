/**
 * ZERO client: JSON-RPC 2.0 (header-less, see protocol.ts) over the WebSocket
 * transport that ZERO's app-server exposes with
 * `codex app-server --listen ws://IP:PORT`.
 *
 * The client owns exactly one connection, performs the mandatory
 * `initialize` / `initialized` handshake, resolves requests by id, fans
 * notifications out to subscribers, and reconnects with backoff. It never
 * fabricates data: when ZERO is unreachable the connection state simply
 * becomes `disconnected` and pending requests reject.
 */
import {
  isJsonRpcError,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  ZERO_METHODS,
  type InitializeParams,
  type InitializeResponse,
  type JsonRpcMessage,
  type RequestId,
} from './protocol';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** Minimal surface of the browser `WebSocket` the client depends on. */
export interface ZeroSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => ZeroSocket;

export interface ZeroClientOptions {
  url: string;
  clientInfo: { name: string; title?: string; version: string };
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[];
  /** Injectable for tests; defaults to the browser WebSocket. */
  socketFactory?: SocketFactory;
  /** Reconnect backoff bounds, in milliseconds. */
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  requestTimeoutMs?: number;
  /** Injectable timer for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ZeroClientEvents {
  state: (state: ConnectionState, detail?: { error?: string }) => void;
  notification: (method: string, params: unknown) => void;
  /** Server-initiated request (e.g. approvals). Answered with an error by default. */
  serverRequest: (method: string, params: unknown, id: RequestId) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: unknown;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class ZeroClient {
  private readonly options: Required<
    Pick<
      ZeroClientOptions,
      'url' | 'clientInfo' | 'minReconnectDelayMs' | 'maxReconnectDelayMs' | 'requestTimeoutMs'
    >
  > &
    ZeroClientOptions;

  private socket: ZeroSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly listeners: {
    [K in keyof ZeroClientEvents]: Set<ZeroClientEvents[K]>;
  } = { state: new Set(), notification: new Set(), serverRequest: new Set() };

  private state: ConnectionState = 'idle';
  private reconnectDelay: number;
  private reconnectTimer: unknown = null;
  private closedByUser = false;
  private handshake: Promise<InitializeResponse> | null = null;
  private userAgent: string | null = null;

  constructor(options: ZeroClientOptions) {
    this.options = {
      minReconnectDelayMs: 1_000,
      maxReconnectDelayMs: 15_000,
      requestTimeoutMs: DEFAULT_TIMEOUT_MS,
      ...options,
    };
    this.reconnectDelay = this.options.minReconnectDelayMs;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get serverUserAgent(): string | null {
    return this.userAgent;
  }

  get url(): string {
    return this.options.url;
  }

  on<K extends keyof ZeroClientEvents>(event: K, handler: ZeroClientEvents[K]): () => void {
    this.listeners[event].add(handler as never);
    return () => {
      this.listeners[event].delete(handler as never);
    };
  }

  connect(): Promise<InitializeResponse> {
    this.closedByUser = false;
    if (this.handshake) return this.handshake;

    const factory: SocketFactory =
      this.options.socketFactory ??
      ((url: string) => new WebSocket(url) as unknown as ZeroSocket);

    this.setState('connecting');
    this.handshake = new Promise<InitializeResponse>((resolve, reject) => {
      let socket: ZeroSocket;
      try {
        socket = factory(this.options.url);
      } catch (error) {
        this.handshake = null;
        this.setState('disconnected', { error: describeError(error) });
        this.scheduleReconnect();
        reject(toError(error));
        return;
      }
      this.socket = socket;

      socket.onopen = () => {
        const params: InitializeParams = {
          clientInfo: {
            name: this.options.clientInfo.name,
            title: this.options.clientInfo.title ?? null,
            version: this.options.clientInfo.version,
          },
          capabilities: {
            experimentalApi: this.options.experimentalApi ?? false,
            optOutNotificationMethods: this.options.optOutNotificationMethods ?? null,
          },
        };
        this.request<InitializeResponse>(ZERO_METHODS.initialize, params)
          .then((response) => {
            this.notify(ZERO_METHODS.initialized);
            this.userAgent = response?.userAgent ?? null;
            this.reconnectDelay = this.options.minReconnectDelayMs;
            this.setState('connected');
            resolve(response);
          })
          .catch((error: unknown) => {
            this.setState('disconnected', { error: describeError(error) });
            reject(toError(error));
            this.teardownSocket();
            this.scheduleReconnect();
          });
      };

      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      socket.onerror = (event) => {
        this.setState(this.state === 'connected' ? 'connected' : 'connecting', {
          error: describeError(event),
        });
      };

      socket.onclose = () => {
        const wasHandshaking = this.state !== 'connected';
        this.teardownSocket();
        this.failPending(new Error('ZERO connection closed'));
        this.setState('disconnected');
        if (wasHandshaking) reject(new Error('ZERO connection closed before initialize'));
        this.scheduleReconnect();
      };
    });

    return this.handshake;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.teardownSocket();
    this.failPending(new Error('ZERO client closed'));
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    this.setState('idle');
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(`not connected to ZERO (${method})`));
    const id = this.nextId++;
    const payload = JSON.stringify(params === undefined ? { id, method } : { id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        reject(new Error(`ZERO request timed out: ${method}`));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        socket.send(payload);
      } catch (error) {
        this.pending.delete(id);
        this.clearTimer(timer);
        reject(toError(error));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.socket) return;
    try {
      this.socket.send(
        JSON.stringify(params === undefined ? { method } : { method, params }),
      );
    } catch {
      /* the close handler takes care of the connection state */
    }
  }

  /** Answer a server-initiated request. */
  respond(id: RequestId, result: unknown): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify({ id, result }));
  }

  respondWithError(id: RequestId, code: number, message: string): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify({ id, error: { code, message } }));
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer !== undefined) this.clearTimer(pending.timer);
      pending.resolve(message.result);
      return;
    }

    if (isJsonRpcError(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer !== undefined) this.clearTimer(pending.timer);
      pending.reject(new Error(message.error?.message ?? 'ZERO returned an error'));
      return;
    }

    if (isJsonRpcRequest(message)) {
      const handlers = this.listeners.serverRequest;
      if (handlers.size === 0) {
        // The Brain Interface is a read-only observer: it must never silently
        // approve anything on ZERO's behalf, so unhandled requests are declined.
        this.respondWithError(message.id, -32601, 'Brain Interface does not handle this request');
        return;
      }
      for (const handler of handlers) handler(message.method, message.params, message.id);
      return;
    }

    if (isJsonRpcNotification(message)) {
      for (const handler of this.listeners.notification) {
        handler(message.method, message.params);
      }
    }
  }

  private setState(state: ConnectionState, detail?: { error?: string }): void {
    this.state = state;
    for (const handler of this.listeners.state) handler(state, detail);
  }

  private teardownSocket(): void {
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
    }
    this.socket = null;
    this.handshake = null;
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) this.clearTimer(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.maxReconnectDelayMs);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      void this.connect().catch(() => {
        /* the state listener already surfaced the failure */
      });
    }, delay);
  }

  private setTimer(fn: () => void, ms: number): unknown {
    const impl = this.options.setTimeoutFn ?? ((cb: () => void, delay: number) => setTimeout(cb, delay));
    return impl(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    const impl =
      this.options.clearTimeoutFn ??
      ((value: unknown) => clearTimeout(value as ReturnType<typeof setTimeout>));
    impl(handle);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(describeError(error));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
