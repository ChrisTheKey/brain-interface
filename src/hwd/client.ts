/**
 * The client for HWD-ZERO, the operator.
 *
 * Same origin, always: the gateway on port 3000 serves this bundle and proxies
 * `/api`, `/ws/events` and `/ws/voice` to HWD-ZERO on loopback. So there is no
 * host to configure here and no credential to embed — whoever loaded the page
 * is already authenticated by the gateway, and HWD-ZERO itself is not reachable
 * from the network at all.
 *
 * The client reads and requests. It never decides: no routing it performs, no
 * agent process it starts, no shell it touches, no approval it grants on its
 * own, no state it maintains that the operator does not already hold.
 */

import type {
  ApprovalTicket,
  GatewayHealth,
  OperatorApproval,
  OperatorEvent,
  OperatorMission,
  OperatorRegistry,
  OperatorState,
  OperatorTask,
} from './types';

export interface OperatorClientOptions {
  /** Same-origin by default; only tests pass an explicit base. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected so tests can drive a fake socket. */
  socketFactory?: (url: string) => WebSocket;
  /** Backoff for the event stream, in ms. */
  reconnectDelayMs?: number;
  /** Injected so tests do not depend on `window.location`. */
  origin?: { protocol: string; host: string };
}

export class OperatorError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OperatorError';
  }
}

function joinPath(base: string, path: string): string {
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}${path}`;
}

export class HwdZeroClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly reconnectDelayMs: number;
  private readonly origin: { protocol: string; host: string } | null;
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OperatorClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.origin =
      options.origin ??
      (typeof window !== 'undefined' && window.location
        ? { protocol: window.location.protocol, host: window.location.host }
        : null);
  }

  // ------------------------------------------------------------------ reads

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(joinPath(this.baseUrl, path), {
      headers: { accept: 'application/json' },
    });
    return this.unwrap<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(joinPath(this.baseUrl, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return this.unwrap<T>(response);
  }

  private async unwrap<T>(response: Response): Promise<T> {
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : text.slice(0, 200) || response.statusText;
      throw new OperatorError(detail, response.status);
    }
    return payload as T;
  }

  /** The gateway's own health — answers even when HWD-ZERO is down. */
  gatewayHealth(): Promise<GatewayHealth> {
    return this.get('/api/gateway/health');
  }

  health(): Promise<{ status: string; safe_mode: boolean }> {
    return this.get('/api/health');
  }

  state(): Promise<OperatorState> {
    return this.get('/api/state');
  }

  registry(): Promise<OperatorRegistry> {
    return this.get('/api/agents');
  }

  async tasks(): Promise<OperatorTask[]> {
    const payload = await this.get<{ tasks: OperatorTask[] }>('/api/tasks');
    return payload.tasks ?? [];
  }

  async missions(): Promise<OperatorMission[]> {
    const payload = await this.get<{ missions: OperatorMission[] }>('/api/missions');
    return payload.missions ?? [];
  }

  async approvals(): Promise<OperatorApproval[]> {
    const payload = await this.get<{ approvals: OperatorApproval[] }>('/api/approvals');
    return payload.approvals ?? [];
  }

  async journal(missionId: string, limit = 200): Promise<Record<string, unknown>[]> {
    const payload = await this.get<{ journal: Record<string, unknown>[] }>(
      `/api/missions/${encodeURIComponent(missionId)}/journal?limit=${limit}`,
    );
    return payload.journal ?? [];
  }

  // ----------------------------------------------------------------- writes

  /** Start a mission from a contract the operator already holds. */
  startMission(task: string): Promise<{ run: Record<string, unknown> }> {
    return this.post('/api/missions', { task });
  }

  /**
   * Ask for an approval ticket. The server only mints one for a gate it can
   * see is genuinely pending, and the token comes back exactly once.
   */
  requestApproval(missionId: string, gate: string): Promise<ApprovalTicket> {
    return this.post('/api/approvals', { mission_id: missionId, gate });
  }

  /** Redeem a ticket. Single use, and refused once it expires. */
  grantApproval(ticket: ApprovalTicket): Promise<{ approved_gate: string; mission_id: string }> {
    return this.post(`/api/approvals/${encodeURIComponent(ticket.ticket_id)}/grant`, {
      token: ticket.token,
    });
  }

  /** The kill switch. On refuses every execution until a human turns it off. */
  setSafeMode(enabled: boolean): Promise<{ safe_mode: boolean }> {
    return this.post('/api/control/safe-mode', { enabled });
  }

  /**
   * Optional contract: synthesise a text into an audio file. Used when the
   * operator has no `/ws/voice` stream but can still voice a sentence — the
   * result is decoded into the Web Audio graph, so the brain still reacts to
   * the real signal rather than to a guess.
   *
   * Returns `null` when the operator does not implement it (404 / 501).
   */
  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const response = await this.fetchImpl(joinPath(this.baseUrl, '/api/voice/tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/*' },
      body: JSON.stringify({ text }),
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404 || response.status === 501 || response.status === 405) return null;
    if (!response.ok) {
      throw new OperatorError(`tts failed (${response.status})`, response.status);
    }
    return response.arrayBuffer();
  }

  // ----------------------------------------------------------------- events

  /** Absolute ws:// URL for a gateway path, same origin as the page. */
  socketUrl(path: string): string {
    if (this.baseUrl) {
      return `${this.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}${path}`;
    }
    if (!this.origin) return path;
    const scheme = this.origin.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${this.origin.host}${path}`;
  }

  eventsUrl(): string {
    return this.socketUrl('/ws/events');
  }

  voiceUrl(): string {
    return this.socketUrl('/ws/voice');
  }

  /** Opens a raw socket on a gateway path (used by the voice channel). */
  openSocket(path: string): WebSocket {
    return this.socketFactory(this.socketUrl(path));
  }

  /**
   * Subscribe to the operator's event stream.
   *
   * Reconnects on drop, because the phone's screen turning off closes the
   * socket and the brain must come back to life by itself. On reconnect the
   * server replays its recent buffer, so `event_id` is what deduplicates —
   * the client does not try to remember where it was.
   */
  connectEvents(handlers: {
    onEvent: (event: OperatorEvent) => void;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (message: string) => void;
  }): () => void {
    this.closedByUs = false;

    const open = (): void => {
      if (this.closedByUs) return;
      let socket: WebSocket;
      try {
        socket = this.socketFactory(this.eventsUrl());
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error.message : String(error));
        schedule();
        return;
      }
      this.socket = socket;
      socket.onopen = () => handlers.onOpen?.();
      socket.onmessage = (message: MessageEvent) => {
        if (typeof message.data !== 'string') return;
        try {
          handlers.onEvent(JSON.parse(message.data) as OperatorEvent);
        } catch {
          // A frame we cannot parse is dropped rather than rendered as an
          // event with missing fields.
        }
      };
      socket.onerror = () => handlers.onError?.('event stream error');
      socket.onclose = () => {
        this.socket = null;
        handlers.onClose?.();
        schedule();
      };
    };

    const schedule = (): void => {
      if (this.closedByUs || this.reconnectTimer !== null) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        open();
      }, this.reconnectDelayMs);
    };

    open();

    return () => {
      this.closedByUs = true;
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.socket?.close();
      this.socket = null;
    };
  }
}
