/**
 * Builds the brain from HWD-ZERO's agent registry.
 *
 *   GET /api/agents      → the roster (the only source of "which agents exist")
 *   /ws/events           → which of them are running, blocked or failing
 *   src/zero/agentPolicy → which repositories may appear at all
 *
 * The interface adds nothing: no agent it discovered itself, no capability it
 * assumed, no connection that HWD-ZERO does not report. What the operator does
 * not provide is written into `notes` instead of being filled in.
 */
import {
  childAgentForId,
  childAgentForRepo,
  isExcludedRepository,
  isSystemRepository,
  type ChildAgentDefinition,
  type Department,
} from '../zero/agentPolicy';
import { classifyRepository, summarizeClassifications } from '../zero/agentClassifier';
import type { OperatorAgent, OperatorRegistry } from '../hwd/types';
import {
  agentHubId,
  CORE_ID,
  CORE_RADIUS,
  HUB_RADIUS,
  SATELLITE_RADIUS,
  satelliteId,
  type BrainCluster,
  type BrainGraph,
  type BrainLink,
  type BrainNode,
  type BrainStatus,
} from './model';
import { curveControlPoint, hubPosition, satellitePosition, type LayoutOptions } from './layout3d';

/** Live facts about the roster, folded from `/ws/events`. */
export interface BrainRuntime {
  /** Agents HWD-ZERO reports as running right now. */
  activeAgentIds?: readonly string[];
  /** Agents whose last event was an error. */
  erroredAgentIds?: readonly string[];
  /** Agents stopped on an open approval gate. */
  blockedAgentIds?: readonly string[];
  /** The last thing the operator said each agent was doing. */
  agentActivity?: ReadonlyMap<string, { label: string; missionId?: string; at: number }>;
}

/** How many terminals a cluster grows when the operator reports no detail. */
const STRUCTURAL_TERMINALS = 4;
const MAX_TERMINALS = 8;

/** Resolve an operator agent against the operator's own agent policy. */
export function definitionFor(agent: OperatorAgent): ChildAgentDefinition | undefined {
  return (
    childAgentForId(agent.id) ??
    (agent.repo ? childAgentForRepo(agent.repo) : undefined) ??
    childAgentForRepo(agent.id) ??
    childAgentForId(agent.role ?? '')
  );
}

/** True when this roster entry must never reach the brain. */
export function isBlockedByPolicy(agent: OperatorAgent): boolean {
  return (
    isExcludedRepository(agent.id) ||
    (agent.repo !== undefined && isExcludedRepository(agent.repo)) ||
    isExcludedRepository(agent.role ?? '')
  );
}

function statusFor(agent: OperatorAgent, runtime: BrainRuntime): BrainStatus {
  if (runtime.erroredAgentIds?.includes(agent.id)) return 'error';
  if (runtime.activeAgentIds?.includes(agent.id)) return 'active';
  if (runtime.blockedAgentIds?.includes(agent.id)) return 'blocked';
  if (agent.available === false) return 'disabled';
  const status = (agent.status ?? '').toLowerCase();
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'running' || status === 'active') return 'active';
  if (status === 'disabled' || status === 'offline') return 'disabled';
  if (status === '') return 'unknown';
  return 'idle';
}

function departmentFor(
  agent: OperatorAgent,
  definition: ChildAgentDefinition | undefined,
): Department | null {
  if (definition) return definition.department;
  const reported = agent.department as Department | undefined;
  return reported ?? null;
}

/**
 * The real capabilities that become the cluster's satellites. Strengths first
 * (what the agent can do), then the gates that always need a human — both come
 * straight out of the registry and the policy.
 */
