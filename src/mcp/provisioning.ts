/**
 * MCP provisioning: connecting an integration to ZERO, through ZERO.
 *
 *   catalog (what it should be)   +   config/read (what it is)
 *                         └──────────┬─────────┘
 *                                    ▼
 *                              a plan, per integration
 *                                    ▼
 *              config/batchWrite → config/mcpServer/reload → mcpServer/oauth/login
 *
 * The Brain Interface does not edit files and does not hold credentials. It
 * asks ZERO to write its own `config.toml` (`config/value/write` only ever
 * accepts the user config, ZERO enforces that), asks ZERO to reload its MCP
 * servers, and asks ZERO to run the OAuth sign-in. Every secret stays where it
 * already was: in ZERO's environment or in ZERO's credential store.
 *
 * A server's *state* is never inferred from the config either — it is read
 * back from `mcpServerStatus/list`, which is the only thing that knows whether
 * a server actually started and whether it is signed in.
 */
import type { ZeroClient } from '../zero/client';
import {
  ZERO_METHODS,
  type ConfigBatchWriteParams,
  type ConfigEdit,
  type ConfigReadResponse,
  type ConfigWriteResponse,
  type McpAuthStatus,
  type McpServerConfigEntry,
  type McpServerOauthLoginResponse,
  type McpServerStatus,
} from '../zero/protocol';
import type { IntegrationDefinition } from './catalog';

/** Where an integration stands, as far as ZERO is concerned. */
export type IntegrationState =
  /** Not in ZERO's config at all. */
  | 'notConfigured'
  /** In the config, but with a different transport/arguments than the catalog. */
  | 'outdated'
  /** Configured, but ZERO reports no running server for it. */
  | 'configured'
  /** Running, but the OAuth sign-in has not happened. */
  | 'needsSignIn'
  /** Running and usable. */
  | 'connected'
  /** Configured but explicitly disabled in ZERO's config. */
  | 'disabled';

export interface IntegrationStatus {
  integration: IntegrationDefinition;
  state: IntegrationState;
  /** The entry ZERO currently has, if any. */
  current: McpServerConfigEntry | null;
  /** Live status from `mcpServerStatus/list`, if ZERO reports one. */
  server: McpServerStatus | null;
  authStatus: McpAuthStatus | null;
  toolCount: number;
  /** Keys whose value differs from the catalog (only set when `outdated`). */
  differences: string[];
}

/** The `mcp_servers` table out of ZERO's effective config, as ZERO reports it. */
export function readConfiguredServers(
  config: ConfigReadResponse | null,
): Record<string, McpServerConfigEntry> {
  const root = (config?.config ?? config) as Record<string, unknown> | undefined;
  const table = root?.['mcp_servers'];
  if (!table || typeof table !== 'object' || Array.isArray(table)) return {};
  return table as Record<string, McpServerConfigEntry>;
}

/**
 * Compares the entry ZERO has against the entry the catalog declares. Only
 * the fields the catalog sets are compared: an operator who added
 * `disabled_tools` by hand has not made the entry wrong.
 */
export function configDifferences(
  desired: McpServerConfigEntry,
  current: McpServerConfigEntry | null,
): string[] {
  if (!current) return Object.keys(desired);
  const differences: string[] = [];
  for (const [key, value] of Object.entries(desired)) {
    if (key === 'enabled') continue; // an operator may disable a server on purpose
    const existing = (current as Record<string, unknown>)[key];
    if (!deepEqual(value, existing)) differences.push(key);
  }
  return differences;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as object).sort();
    const rightKeys = Object.keys(right as object).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) =>
      deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/** Works out where each integration stands, from ZERO's own two answers. */
export function resolveStatuses(
  integrations: readonly IntegrationDefinition[],
  configuredServers: Record<string, McpServerConfigEntry>,
  servers: readonly McpServerStatus[],
): IntegrationStatus[] {
  const byName = new Map(servers.map((server) => [server.name, server]));

  return integrations.map((integration) => {
    const current = configuredServers[integration.id] ?? null;
    const server = byName.get(integration.id) ?? null;
    const differences = current ? configDifferences(integration.config, current) : [];
    const toolCount = Object.keys(server?.tools ?? {}).length;
    const authStatus = server?.authStatus ?? null;

    const state: IntegrationState = !current
      ? 'notConfigured'
      : current.enabled === false
        ? 'disabled'
        : differences.length > 0
          ? 'outdated'
          : !server
            ? 'configured'
            : authStatus === 'notLoggedIn'
              ? 'needsSignIn'
              : 'connected';

    return { integration, state, current, server, authStatus, toolCount, differences };
  });
}

