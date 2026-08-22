/**
 * The brain's own model: what the 3D scene draws.
 *
 * This is a *view* of HWD-ZERO's agent registry and event stream, nothing
 * more. It never invents an agent, never invents a connection, and never adds
 * a node kind the operator does not have:
 *
 *   core       ZERO itself — one, always, at the centre
 *   agent      the hub of one child agent's cluster
 *   satellite  a real capability of that agent (a strength, an approval gate)
 *
 * Positions live in "brain units": the core sits at the origin, agent hubs on
 * a sphere of radius ~1, satellites just outside their hub.
 */
import type { Department } from '../zero/agentPolicy';

export type BrainNodeKind = 'core' | 'agent' | 'satellite';

export type BrainStatus = 'idle' | 'active' | 'blocked' | 'error' | 'disabled' | 'unknown';

export type Vec3 = readonly [number, number, number];

export interface BrainNode {
  id: string;
  kind: BrainNodeKind;
  label: string;
  /** The agent cluster this node belongs to; `null` for the core. */
  clusterId: string | null;
  department: Department | null;
  status: BrainStatus;
  /** 0 = core, 1 = agent hub, 2 = satellite. */
  depth: number;
  parentId: string | null;
  position: Vec3;
  /** Visual radius in brain units. */
  radius: number;
  description?: string;
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface BrainLink {
  id: string;
  source: string;
  target: string;
  /** core → hub is an axon; hub → satellite is a dendrite. */
  kind: 'axon' | 'dendrite';
  clusterId: string;
  department: Department | null;
  /** Deterministic mid control point — the curve never flickers. */
  control: Vec3;
}

export interface BrainCluster {
  /** The agent id exactly as HWD-ZERO reports it. */
  agentId: string;
  label: string;
  department: Department | null;
  hubId: string;
  nodeIds: string[];
  linkIds: string[];
  status: BrainStatus;
  available: boolean;
  role: string;
  purpose: string;
  strengths: string[];
  requiresApprovalFor: string[];
  repo?: string;
  cwd?: string;
  repository?: string;
  branch?: string;
  /** What the operator last reported this agent doing, if anything. */
  activity?: string;
  /** Mission the agent is currently attached to. */
  missionId?: string;
}

export interface BrainGraph {
  nodes: BrainNode[];
  links: BrainLink[];
  clusters: BrainCluster[];
  /** Human-readable notes about what the operator did not provide. */
  notes: string[];
  /** Repositories the policy blocks — never rendered, never routed. */
  excluded: string[];
}

export const CORE_ID = 'zero';

/**
 * Sizes in brain units. ZERO is four times an agent hub and ten times a
 * terminal — the hierarchy has to be legible before a single colour is read.
 */
export const CORE_RADIUS = 0.34;
export const HUB_RADIUS = 0.078;
export const SATELLITE_RADIUS = 0.03;

export function agentHubId(agentId: string): string {
  return `agent:${agentId}`;
}

export function satelliteId(agentId: string, index: number): string {
  return `agent:${agentId}:node:${index}`;
}

export const EMPTY_BRAIN: BrainGraph = {
  nodes: [],
  links: [],
  clusters: [],
  notes: [],
  excluded: [],
};

/** Deterministic 0..1 from a string — the same node always lands in the same place. */
export function hashUnit(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}
