/**
 * The shapes HWD-ZERO's operations API returns.
 *
 * Mirrored from `zero/ops/` in the HWD-ZERO repository — `child_agents.py`,
 * `missions.py`, `approvals.py`, `events.py`. Kept deliberately narrow: the
 * interface declares only the fields it renders, so a field the operator adds
 * later cannot silently change what is displayed.
 */

/** The event vocabulary `zero/ops/events.py` emits. */
export type OperatorEventType =
  | 'zero.state.changed'
  | 'zero.listening'
  | 'zero.thinking'
  | 'zero.planning'
  | 'zero.speaking'
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
  | 'agent.health'
  | 'approval.required'
  | 'approval.approved'
  | 'approval.denied'
  | 'policy.suggested'
  | 'policy.changed'
  | 'system.safe_mode'
  | 'system.resumed';

/** ZERO's visible states, mirrored by the renderer. */
export type ZeroState =
  | 'IDLE'
  | 'LISTENING'
  | 'THINKING'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'SPEAKING'
  | 'ERROR'
  | 'SAFE_MODE';

export interface OperatorEvent {
  event_id: string;
  timestamp: string;
  mission_id: string;
  agent_id: string;
  type: OperatorEventType;
  /** True only for the development visualiser. Never set by real execution. */
  simulated: boolean;
  payload: Record<string, unknown>;
}

export type AgentHealth = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'STARTING' | 'ERROR';

export type AgentStatus =
  | 'OFFLINE'
  | 'IDLE'
  | 'THINKING'
  | 'RUNNING'
  | 'WAITING'
  | 'AWAITING_APPROVAL'
  | 'VERIFYING'
  | 'DONE'
  | 'ERROR';

export type Department =
  | 'orchestration'
  | 'acquisition'
  | 'social'
  | 'reputation'
  | 'infrastructure'
  | 'outreach'
  | 'seo'
  | 'funnel';

/** One child of ZERO, exactly as the registry reports it. */
export interface OperatorAgent {
  id: string;
  display_name: string;
  repo: string;
  repo_path: string;
  parent: string;
  department: Department;
  enabled: boolean;
  status: AgentStatus;
  health: AgentHealth;
  risk_level: string;
  capabilities: string[];
  requires_approval_for: string[];
  allowed_paths: string[];
  allowed_network_scope: string;
  execution_adapter: string;
  entry_point: string;
  runtime: string;
  endpoint: string;
  version: string;
  last_activity: string;
  current_mission: string;
}

export interface OperatorRegistry {
  version: number;
  parent: string;
  agents: OperatorAgent[];
  /** Repositories the operator's exclusion list refused. Shown, never rendered
   *  as agents — surfacing them is how a refusal stays visible. */
  excluded: string[];
  narrowed_claims: string[];
  departments: Department[];
}

export type StepState =
  | 'PENDING'
  | 'BLOCKED'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'VERIFYING'
  | 'DONE'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED';

export interface MissionStep {
  id: string;
  agent_id: string;
  action: string;
  capability: string;
  description: string;
  depends_on: string[];
  state: StepState;
  attempts: number;
  max_attempts: number;
  approval_id: string;
  result: Record<string, unknown>;
  error: string;
  started_at: string;
  finished_at: string;
}

export type MissionState =
  | 'CREATED'
  | 'PLANNING'
  | 'EXECUTING'
  | 'AWAITING_APPROVAL'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface OperatorMission {
  id: string;
  objective: string;
  state: MissionState;
  origin: string;
  simulated: boolean;
  created_at: string;
  finished_at: string;
  error: string;
  agents: string[];
  steps: MissionStep[];
  results: Record<string, unknown>;
}

/**
 * A gate a mission is genuinely stopped on.
 *
 * There is no token here on purpose. The one-time secret never leaves the
 * laptop: the interface names an approval by id, and HWD-ZERO redeems it
 * against the payload digest it stored when it raised the gate.
 */
export interface OperatorApproval {
  id: string;
  mission_id: string;
  agent_id: string;
  capability: string;
  action: string;
  target: string;
  risk_level: string;
  summary: string;
  preview: Record<string, unknown>;
  estimated_cost: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  created_at: string;
  expires_at: string;
  decided_at: string;
  decided_by: string;
}

export interface OperatorPolicy {
  autonomous: string[];
  /** Capabilities no policy can ever make autonomous. */
  always_human: string[];
  suggestion_threshold: number;
  approvals_seen: Record<string, number>;
  suggested: string[];
}

export interface OperatorStatus {
  zero_state: ZeroState;
  safe_mode: { safe_mode: boolean; reason: string; since: string };
  brain_root: string;
  workspace_root: string;
  agents: { total: number; enabled: number; healthy: number; offline: number };
  excluded: string[];
  missions: { total: number; active: number };
  approvals_pending: number;
  policy: OperatorPolicy;
  subscribers: number;
}

export interface OperatorHealth {
  status: string;
  zero_state: ZeroState;
  safe_mode: boolean;
  agents: Record<string, { state: AgentHealth; detail: string; latency_ms: number }>;
  offline: string[];
  checked_at: string;
}

/** What ZERO answered a spoken instruction with. */
export interface VoiceReply {
  kind: 'answer' | 'mission';
  transcript: string;
  response: string;
  mission?: OperatorMission;
  agents?: OperatorAgent[];
}

export type OperatorConnection = 'connecting' | 'open' | 'closed' | 'unreachable';
