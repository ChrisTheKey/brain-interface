import { describe, expect, it } from 'vitest';
import { resolveZeroStatus, zeroNodeStatus } from '../src/zero/connectionState';

/** A fully connected, fully answered ZERO — the only shape that may be READY. */
const CONNECTED = {
  probed: true,
  gateway: 'healthy',
  zeroHttp: 'healthy',
  runtimeSocket: 'connected',
  runtimeConfigured: true,
  eventStream: 'open',
  runtimeResponded: true,
  operatorResponded: true,
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
    // operator stream down, the honest answer is DEGRADED — the lists are
    // stale and the brain has stopped moving.
    expect(
      resolveZeroStatus({ ...CONNECTED, runtimeSocket: 'disconnected', eventStream: 'closed' })
        .state,
    ).toBe('DEGRADED');

    // With nothing received and no socket, it is still only CONNECTING.
    expect(
      resolveZeroStatus({
        ...CONNECTED,
        runtimeSocket: 'disconnected',
        eventStream: 'closed',
        runtimeResponded: false,
        operatorResponded: false,
      }).state,
    ).toBe('CONNECTING');

    // An open socket that has not answered yet is CONNECTED, not READY.
    expect(
      resolveZeroStatus({ ...CONNECTED, runtimeResponded: false, operatorResponded: false }).state,
    ).toBe('BACKEND_CONNECTED');
  });

  it('reports DEGRADED when the operator stream is down', () => {
    expect(resolveZeroStatus({ ...CONNECTED, eventStream: 'closed' }).state).toBe('DEGRADED');
  });

  it('does not let an optional runtime app-server hold the interface below READY', () => {
    // A phone running HWD-ZERO under Termux has no codex app-server, and never
    // will. Waiting on a component this deployment does not run would mean
    // READY is unreachable no matter how healthy the operator is.
    const withoutRuntime = {
      ...CONNECTED,
      runtimeConfigured: false,
      runtimeSocket: 'idle',
      runtimeResponded: false,
    } as const;
    expect(resolveZeroStatus(withoutRuntime).state).toBe('READY');
    expect(resolveZeroStatus(withoutRuntime).ready).toBe(true);
  });

  it('does report a runtime that is configured and not connected', () => {
    // Configured and down is a real loss — the graph and the voice go with it.
    const status = resolveZeroStatus({ ...CONNECTED, runtimeSocket: 'disconnected' });
    expect(status.state).toBe('DEGRADED');
    expect(status.detail).toContain('runtime app-server');
    expect(status.ready).toBe(false);
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

  it('maps each state onto an honest ZERO node status', () => {
    expect(zeroNodeStatus('READY')).toBe('active');
    expect(zeroNodeStatus('BACKEND_OFFLINE')).toBe('error');
    expect(zeroNodeStatus('ERROR')).toBe('error');
    expect(zeroNodeStatus('SAFE_MODE')).toBe('idle');
    expect(zeroNodeStatus('STARTING')).toBe('notLoaded');
  });
});
