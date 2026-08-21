/**
 * The shapes HWD-ZERO's API returns.
 *
 * Mirrored from `zero/api/` in the HWD-ZERO repository. Kept deliberately
 * narrow: the interface declares only the fields it renders, so a field the
 * operator adds later cannot silently change what is displayed.
 */

/** Interface event vocabulary — the values `zero/api/events.py` emits. */
export type OperatorEventType =
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
   * The optional codex runtime app-server, probed by the gateway on loopback.
   * `not_configured` means the deployment does not run one — which is normal
   * on a phone, and is not a degradation.
   */
  websocket: 'healthy' | 'offline' | 'not_configured';
  /** Whether a runtime app-server is configured at all. */
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
