/**
 * ZERO's routing decision.
 *
 * The interface does not decide which agent handles a request — ZERO does.
 * The transcript and the *real* agent registry are handed to a ZERO turn whose
 * final message is constrained by a JSON schema (`turn/start.outputSchema`),
 * so the decision comes back as structured data instead of prose.
 *
 *   user speech → transcript → ZERO (routing turn) → { agentIds, task, reply }
 *
 * If ZERO cannot answer (not authenticated, offline, model error) the caller
 * gets `null` and the UI says so — there is no keyword-matching fallback
 * pretending to be ZERO's judgement.
 */
import type { ZeroClient } from './client';
import type { Thread, ThreadItem, Turn } from './protocol';
import type { ZeroAgent } from './agentRegistry';

export interface RouteDecision {
  /** Agents ZERO wants to use, in order. Empty when it answers directly. */
  agentIds: string[];
  /** The task ZERO wants to hand to those agents. */
  task: string;
  /** ZERO's direct reply (used when no agent is needed, or as a preamble). */
  reply: string;
  reason: string;
}

export interface RouterOptions {
  /** Working directory for the routing thread. */
  cwd: string;
  timeoutMs: number;
  model?: string;
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    needsAgent: { type: 'boolean' },
    agentIds: { type: 'array', items: { type: 'string' } },
    task: { type: 'string' },
    reply: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['needsAgent', 'agentIds', 'task', 'reply', 'reason'],
  additionalProperties: false,
} as const;

export function buildRoutingPrompt(transcript: string, agents: ZeroAgent[]): string {
  const roster = agents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const parts = [`- id: ${agent.id}`, `  name: ${agent.name}`, `  workspace: ${agent.cwd}`];
      if (agent.role) parts.push(`  role: ${agent.role}`);
      if (agent.description) parts.push(`  description: ${agent.description}`);
      if (agent.capabilities?.length) parts.push(`  capabilities: ${agent.capabilities.join(', ')}`);
      if (agent.inputs?.length) parts.push(`  inputs: ${agent.inputs.join(', ')}`);
      if (agent.outputs?.length) parts.push(`  outputs: ${agent.outputs.join(', ')}`);
      return parts.join('\n');
    })
    .join('\n');

  return [
    'You are ZERO, the orchestrator of the agent network below.',
    'Decide how to handle the user request. Do not perform the work yourself.',
    '',
    'Available agents (each one is a repository you can run a task in):',
    roster.length > 0 ? roster : '- (none available)',
    '',
    'Rules:',
    '- Use agentIds only from the list above, in the order they should run.',
    '- needsAgent=false when you can answer without any agent; then agentIds is empty.',
    '- task: the concrete instruction handed to the agents, self-contained.',
    '- reply: what you say to the user right now, in the user\'s language, one or two sentences.',
    '- reason: one short sentence on why this routing.',
    '',
    `User request: ${transcript}`,
  ].join('\n');
}

export async function routeTask(
  client: ZeroClient,
  transcript: string,
  agents: ZeroAgent[],
  options: RouterOptions,
): Promise<{ decision: RouteDecision | null; error?: string }> {
  let threadId = '';
  try {
    const started = await client.request<{ thread: Thread }>('thread/start', {
      cwd: options.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ...(options.model ? { model: options.model } : {}),
    });
    threadId = started?.thread?.id ?? '';
  } catch (error) {
    return { decision: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (!threadId) return { decision: null, error: 'ZERO did not return a routing thread' };

  // Name it, so this internal thread does not show up in the brain labelled
  // with the routing prompt itself.
  void client
    .request('thread/name/set', { threadId, name: 'ZERO · routing' })
    .catch(() => undefined);

  try {
    const raw = await runDecisionTurn(client, threadId, transcript, agents, options);
    if (raw.error) return { decision: null, error: raw.error };
    const decision = parseDecision(raw.text, agents);
    if (!decision) return { decision: null, error: 'ZERO returned an unusable routing decision' };
    return { decision };
  } finally {
    void client.request('thread/unsubscribe', { threadId }).catch(() => undefined);
  }
}

function runDecisionTurn(
  client: ZeroClient,
  threadId: string,
  transcript: string,
  agents: ZeroAgent[],
  options: RouterOptions,
): Promise<{ text: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let turnId: string | null = null;
    const messages: string[] = [];

    const finish = (text: string, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(error ? { text, error } : { text });
    };

    const unsubscribe = client.on('notification', (method, params) => {
      const payload = params as
        | { threadId?: string; turn?: Turn; item?: ThreadItem; error?: { message?: string } }
        | undefined;
      if (!payload) return;
      if (payload.threadId && payload.threadId !== threadId) return;

      if (method === 'turn/started') {
        turnId = payload.turn?.id ?? turnId;
        return;
      }
      if (method === 'item/completed' && payload.item?.type === 'agentMessage') {
        messages.push((payload.item as Extract<ThreadItem, { type: 'agentMessage' }>).text ?? '');
        return;
      }
      if (method === 'turn/completed') {
        if (payload.turn?.status === 'completed') finish(messages.join('\n'));
        else finish(messages.join('\n'), payload.turn?.error?.message ?? `turn ${payload.turn?.status}`);
        return;
      }
      if (method === 'error') {
        finish('', payload.error?.message ?? 'ZERO reported an error');
      }
    });

    const timer = setTimeout(() => {
      if (turnId) void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      finish('', `ZERO did not decide within ${options.timeoutMs} ms`);
    }, options.timeoutMs);

    client
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text: buildRoutingPrompt(transcript, agents) }],
        outputSchema: DECISION_SCHEMA,
      })
      .then((response) => {
        turnId = (response as { turn?: Turn } | undefined)?.turn?.id ?? turnId;
      })
      .catch((error: unknown) => {
        finish('', error instanceof Error ? error.message : String(error));
      });
  });
}

/** Parses ZERO's structured answer; tolerates code fences around the JSON. */
export function parseDecision(text: string, agents: ZeroAgent[]): RouteDecision | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const jsonText = extractJson(trimmed);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;

  const known = new Set(agents.map((agent) => agent.id));
  const requested = Array.isArray(record['agentIds'])
    ? record['agentIds'].filter((id): id is string => typeof id === 'string')
    : [];
  // Never invent an agent: ids ZERO made up are dropped.
  const agentIds = record['needsAgent'] === true ? requested.filter((id) => known.has(id)) : [];

  return {
    agentIds,
    task: typeof record['task'] === 'string' ? record['task'] : '',
    reply: typeof record['reply'] === 'string' ? record['reply'] : '',
    reason: typeof record['reason'] === 'string' ? record['reason'] : '',
  };
}

function extractJson(text: string): string | null {
  if (text.startsWith('{')) return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}
