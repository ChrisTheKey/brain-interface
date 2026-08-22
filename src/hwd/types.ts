/**
 * The shapes HWD-ZERO's API returns.
 *
 * Mirrored from `zero/api/` in the HWD-ZERO repository. Kept deliberately
 * narrow: the interface declares only the fields it renders, so a field the
 * operator adds later cannot silently change what is displayed. Everything
 * marked optional is part of the contract the interface *asks* for and
 * degrades without — see `docs/BACKEND_CONTRACT.md`.
 */
import type { RepositoryEvidence } from '../zero/agentClassifier';

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
  | 'policy.changed'
  /** Optional: HWD-ZERO's own voice/runtime state, when it reports one. */
  | 'zero.state.changed';

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
  /* --- optional enrichment; absent on a plain registry ------------------- */
  /** Repository directory name — how the agent policy recognises the agent. */
  repo?: string;
  /** Absolute workspace on the operator's machine (display only). */
  cwd?: string;
  repository?: string;
  branch?: string;
  /** Capabilities that always require an explicit human approval. */
  requires_approval_for?: string[];
  /** Department, when the operator already classifies its agents. */
  department?: string;
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
  /**
   * Optional: the repositories the operator scanned, with the evidence used to
   * classify them. The interface classifies nothing on its own machine — it
   * only renders the classification of evidence the operator collected.
   */
  repositories?: (RepositoryEvidence & {
    repository?: string;
    branch?: string;
    description?: string;
  })[];
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

/** `/api/gateway/health` — served by the gateway itself, never by HWD-ZERO. */
export interface GatewayHealth {
  gateway: 'ok';
  lanMode: boolean;
  zeroApi: string;
  authRequired: boolean;
  websocketPaths: string[];
  upstream: { reachable: boolean; checkedAt: number; error?: string };
}

/* -------------------------------------------------------------------------- */
/*  /ws/voice — the voice channel contract                                     */
/* -------------------------------------------------------------------------- */

/** Frames the interface sends to HWD-ZERO. */
export type VoiceClientFrame =
  | { type: 'voice.hello'; language: string; client: string }
  /** Live, still-changing recognition result. */
  | { type: 'voice.partial'; text: string }
  /** The finished sentence. This is the handoff to HWD-ZERO. */
  | { type: 'voice.final'; text: string; language: string }
  /** A typed request — the same pipeline, without the microphone. */
  | { type: 'voice.text'; text: string }
  /** Ask the operator to voice a text it already produced. */
  | { type: 'voice.speak'; text: string }
  | { type: 'voice.cancel' };

/** Frames HWD-ZERO sends back. */
export type VoiceServerFrame =
  /** The operator's own runtime state, authoritative when present. */
  | { type: 'voice.state'; state: string; detail?: string }
  /** Server-side recognition, when the operator does the STT itself. */
  | { type: 'voice.partial'; text: string }
  | { type: 'voice.transcript'; text: string; final?: boolean }
  /** ZERO's answer as text. */
  | { type: 'voice.response'; text: string; mission_id?: string }
  /** One chunk of TTS audio. Base64 PCM16, or announced for binary frames. */
  | {
      type: 'voice.audio';
      format?: 'pcm16';
      sample_rate?: number;
      channels?: number;
      data?: string;
    }
  | { type: 'voice.audio.end' }
  | { type: 'voice.error'; message: string };

export interface VoiceAudioChunk {
  /** Interleaved PCM16 samples, already decoded from base64 or a binary frame. */
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}
