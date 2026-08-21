/**
 * The ZERO connection state machine.
 *
 * The interface used to say `notLoaded`, which described the *graph* — "no
 * snapshot yet" — and was read as a statement about ZERO. It is not one. A
 * loaded React bundle proves nothing about the backend, so this module keeps
 * the two strictly apart:
 *
 *     UI LOADED   ≠   ZERO READY
 *
 * `READY` requires three independent facts at the same time:
 *
 *   1. the gateway's HTTP health probe reaches HWD-ZERO,
 *   2. the same-origin `/ws/events` socket is open, and
 *   3. the canonical runtime answered — `zero.runtime.ready` on that stream.
 *
 * What is deliberately *not* in that list: the codex app-server. ZERO's
 * runtime is HWD-ZERO's `ZeroSession` — brain, missions, policy, verification,
 * child agents. Codex, Claude and Ollama are executors ZERO may drive. Treating
 * an executor as the runtime is what made the panel say `ZERO RUNTIME OFFLINE`
 * while HWD-ZERO was perfectly healthy, and it made READY unreachable on any
 * device that will never run codex.
 *
 * Anything less is named for what it is, so the operator sees the truth
 * instead of a spinner.
 */

/** Every state the interface may report about ZERO. */
export type ZeroState =
  | 'STARTING'
  | 'CONNECTING'
  | 'AUTH_REQUIRED'
  | 'BACKEND_OFFLINE'
  | 'BACKEND_CONNECTED'
  | 'DEGRADED'
  | 'READY'
  | 'ERROR'
  | 'SAFE_MODE';

/** What the gateway itself reports about an upstream. */
export type ProbeResult = 'unknown' | 'healthy' | 'offline';

/** How much of ZERO's event stream is actually working. */
export type EventStreamLevel = 'offline' | 'partial' | 'full';

/** The canonical runtime — HWD-ZERO's ZeroSession, never an executor. */
export type RuntimeLevel = 'unknown' | 'online' | 'offline';

/** An optional executor ZERO may drive. Never part of READY. */
export type ExecutorLevel = 'not_configured' | 'online' | 'offline';

/** Runtime socket state, mirroring `ZeroClient`. */
export type SocketState = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** Operator event-stream state, mirroring `HwdZeroClient`. */
export type StreamState = 'connecting' | 'open' | 'closed' | 'unreachable';

export interface ZeroStatusInput {
  /** False until the first `/api/health` round-trip finished, either way. */
  probed: boolean;
  /** Did the gateway on this origin answer at all? */
  gateway: ProbeResult;
  /** Does the gateway demand a pairing token we do not hold? */
  authRequired: boolean;
  /** HWD-ZERO's HTTP health, as seen by the gateway (never by the browser). */
  zeroHttp: ProbeResult;
  /**
   * The optional codex executor's socket, through `/ws`.
   *
   * Reported, never required. It is one of several executors ZERO may drive,
   * and a phone running HWD-ZERO under Termux will never have one.
   */
  codexSocket: SocketState;
  /** Is a codex executor configured at all? */
  codexConfigured: boolean;
  /**
   * Did the canonical runtime announce itself on `/ws/events`?
   *
   * This is the `zero.runtime.ready` frame HWD-ZERO sends to every subscriber
   * the moment it connects. It is the difference between a socket that is open
   * and a stream that is working.
   */
  runtimeAnnounced: boolean;
  /** Operator event stream, through `/ws/events`. */
  eventStream: StreamState;
  /** True once ZERO's runtime returned a real snapshot. */
  runtimeResponded: boolean;
  /** True once HWD-ZERO returned real operator state. */
  operatorResponded: boolean;
  /** HWD-ZERO's kill switch. */
  safeMode: boolean;
  /** A failure worth surfacing verbatim; empty when there is none. */
  error: string;
}

export interface ZeroStatus {
  state: ZeroState;
  /** Short, uppercase, for the ZERO panel headline. */
  headline: string;
  /** One sentence a human can act on. */
  detail: string;
  /** True only when every precondition below is genuinely satisfied. */
  ready: boolean;
  /** Should the interface offer a retry button? */
  retryable: boolean;
}

export const ZERO_STATUS_DEFAULTS: ZeroStatusInput = {
  probed: false,
  gateway: 'unknown',
  authRequired: false,
  zeroHttp: 'unknown',
  codexSocket: 'idle',
  codexConfigured: false,
  runtimeAnnounced: false,
  eventStream: 'connecting',
  runtimeResponded: false,
  operatorResponded: false,
  safeMode: false,
  error: '',
};

/**
 * The stream that matters: HWD-ZERO's own `/ws/events`.
 *
 * READY turns on this one and nothing else. A deployment that never runs a
 * codex app-server — every phone — must still be able to reach READY.
 */
function operatorStreamOpen(input: ZeroStatusInput): boolean {
  return input.eventStream === 'open';
}

function backendResponded(input: ZeroStatusInput): boolean {
  return input.runtimeResponded || input.operatorResponded;
}

/**
 * How complete the event stream is.
 *
 * `full` means the socket is open *and* the runtime announced itself on it —
 * complete event coverage, so missions, agents and approvals all arrive here.
 * `partial` is an open socket that has not spoken yet. An optional executor's
 * separate socket has nothing to do with either.
 */
export function eventStreamLevel(input: ZeroStatusInput): EventStreamLevel {
  if (!operatorStreamOpen(input)) return 'offline';
  return input.runtimeAnnounced ? 'full' : 'partial';
}

/**
 * Is the canonical runtime up?
 *
 * HWD-ZERO healthy, plus the runtime having announced itself over the stream.
 * `ZeroSession` is the runtime; no executor appears in this answer.
 */
