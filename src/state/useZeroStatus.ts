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
  resolveZeroStatus,
  type ProbeResult,
  type SocketState,
  type StreamState,
  type ZeroStatus,
} from '../zero/connectionState';
import type { GatewayHealth } from '../hwd/types';

/** While the chain is not up yet, ask often; once it is, stop hammering it. */
const HEALTH_INTERVAL_UNHEALTHY_MS = 5_000;
const HEALTH_INTERVAL_HEALTHY_MS = 20_000;

export interface ZeroStatusSources {
  runtimeSocket: SocketState;
  eventStream: StreamState;
  runtimeResponded: boolean;
  operatorResponded: boolean;
  safeMode: boolean;
  /** A failure the sockets already reported; empty when there is none. */
  error?: string;
}

export interface ZeroStatusView extends ZeroStatus {
  /** The gateway's last health payload, or null before the first answer. */
  health: GatewayHealth | null;
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

  const status = useMemo(
    () =>
      resolveZeroStatus({
        probed,
        gateway,
        authRequired: health?.authRequired ?? false,
        zeroHttp: health ? (health.zero === 'healthy' ? 'healthy' : 'offline') : 'unknown',
        runtimeSocket: sources.runtimeSocket,
        // The gateway is the only thing that knows whether a runtime
        // app-server exists at all; the browser must not assume one.
        runtimeConfigured: health?.runtimeConfigured ?? false,
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
      sources.runtimeSocket,
      sources.eventStream,
      sources.runtimeResponded,
      sources.operatorResponded,
      sources.safeMode,
      sources.error,
    ],
  );

  return { ...status, health, retry };
}
