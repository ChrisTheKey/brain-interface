import { describe, expect, it, vi } from 'vitest';
import { ZeroDataAdapter } from '../src/zero/adapter';
import type { ZeroClient } from '../src/zero/client';

/** Minimal ZERO stand-in that answers the exact methods the adapter calls. */
function makeClient(responses: Record<string, unknown>, failing: string[] = []) {
  const notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  const requested: { method: string; params: unknown }[] = [];
  const client = {
    serverUserAgent: 'zero-test/1.0',
    connectionState: 'connected',
    request: vi.fn(async (method: string, params: unknown) => {
      requested.push({ method, params });
      if (failing.includes(method)) throw new Error(`${method} not supported`);
      return responses[method] ?? {};
    }),
    on: (event: string, handler: unknown) => {
      if (event === 'notification') {
        notificationHandlers.push(handler as (method: string, params: unknown) => void);
      }
      return () => undefined;
    },
  } as unknown as ZeroClient;
  return {
    client,
    requested,
    emit: (method: string, params: unknown) => {
      for (const handler of notificationHandlers) handler(method, params);
    },
  };
}

const THREADS = {
  'thread/list': {
    data: [
      {
        id: 'thr_root',
        preview: 'Refactor the renderer',
        cwd: '/workspace/zero',
        createdAt: 1,
        updatedAt: 2,
        modelProvider: 'openai',
        source: 'cli',
        status: { type: 'idle' },
      },
    ],
  },
};

describe('ZeroDataAdapter', () => {
  it('collects ZERO entities and reports which APIs answered', async () => {
    const { client, requested } = makeClient({
      ...THREADS,
      'account/read': { account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' }, requiresOpenaiAuth: true },
      'config/read': { config: { model: 'gpt-5.1-codex', mcp_servers: { perplexity: {} } } },
      'thread/loaded/list': { data: ['thr_root'] },
      'skills/list': {
        data: [{ cwd: '/workspace/zero', skills: [{ name: 'code-review', description: 'x', path: '/p', scope: 'repo', enabled: true }], errors: [] }],
      },
      'mcpServerStatus/list': {
        data: [{ name: 'perplexity', authStatus: 'unsupported', tools: { perplexity_ask: { name: 'perplexity_ask', inputSchema: {} } }, resources: [], resourceTemplates: [] }],
      },
    }, ['app/list']);

    const adapter = new ZeroDataAdapter(client, { extraCwds: [], threadLimit: 10 });
    const snapshot = await adapter.loadSnapshot();

    expect(snapshot.zero.model).toBe('gpt-5.1-codex');
    expect(snapshot.zero.configuredMcpServers).toEqual(['perplexity']);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.skills[0]?.skills[0]?.name).toBe('code-review');
    expect(snapshot.mcpServers[0]?.name).toBe('perplexity');
    // A failing endpoint degrades into a capability note, not fake data.
    expect(snapshot.apps).toEqual([]);
    expect(snapshot.capabilities.find((entry) => entry.method === 'app/list')?.ok).toBe(false);
    // skills/list is scoped to the cwds ZERO itself reported.
    const skillsCall = requested.find((entry) => entry.method === 'skills/list');
    expect(skillsCall?.params).toMatchObject({ cwds: ['/workspace/zero'] });
  });

  it('turns ZERO notifications into activity events', async () => {
    const { client, emit } = makeClient(THREADS);
    const adapter = new ZeroDataAdapter(client, { extraCwds: [], threadLimit: 10 });
    const events: string[] = [];
    adapter.on('activity', (event) => events.push(`${event.kind}:${event.label}`));
    adapter.listen();

    emit('turn/started', { threadId: 'thr_root', turn: { id: 't1', status: 'inProgress', items: [] } });
    emit('item/started', {
      threadId: 'thr_root',
      item: { type: 'mcpToolCall', id: 'i1', server: 'perplexity', tool: 'perplexity_ask', status: 'inProgress' },
    });
    emit('thread/status/changed', { threadId: 'thr_root', status: { type: 'active', activeFlags: [] } });

    expect(events).toEqual([
      'turnStarted:turn started',
      'mcpToolCall:perplexity · perplexity_ask',
      'threadStatus:status: active',
    ]);
  });

  it('marks tool nodes touched by MCP tool calls', async () => {
    const { client, emit } = makeClient(THREADS);
    const adapter = new ZeroDataAdapter(client, { extraCwds: [], threadLimit: 10 });
    const touches: string[][] = [];
    adapter.on('activity', (event) => touches.push(event.touches ?? []));
    adapter.listen();
    emit('item/completed', {
      threadId: 'thr_root',
      item: { type: 'mcpToolCall', id: 'i1', server: 'perplexity', tool: 'perplexity_ask', status: 'completed' },
    });
    expect(touches[0]).toEqual(['mcp:perplexity', 'tool:perplexity/perplexity_ask']);
  });
});