export function terminalsFor(
  agent: OperatorAgent,
  definition: ChildAgentDefinition | undefined,
): { label: string; kind: 'strength' | 'gate' | 'structural' }[] {
  const terminals: { label: string; kind: 'strength' | 'gate' | 'structural' }[] = [];
  for (const strength of agent.strengths ?? []) {
    const label = strength.trim();
    if (label.length > 0) terminals.push({ label, kind: 'strength' });
  }
  const gates = agent.requires_approval_for ?? definition?.requiresApprovalFor ?? [];
  for (const gate of gates) {
    const label = gate.trim();
    if (label.length > 0 && !terminals.some((entry) => entry.label === label)) {
      terminals.push({ label, kind: 'gate' });
    }
  }
  if (terminals.length === 0) {
    // The operator reported no detail for this agent. The cluster still has a
    // body — but the terminals are marked structural and a note says so, so
    // the picture never claims a capability that was never reported.
    for (let i = 0; i < STRUCTURAL_TERMINALS; i += 1) {
      terminals.push({ label: '', kind: 'structural' });
    }
  }
  return terminals.slice(0, MAX_TERMINALS);
}

export interface BuildOptions extends LayoutOptions {
  /** Whether HWD-ZERO answered at all. Drives the core's own status. */
  connected?: boolean;
}

