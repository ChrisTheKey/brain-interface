/**
 * React binding for the integrations: Meta Ads, Google Ads, Gmail and the
 * ZERO Browser.
 *
 * The hook holds no state of its own about whether something is connected —
 * it reads ZERO's config and ZERO's live MCP server list, compares both
 * against the catalog, and lets the operator ask ZERO to write the missing
 * entry or to run the sign-in. Every action is a ZERO request; nothing here
 * edits a file or holds a credential.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ZeroClient } from '../zero/client';
import {
  ZERO_METHODS,
  type ConfigReadResponse,
  type McpServerOauthLoginCompletedNotification,
  type McpServerStatus,
} from '../zero/protocol';
import { INTEGRATIONS, withGatewayCommand, type IntegrationDefinition } from '../mcp/catalog';
import {
  disconnect,
  provision,
  readConfiguredServers,
  resolveStatuses,
  signIn,
  type IntegrationStatus,
} from '../mcp/provisioning';
import type { GatewayFeatures } from '../browser/client';

export interface IntegrationsApi {
  statuses: IntegrationStatus[];
  /** Integrations ZERO does not have, or has with a different configuration. */
  pending: IntegrationStatus[];
  busy: string | null;
  error: string | null;
  /** URL the operator must open to finish a sign-in, once one was requested. */
  authorizationUrl: { id: string; url: string } | null;
  notice: string | null;
  gatewayFeatures: GatewayFeatures | null;
  refresh: () => void;
  connect: (id: string) => void;
  /** Registers every integration that is missing or out of date, in one write. */
  connectAll: () => void;
  authorize: (id: string) => void;
  remove: (id: string) => void;
  dismissAuthorization: () => void;
}

/**
 * `gatewayFeatures` comes from `useBrowserBridge`: the gateway is the only
 * place that knows where this interface is installed, which is exactly what
 * the browser MCP entry needs.
 */
export function useIntegrations(
  client: ZeroClient | null,
  gatewayFeatures: GatewayFeatures | null,
): IntegrationsApi {
  const [configuredServers, setConfiguredServers] = useState<Record<string, unknown>>({});
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<{ id: string; url: string } | null>(null);

  /**
   * The browser bridge is registered with the absolute command the gateway
   * reports, so the catalog entry ZERO gets is runnable from any directory.
   */
  const integrations = useMemo<IntegrationDefinition[]>(
    () =>
      INTEGRATIONS.map((integration) =>
        withGatewayCommand(integration, gatewayFeatures?.browserMcp ?? null),
      ),
    [gatewayFeatures],
  );

  const load = useCallback(async (): Promise<void> => {
    if (!client || client.connectionState !== 'connected') return;
    try {
      const [configResponse, serverResponse] = await Promise.all([
        client.request<ConfigReadResponse>(ZERO_METHODS.configRead, { includeLayers: false }),
        client.request<{ data: McpServerStatus[] }>(ZERO_METHODS.mcpServerStatusList, {}),
      ]);
      setConfiguredServers(readConfiguredServers(configResponse));
      setServers(serverResponse?.data ?? []);
      setError(null);
    } catch (cause) {
      setError(describe(cause));
    }
  }, [client]);

  // ZERO connecting (or reconnecting) is the event this panel depends on, so
  // the reload hangs off the client's own state rather than off a render.
  useEffect(() => {
    if (!client) return;
    const off = client.on('state', (state) => {
      if (state === 'connected') void load();
    });
    // The connection may already be up when the panel mounts.
    const initial = setTimeout(() => void load(), 0);
    return () => {
      off();
      clearTimeout(initial);
    };
  }, [client, load]);

  // ZERO reports the end of an OAuth sign-in; that is when the status changes.
  useEffect(() => {
    if (!client) return;
    return client.on('notification', (method, params) => {
      if (method !== 'mcpServer/oauthLogin/completed') return;
      const payload = params as McpServerOauthLoginCompletedNotification | undefined;
      if (!payload) return;
      setAuthorizationUrl((current) => (current?.id === payload.name ? null : current));
      setNotice(
        payload.success
          ? `${payload.name} is signed in.`
          : `${payload.name} sign-in failed: ${payload.error ?? 'unknown error'}`,
      );
      void load();
    });
  }, [client, load]);

  const statuses = useMemo(
    () =>
      resolveStatuses(
        integrations,
        configuredServers as Parameters<typeof resolveStatuses>[1],
        servers,
      ),
    [integrations, configuredServers, servers],
  );

  const pending = useMemo(
    () => statuses.filter((status) => status.state === 'notConfigured' || status.state === 'outdated'),
    [statuses],
  );

  const run = useCallback(
    async (id: string, action: () => Promise<string | null>): Promise<void> => {
      setBusy(id);
      setError(null);
      setNotice(null);
      try {
        const message = await action();
        if (message) setNotice(message);
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setBusy(null);
        await load();
      }
    },
    [load],
  );

  const connectMany = useCallback(
    (targets: IntegrationDefinition[], label: string) => {
      if (!client || targets.length === 0) return;
      void run(label, async () => {
        const results = await provision(client, targets);
        const failed = results.filter((result) => result.error);
        if (failed.length > 0) {
          throw new Error(failed.map((result) => `${result.id}: ${result.error}`).join('; '));
        }
        const file = results[0]?.filePath;
        return `Registered ${targets.map((target) => target.name).join(', ')} in ZERO${file ? ` (${file})` : ''}.`;
      });
    },
    [client, run],
  );

  const connect = useCallback(
    (id: string) => {
      const target = integrations.find((integration) => integration.id === id);
      if (target) connectMany([target], id);
    },
    [connectMany, integrations],
  );

  const connectAll = useCallback(() => {
    connectMany(
      pending.map((status) => status.integration),
      'all',
    );
  }, [connectMany, pending]);

  const authorize = useCallback(
    (id: string) => {
      const target = integrations.find((integration) => integration.id === id);
      if (!client || !target) return;
      void run(id, async () => {
        const { authorizationUrl: url } = await signIn(client, target);
        setAuthorizationUrl({ id, url });
        // Opening it is the operator's move: a popup blocker must not turn
        // into "the sign-in silently did nothing".
        return `Open the authorization URL to finish signing in to ${target.name}.`;
      });
    },
    [client, integrations, run],
  );

  const remove = useCallback(
    (id: string) => {
      const target = integrations.find((integration) => integration.id === id);
      if (!client || !target) return;
      void run(id, async () => {
        const result = await disconnect(client, target);
        if (result.error) throw new Error(result.error);
        return `${target.name} removed from ZERO's configuration.`;
      });
    },
    [client, integrations, run],
  );

  return {
    statuses,
    pending,
    busy,
    error,
    notice,
    authorizationUrl,
    gatewayFeatures,
    refresh: () => void load(),
    connect,
    connectAll,
    authorize,
    remove,
    dismissAuthorization: () => setAuthorizationUrl(null),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
