/**
 * The publishing branch of the brain: ZERO → SOCIAL → the networks.
 *
 * Two rules, and they are the reason this is a separate module rather than a
 * few lines inside `buildGraph`.
 *
 * **Every node here is a real connection.** The networks are the ones the
 * operator's Metricool brand actually has an account for, read from the
 * runtime. There is no node for a platform that merely exists — a brain that
 * draws a TikTok node when no TikTok is connected is a brain that has started
 * telling you things that are not true.
 *
 * **Every state change is an event that happened.** PREPARING, WAITING FOR
 * APPROVAL, PUBLISHING, VERIFYING, DONE and PARTIAL FAILURE come from
 * `zero.social.*` on the operator's stream — the same events the runtime
 * publishes when it does those things. Nothing here animates on a timer, and
 * in particular nothing shows PUBLISHING before a human has approved, because
 * the runtime does not send that event before then.
 */
import type { MetricoolStatus, OperatorEvent } from '../hwd/types';
import {
  SOCIAL_NODE_ID,
  ZERO_NODE_ID,
  socialNetworkNodeId,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  type NodeStatus,
} from './model';

/** What the operator sees under the hub, in the order the work happens. */
export type SocialState =
  | 'offline'
  | 'blocked'
  | 'connected'
  | 'preparing'
  | 'awaiting_approval'
  | 'publishing'
  | 'verifying'
  | 'done'
  | 'partial_failure'
  | 'failed';

const LABELS: Record<SocialState, string> = {
  offline: 'DISCONNECTED',
  blocked: 'BLOCKED BY LOCAL-ONLY MODE',
  connected: 'CONNECTED',
  preparing: 'PREPARING',
  awaiting_approval: 'WAITING FOR APPROVAL',
  publishing: 'PUBLISHING',
  verifying: 'VERIFYING',
  done: 'DONE',
  partial_failure: 'PARTIAL FAILURE',
  failed: 'FAILED',
};

const FROM_EVENT: Record<string, SocialState> = {
  'zero.social.preparing': 'preparing',
  'zero.social.awaiting_approval': 'awaiting_approval',
  'zero.social.publishing': 'publishing',
  'zero.social.verifying': 'verifying',
  'zero.social.published': 'done',
  'zero.social.partial': 'partial_failure',
  'zero.social.failed': 'failed',
  'zero.social.refused': 'connected',
  'zero.social.connected': 'connected',
};

const STATUS: Record<SocialState, NodeStatus> = {
  offline: 'notLoaded',
  blocked: 'disabled',
  connected: 'idle',
  preparing: 'active',
  awaiting_approval: 'active',
  publishing: 'active',
  verifying: 'active',
  done: 'idle',
  partial_failure: 'error',
  failed: 'error',
};

/** The latest state the runtime actually reported. Never inferred. */
export function socialState(
  status: MetricoolStatus | null,
  events: readonly OperatorEvent[] = [],
): SocialState {
  if (!status || (!status.connected && !status.blocked_by)) return 'offline';
  if (status.blocked_by) return 'blocked';
  const last = [...events].reverse().find((event) => event.type in FROM_EVENT);
  return (last && FROM_EVENT[last.type]) ?? 'connected';
}

/**
 * Which networks the last publish reached, and which it did not.
 *
 * Read from the `published`/`partial` event rather than from the plan, so a
 * network that failed is drawn as failed. The alternative — colouring every
 * target green when the publish "completed" — is the exact fake success this
 * integration is built to avoid.
 */
function lastOutcome(events: readonly OperatorEvent[]): {
  published: Set<string>;
  failed: Set<string>;
} {
  const published = new Set<string>();
  const failed = new Set<string>();
  const last = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'zero.social.published' ||
        event.type === 'zero.social.partial' ||
        event.type === 'zero.social.failed',
    );
  if (!last) return { published, failed };
  const ok = last.payload['published'];
  if (Array.isArray(ok)) ok.forEach((name) => published.add(String(name)));
  const bad = last.payload['failed'];
  if (Array.isArray(bad)) {
    bad.forEach((entry) => {
      if (entry && typeof entry === 'object' && 'network' in entry) {
        failed.add(String((entry as { network: unknown }).network));
      } else {
        failed.add(String(entry));
      }
    });
  }
  return { published, failed };
}

