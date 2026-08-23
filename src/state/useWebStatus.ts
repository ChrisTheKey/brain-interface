/**
 * Whether ZERO can reach the internet, and how far.
 *
 * Read from the runtime rather than assumed, and shown for the same reason the
 * cloud voice is shown: this is the difference between a system that keeps its
 * own counsel and one that talks to strangers. An operator should be able to
 * see which of the two is running without opening a config file.
 */
import { useEffect, useState } from 'react';

export interface WebStatus {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  allow: string[];
  deny: string[];
  search: { provider: string; ready: boolean };
  local_only: boolean;
  reads: string;
}

export function useWebStatus(fetchImpl?: typeof fetch): WebStatus | null {
  const [status, setStatus] = useState<WebStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const send = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    void send('/api/web/status')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled) setStatus(payload as WebStatus | null);
      })
      .catch(() => {
        // The runtime being down is already reported elsewhere; a second
        // banner for it would say nothing new.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  return status;
}

/** The one line the operator reads. Never vaguer than the truth. */
export function webSummary(status: WebStatus | null): { state: string; detail: string } {
  if (!status) return { state: 'UNKNOWN', detail: 'the runtime did not answer' };
  if (status.local_only) return { state: 'OFFLINE', detail: 'LOCAL ONLY — nothing leaves this machine' };
  if (!status.enabled) return { state: 'OFFLINE', detail: 'ZERO cannot reach the internet' };
  const scope = status.allow.length > 0 ? status.allow.join(', ') : 'any public host';
  const search = status.search.ready
    ? `search via ${status.search.provider}`
    : 'reads a named URL; cannot search';
  return { state: 'READ-ONLY', detail: `${scope} · ${search}` };
}
