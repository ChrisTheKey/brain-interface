/**
 * Transforms a ZERO snapshot into the Brain Interface graph.
 *
 * Mapping (all edges are read out of ZERO's data, never generated):
 *
 *   ZERO                      ← account/read + config/read + initialize userAgent
 *    ├─ agent                 ← agent registry (repositories ZERO can run a thread in)
 *    │   └─ session           ← thread whose cwd is that agent's workspace
 *    ├─ session               ← thread/list (sourceKinds cli|vscode|exec|appServer|unknown)
 *    │   └─ subAgent          ← thread.source.subAgent.thread_spawn.parent_thread_id
 *    ├─ subAgent (review/…)   ← thread.source.subAgent = "review"|"compact"|"memory_consolidation"
 *    ├─ skill (knowledge)     ← skills/list  (user/system/admin scope → attached to ZERO)
 *    │   └─ requires          ← skill.dependencies.tools[] (linked to the MCP server when the name matches)
 *    ├─ mcpServer (tools)     ← mcpServerStatus/list
 *    │   ├─ tool              ← server.tools
 *    │   └─ resource          ← server.resources / resourceTemplates
 *    └─ app (connector)       ← app/list
 *
 *   agent ── workspaceKnowledge ── skill   for repo-scoped skills whose
 *   `skills/list` cwd equals the thread's cwd (that scoping is ZERO's own).
 */
import type { ZeroSnapshot } from '../zero/adapter';
import type { ZeroAgent } from '../zero/agentRegistry';
import { summarizeClassifications } from '../zero/agentClassifier';
import type { SkillMetadata, Thread, ThreadStatus } from '../zero/protocol';
import {
  agentNodeId,
  appNodeId,
  mcpServerNodeId,
  mcpToolNodeId,
  resourceNodeId,
  skillNodeId,
  threadNodeId,
  ZERO_NODE_ID,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  type NodeStatus,
} from './model';

export interface GraphRuntime {
  /** Agents whose ZERO thread is running right now. */
  activeAgentIds?: readonly string[];
  /** Last (or current) task per agent, from the real run log. */
  agentTasks?: ReadonlyMap<string, { task: string; status: string; at: number }>;
}

