/**
 * The advertising branch of the brain: ZERO → ADVERTISING → the ad accounts.
 *
 * Same two rules as the publishing branch, and they matter more here because
 * this one spends money.
 *
 * **Every node is a real account.** The accounts are the ones this Meta login
 * actually reaches, read from the runtime. There is no node for an account
 * that might exist, and no node at all when nothing is connected.
 *
 * **Every state is an event that happened.** READING, ANALYZING, PLANNING,
 * AWAITING_APPROVAL, UPDATING, VERIFYING, DONE and ERROR come from
 * `zero.ads.*` on the operator's stream. In particular UPDATING cannot appear
 * before a human approves — not because this module checks, but because the
 * runtime does not publish that event until then.
 */
import type { MetaAdsStatus, OperatorEvent } from '../hwd/types';
import {
  ADS_NODE_ID,
  ZERO_NODE_ID,
  adsAccountNodeId,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  type NodeStatus,
} from './model';

export type AdsState =
  | 'offline'
  | 'blocked'
  | 'connected'
  | 'reading'
  | 'analyzing'
  | 'planning'
  | 'awaiting_approval'
  | 'updating'
  | 'verifying'
  | 'done'
  | 'partial_failure'
  | 'error';

const LABELS: Record<AdsState, string> = {
  offline: 'DISCONNECTED',
  blocked: 'BLOCKED BY LOCAL-ONLY MODE',
  connected: 'CONNECTED',
  reading: 'READING',
  analyzing: 'ANALYZING',
  planning: 'PLANNING',
  awaiting_approval: 'AWAITING_APPROVAL',
  updating: 'UPDATING',
  verifying: 'VERIFYING',
  done: 'DONE',
  partial_failure: 'PARTIAL FAILURE',
  error: 'ERROR',
};

const FROM_EVENT: Record<string, AdsState> = {
  'zero.ads.connected': 'connected',
  'zero.ads.reading': 'reading',
  'zero.ads.analyzing': 'analyzing',
  'zero.ads.planning': 'planning',
  'zero.ads.awaiting_approval': 'awaiting_approval',
  'zero.ads.updating': 'updating',
  'zero.ads.verifying': 'verifying',
  'zero.ads.done': 'done',
  'zero.ads.partial': 'partial_failure',
  'zero.ads.error': 'error',
  'zero.ads.refused': 'connected',
};

const STATUS: Record<AdsState, NodeStatus> = {
  offline: 'notLoaded',
  blocked: 'disabled',
  connected: 'idle',
  reading: 'active',
  analyzing: 'active',
  planning: 'active',
  awaiting_approval: 'active',
  updating: 'active',
  verifying: 'active',
  done: 'idle',
  partial_failure: 'error',
  error: 'error',
};

/** The latest state the runtime actually reported. Never inferred. */
export function adsState(
  status: MetaAdsStatus | null,
  events: readonly OperatorEvent[] = [],
): AdsState {
  if (!status || (!status.connected && !status.blocked_by)) return 'offline';
  if (status.blocked_by) return 'blocked';
  const last = [...events].reverse().find((event) => event.type in FROM_EVENT);
  return (last && FROM_EVENT[last.type]) ?? 'connected';
}

export interface AdsBranch {
  nodes: GraphNode[];
  edges: GraphEdge[];
  state: AdsState;
  label: string;
}

export function adsBranch(
  status: MetaAdsStatus | null,
  events: readonly OperatorEvent[] = [],
): AdsBranch {
  const state = adsState(status, events);
  const label = LABELS[state];
  if (state === 'offline') {
    // Not connected is not a node. An empty ADVERTISING hub beside the brain
    // would imply a capability that is not there.
    return { nodes: [], edges: [], state, label };
  }

  const hub: GraphNode = {
    id: ADS_NODE_ID,
    type: 'adsHub',
    label: 'ADVERTISING',
    status: STATUS[state],
    depth: 1,
    parentId: ZERO_NODE_ID,
    description:
      state === 'blocked'
        ? 'Meta Ads is blocked by local-only mode; no socket is opened.'
        : "Meta's official Ads MCP. Reading is autonomous; every change stops at a person.",
    metadata: {
      integration: 'meta-ads',
      state: label,
      endpoint: status?.endpoint ?? '',
      // Meta's own rollout flag, carried rather than interpreted.
      rollout: status?.rollout ?? 'unknown',
      accounts: status?.accounts ?? 0,
      read_ready: status?.read_ready ?? false,
      mutation_ready: status?.mutation_ready ?? false,
    },
  };

  const selected = status?.selected_account ?? '';
  const accounts = (status?.account_list ?? []).map<GraphNode>((account) => ({
    id: adsAccountNodeId(account.id),
    type: 'adsAccount',
    label: account.label,
    // Only the account actually in play carries the branch's activity; the
    // others are reachable, not busy.
    status:
      account.id === selected && STATUS[state] === 'active' ? 'active' : 'idle',
    depth: 2,
    parentId: ADS_NODE_ID,
    metadata: {
      account: account.id,
      currency: account.currency,
      selected: account.id === selected,
      // Meta's per-account rollout flag: an account still in the queue is
      // reachable and unmanageable, and the graph should not hide that.
      mcp_enabled: account.mcp_enabled === null ? 'unknown' : String(account.mcp_enabled),
    },
  }));

  const edges: GraphEdge[] = [
    {
      id: `${ZERO_NODE_ID}->${ADS_NODE_ID}`,
      source: ZERO_NODE_ID,
      target: ADS_NODE_ID,
      relationship: 'advertises',
      status: STATUS[state],
    },
    ...accounts.map<GraphEdge>((node) => ({
      id: `${ADS_NODE_ID}->${node.id}`,
      source: ADS_NODE_ID,
      target: node.id,
      relationship: 'adAccount',
      status: node.status,
    })),
  ];

  return { nodes: [hub, ...accounts], edges, state, label };
}

/** Merge the branch into the graph, replacing whatever was there before. */
export function withAds(graph: GraphModel, branch: AdsBranch): GraphModel {
  const isAds = (id: string) => id === ADS_NODE_ID || id.startsWith('ads:account:');
  const nodes = graph.nodes.filter((node) => !isAds(node.id));
  const edges = graph.edges.filter((edge) => !isAds(edge.source) && !isAds(edge.target));
  if (branch.nodes.length === 0) {
    return nodes.length === graph.nodes.length && edges.length === graph.edges.length
      ? graph
      : { ...graph, nodes, edges };
  }
  return { ...graph, nodes: [...nodes, ...branch.nodes], edges: [...edges, ...branch.edges] };
}