export interface ProvisionResult {
  id: string;
  /** What was done: the config write, and the sign-in if one was needed. */
  wrote: boolean;
  reloaded: boolean;
  /** URL the operator has to open to finish an OAuth sign-in. */
  authorizationUrl?: string;
  filePath?: string;
  error?: string;
}

/**
 * Writes the catalog entries for the given integrations into ZERO's user
 * config and asks ZERO to reload. `merge: 'replace'` is deliberate: the entry
 * is owned by the catalog, so a stale transport is replaced rather than
 * merged into something half-old and half-new.
 */
export async function provision(
  client: ZeroClient,
  integrations: readonly IntegrationDefinition[],
): Promise<ProvisionResult[]> {
  if (integrations.length === 0) return [];

  const edits: ConfigEdit[] = integrations.map((integration) => ({
    keyPath: `mcp_servers.${integration.id}`,
    value: integration.config,
    mergeStrategy: 'replace',
  }));

  const results: ProvisionResult[] = integrations.map((integration) => ({
    id: integration.id,
    wrote: false,
    reloaded: false,
  }));

  let written: ConfigWriteResponse;
  try {
    written = await client.request<ConfigWriteResponse>(ZERO_METHODS.configBatchWrite, {
      edits,
    } satisfies ConfigBatchWriteParams);
  } catch (error) {
    const message = describe(error);
    return results.map((result) => ({ ...result, error: message }));
  }

  for (const result of results) {
    result.wrote = true;
    result.filePath = written.filePath;
  }

  // ZERO only picks up a new server after a reload; without this the operator
  // would have to restart the backend to see the tools appear.
  try {
    await client.request(ZERO_METHODS.mcpServerReload);
    for (const result of results) result.reloaded = true;
  } catch (error) {
    const message = describe(error);
    for (const result of results) result.error = `config written, reload failed: ${message}`;
  }

  return results;
}

/**
 * Starts ZERO's OAuth sign-in for one server and returns the URL the operator
 * must open. ZERO performs the exchange and stores the token; the interface
 * never sees it. Completion arrives as `mcpServer/oauthLogin/completed`.
 */
export async function signIn(
  client: ZeroClient,
  integration: IntegrationDefinition,
): Promise<{ authorizationUrl: string }> {
  const response = await client.request<McpServerOauthLoginResponse>(
    ZERO_METHODS.mcpServerOauthLogin,
    {
      name: integration.id,
      ...(integration.config.scopes ? { scopes: integration.config.scopes } : {}),
    },
  );
  if (!response?.authorizationUrl) {
    throw new Error(`ZERO did not return an authorization URL for ${integration.name}`);
  }
  return { authorizationUrl: response.authorizationUrl };
}

/** Removes an integration from ZERO's config and reloads. */
export async function disconnect(
  client: ZeroClient,
  integration: IntegrationDefinition,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { id: integration.id, wrote: false, reloaded: false };
  try {
    const written = await client.request<ConfigWriteResponse>(ZERO_METHODS.configValueWrite, {
      keyPath: `mcp_servers.${integration.id}`,
      value: null,
      mergeStrategy: 'replace',
    });
    result.wrote = true;
    result.filePath = written.filePath;
  } catch (error) {
    result.error = describe(error);
    return result;
  }
  try {
    await client.request(ZERO_METHODS.mcpServerReload);
    result.reloaded = true;
  } catch (error) {
    result.error = `entry removed, reload failed: ${describe(error)}`;
  }
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line per integration, for the status line's data notes. */
export function summarizeStatuses(statuses: readonly IntegrationStatus[]): string[] {
  return statuses
    .filter((status) => status.state !== 'connected')
    .map((status) => {
      switch (status.state) {
        case 'notConfigured':
          return `${status.integration.name} is not registered with ZERO.`;
        case 'outdated':
          return `${status.integration.name} is registered with a different configuration (${status.differences.join(', ')}).`;
        case 'configured':
          return `${status.integration.name} is registered but ZERO reports no running server for it.`;
        case 'needsSignIn':
          return `${status.integration.name} is running but not signed in.`;
        case 'disabled':
          return `${status.integration.name} is disabled in ZERO's config.`;
        default:
          return `${status.integration.name}: unknown state.`;
      }
    });
}