export function buildGraph(
  snapshot: ZeroSnapshot | null,
  runtime: GraphRuntime = {},
): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const notes: string[] = [];

  const zeroNode: GraphNode = {
    id: ZERO_NODE_ID,
    type: 'zero',
    label: 'ZERO',
    status: snapshot ? 'idle' : 'notLoaded',
    depth: 0,
    parentId: null,
    metadata: {},
    description: 'Central orchestrator (ZERO app-server).',
  };
  nodes.push(zeroNode);

  if (!snapshot) {
    notes.push('No ZERO snapshot yet — showing ZERO only.');
    return { nodes, edges, notes };
  }

  const zeroMeta = zeroNode.metadata;
  if (snapshot.zero.userAgent) zeroMeta['userAgent'] = snapshot.zero.userAgent;
  if (snapshot.zero.model) zeroMeta['model'] = snapshot.zero.model;
  if (snapshot.zero.modelProvider) zeroMeta['modelProvider'] = snapshot.zero.modelProvider;
  if (snapshot.zero.approvalPolicy) zeroMeta['approvalPolicy'] = snapshot.zero.approvalPolicy;
  if (snapshot.zero.sandboxMode) zeroMeta['sandboxMode'] = snapshot.zero.sandboxMode;
  if (snapshot.zero.agentRoles.length > 0) zeroMeta['agentRoles'] = snapshot.zero.agentRoles;
  if (snapshot.zero.configuredMcpServers.length > 0) {
    zeroMeta['configuredMcpServers'] = snapshot.zero.configuredMcpServers;
  }
  if (snapshot.zero.account) {
    zeroMeta['account'] = snapshot.zero.account.type;
    if (snapshot.zero.account.type === 'chatgpt') {
      zeroMeta['accountEmail'] = snapshot.zero.account.email;
      zeroMeta['plan'] = snapshot.zero.account.planType;
    }
  } else if (snapshot.zero.requiresOpenaiAuth) {
    zeroMeta['account'] = 'not signed in';
  }
  zeroMeta['threads'] = snapshot.threads.length;
  zeroMeta['loadedThreads'] = snapshot.loadedThreadIds.length;

  const loaded = new Set(snapshot.loadedThreadIds);

  /* --------------------------- agent registry ----------------------------- */

  const activeAgents = new Set(runtime.activeAgentIds ?? []);
  const agentByCwd = new Map<string, GraphNode>();
  for (const agent of snapshot.agents) {
    const running = activeAgents.has(agent.id);
    const lastRun = runtime.agentTasks?.get(agent.id);
    const node: GraphNode = {
      id: agentNodeId(agent.id),
      type: 'agent',
      label: agent.name,
      status: running ? 'active' : agent.enabled ? 'idle' : 'disabled',
      depth: 1,
      parentId: ZERO_NODE_ID,
      metadata: {
        ...agentMetadata(agent),
        ...(running ? { running: true } : {}),
        ...(lastRun
          ? {
              [running ? 'currentTask' : 'lastTask']: lastRun.task,
              lastRunStatus: lastRun.status,
              lastActivity: new Date(lastRun.at).toISOString(),
            }
          : {}),
      },
      ...(agent.description ? { description: agent.description } : {}),
    };
    nodes.push(node);
    agentByCwd.set(normalizeCwd(agent.cwd), node);
    edges.push({
      id: `edge:agent:${agent.id}`,
      source: ZERO_NODE_ID,
      target: node.id,
      relationship: 'agent',
      status: node.status,
    });
  }

  /* ----------------------------- sessions --------------------------------- */

  const threadNodes = new Map<string, GraphNode>();

  for (const thread of snapshot.threads) {
    const spawn = threadSpawnInfo(thread);
    const isSubAgent = spawn !== null || subAgentKind(thread) !== null;
    const node: GraphNode = {
      id: threadNodeId(thread.id),
      type: isSubAgent ? 'subAgent' : 'session',
      label: threadLabel(thread),
      status: threadStatus(thread.status, loaded.has(thread.id)),
      depth: 1,
      parentId: ZERO_NODE_ID,
      metadata: threadMetadata(thread, loaded.has(thread.id)),
      description: thread.preview?.trim() || undefined,
    };
    nodes.push(node);
    threadNodes.set(thread.id, node);
  }

  for (const thread of snapshot.threads) {
    const node = threadNodes.get(thread.id);
    if (!node) continue;
    const spawn = threadSpawnInfo(thread);
    if (spawn && threadNodes.has(spawn.parentThreadId)) {
      node.parentId = threadNodeId(spawn.parentThreadId);
      node.depth = 2;
      edges.push({
        id: `edge:spawn:${spawn.parentThreadId}->${thread.id}`,
        source: threadNodeId(spawn.parentThreadId),
        target: node.id,
        relationship: 'spawned',
        status: node.status,
      });
      continue;
    }
    if (spawn) {
      // ZERO reports a parent that is outside the requested thread page.
      notes.push(
        `Sub-agent ${thread.id} references parent thread ${spawn.parentThreadId}, which is not in the current thread page; it is attached to ZERO.`,
      );
    }
    // A session that runs in an agent's workspace belongs to that agent.
    const owningAgent = thread.cwd ? agentByCwd.get(normalizeCwd(thread.cwd)) : undefined;
    if (owningAgent && !spawn) {
      node.parentId = owningAgent.id;
      node.depth = owningAgent.depth + 1;
      edges.push({
        id: `edge:runsIn:${thread.id}`,
        source: node.id,
        target: owningAgent.id,
        relationship: 'runsIn',
        status: node.status,
      });
      continue;
    }

    const kind = subAgentKind(thread);
    edges.push({
      id: `edge:orchestrates:${thread.id}`,
      source: ZERO_NODE_ID,
      target: node.id,
      relationship:
        kind === 'review'
          ? 'review'
          : kind === 'compact'
            ? 'compact'
            : kind === 'memory_consolidation'
              ? 'memoryConsolidation'
              : kind === 'other'
                ? 'subAgentOther'
                : 'orchestrates',
      status: node.status,
    });
  }

  /* ------------------------- MCP servers = tools -------------------------- */

  const serverNodeByName = new Map<string, GraphNode>();
  for (const server of snapshot.mcpServers) {
    const node: GraphNode = {
      id: mcpServerNodeId(server.name),
      type: 'mcpServer',
      label: server.name,
      status: server.authStatus === 'notLoggedIn' ? 'error' : 'idle',
      depth: 1,
      parentId: ZERO_NODE_ID,
      metadata: {
        authStatus: server.authStatus,
        tools: Object.keys(server.tools ?? {}).length,
        resources: (server.resources ?? []).length,
        resourceTemplates: (server.resourceTemplates ?? []).length,
      },
    };
    nodes.push(node);
    serverNodeByName.set(server.name, node);
    edges.push({
      id: `edge:toolProvider:${server.name}`,
      source: ZERO_NODE_ID,
      target: node.id,
      relationship: 'toolProvider',
      status: node.status,
    });

    for (const [toolName, tool] of Object.entries(server.tools ?? {})) {
      const toolNode: GraphNode = {
        id: mcpToolNodeId(server.name, toolName),
        type: 'tool',
        label: tool?.title?.trim() || toolName,
        status: 'idle',
        depth: 2,
        parentId: node.id,
        metadata: { server: server.name, tool: toolName },
        description: tool?.description ?? undefined,
      };
      nodes.push(toolNode);
      edges.push({
        id: `edge:provides:${server.name}/${toolName}`,
        source: node.id,
        target: toolNode.id,
        relationship: 'provides',
        status: 'idle',
      });
    }

    for (const resource of server.resources ?? []) {
      const resourceNode: GraphNode = {
        id: resourceNodeId(server.name, resource.uri),
        type: 'resource',
        label: resource.title?.trim() || resource.name,
        status: 'idle',
        depth: 2,
        parentId: node.id,
        metadata: {
          server: server.name,
          uri: resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        },
        description: resource.description ?? undefined,
      };
      nodes.push(resourceNode);
      edges.push({
        id: `edge:exposes:${server.name}/${resource.uri}`,
        source: node.id,
        target: resourceNode.id,
        relationship: 'exposes',
        status: 'idle',
      });
    }
  }

  /* ----------------------- skills = knowledge bases ----------------------- */

  const threadsByCwd = new Map<string, Thread[]>();
  for (const thread of snapshot.threads) {
    if (!thread.cwd) continue;
    const list = threadsByCwd.get(thread.cwd) ?? [];
    list.push(thread);
    threadsByCwd.set(thread.cwd, list);
  }

  const seenSkillNodes = new Set<string>();
  for (const entry of snapshot.skills) {
    for (const error of entry.errors ?? []) {
      notes.push(`skills/list error in ${entry.cwd}: ${error.message} (${error.path})`);
    }
    for (const skill of entry.skills ?? []) {
      const id = skillNodeId(entry.cwd, skill);
      if (seenSkillNodes.has(id)) continue;
      seenSkillNodes.add(id);

      const repoScoped = skill.scope === 'repo';
      const owners = repoScoped ? (threadsByCwd.get(entry.cwd) ?? []) : [];
      const node: GraphNode = {
        id,
        type: 'skill',
        label: skill.interface?.displayName?.trim() || skill.name,
        status: skill.enabled ? 'idle' : 'disabled',
        depth: owners.length > 0 ? 2 : 1,
        parentId: owners[0] ? threadNodeId(owners[0].id) : ZERO_NODE_ID,
        metadata: {
          scope: skill.scope,
          enabled: skill.enabled,
          cwd: entry.cwd,
          path: skill.path,
        },
        description: skillDescription(skill),
      };
      nodes.push(node);

      if (owners.length > 0) {
        for (const owner of owners) {
          edges.push({
            id: `edge:workspaceKnowledge:${owner.id}:${id}`,
            source: threadNodeId(owner.id),
            target: id,
            relationship: 'workspaceKnowledge',
            status: node.status,
          });
        }
      } else {
        edges.push({
          id: `edge:knowledge:${id}`,
          source: ZERO_NODE_ID,
          target: id,
          relationship: 'knowledge',
          status: node.status,
        });
      }

      for (const dependency of skill.dependencies?.tools ?? []) {
        const server = serverNodeByName.get(dependency.value);
        if (server) {
          edges.push({
            id: `edge:requires:${id}:${dependency.value}`,
            source: id,
            target: server.id,
            relationship: 'requires',
            status: server.status,
          });
          continue;
        }
        const depId = `dep:${dependency.type}:${dependency.value}`;
        if (!nodes.some((existing) => existing.id === depId)) {
          nodes.push({
            id: depId,
            type: 'toolDependency',
            label: dependency.value,
            status: 'unknown',
            depth: node.depth + 1,
            parentId: id,
            metadata: {
              type: dependency.type,
              ...(dependency.transport ? { transport: dependency.transport } : {}),
              ...(dependency.command ? { command: dependency.command } : {}),
              ...(dependency.url ? { url: dependency.url } : {}),
            },
            description: dependency.description ?? undefined,
          });
        }
        edges.push({
          id: `edge:requires:${id}:${depId}`,
          source: id,
          target: depId,
          relationship: 'requires',
          status: 'unknown',
        });
      }
    }
  }

  /* ------------------------------- apps ---------------------------------- */

  for (const app of snapshot.apps) {
    const node: GraphNode = {
      id: appNodeId(app.id),
      type: 'app',
      label: app.name || app.id,
      status: app.isEnabled === false ? 'disabled' : app.isAccessible === false ? 'error' : 'idle',
      depth: 1,
      parentId: ZERO_NODE_ID,
      metadata: {
        id: app.id,
        ...(app.isEnabled === undefined ? {} : { enabled: app.isEnabled }),
        ...(app.isAccessible === undefined ? {} : { accessible: app.isAccessible }),
      },
      description: app.description ?? undefined,
    };
    nodes.push(node);
    edges.push({
      id: `edge:connector:${app.id}`,
      source: ZERO_NODE_ID,
      target: node.id,
      relationship: 'connector',
      status: node.status,
    });
  }

  /* ------------------------------- notes ---------------------------------- */

  for (const capability of snapshot.capabilities) {
    if (!capability.ok) {
      notes.push(`ZERO API unavailable: ${capability.method} (${capability.error ?? 'error'})`);
    }
  }
  notes.push(...summarizeClassifications(snapshot.agentRegistry.repositories));
  if (snapshot.agentRegistry.error) {
    notes.push(`Agent registry unavailable: ${snapshot.agentRegistry.error}`);
  } else if (snapshot.agents.length === 0) {
    notes.push(
      `No agent repositories found under ${snapshot.agentRegistry.root || '(unset agent root)'}.`,
    );
  }
  if (snapshot.mcpServers.length === 0) {
    notes.push('ZERO reports no MCP servers — no tool nodes exist.');
  }
  if (snapshot.skills.every((entry) => (entry.skills ?? []).length === 0)) {
    notes.push('ZERO reports no skills for the scanned workspaces — no knowledge nodes exist.');
  }

  zeroNode.status = nodes.some((node) => node.status === 'active') ? 'active' : 'idle';

  return { nodes, edges, notes };
}

