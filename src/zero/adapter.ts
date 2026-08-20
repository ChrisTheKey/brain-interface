/**
 * ZERO Data Adapter.
 *
 *   ZERO (codex app-server)
 *        ↓  WebSocket JSON-RPC
 *   ZeroClient
 *        ↓
 *   ZeroDataAdapter   ← this file: reads ZERO's real entities, tracks live activity
 *        ↓
 *   graph transformation (graph.ts)
 *        ↓
 *   Brain Interface
 *
 * Every field in a snapshot comes from a ZERO API response. Calls that a given
 * ZERO build does not support (or that fail) are recorded in
 * `snapshot.capabilities` instead of being replaced with invented data.
 */
import type { ZeroClient } from './client';
import { loadAgents, type AgentRegistryResult, type ZeroAgent } from './agentRegistry';
import {
  ZERO_METHODS,
  type Account,
  type AppSummary,
  type AppsListResponse,
  type ConfigReadResponse,
  type GetAccountResponse,
  type ItemNotification,
  type ListMcpServerStatusResponse,
  type McpServerStatus,
  type SkillsListEntry,
  type SkillsListResponse,
  type Thread,
  type ThreadListResponse,
  type ThreadReadResponse,
  type ThreadLoadedListResponse,
  type ThreadSourceKind,
  type ThreadStatus,
  type ThreadStatusChangedNotification,
  type TurnNotification,
  type TokenUsageNotification,
} from './protocol';

export interface CapabilityStatus {
  /** JSON-RPC method that was probed. */
  method: string;
  ok: boolean;
  error?: string;
}

export interface ZeroSnapshot {
  /** ZERO itself: account + effective config, as reported by the backend. */
  zero: {
    userAgent: string | null;
    account: Account | null;
    requiresOpenaiAuth: boolean | null;
    model: string | null;
    modelProvider: string | null;
    approvalPolicy: string | null;
    sandboxMode: string | null;
    agentRoles: string[];
    configuredMcpServers: string[];
  };
  /** The real agent repositories ZERO can address. */
  agents: ZeroAgent[];
  agentRegistry: {
    source: AgentRegistryResult['source'];
    root: string;
    error?: string;
    /** Every repository the scan classified, agents and non-agents alike. */
    repositories: AgentRegistryResult['repositories'];
    /** Repositories the policy blocks outright. */
    excluded: string[];
  };
  threads: Thread[];
  loadedThreadIds: string[];
  skills: SkillsListEntry[];
  mcpServers: McpServerStatus[];
  apps: AppSummary[];
  capabilities: CapabilityStatus[];
  fetchedAt: number;
}

export interface ActivityEvent {
  id: string;
  at: number;
  /** Thread the activity belongs to, when ZERO reports one. */
  threadId?: string;
  kind:
    | 'threadStatus'
    | 'turnStarted'
    | 'turnCompleted'
    | 'itemStarted'
    | 'itemCompleted'
    | 'mcpToolCall'
    | 'collabAgentToolCall'
    | 'agentMessage'
    | 'tokenUsage'
    | 'error';
  label: string;
  /** 0..1, used purely to scale the visual reaction. */
  intensity: number;
  /** Additional node ids this event touches (e.g. `mcp:server/tool`). */
  touches?: string[];
  text?: string;
}

export interface AdapterEvents {
  snapshot: (snapshot: ZeroSnapshot) => void;
  activity: (event: ActivityEvent) => void;
  threadStatus: (threadId: string, status: ThreadStatus) => void;
}

const EMPTY_SNAPSHOT_ZERO: ZeroSnapshot['zero'] = {
  userAgent: null,
  account: null,
  requiresOpenaiAuth: null,
  model: null,
  modelProvider: null,
  approvalPolicy: null,
  sandboxMode: null,
  agentRoles: [],
  configuredMcpServers: [],
};

const ROOT_SOURCE_KINDS: ThreadSourceKind[] = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
const SUB_AGENT_SOURCE_KINDS: ThreadSourceKind[] = [
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
];

export class ZeroDataAdapter {
  private readonly listeners: { [K in keyof AdapterEvents]: Set<AdapterEvents[K]> } = {
    snapshot: new Set(),
    activity: new Set(),
    threadStatus: new Set(),
  };

  private activitySeq = 0;
  private lastSnapshot: ZeroSnapshot | null = null;
  private unsubscribeNotifications: (() => void) | null = null;

  constructor(
    private readonly client: ZeroClient,
    private readonly options: {
      extraCwds: string[];
      threadLimit: number;
      agentRoot: string;
      agentManifestPath: string;
      execSandbox: 'readOnly' | 'externalSandbox' | 'workspaceWrite';
    },
  ) {}

  get snapshot(): ZeroSnapshot | null {
    return this.lastSnapshot;
  }

