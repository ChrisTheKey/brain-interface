/**
 * ZERO's runtime state, as the interface shows it.
 *
 * Every state is derived from something that really happened: a flag the
 * operator reports (`safe_mode`), a gate that is genuinely open, an event on
 * `/ws/events`, or a local fact about this browser (the microphone is open,
 * audio is playing). Nothing here runs on a timer and nothing is inferred from
 * the length of a sentence.
 *
 * The reducer is pure so the whole state machine is unit-testable.
 */
import type { OperatorConnection, OperatorEvent } from '../hwd/types';

export const RUNTIME_STATES = [
  'IDLE',
  'LISTENING',
  'FINALIZING',
  'THINKING',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VERIFYING',
  'SPEAKING',
  'ERROR',
  'SAFE_MODE',
] as const;

export type ZeroRuntimeState = (typeof RUNTIME_STATES)[number];

/** Where a mission is in its lifecycle, folded from the event stream. */
export type MissionPhase =
  | 'created'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed';

export interface RuntimeSignals {
  connection: OperatorConnection;
  /** HWD-ZERO's kill switch. A global halt — it outranks everything. */
  safeMode: boolean;
  /** Gates a mission is genuinely stopped on. */
  approvalsPending: number;
  /** The microphone is open right now. */
  micOpen: boolean;
  /** Recognition ended; the final sentence is being handed to HWD-ZERO. */
  finalizing: boolean;
  /** The transcript is with HWD-ZERO and no answer has arrived yet. */
  awaitingResponse: boolean;
  /** TTS audio is actually playing. */
  speaking: boolean;
  /** Latest mission lifecycle phase from `/ws/events`. */
  missionPhase: MissionPhase | null;
  /** A hard error the session or the operator surfaced. Cleared on a new turn. */
  error: string | null;
  /**
   * A state HWD-ZERO reported itself (`voice.state` frame or
   * `zero.state.changed` event). Authoritative for the mission tier — the
   * operator knows better than a fold over events — but it can never override
   * SAFE_MODE, an open gate, or a local microphone/speaker fact.
   */
  reported: string | null;
}

export const IDLE_SIGNALS: RuntimeSignals = {
  connection: 'connecting',
  safeMode: false,
  approvalsPending: 0,
  micOpen: false,
  finalizing: false,
  awaitingResponse: false,
  speaking: false,
  missionPhase: null,
  error: null,
  reported: null,
};

/** Only the mission-tier states may be adopted from a reported string. */
const REPORTABLE = new Set<ZeroRuntimeState>([
  'IDLE',
  'THINKING',
  'PLANNING',
  'EXECUTING',
  'VERIFYING',
]);

export function normalizeReportedState(value: string | null | undefined): ZeroRuntimeState | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const match = RUNTIME_STATES.find((state) => state === upper);
  return match && REPORTABLE.has(match) ? match : null;
}

/** Folds one operator event into a mission phase; `null` = not a lifecycle event. */
export function missionPhaseFromEvent(event: Pick<OperatorEvent, 'type'>): MissionPhase | null {
  switch (event.type) {
    case 'mission.created':
      return 'created';
    case 'mission.planning':
      return 'planning';
    case 'mission.executing':
    case 'agent.started':
    case 'agent.activity':
      return 'executing';
    case 'mission.verifying':
      return 'verifying';
    case 'mission.completed':
      return 'completed';
    case 'mission.failed':
      return 'failed';
    default:
      return null;
  }
}

/** The newest lifecycle phase in a list of events (events are oldest-first). */
export function foldMissionPhase(events: readonly Pick<OperatorEvent, 'type'>[]): MissionPhase | null {
  let phase: MissionPhase | null = null;
  for (const event of events) {
    const next = missionPhaseFromEvent(event);
    if (next) phase = next;
  }
  return phase;
}

/**
 * The one place that decides what ZERO is doing.
 *
 * Priority, highest first:
 *   SAFE_MODE          the operator refuses to execute anything
 *   ERROR              something really failed and has not been superseded
 *   AWAITING_APPROVAL  a gate is open and a human is required
 *   LISTENING          the microphone is open (barge-in beats everything below)
 *   FINALIZING         the sentence is closed and on its way to HWD-ZERO
 *   SPEAKING           TTS audio is playing
 *   VERIFYING / EXECUTING / PLANNING / THINKING   the mission tier
 *   IDLE
 */
export function deriveRuntimeState(signals: RuntimeSignals): ZeroRuntimeState {
  if (signals.safeMode) return 'SAFE_MODE';
  if (signals.error) return 'ERROR';
  if (signals.connection === 'unreachable') return 'ERROR';
  if (signals.approvalsPending > 0) return 'AWAITING_APPROVAL';
  if (signals.micOpen) return 'LISTENING';
  if (signals.finalizing) return 'FINALIZING';
  if (signals.speaking) return 'SPEAKING';

  const reported = normalizeReportedState(signals.reported);
  if (reported && reported !== 'IDLE') return reported;

  switch (signals.missionPhase) {
    case 'verifying':
      return 'VERIFYING';
    case 'executing':
      return 'EXECUTING';
    case 'planning':
      return 'PLANNING';
    case 'created':
      return 'THINKING';
    default:
      break;
  }

  if (signals.awaitingResponse) return 'THINKING';
  return 'IDLE';
}

export interface RuntimeStateVisual {
  label: string;
  /** Accent colour of the state, used by the HUD and by the core shader. */
  accent: string;
  /** How agitated the brain is in this state, 0..1. */
  agitation: number;
  /** True while ZERO genuinely needs a human. */
  demandsHuman: boolean;
}

/**
 * The visual signature of each state. Colours stay inside the reference
 * plate's palette (obsidian, magenta, crimson) so the brain never turns into
 * a traffic light.
 */
export const RUNTIME_STATE_VISUALS: Record<ZeroRuntimeState, RuntimeStateVisual> = {
  IDLE: { label: 'idle', accent: '#6a6f86', agitation: 0.05, demandsHuman: false },
  LISTENING: { label: 'listening', accent: '#7fd8ff', agitation: 0.35, demandsHuman: false },
  FINALIZING: { label: 'finalizing', accent: '#9fc6ff', agitation: 0.45, demandsHuman: false },
  THINKING: { label: 'thinking', accent: '#b98cff', agitation: 0.55, demandsHuman: false },
  PLANNING: { label: 'planning', accent: '#d07bff', agitation: 0.62, demandsHuman: false },
  AWAITING_APPROVAL: {
    label: 'awaiting approval',
    accent: '#ffb066',
    agitation: 0.5,
    demandsHuman: true,
  },
  EXECUTING: { label: 'executing', accent: '#ff4fa3', agitation: 0.85, demandsHuman: false },
  VERIFYING: { label: 'verifying', accent: '#63e0c0', agitation: 0.6, demandsHuman: false },
  SPEAKING: { label: 'speaking', accent: '#ff7ac6', agitation: 0.75, demandsHuman: false },
  ERROR: { label: 'error', accent: '#ff5f57', agitation: 0.9, demandsHuman: true },
  SAFE_MODE: { label: 'safe mode', accent: '#ff3b30', agitation: 0.02, demandsHuman: true },
};