function agentMetadata(agent: ZeroAgent): GraphNode['metadata'] {
  const metadata: GraphNode['metadata'] = {
    agentId: agent.id,
    workspace: agent.cwd,
    enabled: agent.enabled,
    callable: agent.callable,
    invocationMethod: agent.invocationMethod,
    classification: agent.classification,
    classifiedBecause: agent.classificationReason,
    registrySource: agent.source,
  };
  if (agent.role) metadata['role'] = agent.role;
  if (agent.capabilities?.length) metadata['capabilities'] = agent.capabilities;
  if (agent.inputs?.length) metadata['inputs'] = agent.inputs;
  if (agent.outputs?.length) metadata['outputs'] = agent.outputs;
  if (agent.repository) metadata['repository'] = agent.repository;
  if (agent.branch) metadata['branch'] = agent.branch;
  if (agent.hasInstructions !== undefined) metadata['agentInstructions'] = agent.hasInstructions;
  return metadata;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, '');
}

function threadLabel(thread: Thread): string {
  const explicit = thread.name?.trim() || thread.agentNickname?.trim();
  if (explicit) return explicit;
  const preview = thread.preview?.trim();
  if (preview) return preview.length > 42 ? `${preview.slice(0, 39)}…` : preview;
  // A thread without a name or a first message is still identified by the
  // workspace ZERO opened it in.
  const workspace = thread.cwd?.split('/').filter(Boolean).at(-1);
  const shortId = thread.id.slice(0, 6);
  return workspace ? `${workspace} · ${shortId}` : shortId;
}

