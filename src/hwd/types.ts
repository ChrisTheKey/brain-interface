/**
 * The shapes HWD-ZERO's API returns.
 *
 * Mirrored from `zero/api/` in the HWD-ZERO repository. Kept deliberately
 * narrow: the interface declares only the fields it renders, so a field the
 * operator adds later cannot silently change what is displayed.
 */

/** Interface event vocabulary — the values `zero/api/events.py` emits. */
export type OperatorEventType =
  /**
   * The runtime announcing itself. Sent to every subscriber as the first frame
   * on `/ws/events`, before any replay — it is what makes the stream *full*
   * rather than merely open.
   */
  | 'zero.runtime.ready'
  | 'zero.state.changed'
  | 'mission.created'
  | 'mission.planning'
  | 'mission.executing'
  | 'mission.verifying'
  | 'mission.completed'
  | 'mission.failed'
  | 'agent.started'
  | 'agent.activity'
  | 'agent.completed'
  | 'agent.error'
  | 'approval.required'
  | 'approval.approved'
  | 'approval.denied'
  | 'policy.suggested'
  | 'policy.changed'
  /**
   * ZERO publishing. One event per state the activity path draws, so what the
   * interface shows is something that actually happened rather than an
   * animation: `publishing` is only ever sent after a human approved.
   */
  | 'zero.social.connected'
  | 'zero.social.preparing'
  | 'zero.social.awaiting_approval'
  | 'zero.social.publishing'
  | 'zero.social.verifying'
  | 'zero.social.published'
  | 'zero.social.partial'
  | 'zero.social.failed'
  | 'zero.social.refused';

export interface OperatorEvent {
  event_id: string;
  timestamp: string;
  mission_id: string;
  agent_id: string;
  type: OperatorEventType;
  payload: Record<string, unknown>;
}

export interface OperatorMission {
  mission_id: string;
  task_id: string;
  objective: string;
  project: string;
  executor: string;
  status: string;
  started_at: string;
  finished_at: string;
  iterations: number;
}

export interface OperatorAgent {
  id: string;
  role: string;
  status: string;
  purpose: string;
  strengths: string[];
  available: boolean;
}

export interface OperatorProject {
  id: string;
  status: string;
  priority: string;
  runtime: string;
}

export interface OperatorRegistry {
  version: string;
  agents: OperatorAgent[];
  projects: OperatorProject[];
}

export interface OperatorTask {
  id: string;
  reference?: string;
  objective?: string;
  project?: string;
  executor?: string;
  gates?: string[];
  loadable: boolean;
  error?: string;
}

/** A gate a mission is genuinely stopped on. Never synthesised by the client. */
export interface OperatorApproval {
  mission_id: string;
  task_id: string;
  gate: string;
  reason: string;
  rationale: string;
  objective: string;
  executor: string;
  iteration: number;
  payload_digest: string;
  /**
   * `mission` — a stopped loop that resumes. `action` — something that happens
   * once, to the world, exactly as previewed. The two need different words on
   * the button, because approving a resume and approving a post are not the
   * same decision.
   */
  kind?: 'mission' | 'action';
  /** For an action: what the human is being asked about, verbatim. */
  preview?: SocialPlanView;
}

/** One network in a publish plan, with its own wording and its own minute. */
export interface SocialTargetView {
  network: string;
  label: string;
  text: string;
  when: string;
  time_source: string;
  ok: boolean;
  reasons: string[];
  warnings: string[];
  shortened: boolean;
}

/**
 * A publish, fully decided, before anyone has been asked. `digest` is what the
 * approval is bound to — the interface shows it so the operator can see that
 * the thing they are approving is the thing they looked at.
 */
export interface SocialPlanView {
  plan_id: string;
  brand: { id: string; label: string };
  timezone: string;
  action: 'schedule' | 'publish';
  created_at: string;
  draft: {
    text: string;
    media: { url: string; kind: string; alt: string }[];
    first_comment: string;
  };
  targets: SocialTargetView[];
  publishable: string[];
  blocked: { network: string; reasons: string[] }[];
  requested: string[];
  digest: string;
  idempotency_key: string;
  note: string;
  risk: string;
}

