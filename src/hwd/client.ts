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

import { Backoff } from '../zero/lifecycle';
import { ZERO_EVENTS_WS_PATH, apiPath, sameOriginWsUrl } from '../zero/endpoints';
import type {
  ApprovalTicket,
  ChildAgentDiscovery,
  AdsOutcome,
  AdsPlanView,
  GatewayHealth,
  MetaAdsStatus,
  MetricoolStatus,
  OperatorApproval,
  OperatorEvent,
  OperatorMission,
  OperatorRegistry,
  OperatorState,
  OperatorTask,
  SocialOutcome,
  SocialPlanView,
} from './types';

export interface OperatorClientOptions {
  /** Same-origin by default; only tests pass an explicit base. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected so tests can drive a fake socket. */
  socketFactory?: (url: string) => WebSocket;
  /** First backoff step for the event stream, in ms. Doubles up to the max. */
  reconnectDelayMs?: number;
  /** Upper bound of the backoff, in ms. */
  maxReconnectDelayMs?: number;
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
  private readonly maxReconnectDelayMs: number;
  private readonly backoff: Backoff;
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reopen: (() => void) | null = null;
  private responded = false;

  constructor(options: OperatorClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 15_000;
    this.backoff = new Backoff(this.reconnectDelayMs, this.maxReconnectDelayMs);
  }

  /** True once HWD-ZERO returned a real payload — not merely "a socket opened". */
  get hasResponded(): boolean {
    return this.responded;
  }

  // ------------------------------------------------------------------ reads

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(joinPath(this.baseUrl, path), {
      headers: { accept: 'application/json' },
    });
    const payload = await this.unwrap<T>(response);
    this.responded = true;
    return payload;
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

  /**
   * The gateway's composite health. It answers for itself *and* reports what
   * it can actually see of HWD-ZERO, so an offline operator is a fact from the
   * gateway rather than a fetch that simply never resolved in the browser.
   */
  health(): Promise<GatewayHealth> {
    return this.get(apiPath('/health'));
  }

  state(): Promise<OperatorState> {
    return this.get('/api/state');
  }

  /** ZERO's own roles and executors. Not the child-agent network. */
  registry(): Promise<OperatorRegistry> {
    return this.get('/api/agents');
  }

