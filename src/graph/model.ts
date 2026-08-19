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
  | 'connector';

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