function threadMetadata(thread: Thread, isLoaded: boolean): GraphNode['metadata'] {
  const metadata: GraphNode['metadata'] = {
    threadId: thread.id,
    cwd: thread.cwd ?? '',
    modelProvider: thread.modelProvider ?? '',
    source: describeSource(thread),
    loaded: isLoaded,
  };
  if (thread.agentRole) metadata['role'] = thread.agentRole;
  if (thread.agentNickname) metadata['nickname'] = thread.agentNickname;
  if (thread.createdAt) metadata['createdAt'] = thread.createdAt;
  if (thread.updatedAt) metadata['updatedAt'] = thread.updatedAt;
  if (thread.cliVersion) metadata['cliVersion'] = thread.cliVersion;
  if (thread.gitInfo?.branch) metadata['branch'] = thread.gitInfo.branch;
  if (thread.gitInfo?.repositoryUrl) metadata['repository'] = thread.gitInfo.repositoryUrl;
  const spawn = threadSpawnInfo(thread);
  if (spawn) {
    metadata['parentThreadId'] = spawn.parentThreadId;
    metadata['depth'] = spawn.depth;
  }
  return metadata;
}

function skillDescription(skill: SkillMetadata): string | undefined {
  return (
    skill.interface?.shortDescription?.trim() ||
    skill.shortDescription?.trim() ||
    skill.description?.trim() ||
    undefined
  );
}