  /**
   * Child-agent repositories the runtime found on disk.
   *
   * Facts, not policy: which of these may become agents is decided by
   * `src/zero/agentPolicy.ts`, which stays the single source of that list.
   */
  childAgents(): Promise<ChildAgentDiscovery> {
    return this.get('/api/agents/children');
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

  /**
   * Denial. Not "not yet" — the gate closes and, for a publish, the prepared
   * payload is dropped so no later ticket can find it still sitting there.
   */
  denyApproval(
    missionId: string,
    gate: string,
    reason = '',
  ): Promise<{ denied_gate: string; mission_id: string }> {
    return this.post(`/api/approvals/${encodeURIComponent(missionId)}/deny`, { gate, reason });
  }

  // -------------------------------------------------------------- metricool

  /** Connected, which brands, which networks. Never a token. */
  metricoolStatus(): Promise<MetricoolStatus> {
    return this.get('/api/integrations/metricool/status');
  }

  /**
   * Start the sign-in. Returns the URL the operator opens; the PKCE verifier
   * behind it stays inside HWD-ZERO, which is why the callback can safely come
   * back through this gateway.
   */
  metricoolConnect(): Promise<{ authorization_url: string; state: string }> {
    return this.post('/api/integrations/metricool/connect', {});
  }

  /** Forget the credential. Nothing already published is undone. */
  metricoolDisconnect(): Promise<{ connected: boolean }> {
    return this.post('/api/integrations/metricool/disconnect', {});
  }

  /**
   * What ZERO would post if the operator says "poste das". ZERO does not write
   * the copy — this is where what they wrote is held.
   */
  setSocialDraft(draft: {
    text: string;
    media?: unknown[];
    first_comment?: string;
    extras?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.post('/api/social/draft', draft);
  }

  /**
   * Build the plan and stop on the gate. Nothing reaches Metricool here: the
   * reply is a preview and a pending approval, which is the whole point.
   */
  prepareSocial(request: {
    text?: string;
    request?: string;
    networks?: string[];
    when?: string;
    brand?: string;
    media?: unknown[];
    first_comment?: string;
    extras?: Record<string, unknown>;
  }): Promise<{
    plan: SocialPlanView;
    approval: OperatorApproval;
    state: string;
    summary: string;
  }> {
    return this.post('/api/social/prepare', request);
  }

  /** What one publish actually did. */
  socialOutcome(planId: string): Promise<SocialOutcome> {
    return this.get(`/api/social/plans/${encodeURIComponent(planId)}`);
  }

  // --------------------------------------------------------------- meta ads

  /** Connected, which accounts, rollout, readiness. Never a token. */
  metaAdsStatus(): Promise<MetaAdsStatus> {
    return this.get('/api/integrations/meta-ads/status');
  }

  /** Start the Meta Business OAuth. The verifier stays in the runtime. */
  metaAdsConnect(): Promise<{ authorization_url: string; state: string }> {
    return this.post('/api/integrations/meta-ads/connect', {});
  }

  metaAdsDisconnect(): Promise<{ connected: boolean }> {
    return this.post('/api/integrations/meta-ads/disconnect', {});
  }

  /** Choose the ad account. Never chosen at random when several exist. */
  selectAdAccount(account: string): Promise<{ selected: { id: string; label: string } }> {
    return this.post('/api/integrations/meta-ads/account', { account });
  }

  /**
   * Real numbers from Meta. Read-only, so no gate: looking at what an account
   * already spent changes nothing and shows nobody anything.
   */
  adsInsights(request: {
    account?: string;
    date_preset?: string;
    level?: string;
    time_range?: { since: string; until: string };
    entity_id?: string;
  }): Promise<{ rows: Record<string, unknown>[]; count: number; source: string }> {
    return this.post('/api/ads/insights', request);
  }

  /** Everything an audit needs, gathered. Recommends nothing by itself. */
  adsAudit(request: { account?: string; date_preset?: string }): Promise<Record<string, unknown>> {
    return this.post('/api/ads/audit', request);
  }

  /**
   * Build a campaign structure and stop on the gate. Nothing reaches Meta
   * here — the reply is a preview and a pending approval.
   */
  prepareCampaign(request: Record<string, unknown>): Promise<{
    plan: AdsPlanView;
    approval: OperatorApproval;
    state: string;
    summary: string;
  }> {
    return this.post('/api/ads/campaign/prepare', request);
  }

  /** Pause, activate, change a budget. Same gate, same binding. */
  prepareAdsMutation(request: Record<string, unknown>): Promise<{
    plan: AdsPlanView;
    approval: OperatorApproval;
    state: string;
    summary: string;
  }> {
    return this.post('/api/ads/mutation/prepare', request);
  }

  adsOutcome(planId: string): Promise<AdsOutcome> {
    return this.get(`/api/ads/plans/${encodeURIComponent(planId)}`);
  }

  /** The kill switch. On refuses every execution until a human turns it off. */
  setSafeMode(enabled: boolean): Promise<{ safe_mode: boolean }> {
    return this.post('/api/control/safe-mode', { enabled });
  }

  // ----------------------------------------------------------------- events

  eventsUrl(): string {
    if (this.baseUrl) {
      return `${this.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}${ZERO_EVENTS_WS_PATH}`;
    }
    // Same origin, and `https:` upgrades the socket to `wss:` — a `ws:`
    // socket from an HTTPS page is blocked as mixed content, not downgraded.
    return sameOriginWsUrl(ZERO_EVENTS_WS_PATH, window.location);
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
    this.backoff.reset();

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
      socket.onopen = () => {
        // A successful connection is what earns the short delay back; without
        // the reset every later drop would inherit the previous 15s ceiling.
        this.backoff.reset();
        handlers.onOpen?.();
      };
      socket.onmessage = (message: MessageEvent) => {
        if (typeof message.data !== 'string') return;
        try {
          const event = JSON.parse(message.data) as OperatorEvent;
          this.responded = true;
          handlers.onEvent(event);
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
      // 1s, 2s, 4s, 8s, then 15s — never a reconnect storm, never a long
      // silence after the laptop comes back.
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        open();
      }, this.backoff.next());
    };

    this.reopen = open;
    open();

    return () => {
      this.closedByUs = true;
      this.reopen = null;
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.socket?.close();
      this.socket = null;
    };
  }

  /**
   * Re-check the stream right now instead of waiting out the backoff. Called
   * when the browser reports it woke up (`online`, tab visible again): the
   * socket a locked phone left behind is already dead, it just has not been
   * noticed yet.
   */
  reconnectNow(): void {
    if (this.closedByUs || this.reopen === null) return;
    if (this.socket !== null) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff.reset();
    this.reopen();
  }
}
