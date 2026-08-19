import { describe, expect, it, vi } from 'vitest';
import { ConversationPipeline, composeAnswer } from '../src/state/conversation';
import type { ZeroClient } from '../src/zero/client';
import type { ZeroAgent } from '../src/zero/agentRegistry';

const AGENT: ZeroAgent = {
  id: 'seo',
  name: 'SEO',
  cwd: '/agents/SEO',
  enabled: true,
  source: 'scan',
  classification: 'agent',
  classificationReason: 'ships agent instructions',
  callable: true,
  invocationMethod: 'thread/start',
};

/**
 * ZERO stand-in: the routing turn returns a structured decision, the agent
 * turn returns an agent message — exactly like the real app-server does.
 */
function makeClient(options: { route: unknown; agentAnswer?: string; routeFails?: boolean }) {
  let notify: ((method: string, params: unknown) => void) | undefined;
  let threadCounter = 0;
  const threads = new Map<string, 'router' | 'agent'>();

  const client = {
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/start') {
        threadCounter += 1;
        const id = `thr_${threadCounter}`;
        const cwd = (params as { cwd?: string }).cwd;
        threads.set(id, cwd === AGENT.cwd ? 'agent' : 'router');
        return { thread: { id } };
      }
      if (method === 'turn/start') {
        const threadId = (params as { threadId: string }).threadId;
        const kind = threads.get(threadId);
        if (kind === 'router' && options.routeFails) throw new Error('not authenticated');
        queueMicrotask(() => {
          notify?.('turn/started', { threadId, turn: { id: 't' } });
          notify?.('item/completed', {
            threadId,
            item: {
              type: 'agentMessage',
              id: 'm',
              text: kind === 'router' ? JSON.stringify(options.route) : (options.agentAnswer ?? ''),
            },
          });
          notify?.('turn/completed', { threadId, turn: { id: 't', status: 'completed' } });
        });
        return { turn: { id: 't' } };
      }
      return {};
    }),
    on: (event: string, handler: unknown) => {
      if (event === 'notification') notify = handler as (m: string, p: unknown) => void;
      return () => undefined;
    },
  } as unknown as ZeroClient;

  return client;
}

function makePipeline(client: ZeroClient) {
  const states: string[] = [];
  const spoken: string[] = [];
  const started: string[] = [];
  const pipeline = new ConversationPipeline(
    client,
    {
      routerCwd: '/agents',
      routeTimeoutMs: 2_000,
      invokeTimeoutMs: 2_000,
      sandbox: 'read-only',
    },
    {
      onState: (state) => states.push(state),
      onTranscript: () => undefined,
      onAgentStart: (agent) => started.push(agent.id),
      onAgentFinish: () => undefined,
      onAnswer: () => undefined,
      speak: async (text) => {
        spoken.push(text);
      },
    },
  );
  return { pipeline, states, spoken, started };
}

describe('conversation pipeline', () => {
  it('routes a spoken request to a real agent call and speaks the result', async () => {
    const client = makeClient({
      route: {
        needsAgent: true,
        agentIds: ['seo'],
        task: 'Audit example.com',
        reply: 'Ich lasse das prüfen.',
        reason: 'capability match',
      },
      agentAnswer: 'Audit finished: 3 findings.',
    });
    const { pipeline, states, spoken, started } = makePipeline(client);

    const log = await pipeline.handleTranscript('Prüfe example.com', [AGENT]);

    expect(started).toEqual(['seo']);
    expect(log.runs[0]?.status).toBe('completed');
    expect(log.answer).toContain('Ich lasse das prüfen.');
    expect(log.answer).toContain('Audit finished: 3 findings.');
    expect(spoken).toEqual([log.answer]);
    expect(states).toEqual(['processing', 'agentActive', 'speaking', 'idle']);
  });

  it('answers without an agent when ZERO decides so', async () => {
    const client = makeClient({
      route: { needsAgent: false, agentIds: [], task: '', reply: 'Guten Abend.', reason: 'small talk' },
    });
    const { pipeline, started, states } = makePipeline(client);
    const log = await pipeline.handleTranscript('Hallo ZERO', [AGENT]);
    expect(started).toEqual([]);
    expect(log.answer).toBe('Guten Abend.');
    expect(states).toEqual(['processing', 'speaking', 'idle']);
  });

  it('goes to error — not to a fake answer — when ZERO cannot route', async () => {
    const client = makeClient({ route: {}, routeFails: true });
    const { pipeline, states } = makePipeline(client);
    const log = await pipeline.handleTranscript('Prüfe example.com', [AGENT]);
    expect(log.answer).toBe('');
    expect(log.error).toContain('not authenticated');
    expect(states.at(-1)).toBe('error');
  });

  it('keeps failed agent runs visible in the answer', () => {
    const answer = composeAnswer(
      { agentIds: ['seo'], task: 't', reply: 'Ich prüfe das.', reason: 'r' },
      [
        {
          agentId: 'seo',
          threadId: 'thr_1',
          turnId: 't',
          status: 'timeout',
          text: '',
          steps: [],
          error: 'no answer within 1000 ms',
        },
      ],
    );
    expect(answer).toContain('Ich prüfe das.');
    expect(answer).toContain('seo timeout');
  });
});