export function threadSpawnInfo(
  thread: Thread,
): { parentThreadId: string; depth: number; role?: string; nickname?: string } | null {
  const source = thread.source;
  if (!source || typeof source !== 'object' || !('subAgent' in source)) return null;
  const subAgent = source.subAgent;
  if (!subAgent || typeof subAgent !== 'object' || !('thread_spawn' in subAgent)) return null;
  const spawn = subAgent.thread_spawn;
  if (!spawn?.parent_thread_id) return null;
  return {
    parentThreadId: spawn.parent_thread_id,
    depth: spawn.depth ?? 1,
    ...(spawn.agent_role ? { role: spawn.agent_role } : {}),
    ...(spawn.agent_nickname ? { nickname: spawn.agent_nickname } : {}),
  };
}

export function subAgentKind(
  thread: Thread,
): 'review' | 'compact' | 'memory_consolidation' | 'thread_spawn' | 'other' | null {
  const source = thread.source;
  if (!source || typeof source !== 'object' || !('subAgent' in source)) return null;
  const subAgent = source.subAgent;
  if (typeof subAgent === 'string') {
    return subAgent === 'review' || subAgent === 'compact' || subAgent === 'memory_consolidation'
      ? subAgent
      : 'other';
  }
  if (subAgent && typeof subAgent === 'object') {
    if ('thread_spawn' in subAgent) return 'thread_spawn';
    return 'other';
  }
  return null;
}

function describeSource(thread: Thread): string {
  const source = thread.source;
  if (!source) return 'unknown';
  if (typeof source === 'string') return source;
  const kind = subAgentKind(thread);
  return kind ? `subAgent:${kind}` : 'unknown';
}

function threadStatus(status: ThreadStatus | undefined, isLoaded: boolean): NodeStatus {
  switch (status?.type) {
    case 'active':
      return 'active';
    case 'idle':
      return 'idle';
    case 'systemError':
      return 'error';
    case 'notLoaded':
      return isLoaded ? 'idle' : 'notLoaded';
    default:
      return isLoaded ? 'idle' : 'notLoaded';
  }
}
