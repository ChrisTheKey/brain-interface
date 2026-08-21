/**
 * The client for HWD-ZERO, the operator.
 *
 * Same origin, always: the gateway on port 3000 serves this bundle and proxies
 * `/api` and `/ws` to HWD-ZERO on loopback. So there is no host to configure
 * here and no credential to embed — whoever loaded the page is already
 * authenticated by the gateway, and HWD-ZERO itself is not reachable from the
 * network at all.
 *
 * The client reads and requests. It never decides: no retry that re-runs a
 * mission, no approval it grants on its own, no state it maintains that the
 * operator does not already hold.
 */

import type {
  OperatorAgent,
  OperatorApproval,
  OperatorEvent,
  OperatorHealth,
  OperatorMission,
  OperatorPolicy,
  OperatorRegistry,
  OperatorStatus,
  VoiceReply,
} from './types';

export interface OperatorClientOptions {
  /** Same-origin by default; only tests pass an explicit base. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected so tests can drive a fake socket. */
  socketFactory?: (url: string) => WebSocket;
  /** Backoff for the event stream, in ms. */
  reconnectDelayMs?: number;
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
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OperatorClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
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

  health(): Promise<OperatorHealth> {
    return this.get('/api/health');
  }

  status(): Promise<OperatorStatus> {
    return this.get('/api/status');
  }

  registry(): Promise<OperatorRegistry> {
    return this.get('/api/agents');
  }

  agent(id: string): Promise<OperatorAgent> {
    return this.get(`/api/agents/${encodeURIComponent(id)}`);
  }

  refreshAgents(): Promise<OperatorRegistry> {
    return this.post('/api/agents/refresh', {});
  }

  async missions(): Promise<OperatorMission[]> {
    const payload = await this.get<{ missions: OperatorMission[] }>('/api/missions');
    return payload.missions ?? [];
  }

  mission(id: string): Promise<OperatorMission> {
    return this.get(`/api/missions/${encodeURIComponent(id)}`);
  }

  async approvals(): Promise<OperatorApproval[]> {
    const payload = await this.get<{ pending: OperatorApproval[] }>('/api/approvals');
    return payload.pending ?? [];
  }

  policy(): Promise<OperatorPolicy> {
    return this.get('/api/policy');
  }

  async audit(limit = 100): Promise<Record<string, unknown>[]> {
    const payload = await this.get<{ entries: Record<string, unknown>[] }>(
      `/api/audit?limit=${limit}`,
    );
    return payload.entries ?? [];
  }

  // ----------------------------------------------------------------- writes

  /** State an objective. ZERO plans it against the agents that are present. */
  createMission(objective: string, origin = 'operator'): Promise<OperatorMission> {
    return this.post('/api/missions', { objective, origin });
  }

  cancelMission(id: string): Promise<OperatorMission> {
    return this.post(`/api/missions/${encodeURIComponent(id)}/cancel`, {});
  }

  /**
   * Approve one gate.
   *
   * The interface sends an id and nothing else. It cannot widen what was
   * approved, because the payload the operator saw was digested server-side
   * when the gate was raised and is re-checked at redemption.
   */
  approve(approvalId: string): Promise<OperatorApproval> {
    return this.post(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {});
  }

  deny(approvalId: string): Promise<OperatorApproval> {
    return this.post(`/api/approvals/${encodeURIComponent(approvalId)}/deny`, {});
  }

  /**
   * Promote a capability to autonomous — the "CREATE POLICY" button.
   *
   * `operator_confirmed` is always true from here because this method is only
   * reachable from a deliberate operator action. The server refuses without it,
   * and refuses regardless for any capability on the always-human floor.
   */
  grantPolicy(capability: string): Promise<OperatorPolicy> {
    return this.post('/api/policy/grant', { capability, operator_confirmed: true });
  }

  revokePolicy(capability: string): Promise<OperatorPolicy> {
    return this.post('/api/policy/revoke', { capability });
  }

  /** The kill switch. Server-side: it stops the laptop, not just this screen. */
  stop(reason = 'operator pressed STOP ZERO'): Promise<{ safe_mode: boolean }> {
    return this.post('/api/system/stop', { reason });
  }

  resume(): Promise<{ safe_mode: boolean }> {
    return this.post('/api/system/resume', { by: 'operator' });
  }

  /** A finished transcript, from this device's microphone. */
  sendTranscript(text: string): Promise<VoiceReply> {
    return this.post('/api/voice/transcript', { text });
  }

  /** Recorded audio, transcribed on the laptop rather than on the phone. */
  async sendAudio(audio: Blob): Promise<VoiceReply | { ok: false; detail: string }> {
    const response = await this.fetchImpl(joinPath(this.baseUrl, '/api/voice/audio'), {
      method: 'POST',
      headers: { 'content-type': audio.type || 'application/octet-stream' },
      body: audio,
    });
    return this.unwrap(response);
  }

  // ----------------------------------------------------------------- events

  eventsUrl(): string {
    if (this.baseUrl) {
      return `${this.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws/events`;
    }
    // Same origin as the page the gateway served, so the socket inherits the
    // gateway's authentication and needs no address of its own. Outside a
    // browser there is no origin to inherit; returning a relative path keeps
    // this total rather than throwing, and a caller with no window is a test or
    // a server renderer, neither of which opens a real socket.
    const location = typeof window === 'undefined' ? undefined : window.location;
    if (!location) return '/ws/events';
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/events`;
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
