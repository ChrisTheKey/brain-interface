/**
 * Whether ZERO can publish, and to what.
 *
 * Read from the runtime rather than assumed, and refreshed on the events that
 * actually change it. The panel this feeds says CONNECTED or it says why not —
 * there is no state in which the interface implies ZERO could post and it
 * turns out it could not.
 *
 * Nothing here ever holds a token. The runtime does not send one, and the only
 * thing this module could leak is the number of brands.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MetricoolStatus, OperatorEvent } from '../hwd/types';

export interface MetricoolView {
  status: MetricoolStatus | null;
  /** True while the first read is in flight — distinct from "not connected". */
  loading: boolean;
  error: string;
  /** One line for the panel, and for reading back over voice. */
  summary: string;
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** Events that change what this panel should say. */
const WATCHED = new Set([
  'zero.social.connected',
  'zero.social.published',
  'zero.social.partial',
  'zero.social.failed',
  'zero.social.refused',
]);

export function metricoolSummary(status: MetricoolStatus | null): string {
  if (!status) return 'METRICOOL · UNKNOWN';
  if (status.blocked_by === 'local_only') return 'METRICOOL · BLOCKED BY LOCAL-ONLY MODE';
  if (status.blocked_by === 'metricool_disabled') return 'METRICOOL · OFF';
  if (!status.connected) return 'METRICOOL · DISCONNECTED';
  // Connected is not the same as able to publish, so both are said.
  const networks = status.networks.length;
  if (!status.publishing_ready) {
    return `METRICOOL · CONNECTED · ${networks} NETWORK${networks === 1 ? '' : 'S'} · NOT READY`;
  }
  return `METRICOOL · CONNECTED · ${networks} NETWORK${networks === 1 ? '' : 'S'}`;
}

interface MetricoolClientLike {
  metricoolStatus: () => Promise<MetricoolStatus>;
  metricoolConnect: () => Promise<{ authorization_url: string; state: string }>;
  metricoolDisconnect: () => Promise<{ connected: boolean }>;
}

export function useMetricool(
  client: MetricoolClientLike,
  events: OperatorEvent[] = [],
): MetricoolView {
  const [status, setStatus] = useState<MetricoolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const apply = useCallback((next: MetricoolStatus | null, cause?: unknown) => {
    setStatus(next);
    // The runtime being down is reported elsewhere; a second banner for it
    // would say nothing new. What matters here is that the panel stops showing
    // a stale CONNECTED for something it can no longer see.
    setError(cause === undefined ? '' : cause instanceof Error ? cause.message : String(cause));
    setLoading(false);
  }, []);

  const refresh = useCallback(
    () =>
      client
        .metricoolStatus()
        .then((next) => apply(next))
        .catch((cause: unknown) => apply(null, cause)),
    [client, apply],
  );

  // Re-read after anything that could have changed the answer, rather than on
  // a timer: a poll that runs every ten seconds on a phone is a poll that runs
  // all night for nothing. The empty string is the first read.
  const trigger = useMemo(
    () => events.filter((event) => WATCHED.has(event.type)).at(-1)?.event_id ?? '',
    [events],
  );

  useEffect(() => {
    let cancelled = false;
    void client
      .metricoolStatus()
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) apply(null, cause);
      });
    return () => {
      cancelled = true;
    };
  }, [client, apply, trigger]);

  const connect = useCallback(async () => {
    const started = await client.metricoolConnect();
    return started.authorization_url;
  }, [client]);

  const disconnect = useCallback(async () => {
    await client.metricoolDisconnect();
    await refresh();
  }, [client, refresh]);

  return {
    status,
    loading,
    error,
    summary: metricoolSummary(status),
    connect,
    disconnect,
    refresh,
  };
}