  on<K extends keyof AdapterEvents>(event: K, handler: AdapterEvents[K]): () => void {
    this.listeners[event].add(handler as never);
    return () => {
      this.listeners[event].delete(handler as never);
    };
  }

  /** Start forwarding ZERO's notification stream as activity events. */
  listen(): () => void {
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = this.client.on('notification', (method, params) => {
      this.handleNotification(method, params);
    });
    return () => {
      this.unsubscribeNotifications?.();
      this.unsubscribeNotifications = null;
    };
  }

  /** Read the full entity set from ZERO. Individual failures degrade gracefully. */
  async loadSnapshot(): Promise<ZeroSnapshot> {
    const capabilities: CapabilityStatus[] = [];

    const call = async <T>(method: string, params?: unknown): Promise<T | null> => {
      try {
        const result = await this.client.request<T>(method, params);
        capabilities.push({ method, ok: true });
        return result;
      } catch (error) {
        capabilities.push({
          method,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    const [account, configResponse, rootThreads, subAgentThreads, loaded] = await Promise.all([
      call<GetAccountResponse>(ZERO_METHODS.accountRead, {}),
      call<ConfigReadResponse>(ZERO_METHODS.configRead, {}),
      this.listThreads(ROOT_SOURCE_KINDS, call),
      this.listThreads(SUB_AGENT_SOURCE_KINDS, call),
      call<ThreadLoadedListResponse>(ZERO_METHODS.threadLoadedList, {}),
    ]);

    // Threads that ZERO currently holds in memory but that are not in the
    // listed pages (for example a freshly started thread whose rollout is not
    // written yet) are still live agents, so read them individually.
    const listedIds = new Set([...rootThreads, ...subAgentThreads].map((thread) => thread.id));
    const missingLoaded = (loaded?.data ?? []).filter((id) => !listedIds.has(id));
    const loadedThreads = (
      await Promise.all(
        missingLoaded.map((threadId) =>
          call<ThreadReadResponse>(ZERO_METHODS.threadRead, { threadId }),
        ),
      )
    )
      .map((response) => response?.thread)
      .filter((thread): thread is Thread => Boolean(thread?.id));

    const threads = dedupeThreads([...rootThreads, ...subAgentThreads, ...loadedThreads]);

    const registry = await loadAgents(this.client, {
      root: this.options.agentRoot,
      manifestPath: this.options.agentManifestPath,
      execSandbox: this.options.execSandbox,
    });
    capabilities.push({
      method: 'command/exec (agent registry)',
      ok: registry.error === undefined,
      ...(registry.error ? { error: registry.error } : {}),
    });

    // Skills are scoped per workspace: scan the agents' workspaces too.
    const cwds = uniq([
      ...this.options.extraCwds,
      ...registry.agents.map((agent) => agent.cwd),
      ...threads.map((thread) => thread.cwd).filter((cwd): cwd is string => Boolean(cwd)),
    ]);

    const [skills, mcpServers, apps] = await Promise.all([
      cwds.length > 0
        ? call<SkillsListResponse>(ZERO_METHODS.skillsList, { cwds, forceReload: false })
        : Promise.resolve<SkillsListResponse | null>({ data: [] }),
      this.listMcpServers(call),
      call<AppsListResponse>(ZERO_METHODS.appList, { limit: 50 }),
    ]);

    const effectiveConfig = extractConfig(configResponse);

    const snapshot: ZeroSnapshot = {
      zero: {
        ...EMPTY_SNAPSHOT_ZERO,
        userAgent: this.client.serverUserAgent,
        account: account?.account ?? null,
        requiresOpenaiAuth: account?.requiresOpenaiAuth ?? null,
        model: stringOrNull(effectiveConfig['model']),
        modelProvider: stringOrNull(effectiveConfig['model_provider']),
        approvalPolicy: stringOrNull(effectiveConfig['approval_policy']),
        sandboxMode: stringOrNull(effectiveConfig['sandbox_mode']),
        agentRoles: keysOf(effectiveConfig['agent_roles']),
        configuredMcpServers: keysOf(effectiveConfig['mcp_servers']),
      },
      agents: registry.agents,
      agentRegistry: {
        source: registry.source,
        root: registry.root,
        repositories: registry.repositories,
        excluded: registry.excluded,
        ...(registry.error ? { error: registry.error } : {}),
      },
      threads,
      loadedThreadIds: loaded?.data ?? [],
      skills: skills?.data ?? [],
      mcpServers,
      apps: apps?.data ?? [],
      capabilities,
      fetchedAt: Date.now(),
    };

    this.lastSnapshot = snapshot;
    for (const handler of this.listeners.snapshot) handler(snapshot);
    return snapshot;
  }

  private async listThreads(
    sourceKinds: ThreadSourceKind[],
    call: <T>(method: string, params?: unknown) => Promise<T | null>,
  ): Promise<Thread[]> {
    const response = await call<ThreadListResponse>(ZERO_METHODS.threadList, {
      limit: this.options.threadLimit,
      sortKey: 'updated_at',
      sourceKinds,
    });
    return response?.data ?? [];
  }

  private async listMcpServers(
    call: <T>(method: string, params?: unknown) => Promise<T | null>,
  ): Promise<McpServerStatus[]> {
    const servers: McpServerStatus[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await call<ListMcpServerStatusResponse>(
        ZERO_METHODS.mcpServerStatusList,
        cursor ? { cursor, limit: 50 } : { limit: 50 },
      );
      if (!response) break;
      servers.push(...response.data);
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    return servers;
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'thread/status/changed': {
        const payload = params as ThreadStatusChangedNotification | undefined;
        if (!payload?.threadId) return;
        for (const handler of this.listeners.threadStatus) {
          handler(payload.threadId, payload.status);
        }
        this.emitActivity({
          threadId: payload.threadId,
          kind: 'threadStatus',
          label: `status: ${payload.status?.type ?? 'unknown'}`,
          intensity: payload.status?.type === 'active' ? 0.8 : 0.3,
        });
        return;
      }
      case 'turn/started': {
        const payload = params as TurnNotification | undefined;
        this.emitActivity({
          threadId: payload?.threadId,
          kind: 'turnStarted',
          label: 'turn started',
          intensity: 0.9,
        });
        return;
      }
      case 'turn/completed': {
        const payload = params as TurnNotification | undefined;
        this.emitActivity({
          threadId: payload?.threadId,
          kind: 'turnCompleted',
          label: `turn ${payload?.turn?.status ?? 'completed'}`,
          intensity: 0.6,
        });
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const payload = params as ItemNotification | undefined;
        const item = payload?.item;
        if (!item) return;
        const completed = method === 'item/completed';
        if (item.type === 'mcpToolCall') {
          const call = item as Extract<ItemNotification['item'], { type: 'mcpToolCall' }>;
          this.emitActivity({
            threadId: payload.threadId,
            kind: 'mcpToolCall',
            label: `${call.server} · ${call.tool}`,
            intensity: completed ? 0.7 : 1,
            touches: [`mcp:${call.server}`, `tool:${call.server}/${call.tool}`],
          });
          return;
        }
        if (item.type === 'collabAgentToolCall') {
          const call = item as Extract<ItemNotification['item'], { type: 'collabAgentToolCall' }>;
          this.emitActivity({
            threadId: payload.threadId ?? call.senderThreadId,
            kind: 'collabAgentToolCall',
            label: `${call.tool}`,
            intensity: 1,
            touches: call.receiverThreadIds.map((id) => `thread:${id}`),
          });
          return;
        }
        if (item.type === 'agentMessage' && completed) {
          const message = item as Extract<ItemNotification['item'], { type: 'agentMessage' }>;
          this.emitActivity({
            threadId: payload.threadId,
            kind: 'agentMessage',
            label: 'agent message',
            intensity: 0.8,
            text: message.text,
          });
          return;
        }
        this.emitActivity({
          threadId: payload.threadId,
          kind: completed ? 'itemCompleted' : 'itemStarted',
          label: String(item.type),
          intensity: completed ? 0.4 : 0.6,
        });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const payload = params as TokenUsageNotification | undefined;
        if (!payload) return;
        this.emitActivity({
          threadId: payload.threadId,
          kind: 'tokenUsage',
          label: `${payload.tokenUsage?.total?.totalTokens ?? 0} tokens`,
          intensity: 0.25,
        });
        return;
      }
      case 'error': {
        const payload = params as { error?: { message?: string }; threadId?: string } | undefined;
        this.emitActivity({
          threadId: payload?.threadId,
          kind: 'error',
          label: payload?.error?.message ?? 'error',
          intensity: 1,
        });
        return;
      }
      default:
        return;
    }
  }

  private emitActivity(event: Omit<ActivityEvent, 'id' | 'at'>): void {
    this.activitySeq += 1;
    const full: ActivityEvent = { ...event, id: `act_${this.activitySeq}`, at: Date.now() };
    for (const handler of this.listeners.activity) handler(full);
  }
}

function dedupeThreads(threads: Thread[]): Thread[] {
  const byId = new Map<string, Thread>();
  for (const thread of threads) {
    if (!thread?.id) continue;
    const existing = byId.get(thread.id);
    if (!existing || (thread.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
      byId.set(thread.id, thread);
    }
  }
  return [...byId.values()];
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function extractConfig(response: ConfigReadResponse | null): Record<string, unknown> {
  if (!response) return {};
  const nested = response.config;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return response as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    // Enum-like config values (e.g. sandbox policies) serialize as objects.
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 1 && keys[0] !== undefined ? keys[0] : null;
  }
  return null;
}

function keysOf(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}