/** Which networks this publish is currently working on, if one is running. */
function inFlight(events: readonly OperatorEvent[]): Set<string> {
  const last = [...events]
    .reverse()
    .find((event) => event.type === 'zero.social.publishing');
  const networks = last?.payload['networks'];
  return new Set(Array.isArray(networks) ? networks.map(String) : []);
}

export interface SocialBranch {
  nodes: GraphNode[];
  edges: GraphEdge[];
  state: SocialState;
  label: string;
}

/** The hub and its networks, or nothing at all when there is nothing real. */
export function socialBranch(
  status: MetricoolStatus | null,
  events: readonly OperatorEvent[] = [],
): SocialBranch {
  const state = socialState(status, events);
  const label = LABELS[state];
  if (state === 'offline') {
    // Not connected is not a node. An empty SOCIAL hub floating beside the
    // brain would imply a capability that is not there.
    return { nodes: [], edges: [], state, label };
  }

  const hub: GraphNode = {
    id: SOCIAL_NODE_ID,
    type: 'socialHub',
    label: 'SOCIAL',
    status: STATUS[state],
    depth: 1,
    parentId: ZERO_NODE_ID,
    description:
      state === 'blocked'
        ? 'Metricool is blocked by local-only mode; no socket is opened.'
        : 'Metricool. Every post stops at an approval bound to its exact payload.',
    metadata: {
      integration: 'metricool',
      state: label,
      server: status?.server ?? '',
      brands: status?.brands ?? 0,
      networks: status?.networks.length ?? 0,
      publishing_ready: status?.publishing_ready ?? false,
    },
  };

  const { published, failed } = lastOutcome(events);
  const running = inFlight(events);

  const networks = (status?.networks ?? []).map<GraphNode>((network) => {
    let nodeStatus: NodeStatus = 'idle';
    if (failed.has(network)) nodeStatus = 'error';
    else if (running.has(network) && state === 'publishing') nodeStatus = 'active';
    else if (published.has(network)) nodeStatus = 'idle';
    return {
      id: socialNetworkNodeId(network),
      type: 'socialNetwork',
      label: network,
      status: nodeStatus,
      depth: 2,
      parentId: SOCIAL_NODE_ID,
      metadata: {
        network,
        // Stated per network, because "published" for four of five is not
        // "published" and the graph should say which one it was.
        last: failed.has(network)
          ? 'FAILED'
          : published.has(network)
            ? 'PUBLISHED'
            : running.has(network)
              ? 'PUBLISHING'
              : 'CONNECTED',
      },
    };
  });

  const edges: GraphEdge[] = [
    {
      id: `${ZERO_NODE_ID}->${SOCIAL_NODE_ID}`,
      source: ZERO_NODE_ID,
      target: SOCIAL_NODE_ID,
      relationship: 'publishes',
      status: STATUS[state],
    },
    ...networks.map<GraphEdge>((node) => ({
      id: `${SOCIAL_NODE_ID}->${node.id}`,
      source: SOCIAL_NODE_ID,
      target: node.id,
      relationship: 'network',
      status: node.status,
    })),
  ];

  return { nodes: [hub, ...networks], edges, state, label };
}

/** Merge the branch into the graph, replacing whatever was there before. */
export function withSocial(graph: GraphModel, branch: SocialBranch): GraphModel {
  const isSocial = (id: string) => id === SOCIAL_NODE_ID || id.startsWith('social:network:');
  const nodes = graph.nodes.filter((node) => !isSocial(node.id));
  const edges = graph.edges.filter(
    (edge) => !isSocial(edge.source) && !isSocial(edge.target),
  );
  if (branch.nodes.length === 0) {
    return nodes.length === graph.nodes.length && edges.length === graph.edges.length
      ? graph
      : { ...graph, nodes, edges };
  }
  return { ...graph, nodes: [...nodes, ...branch.nodes], edges: [...edges, ...branch.edges] };
}
