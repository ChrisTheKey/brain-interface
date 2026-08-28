/**
 * React binding for the browser bridge.
 *
 * ZERO reaches the bridge over MCP; the interface reaches it here, so the
 * operator can see what ZERO's internet access actually *is* — which of
 * Chrome, Firefox, Brave and Edge exist on this machine, which one is running,
 * and whether local addresses are refused — and can start or stop it by hand.
 *
 * Everything shown is reported by the gateway. When there is no gateway (a
 * bare `npm run dev`), the hook says so instead of pretending.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { config } from '../config';
import {
  BrowserBridgeClient,
  type BrowserId,
  type BrowserStatus,
  type GatewayFeatures,
} from '../browser/client';

export interface BrowserBridgeApi {
  /** Null until the gateway has answered, or when there is no gateway. */
  status: BrowserStatus | null;
  /** What the gateway supports; also carries the browser MCP command. */
  features: GatewayFeatures | null;
  /** False when the gateway could not be reached at all. */
  gatewayReachable: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => void;
  launch: (browser?: BrowserId) => void;
  close: () => void;
}

export function useBrowserBridge(): BrowserBridgeApi {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [features, setFeatures] = useState<GatewayFeatures | null>(null);
  const [gatewayReachable, setGatewayReachable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<BrowserBridgeClient | null>(null);
  clientRef.current ??= new BrowserBridgeClient({ endpoint: config.browser.endpoint });

  const load = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const [health, browserStatus] = await Promise.all([client.health(), client.status()]);
      setFeatures(health.features ?? null);
      setStatus(browserStatus);
      setGatewayReachable(true);
      setError(null);
    } catch (cause) {
      // No gateway is a normal state in development, not a failure to report
      // as an error the operator has to act on.
      setGatewayReachable(false);
      setStatus(null);
      setFeatures(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0);
    return () => clearTimeout(initial);
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
        await load();
      }
    },
    [load],
  );

  const launch = useCallback(
    (browser?: BrowserId) => {
      const client = clientRef.current;
      if (!client) return;
      void run(() => client.launch(browser ?? config.browser.preferred));
    },
    [run],
  );

  const close = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    void run(() => client.close());
  }, [run]);

  return {
    status,
    features,
    gatewayReachable,
    busy,
    error,
    refresh: () => void load(),
    launch,
    close,
  };
}
