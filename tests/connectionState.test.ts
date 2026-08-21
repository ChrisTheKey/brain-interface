import { describe, expect, it } from 'vitest';
import {
  codexExecutorLevel,
  eventStreamLevel,
  resolveZeroStatus,
  runtimeLevel,
  zeroNodeLabel,
  zeroNodeStatus,
  ZERO_STATUS_DEFAULTS,
} from '../src/zero/connectionState';
import type { ZeroStatusInput } from '../src/zero/connectionState';

/** The levels take a complete input; tests describe only what differs. */
const full = (partial: Partial<ZeroStatusInput>): ZeroStatusInput => ({
  ...ZERO_STATUS_DEFAULTS,
  ...partial,
});

/** A fully connected, fully answered ZERO — the only shape that may be READY. */
const CONNECTED = {
  probed: true,
  gateway: 'healthy',
  zeroHttp: 'healthy',
  // The canonical runtime announced itself over HWD-ZERO's own stream.
  eventStream: 'open',
  runtimeAnnounced: true,
  operatorResponded: true,
  // A codex executor exists here and is down — which must change nothing.
  codexConfigured: true,
  codexSocket: 'disconnected',
} as const;

describe('ZERO connection state machine', () => {
  it('is STARTING before anything has been probed — never "loaded"', () => {
    const status = resolveZeroStatus({});
    expect(status.state).toBe('STARTING');
    expect(status.ready).toBe(false);
  });

  it('says BACKEND OFFLINE when HWD-ZERO cannot be reached, not notLoaded', () => {
    const status = resolveZeroStatus({ probed: true, gateway: 'healthy', zeroHttp: 'offline' });
    expect(status.state).toBe('BACKEND_OFFLINE');
    expect(status.headline).toBe('BACKEND OFFLINE');
    expect(status.ready).toBe(false);
    // The operator must be able to do something about it.
    expect(status.retryable).toBe(true);
  });

  it('reaches READY only when health, socket and a real answer all agree', () => {
    expect(resolveZeroStatus(CONNECTED).state).toBe('READY');
    expect(resolveZeroStatus(CONNECTED).ready).toBe(true);

    // Rendering the bundle proves nothing: with no backend evidence at all the
    // state is not READY, and never LOADED.
    expect(resolveZeroStatus({ probed: true, gateway: 'healthy' }).ready).toBe(false);

    // HTTP health alone is never enough. With data already in hand but the
    // event stream down, the honest answer is DEGRADED — the lists are stale
    // and the brain has stopped moving.
    expect(resolveZeroStatus({ ...CONNECTED, eventStream: 'closed' }).state).toBe('DEGRADED');

    // With nothing received and no stream, it is still only CONNECTING.
    expect(
      resolveZeroStatus({
        ...CONNECTED,
        eventStream: 'closed',
        runtimeAnnounced: false,
        operatorResponded: false,
      }).state,
    ).toBe('CONNECTING');

    // An open socket that has not answered yet is CONNECTED, not READY.
    expect(
      resolveZeroStatus({ ...CONNECTED, runtimeResponded: false, operatorResponded: false }).state,
    ).toBe('BACKEND_CONNECTED');
  });

  it('reports DEGRADED when the event stream is down', () => {
    expect(resolveZeroStatus({ ...CONNECTED, eventStream: 'closed' }).state).toBe('DEGRADED');
  });

  it('distinguishes a dead gateway from an offline backend', () => {
    // The gateway serves the page, so its silence is an error about this
    // origin — reporting it as "ZERO offline" would point at the wrong system.
    const status = resolveZeroStatus({ probed: true, gateway: 'offline', error: 'fetch failed' });
    expect(status.state).toBe('ERROR');
    expect(status.headline).toBe('GATEWAY ERROR');
  });

  it('asks for pairing rather than reporting a failure', () => {
    const status = resolveZeroStatus({ probed: true, gateway: 'healthy', authRequired: true });
    expect(status.state).toBe('AUTH_REQUIRED');
    expect(status.ready).toBe(false);
  });

  it('surfaces SAFE MODE as its own state, and never as READY', () => {
    const status = resolveZeroStatus({ ...CONNECTED, safeMode: true });
    expect(status.state).toBe('SAFE_MODE');
    expect(status.ready).toBe(false);
  });

  it('waits rather than guessing while the gateway has not classified ZERO yet', () => {
    expect(resolveZeroStatus({ probed: true, gateway: 'healthy', zeroHttp: 'unknown' }).state).toBe(
      'CONNECTING',
    );
  });

  // ------------------------------------------------------------------------
  // The canonical runtime is HWD-ZERO's ZeroSession. Codex is an executor.
  // ------------------------------------------------------------------------

  it('calls the runtime ONLINE from HWD-ZERO and its own stream', () => {
    // Health + the runtime having announced itself. Nothing about codex.
    expect(runtimeLevel(full(CONNECTED))).toBe('online');
  });

  it('reaches READY with codex offline', () => {
    const status = resolveZeroStatus(CONNECTED);
    expect(status.state).toBe('READY');
    expect(status.ready).toBe(true);
    // The executor really is down in this fixture, and it changed nothing.
    expect(codexExecutorLevel(full(CONNECTED))).toBe('offline');
  });

  it('reaches READY with no codex configured at all', () => {
    // Every phone. Waiting on a component this deployment will never run would
    // make READY unreachable no matter how healthy ZERO is.
    const noCodex = full({ ...CONNECTED, codexConfigured: false, codexSocket: 'idle' });
    expect(resolveZeroStatus(noCodex).state).toBe('READY');
    expect(codexExecutorLevel(noCodex)).toBe('not_configured');
    expect(runtimeLevel(noCodex)).toBe('online');
  });

  it('never lets an absent codex cause DEGRADED', () => {
    for (const codexSocket of ['idle', 'connecting', 'disconnected'] as const) {
      for (const codexConfigured of [true, false]) {
        const status = resolveZeroStatus({ ...CONNECTED, codexSocket, codexConfigured });
        expect(status.state).toBe('READY');
        expect(status.state).not.toBe('DEGRADED');
      }
    }
  });

  it('reports the runtime OFFLINE when HWD-ZERO is offline', () => {
    expect(runtimeLevel(full({ ...CONNECTED, zeroHttp: 'offline' }))).toBe('offline');
    // …even with a perfectly connected codex executor, which is not the runtime.
    expect(
      runtimeLevel(full({ ...CONNECTED, zeroHttp: 'offline', codexSocket: 'connected' })),
    ).toBe('offline');
  });

  it('reports the runtime OFFLINE while HWD-ZERO is healthy but silent', () => {
    // Healthy HTTP is not a runtime that answered. Until `zero.runtime.ready`
    // arrives, "online" would be a guess.
    expect(runtimeLevel(full({ ...CONNECTED, runtimeAnnounced: false }))).toBe('offline');
  });

  // ------------------------------------------------------------------------
  // FULL means complete event coverage, not "a second socket also connected".
  // ------------------------------------------------------------------------

  it('calls the stream FULL once the runtime announced itself on it', () => {
    expect(eventStreamLevel(full(CONNECTED))).toBe('full');
  });

  it('calls an open but silent stream PARTIAL', () => {
    expect(eventStreamLevel(full({ ...CONNECTED, runtimeAnnounced: false }))).toBe('partial');
  });

  it('calls a closed stream OFFLINE', () => {
    for (const eventStream of ['closed', 'unreachable', 'connecting'] as const) {
      expect(eventStreamLevel(full({ ...CONNECTED, eventStream }))).toBe('offline');
    }
  });

  it('does not downgrade a full stream because codex is missing', () => {
    // The old panel said PARTIAL for exactly this, and it was wrong: a second,
    // optional socket has nothing to do with ZERO's event coverage.
    expect(
      eventStreamLevel(full({ ...CONNECTED, codexConfigured: false, codexSocket: 'idle' })),
    ).toBe('full');
    expect(eventStreamLevel(full({ ...CONNECTED, codexSocket: 'disconnected' }))).toBe('full');
  });

  it('maps each state onto an honest ZERO node status', () => {
    expect(zeroNodeStatus('READY')).toBe('active');
    expect(zeroNodeStatus('BACKEND_OFFLINE')).toBe('error');
    expect(zeroNodeStatus('ERROR')).toBe('error');
    expect(zeroNodeStatus('SAFE_MODE')).toBe('idle');
    expect(zeroNodeStatus('STARTING')).toBe('notLoaded');
  });

  it('never calls the ZERO node notLoaded once the runtime is online', () => {
    // `notLoaded` describes a missing snapshot. Read as a statement about the
    // runtime it is meaningless, and that is what the panel was doing.
    expect(zeroNodeStatus(resolveZeroStatus(CONNECTED).state)).not.toBe('notLoaded');
    expect(zeroNodeLabel('online', 'READY')).toBe('READY');
    expect(zeroNodeLabel('online', 'BACKEND_CONNECTED')).toBe('ONLINE');
    // It survives only for the case it actually describes.
    expect(zeroNodeLabel('offline', 'STARTING')).toBe('notLoaded');
  });
});
