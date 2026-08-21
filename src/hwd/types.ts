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
  | 'policy.changed';

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
