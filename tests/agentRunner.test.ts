import { describe, expect, it, vi } from 'vitest';
import { AgentRunner } from '../src/zero/agentRunner';
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
  invocationMethod: 'ZERO thread/start + turn/start in the agent workspace',
};

/** A ZERO stand-in that behaves like the real app-server for one turn. */
function makeClient(behaviour: 'ok' | 'turnFails' | 'startFails' | 'silent') {
  const calls: { method: string; params: unknown }[] = [];
  let notify: ((method: string, params: unknown) => void) | undefined;

  const client = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'thread/start') {
        if (behaviour === 'startFails') throw new Error('not authenticated');
        return { thread: { id: 'thr_1' } };
      }
      if (method === 'turn/start') {
        queueMicrotask(() => {
          notify?.('turn/started', { threadId: 'thr_1', turn: { id: 'turn_1' } });
          if (behaviour === 'silent') return;
          notify?.('item/completed', {
            threadId: 'thr_1',
            item: { type: 'mcpToolCall', id: 'i1', server: 'perplexity', tool: 'ask', status: 'completed' },
          });
          notify?.('item/completed', {
            threadId: 'thr_1',
            item: { type: 'agentMessage', id: 'i2', text: 'Audit finished: 3 findings.' },
          });
          notify?.('turn/completed', {
            threadId: 'thr_1',
            turn:
              behaviour === 'turnFails'
                ? { id: 'turn_1', status: 'failed', error: { message: 'usage limit' } }
                : { id: 'turn_1', status: 'completed' },
          });
        });
        return { turn: { id: 'turn_1' } };
      }
      return {};
    }),
    on: (event: string, handler: unknown) => {
      if (event === 'notification') notify = handler as (m: string, p: unknown) => void;
      return () => {
        notify = undefined;
      };
    },
  } as unknown as ZeroClient;

  return { client, calls };
}

describe('AgentRunner', () => {
  it('starts a thread in the agent workspace and returns the real result', async () => {
    const { client, calls } = makeClient('ok');
    const runner = new AgentRunner(client, { sandbox: 'read-only', timeoutMs: 5_000 });
    const result = await runner.invoke(AGENT, 'Audit example.com');

    expect(calls[0]).toMatchObject({
      method: 'thread/start',
      params: { cwd: '/agents/SEO', sandbox: 'read-only' },
    });
    expect(calls[1]).toMatchObject({
      method: 'turn/start',
      params: { threadId: 'thr_1', input: [{ type: 'text', text: 'Audit example.com' }] },
    });
    expect(result.status).toBe('completed');
    expect(result.text).toBe('Audit finished: 3 findings.');
    expect(result.steps).toEqual([{ type: 'tool', label: 'perplexity · ask' }]);
    // The thread is released again.
    expect(calls.some((call) => call.method === 'thread/unsubscribe')).toBe(true);
  });

  it('reports a failed turn instead of pretending it worked', async () => {
    const { client } = makeClient('turnFails');
    const runner = new AgentRunner(client, { sandbox: 'read-only', timeoutMs: 5_000 });
    const result = await runner.invoke(AGENT, 'Audit example.com');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('usage limit');
  });

  it('reports a failing thread start (for example: ZERO not authenticated)', async () => {
    const { client } = makeClient('startFails');
    const runner = new AgentRunner(client, { sandbox: 'read-only', timeoutMs: 5_000 });
    const result = await runner.invoke(AGENT, 'Audit example.com');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not authenticated');
  });

  it('interrupts and reports a timeout when an agent never answers', async () => {
    const { client, calls } = makeClient('silent');
    const runner = new AgentRunner(client, { sandbox: 'read-only', timeoutMs: 30 });
    const result = await runner.invoke(AGENT, 'Audit example.com');
    expect(result.status).toBe('timeout');
    expect(calls.some((call) => call.method === 'turn/interrupt')).toBe(true);
  });

  it('refuses to run a disabled agent', async () => {
    const { client, calls } = makeClient('ok');
    const runner = new AgentRunner(client, { sandbox: 'read-only', timeoutMs: 5_000 });
    const result = await runner.invoke({ ...AGENT, enabled: false }, 'anything');
    expect(result.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});