export function runtimeLevel(input: ZeroStatusInput): RuntimeLevel {
  if (input.zeroHttp === 'unknown') return 'unknown';
  if (input.zeroHttp !== 'healthy') return 'offline';
  return input.runtimeAnnounced && operatorStreamOpen(input) ? 'online' : 'offline';
}

/** The optional codex executor. Reported for the operator, never a gate. */
export function codexExecutorLevel(input: ZeroStatusInput): ExecutorLevel {
  if (!input.codexConfigured) return 'not_configured';
  return input.codexSocket === 'connected' ? 'online' : 'offline';
}

/**
 * Fold the observations into one state. Pure and total: the same inputs always
 * produce the same state, and there is no input for which the answer is
 * "READY, probably".
 */
export function resolveZeroStatus(partial: Partial<ZeroStatusInput> = {}): ZeroStatus {
  const input: ZeroStatusInput = { ...ZERO_STATUS_DEFAULTS, ...partial };

  // The gateway serves this bundle, so if it stops answering the page is
  // looking at a dead origin — that is an error, not an offline backend.
  if (input.probed && input.gateway === 'offline') {
    return {
      state: 'ERROR',
      headline: 'GATEWAY ERROR',
      detail:
        input.error || 'The ZERO gateway on this origin stopped answering. Restart scripts/zero-go.sh.',
      ready: false,
      retryable: true,
    };
  }

  if (input.authRequired) {
    return {
      state: 'AUTH_REQUIRED',
      headline: 'AUTH REQUIRED',
      detail: 'Open the pairing link printed by scripts/start-zero-lan.sh — it carries the token.',
      ready: false,
      retryable: true,
    };
  }

  if (!input.probed) {
    return {
      state: 'STARTING',
      headline: 'STARTING',
      detail: 'Asking the gateway what is actually running.',
      ready: false,
      retryable: false,
    };
  }

  if (input.zeroHttp === 'offline') {
    return {
      state: 'BACKEND_OFFLINE',
      headline: 'BACKEND OFFLINE',
      detail: input.error || 'HWD-ZERO could not be reached. The interface is up, the operator is not.',
      ready: false,
      retryable: true,
    };
  }

  if (input.zeroHttp === 'unknown') {
    return {
      state: 'CONNECTING',
      headline: 'CONNECTING',
      detail: 'The gateway is still establishing what HWD-ZERO reports.',
      ready: false,
      retryable: false,
    };
  }

  // From here HWD-ZERO's HTTP health is good.
  if (input.safeMode) {
    return {
      state: 'SAFE_MODE',
      headline: 'SAFE MODE',
      detail: 'HWD-ZERO is reachable, and the kill switch refuses every execution.',
      ready: false,
      retryable: false,
    };
  }

  if (runtimeLevel(input) === 'online' && backendResponded(input)) {
    // A configured codex executor that is down is worth naming somewhere, but
    // not here: it is one of several executors ZERO may drive, and ZERO is up.
    return {
      state: 'READY',
      headline: 'READY',
      detail: 'HWD-ZERO is healthy, ZeroSession is online and the event stream is full.',
      ready: true,
      retryable: false,
    };
  }

  if (operatorStreamOpen(input)) {
    return {
      state: 'BACKEND_CONNECTED',
      headline: 'BACKEND CONNECTED',
      detail: input.runtimeAnnounced
        ? 'The runtime announced itself — waiting for its first state.'
        : 'Connected through /ws/events — waiting for the runtime to announce itself.',
      ready: false,
      retryable: false,
    };
  }

  if (backendResponded(input)) {
    return {
      state: 'DEGRADED',
      headline: 'DEGRADED',
      detail: 'HWD-ZERO answers over HTTP, but its event stream is down.',
      ready: false,
      retryable: true,
    };
  }

  if (input.error) {
    return {
      state: 'ERROR',
      headline: 'ERROR',
      detail: input.error,
      ready: false,
      retryable: true,
    };
  }

  return {
    state: 'CONNECTING',
    headline: 'CONNECTING',
    detail: 'HWD-ZERO is healthy — opening the same-origin event stream.',
    ready: false,
    retryable: false,
  };
}

/**
 * Maps the state onto the ZERO node's visual status in the graph.
 *
 * `notLoaded` now means only one thing: no runtime snapshot exists yet. Once
 * the runtime is online the node says so, rather than describing the absence
 * of a graph the codex executor would have supplied.
 */
export function zeroNodeStatus(state: ZeroState): 'active' | 'idle' | 'error' | 'notLoaded' {
  switch (state) {
    case 'READY':
      return 'active';
    case 'BACKEND_CONNECTED':
    case 'SAFE_MODE':
      return 'idle';
    case 'BACKEND_OFFLINE':
    case 'ERROR':
    case 'AUTH_REQUIRED':
      return 'error';
    default:
      return 'notLoaded';
  }
}

/** What the ZERO node should be called, given the runtime's real state. */
export function zeroNodeLabel(runtime: RuntimeLevel, state: ZeroState): string {
  if (runtime === 'online') return state === 'READY' ? 'READY' : 'ONLINE';
  if (runtime === 'unknown') return 'connecting';
  return state === 'BACKEND_OFFLINE' ? 'backend offline' : 'notLoaded';
}

/** The one-line description under the ZERO node. */
export function zeroNodeDescription(runtime: RuntimeLevel): string {
  return runtime === 'online'
    ? 'Central orchestrator · Runtime ONLINE (ZeroSession)'
    : 'Central orchestrator (HWD-ZERO · ZeroSession).';
}
