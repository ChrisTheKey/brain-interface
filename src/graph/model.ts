/**
 * Internal graph model of the Brain Interface.
 *
 * This is a UI abstraction over ZERO's real entities — it never adds entity
 * kinds ZERO does not have. Node ids are stable and derived from ZERO's own
 * identifiers so nodes keep their position across refreshes.
 */

export type NodeType =
  | 'zero'
  /** A real agent from the registry (an agent repository ZERO can run). */
  | 'agent'
  /** A ZERO thread — a session that ran (or runs) in some workspace. */
  | 'session'
  | 'subAgent'
  | 'skill'
  | 'mcpServer'
  | 'tool'
  | 'resource'
  | 'app'
  /** The publishing integration, as one node between ZERO and the networks. */
  | 'socialHub'
  /** One social network ZERO can actually publish to, from the real brand. */
  | 'socialNetwork'
  /** Paid advertising, as one node between ZERO and the ad platform. */
  | 'adsHub'
  /** One ad account ZERO can actually reach. */
  | 'adsAccount'
  | 'toolDependency';

export type NodeStatus = 'active' | 'idle' | 'error' | 'notLoaded' | 'disabled' | 'unknown';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  status: NodeStatus;
  /** Depth from ZERO; drives ring radius and node size. */
  depth: number;
  /** Parent id used by the layout to keep children near their origin. */
  parentId: string | null;
  /** Only fields ZERO actually reported. */
  metadata: Record<string, string | number | boolean | string[]>;
  description?: string;
}

export type EdgeRelationship =
  /** ZERO → agent: ZERO can start a thread in this agent's workspace. */
  | 'agent'
  /** session → agent: this thread runs in that agent's workspace. */
  | 'runsIn'
  | 'orchestrates'
  | 'spawned'
  | 'review'
  | 'compact'
  | 'memoryConsolidation'
  | 'subAgentOther'
  | 'knowledge'
  | 'workspaceKnowledge'
  | 'toolProvider'
  | 'provides'
  | 'exposes'
  | 'requires'
  | 'connector'
  /** ZERO → the publishing integration. */
  | 'publishes'
  /** The integration → one network it is really connected to. */
  | 'network'
  /** ZERO → the advertising integration. */
  | 'advertises'
  /** The integration → one ad account it can really reach. */
  | 'adAccount';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationship: EdgeRelationship;
  status: NodeStatus;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Human-readable notes about data ZERO did not expose. */
  notes: string[];
}

export const ZERO_NODE_ID = 'zero';

export function threadNodeId(threadId: string): string {
  return `thread:${threadId}`;
}

export const SOCIAL_NODE_ID = 'social:metricool';
export const ADS_NODE_ID = 'ads:meta';

export function adsAccountNodeId(account: string): string {
  return `ads:account:${account}`;
}

export function socialNetworkNodeId(network: string): string {
  return `social:network:${network}`;
}

export function agentNodeId(agentId: string): string {
  return `agent:${agentId}`;
}

export function mcpServerNodeId(server: string): string {
  return `mcp:${server}`;
}

export function mcpToolNodeId(server: string, tool: string): string {
  return `tool:${server}/${tool}`;
}

/**
 * Repo-scoped skills belong to one workspace, so their id carries the cwd.
 * User/system/admin skills are the same entity for every workspace ZERO
 * scans, so they are keyed by their path and appear exactly once.
 */
export function skillNodeId(cwd: string, skill: { name: string; path: string; scope: string }): string {
  return skill.scope === 'repo' ? `skill:${cwd}:${skill.name}` : `skill:${skill.path}`;
}

export function resourceNodeId(server: string, uri: string): string {
  return `resource:${server}/${uri}`;
}

export function appNodeId(id: string): string {
  return `app:${id}`;
}