export function buildBrain(
  registry: OperatorRegistry | null,
  runtime: BrainRuntime = {},
  options: BuildOptions = {},
): BrainGraph {
  const nodes: BrainNode[] = [];
  const links: BrainLink[] = [];
  const clusters: BrainCluster[] = [];
  const notes: string[] = [];
  const excluded: string[] = [];

  const core: BrainNode = {
    id: CORE_ID,
    kind: 'core',
    label: 'ZERO',
    clusterId: null,
    department: null,
    status: registry ? 'idle' : 'unknown',
    depth: 0,
    parentId: null,
    position: [0, 0, 0],
    radius: CORE_RADIUS,
    description: 'HWD-ZERO — the operator. Every action in this system runs through it.',
    metadata: {},
  };
  nodes.push(core);

  if (!registry) {
    notes.push('HWD-ZERO has not answered /api/agents yet — the brain shows ZERO only.');
    return { nodes, links, clusters, notes, excluded };
  }

  core.metadata['registryVersion'] = registry.version ?? 'unknown';
  core.metadata['projects'] = (registry.projects ?? []).map((project) => project.id);

  const roster: OperatorAgent[] = [];
  for (const agent of registry.agents ?? []) {
    if (!agent?.id) continue;
    if (isBlockedByPolicy(agent)) {
      excluded.push(agent.repo ?? agent.id);
      continue;
    }
    // HWD-ZERO and the interface itself are part of the system, not children.
    if (isSystemRepository(agent.repo ?? agent.id)) continue;
    roster.push(agent);
  }

  if (roster.length === 0) {
    notes.push('HWD-ZERO reports no child agents — the brain shows ZERO alone.');
  }

  const structural: string[] = [];

  roster.forEach((agent, index) => {
    const definition = definitionFor(agent);
    const department = departmentFor(agent, definition);
    const hubId = agentHubId(agent.id);
    const position = hubPosition(agent.id, index, roster.length, options);
    const status = statusFor(agent, runtime);
    const activity = runtime.agentActivity?.get(agent.id);

    const clusterNodeIds: string[] = [hubId];
    const clusterLinkIds: string[] = [];

    const hub: BrainNode = {
      id: hubId,
      kind: 'agent',
      label: definition?.displayName ?? agent.role ?? agent.id,
      clusterId: agent.id,
      department,
      status,
      depth: 1,
      parentId: CORE_ID,
      position,
      radius: HUB_RADIUS,
      ...(agent.purpose ? { description: agent.purpose } : {}),
      metadata: {
        agentId: agent.id,
        parent: 'HWD-ZERO',
        available: agent.available !== false,
        reportedStatus: agent.status ?? 'unknown',
        ...(agent.role ? { role: agent.role } : {}),
        ...(department ? { department } : {}),
        ...(definition ? { repo: definition.repo } : agent.repo ? { repo: agent.repo } : {}),
        ...(agent.cwd ? { workspace: agent.cwd } : {}),
        ...(agent.repository ? { repository: agent.repository } : {}),
        ...(agent.branch ? { branch: agent.branch } : {}),
        ...((agent.strengths ?? []).length > 0 ? { strengths: agent.strengths } : {}),
        ...(activity ? { activity: activity.label } : {}),
        ...(activity?.missionId ? { mission: activity.missionId } : {}),
      },
    };
    nodes.push(hub);

    const axonId = `link:${agent.id}`;
    links.push({
      id: axonId,
      source: CORE_ID,
      target: hubId,
      kind: 'axon',
      clusterId: agent.id,
      department,
      control: curveControlPoint([0, 0, 0], position, axonId, 0.26),
    });
    clusterLinkIds.push(axonId);

    const terminals = terminalsFor(agent, definition);
    if (terminals.every((terminal) => terminal.kind === 'structural')) {
      structural.push(agent.id);
    }

    terminals.forEach((terminal, terminalIndex) => {
      const id = satelliteId(agent.id, terminalIndex);
      const satellitePos = satellitePosition(
        position,
        `${agent.id}:${terminalIndex}`,
        terminalIndex,
        terminals.length,
        options,
      );
      nodes.push({
        id,
        kind: 'satellite',
        label: terminal.label,
        clusterId: agent.id,
        department,
        // A terminal is only "active" because its agent is; it has no state
        // of its own that HWD-ZERO reports.
        status: status === 'active' ? 'active' : status === 'error' ? 'error' : 'idle',
        depth: 2,
        parentId: hubId,
        position: satellitePos,
        radius: SATELLITE_RADIUS * (terminal.kind === 'gate' ? 1.25 : 1),
        metadata: {
          agentId: agent.id,
          terminal: terminal.kind,
          ...(terminal.label ? { capability: terminal.label } : {}),
        },
      });
      clusterNodeIds.push(id);

      const dendriteId = `link:${agent.id}:${terminalIndex}`;
      links.push({
        id: dendriteId,
        source: hubId,
        target: id,
        kind: 'dendrite',
        clusterId: agent.id,
        department,
        control: curveControlPoint(position, satellitePos, dendriteId, 0.35),
      });
      clusterLinkIds.push(dendriteId);
    });

    clusters.push({
      agentId: agent.id,
      label: hub.label,
      department,
      hubId,
      nodeIds: clusterNodeIds,
      linkIds: clusterLinkIds,
      status,
      available: agent.available !== false,
      role: agent.role ?? '',
      purpose: agent.purpose ?? '',
      strengths: agent.strengths ?? [],
      requiresApprovalFor: agent.requires_approval_for ?? definition?.requiresApprovalFor ?? [],
      ...(definition?.repo ?? agent.repo ? { repo: definition?.repo ?? agent.repo } : {}),
      ...(agent.cwd ? { cwd: agent.cwd } : {}),
      ...(agent.repository ? { repository: agent.repository } : {}),
      ...(agent.branch ? { branch: agent.branch } : {}),
      ...(activity ? { activity: activity.label } : {}),
      ...(activity?.missionId ? { missionId: activity.missionId } : {}),
    });
  });

  core.status = clusters.some((cluster) => cluster.status === 'active')
    ? 'active'
    : clusters.some((cluster) => cluster.status === 'error')
      ? 'error'
      : 'idle';
  core.metadata['agents'] = clusters.length;

  if (structural.length > 0) {
    notes.push(
      `HWD-ZERO reports no strengths and no approval gates for: ${structural.sort().join(', ')} — those clusters show structural terminals only.`,
    );
  }
  if (excluded.length > 0) {
    notes.push(
      `Excluded by policy (never rendered, never routed): ${[...new Set(excluded)].sort().join(', ')}.`,
    );
  }
  // Optional contract: when the operator reports the evidence it collected per
  // repository, say what each one actually is. The interface classifies the
  // evidence; it never goes looking for it — that is the operator's machine.
  if (registry.repositories?.length) {
    const classified = registry.repositories
      .filter((entry) => !isExcludedRepository(entry.name))
      .map((entry) => classifyRepository(entry));
    notes.push(...summarizeClassifications(classified));
  }
  const undeclared = clusters.filter((cluster) => cluster.department === null);
  if (undeclared.length > 0) {
    notes.push(
      `No department for: ${undeclared.map((cluster) => cluster.agentId).sort().join(', ')} — they render in the neutral accent.`,
    );
  }

  return { nodes, links, clusters, notes, excluded: [...new Set(excluded)] };
}