/** What `/api/integrations/metricool/status` answers. Never a token. */
export interface MetricoolStatus {
  integration: string;
  server: string;
  connected: boolean;
  blocked_by: string;
  local_only: boolean;
  enabled: boolean;
  brands: number;
  brand_list?: { id: string; label: string; timezone: string; networks: string[] }[];
  networks: string[];
  publishing_ready: boolean;
  auth: { state: string; scopes?: string[]; expires_at?: string; can_refresh?: boolean };
  capabilities: { granted: string[]; missing: string[]; can_publish: boolean; tools?: string[] };
  reason: string | null;
  plans_pending?: number;
  published?: number;
  approval?: { gate: string; required: boolean; clearable_by_contract: boolean };
}

/** What one publish actually did, per network. Never rounded up to success. */
export interface SocialOutcome {
  plan_id: string;
  digest: string;
  state: 'done' | 'partial_failure' | 'failed' | 'awaiting_approval';
  attempts: number;
  deduplicated: boolean;
  at: string;
  published: { network: string; ok: boolean; post_id: string; scheduled_for: string; url: string }[];
  failed: { network: string; ok: boolean; detail: string }[];
  summary?: string;
  brand?: string;
}

/** Minted by the server, redeemable once, before `expires_at`. */
export interface ApprovalTicket {
  ticket_id: string;
  mission_id: string;
  gate: string;
  payload_digest: string;
  expires_at: string;
  token: string;
}

export interface OperatorState {
  zero_version: string;
  safe_mode: boolean;
  brain: {
    root: string;
    revision: string;
    sources: number;
    projects: string[];
    agents: string[];
    [key: string]: unknown;
  };
  missions: { count: number; running: number; recent: OperatorMission[] };
  approvals_pending: number;
  subscribers: number;
  executor_references: string[];
  verifier_types: string[];
}

export type OperatorConnection = 'connecting' | 'open' | 'closed' | 'unreachable';

/**
 * The ZERO gateway's composite health, from `GET /api/health`.
 *
 * Three separate facts, never collapsed into one boolean. The gateway can be
 * perfectly healthy while HWD-ZERO is down — that is the whole point of the
 * distinction, and it is what turns "notLoaded" into "BACKEND OFFLINE".
 */
export interface GatewayHealth {
  gateway: 'healthy';
  /** HWD-ZERO's HTTP API, probed by the gateway on loopback. */
  zero: 'healthy' | 'offline';
  /**
   * The optional codex executor, probed by the gateway on loopback.
   *
   * `not_configured` means this deployment runs no codex app-server — normal
   * on a phone, and never a degradation. ZERO's runtime is HWD-ZERO's
   * ZeroSession; codex is an executor it may drive.
   */
  websocket: 'healthy' | 'offline' | 'not_configured';
  /** Whether a codex executor is configured at all. */
  runtimeConfigured: boolean;
  lanMode: boolean;
  /** True when this origin demands a pairing token the client may not hold. */
  authRequired: boolean;
  /** Public paths the browser is expected to use. Never internal addresses. */
  publicPaths: { api: string; ws: string; events: string };
  /** Internal upstreams — present only when diagnostics are enabled. */
  diagnostics?: {
    zeroApi: string;
    zeroRuntimeWs: string;
    zeroDetail: string;
    websocketDetail: string;
  };
}

/**
 * The payload of `zero.runtime.ready` — HWD-ZERO describing its own runtime.
 *
 * `ZeroSession` is the canonical ZERO runtime: brain, missions, policy,
 * verification, child agents. Codex, Claude and Ollama are executors it may
 * drive, and none of them appears here.
 */
export interface RuntimeReadyPayload {
  runtime: 'ZeroSession';
  healthy: boolean;
  name?: string;
  ready?: boolean;
  version?: string;
  brain_root?: string;
  brain_revision?: string;
  sources?: number;
  /** ZERO's own roles — not the child-agent network. */
  roles?: string[];
  projects?: string[];
}

/** One child-agent repository, as found on disk by the runtime. */
export interface DiscoveredRepository {
  name: string;
  path: string;
  is_git: boolean;
  markers: string[];
}

/** `GET /api/agents/children` — facts about what is on disk, never policy. */
export interface ChildAgentDiscovery {
  root: string;
  exists: boolean;
  repositories: DiscoveredRepository[];
}
