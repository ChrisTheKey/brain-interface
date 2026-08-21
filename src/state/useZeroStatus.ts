/**
 * The one place that decides what the interface is allowed to claim about ZERO.
 *
 * It polls the gateway's composite health on the same origin, folds it
 * together with the two live sockets, and runs the result through the pure
 * state machine in `src/zero/connectionState.ts`. Nothing here infers a
 * healthy backend from a rendered component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZERO_HEALTH_PATH } from '../zero/endpoints';
import { onNetworkWake } from '../zero/lifecycle';
import {
  codexExecutorLevel,
  eventStreamLevel,
  resolveZeroStatus,
  runtimeLevel,
  ZERO_STATUS_DEFAULTS,
  type EventStreamLevel,
  type ExecutorLevel,
  type ProbeResult,
  type RuntimeLevel,
  type SocketState,
  type StreamState,
  type ZeroStatus,
} from '../zero/connectionState';
import type { GatewayHealth } from '../hwd/types';

/** While the chain is not up yet, ask often; once it is, stop hammering it. */
const HEALTH_INTERVAL_UNHEALTHY_MS = 5_000;
const HEALTH_INTERVAL_HEALTHY_MS = 20_000;

export interface ZeroStatusSources {
  /** The optional codex executor's socket. Never a gate on READY. */
  codexSocket: SocketState;
  /** HWD-ZERO's own event stream — the one that matters. */
  eventStream: StreamState;
  /** Did `zero.runtime.ready` arrive on that stream? */
  runtimeAnnounced: boolean;
  runtimeResponded: boolean;
  operatorResponded: boolean;
  safeMode: boolean;
  /** A failure the sockets already reported; empty when there is none. */
  error?: string;
}

export interface ZeroStatusView extends ZeroStatus {
  /** The gateway's last health payload, or null before the first answer. */
  health: GatewayHealth | null;
  /** How complete ZERO's event stream is: offline, partial or full. */
  eventStream: EventStreamLevel;
  /** The canonical runtime — HWD-ZERO's ZeroSession. */
  runtime: RuntimeLevel;
  /** The optional codex executor, reported but never required. */
  codexExecutor: ExecutorLevel;
  /** Re-probe now (the Retry button, and every browser wake-up). */
  retry: () => void;
}

async function fetchHealth(signal: AbortSignal): Promise<GatewayHealth> {
  const response = await fetch(ZERO_HEALTH_PATH, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  // 503 is a *valid* health answer ("gateway up, ZERO offline"), so the body is
  // read either way; only an unparseable answer is a failure.
  const payload = (await response.json()) as GatewayHealth;
  if (typeof payload?.gateway !== 'string') throw new Error('gateway returned no health payload');
  return payload;
}

export function useZeroStatus(sources: ZeroStatusSources): ZeroStatusView {
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [probed, setProbed] = useState(false);
  const [gateway, setGateway] = useState<ProbeResult>('unknown');
  const [probeError, setProbeError] = useState('');
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  const retry = useCallback(() => setNonce((value) => value + 1), []);

  const healthy = health?.zero === 'healthy';

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async (): Promise<void> => {
      try {
        const payload = await fetchHealth(controller.signal);
        if (!mounted.current || stopped) return;
        setHealth(payload);
        setGateway('healthy');
        setProbeError('');
      } catch (error) {
        if (!mounted.current || stopped) return;
        // The gateway serves this page, so a failure here is the origin itself
        // being gone — reported as such, never as "ZERO offline".
        setGateway('offline');
        setProbeError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mounted.current && !stopped) {
          setProbed(true);
          timer = setTimeout(
            () => void tick(),
            healthy ? HEALTH_INTERVAL_HEALTHY_MS : HEALTH_INTERVAL_UNHEALTHY_MS,
          );
        }
      }
    };

    void tick();

    return () => {
      stopped = true;
      mounted.current = false;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [nonce, healthy]);

  // Unlocking the phone, switching WiFi, or restoring the tab re-probes at
  // once rather than waiting out the poll interval.
  useEffect(() => onNetworkWake(retry), [retry]);

  const input = useMemo(
    () => ({
      probed,
      gateway,
      authRequired: health?.authRequired ?? false,
      zeroHttp: (health
        ? health.zero === 'healthy'
          ? 'healthy'
          : 'offline'
        : 'unknown') as ProbeResult,
      codexSocket: sources.codexSocket,
      // The gateway is the only thing that knows whether a codex executor
      // exists at all; the browser must not assume one.
      codexConfigured: health?.runtimeConfigured ?? false,
      runtimeAnnounced: sources.runtimeAnnounced,
      eventStream: sources.eventStream,
      runtimeResponded: sources.runtimeResponded,
      operatorResponded: sources.operatorResponded,
      safeMode: sources.safeMode,
      error: sources.error || probeError,
    }),
    [
      probed,
      gateway,
      health,
      probeError,
      sources.codexSocket,
      sources.runtimeAnnounced,
      sources.eventStream,
      sources.runtimeResponded,
      sources.operatorResponded,
      sources.safeMode,
      sources.error,
    ],
  );

  const status = useMemo(() => resolveZeroStatus(input), [input]);

  return {
    ...status,
    health,
    retry,
    eventStream: eventStreamLevel({ ...ZERO_STATUS_DEFAULTS, ...input }),
    runtime: runtimeLevel({ ...ZERO_STATUS_DEFAULTS, ...input }),
    codexExecutor: codexExecutorLevel({ ...ZERO_STATUS_DEFAULTS, ...input }),
  };
}
