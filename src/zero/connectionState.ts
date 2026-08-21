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
 *   2. the WebSocket is actually open through the same origin,
 *   3. ZERO itself answered with real payload (a snapshot or operator state).
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

/** What the gateway itself reports about the two upstreams. */
export type ProbeResult = 'unknown' | 'healthy' | 'offline';

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
  /** ZERO runtime socket, through `/ws`. */
  runtimeSocket: SocketState;
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
  runtimeSocket: 'idle',
  eventStream: 'connecting',
  runtimeResponded: false,
  operatorResponded: false,
  safeMode: false,
  error: '',
};

function socketOpen(input: ZeroStatusInput): boolean {
  return input.runtimeSocket === 'connected' || input.eventStream === 'open';
}

function socketFullyOpen(input: ZeroStatusInput): boolean {
  return input.runtimeSocket === 'connected' && input.eventStream === 'open';
}

function backendResponded(input: ZeroStatusInput): boolean {
  return input.runtimeResponded || input.operatorResponded;
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

  if (socketFullyOpen(input) && backendResponded(input)) {
    return {
      state: 'READY',
      headline: 'READY',
      detail: 'HTTP health, event stream and the ZERO runtime all answered.',
      ready: true,
      retryable: false,
    };
  }

  if (socketFullyOpen(input)) {
    return {
      state: 'BACKEND_CONNECTED',
      headline: 'BACKEND CONNECTED',
      detail: 'Connected through /ws — waiting for the first real answer from ZERO.',
      ready: false,
      retryable: false,
    };
  }

  if (socketOpen(input) || backendResponded(input)) {
    return {
      state: 'DEGRADED',
      headline: 'DEGRADED',
      detail: 'HWD-ZERO answers over HTTP, but the same-origin event stream is not fully up.',
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

/** Maps the state onto the ZERO node's visual status in the graph. */
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
