/**
 * The conversation pipeline.
 *
 *   I speak → microphone → speech-to-text → ZERO routes → agents run →
 *   ZERO answers → ZERO speaks
 *
 * This module owns the state machine and wires the real pieces together; it
 * contains no fallback that pretends to be ZERO. Every state transition is
 * caused by a real event (recognition result, ZERO response, agent result).
 */
import type { ZeroClient } from '../zero/client';
import type { ZeroAgent } from '../zero/agentRegistry';
import { AgentRunner, type AgentRunResult } from '../zero/agentRunner';
import { routeTask, type RouteDecision } from '../zero/router';

export type ConversationState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'agentActive'
  | 'speaking'
  | 'error';

export interface ConversationTurnLog {
  transcript: string;
  decision: RouteDecision | null;
  runs: AgentRunResult[];
  answer: string;
  error?: string;
  at: number;
}

export interface ConversationHooks {
  onState: (state: ConversationState, detail?: { error?: string }) => void;
  onTranscript: (text: string, final: boolean) => void;
  onAgentStart: (agent: ZeroAgent, task: string) => void;
  onAgentFinish: (result: AgentRunResult) => void;
  onAnswer: (answer: string) => void;
  speak: (text: string) => Promise<void>;
}

export interface ConversationOptions {
  routerCwd: string;
  routeTimeoutMs: number;
  invokeTimeoutMs: number;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  model?: string;
  now?: () => number;
}

export class ConversationPipeline {
  private state: ConversationState = 'idle';
  private readonly runner: AgentRunner;
  private busy = false;

  constructor(
    private readonly client: ZeroClient,
    private readonly options: ConversationOptions,
    private readonly hooks: ConversationHooks,
  ) {
    this.runner = new AgentRunner(client, {
      sandbox: options.sandbox,
      timeoutMs: options.invokeTimeoutMs,
      ...(options.model ? { model: options.model } : {}),
    });
  }

  get currentState(): ConversationState {
    return this.state;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  setState(state: ConversationState, detail?: { error?: string }): void {
    this.state = state;
    this.hooks.onState(state, detail);
  }

  /**
   * Runs one full turn: ZERO routes the request, the selected agents actually
   * run, ZERO's reply is spoken. Returns the log of what really happened.
   */
  async handleTranscript(transcript: string, agents: ZeroAgent[]): Promise<ConversationTurnLog> {
    const at = this.options.now?.() ?? Date.now();
    const text = transcript.trim();
    const log: ConversationTurnLog = { transcript: text, decision: null, runs: [], answer: '', at };
    if (text.length === 0) {
      this.setState('idle');
      return log;
    }

    this.busy = true;
    this.setState('processing');
    this.hooks.onTranscript(text, true);

    try {
      const routed = await routeTask(this.client, text, agents, {
        cwd: this.options.routerCwd,
        timeoutMs: this.options.routeTimeoutMs,
        ...(this.options.model ? { model: this.options.model } : {}),
      });

      if (!routed.decision) {
        log.error = routed.error ?? 'ZERO could not route the request';
        this.setState('error', { error: log.error });
        this.busy = false;
        return log;
      }

      log.decision = routed.decision;
      const selected = routed.decision.agentIds
        .map((id) => agents.find((agent) => agent.id === id))
        .filter((agent): agent is ZeroAgent => Boolean(agent));

      if (selected.length > 0) {
        this.setState('agentActive');
        const task = routed.decision.task || text;
        for (const agent of selected) {
          this.hooks.onAgentStart(agent, task);
          const result = await this.runner.invoke(agent, task);
          log.runs.push(result);
          this.hooks.onAgentFinish(result);
        }
      }

      log.answer = composeAnswer(routed.decision, log.runs);
      this.hooks.onAnswer(log.answer);

      if (log.answer.length > 0) {
        this.setState('speaking');
        await this.hooks.speak(log.answer);
      }
      this.setState('idle');
      return log;
    } catch (error) {
      log.error = error instanceof Error ? error.message : String(error);
      this.setState('error', { error: log.error });
      return log;
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Combines ZERO's own reply with the agents' results. Agent output is quoted
 * verbatim — nothing is summarised away or invented here.
 */
export function composeAnswer(decision: RouteDecision, runs: AgentRunResult[]): string {
  const parts: string[] = [];
  if (decision.reply.trim().length > 0) parts.push(decision.reply.trim());

  for (const run of runs) {
    if (run.status === 'completed' && run.text.trim().length > 0) {
      parts.push(`${run.agentId}: ${run.text.trim()}`);
      continue;
    }
    if (run.status === 'completed') {
      parts.push(`${run.agentId} finished without a message.`);
      continue;
    }
    parts.push(`${run.agentId} ${run.status}${run.error ? `: ${run.error}` : ''}.`);
  }

  return parts.join('\n\n').trim();
}
