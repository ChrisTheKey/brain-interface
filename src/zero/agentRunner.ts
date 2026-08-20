/**
 * Agent invocation.
 *
 * The edge ZERO → agent is not decorative: invoking an agent starts a real
 * ZERO thread in that agent's repository and runs a real turn there.
 *
 *   thread/start { cwd: agent.cwd }   → the agent's own workspace
 *   turn/start   { input: [task] }    → the agent does the work
 *   item/* + turn/completed           → result, status, errors
 *   thread/unsubscribe                → cleanup
 *
 * Everything runs inside ZERO's own approval and sandbox policy — this module
 * never bypasses them, it only chooses the workspace.
 */
import type { ZeroClient } from './client';
import type { Thread, ThreadItem, Turn } from './protocol';
import type { ZeroAgent } from './agentRegistry';

export type AgentRunStatus = 'completed' | 'failed' | 'interrupted' | 'timeout';

export interface AgentRunResult {
  agentId: string;
  threadId: string;
  turnId: string | null;
  status: AgentRunStatus;
  /** Concatenated agent messages — the actual answer of the agent. */
  text: string;
  /** Tool calls, commands and file changes the agent performed. */
  steps: { type: string; label: string }[];
  error?: string;
}

export interface AgentRunHooks {
  onThreadStarted?: (threadId: string) => void;
  onStep?: (step: { type: string; label: string }) => void;
  onMessageDelta?: (text: string) => void;
}

export interface AgentRunnerOptions {
  /** Sandbox mode for the agent thread, as configured for the interface. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  timeoutMs: number;
  model?: string;
}

export class AgentRunner {
  private readonly active = new Map<string, { threadId: string; agentId: string }>();

  constructor(
    private readonly client: ZeroClient,
    private readonly options: AgentRunnerOptions,
  ) {}

  /** Thread ids currently running an agent, keyed by agent id. */
  get activeAgentIds(): string[] {
    return [...this.active.values()].map((entry) => entry.agentId);
  }

  async invoke(agent: ZeroAgent, task: string, hooks: AgentRunHooks = {}): Promise<AgentRunResult> {
    if (!agent.enabled) {
      return {
        agentId: agent.id,
        threadId: '',
        turnId: null,
        status: 'failed',
        text: '',
        steps: [],
        error: `agent ${agent.id} is disabled in the registry`,
      };
    }

    let threadId = '';
    try {
      const started = await this.client.request<{ thread: Thread }>('thread/start', {
        cwd: agent.cwd,
        approvalPolicy: 'never',
        sandbox: this.options.sandbox,
        ...(this.options.model ? { model: this.options.model } : {}),
      });
      threadId = started?.thread?.id ?? '';
    } catch (error) {
      return {
        agentId: agent.id,
        threadId: '',
        turnId: null,
        status: 'failed',
        text: '',
        steps: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!threadId) {
      return {
        agentId: agent.id,
        threadId: '',
        turnId: null,
        status: 'failed',
        text: '',
        steps: [],
        error: 'ZERO did not return a thread id',
      };
    }

    hooks.onThreadStarted?.(threadId);
    // A run gets the agent's name, so its session node is readable at a glance.
    void this.client
      .request('thread/name/set', { threadId, name: `${agent.name} · run` })
      .catch(() => undefined);
    this.active.set(threadId, { threadId, agentId: agent.id });

    try {
      return await this.runTurn(agent, threadId, task, hooks);
    } finally {
      this.active.delete(threadId);
      void this.client.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    }
  }

  private runTurn(
    agent: ZeroAgent,
    threadId: string,
    task: string,
    hooks: AgentRunHooks,
  ): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve) => {
      const messages: string[] = [];
      const steps: { type: string; label: string }[] = [];
      let turnId: string | null = null;
      let settled = false;

      const finish = (status: AgentRunStatus, error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({
          agentId: agent.id,
          threadId,
          turnId,
          status,
          text: messages.join('\n\n').trim(),
          steps,
          ...(error ? { error } : {}),
        });
      };

      const unsubscribe = this.client.on('notification', (method, params) => {
        const payload = params as
          | { threadId?: string; turn?: Turn; item?: ThreadItem; error?: { message?: string } }
          | undefined;
        if (!payload) return;
        // Every notification for a thread other than ours is somebody else's.
        if (payload.threadId && payload.threadId !== threadId) return;

        switch (method) {
          case 'turn/started':
            turnId = payload.turn?.id ?? turnId;
            return;
          case 'item/completed': {
            const item = payload.item;
            if (!item) return;
            if (item.type === 'agentMessage') {
              const text = (item as Extract<ThreadItem, { type: 'agentMessage' }>).text;
              if (text) {
                messages.push(text);
                hooks.onMessageDelta?.(text);
              }
              return;
            }
            const step = describeStep(item);
            if (step) {
              steps.push(step);
              hooks.onStep?.(step);
            }
            return;
          }
          case 'turn/completed': {
            const status = payload.turn?.status;
            if (status === 'failed') {
              finish('failed', payload.turn?.error?.message ?? 'turn failed');
            } else if (status === 'interrupted') {
              finish('interrupted');
            } else {
              finish('completed');
            }
            return;
          }
          case 'error': {
            finish('failed', payload.error?.message ?? 'ZERO reported an error');
            return;
          }
          default:
            return;
        }
      });

      const timer = setTimeout(() => {
        if (turnId) {
          void this.client
            .request('turn/interrupt', { threadId, turnId })
            .catch(() => undefined);
        }
        finish('timeout', `agent ${agent.id} did not answer within ${this.options.timeoutMs} ms`);
      }, this.options.timeoutMs);

      this.client
        .request<{ turn: Turn }>('turn/start', {
          threadId,
          input: [{ type: 'text', text: task }],
        })
        .then((response) => {
          turnId = response?.turn?.id ?? turnId;
        })
        .catch((error: unknown) => {
          finish('failed', error instanceof Error ? error.message : String(error));
        });
    });
  }
}

export function describeStep(item: ThreadItem): { type: string; label: string } | null {
  switch (item.type) {
    case 'mcpToolCall': {
      const call = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      return { type: 'tool', label: `${call.server} · ${call.tool}` };
    }
    case 'commandExecution': {
      const call = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return { type: 'command', label: call.command };
    }
    case 'fileChange': {
      const call = item as Extract<ThreadItem, { type: 'fileChange' }>;
      return { type: 'fileChange', label: call.changes.map((change) => change.path).join(', ') };
    }
    case 'webSearch': {
      const call = item as Extract<ThreadItem, { type: 'webSearch' }>;
      return { type: 'webSearch', label: call.query };
    }
    case 'collabAgentToolCall': {
      const call = item as Extract<ThreadItem, { type: 'collabAgentToolCall' }>;
      return { type: 'subAgent', label: call.tool };
    }
    default:
      return null;
  }
}
