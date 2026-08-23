/**
 * Whether ZERO can read the ad account, and whether it could change it.
 *
 * Those are two different questions and this hook keeps them apart, because
 * the answers differ for real reasons: Meta rolls the Ads MCP out by account,
 * a login may carry `ads_read` without `ads_management`, and a rollout may
 * publish read tools and no write tools. Collapsing them into "connected"
 * would let the interface imply ZERO could change something it cannot.
 *
 * Nothing here holds a token. The runtime does not send one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MetaAdsStatus, OperatorEvent } from '../hwd/types';

export interface MetaAdsView {
  status: MetaAdsStatus | null;
  loading: boolean;
  error: string;
  /** One line for the panel, and for reading back over voice. */
  summary: string;
  /** Why writing is impossible, in words, or an empty string when it is not. */
  manageBlocker: string;
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  selectAccount: (account: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/** Events that change what this panel should say. */
const WATCHED = new Set([
  'zero.ads.connected',
  'zero.ads.done',
  'zero.ads.partial',
  'zero.ads.error',
  'zero.ads.refused',
]);

export function metaAdsSummary(status: MetaAdsStatus | null): string {
  if (!status) return 'META ADS · UNKNOWN';
  if (status.blocked_by === 'local_only') return 'META ADS · BLOCKED BY LOCAL-ONLY MODE';
  if (status.blocked_by === 'meta_disabled') return 'META ADS · OFF';
  if (status.auth_state?.state === 'reauthentication_required') {
    return 'META ADS · REAUTHENTICATION REQUIRED';
  }
  if (!status.connected) return 'META ADS · DISCONNECTED';
  if (status.rollout === 'disabled') return 'META ADS MCP · NOT ENABLED FOR THIS ACCOUNT';
  // Connected and readable is the common case; whether it can *manage* is a
  // separate line in the panel, so this one does not pretend to answer it.
  if (!status.read_ready) return 'META ADS · DEGRADED';
  return status.mutation_ready ? 'META ADS · CONNECTED' : 'META ADS · READ ONLY';
}

/** Why ZERO cannot change this account, in words the operator can act on. */
export function manageBlocker(status: MetaAdsStatus | null): string {
  if (!status || !status.connected || status.blocked_by) return '';
  if (status.mutation_ready) return '';
  switch (status.mutation_reason) {
    case 'meta_rollout_disabled':
      return 'Meta has not switched the Ads MCP on for this account yet.';
    case 'meta_scope_missing':
      return 'This connection has no ads_management scope — sign in again to manage.';
    case 'meta_no_write_tools':
      return 'This rollout publishes no mutation tools.';
    default:
      return status.reason ?? '';
  }
}

interface MetaAdsClientLike {
  metaAdsStatus: () => Promise<MetaAdsStatus>;
  metaAdsConnect: () => Promise<{ authorization_url: string; state: string }>;
  metaAdsDisconnect: () => Promise<{ connected: boolean }>;
  selectAdAccount: (account: string) => Promise<{ selected: { id: string; label: string } }>;
}

export function useMetaAds(
  client: MetaAdsClientLike,
  events: OperatorEvent[] = [],
): MetaAdsView {
  const [status, setStatus] = useState<MetaAdsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const apply = useCallback((next: MetaAdsStatus | null, cause?: unknown) => {
    setStatus(next);
    setError(cause === undefined ? '' : cause instanceof Error ? cause.message : String(cause));
    setLoading(false);
  }, []);

  const refresh = useCallback(
    () =>
      client
        .metaAdsStatus()
        .then((next) => apply(next))
        .catch((cause: unknown) => apply(null, cause)),
    [client, apply],
  );

  // Re-read after anything that could have changed the answer, rather than on
  // a timer: a poll every ten seconds on a phone is a poll that runs all night.
  const trigger = useMemo(
    () => events.filter((event) => WATCHED.has(event.type)).at(-1)?.event_id ?? '',
    [events],
  );

  useEffect(() => {
    let cancelled = false;
    void client
      .metaAdsStatus()
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
    const started = await client.metaAdsConnect();
    return started.authorization_url;
  }, [client]);

  const disconnect = useCallback(async () => {
    await client.metaAdsDisconnect();
    await refresh();
  }, [client, refresh]);

  const selectAccount = useCallback(
    async (account: string) => {
      await client.selectAdAccount(account);
      await refresh();
    },
    [client, refresh],
  );

  return {
    status,
    loading,
    error,
    summary: metaAdsSummary(status),
    manageBlocker: manageBlocker(status),
    connect,
    disconnect,
    selectAccount,
    refresh,
  };
}
