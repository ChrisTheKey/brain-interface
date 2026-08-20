import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/transform';
import type { ZeroSnapshot } from '../src/zero/adapter';

function snapshot(partial: Partial<ZeroSnapshot> = {}): ZeroSnapshot {
  return {
    zero: {
      userAgent: 'zero/1.0',
      account: null,
      requiresOpenaiAuth: false,
      model: 'gpt-5.1-codex',
      modelProvider: 'openai',
      approvalPolicy: null,
      sandboxMode: null,
      agentRoles: [],
      configuredMcpServers: [],
    },
    agents: [],
    agentRegistry: { source: 'none', root: '/workspace', repositories: [], excluded: [] },
    threads: [],
    loadedThreadIds: [],
    skills: [],
    mcpServers: [],
    apps: [],
    capabilities: [],
    fetchedAt: 0,
    ...partial,
  };
}

describe('buildGraph', () => {
  it('always keeps ZERO as the centre, even without a backend', () => {
    const graph = buildGraph(null);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ id: 'zero', type: 'zero', depth: 0 });
  });

  it('derives sub-agent edges from thread_spawn parents, not from guesses', () => {
    const graph = buildGraph(
      snapshot({
        threads: [
          {
            id: 'thr_parent',
            preview: 'root',
            cwd: '/w',
            createdAt: 1,
            modelProvider: 'openai',
            source: 'cli',
            status: { type: 'active', activeFlags: [] },
          },
          {
            id: 'thr_child',
            preview: 'explore',
            cwd: '/w',
            createdAt: 2,
            modelProvider: 'openai',
            agentRole: 'explorer',
            agentNickname: 'Atlas',
            source: {
              subAgent: {
                thread_spawn: { parent_thread_id: 'thr_parent', depth: 1, agent_role: 'explorer' },
              },
            },
            status: { type: 'idle' },
          },
        ],
      }),
    );

    const child = graph.nodes.find((node) => node.id === 'thread:thr_child');
    expect(child).toMatchObject({ type: 'subAgent', depth: 2, parentId: 'thread:thr_parent' });
    expect(child?.label).toBe('Atlas');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'thread:thr_parent',
        target: 'thread:thr_child',
        relationship: 'spawned',
      }),
    );
    // The root thread hangs off ZERO.
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'zero', target: 'thread:thr_parent', relationship: 'orchestrates' }),
    );
  });

  it('maps review/compact sub-agents onto their real ZERO relationship', () => {
    const graph = buildGraph(
      snapshot({
        threads: [
          {
            id: 'thr_review',
            preview: 'review',
            cwd: '/w',
            createdAt: 1,
            modelProvider: 'openai',
            source: { subAgent: 'review' },
          },
        ],
      }),
    );
    expect(graph.edges[0]).toMatchObject({ relationship: 'review', target: 'thread:thr_review' });
  });

  it('expands MCP servers into tool and resource nodes', () => {
    const graph = buildGraph(
      snapshot({
        mcpServers: [
          {
            name: 'perplexity',
            authStatus: 'unsupported',
            tools: {
              perplexity_ask: { name: 'perplexity_ask', description: 'Ask Perplexity', inputSchema: {} },
            },
            resources: [{ name: 'docs', uri: 'perplexity://docs' }],
            resourceTemplates: [],
          },
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        'mcp:perplexity',
        'tool:perplexity/perplexity_ask',
        'resource:perplexity/perplexity://docs',
      ]),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'mcp:perplexity',
        target: 'tool:perplexity/perplexity_ask',
        relationship: 'provides',
      }),
    );
  });

  it('links repo-scoped skills to the agents working in the same cwd', () => {
    const graph = buildGraph(
      snapshot({
        threads: [
          {
            id: 'thr_a',
            preview: 'work',
            cwd: '/workspace/zero',
            createdAt: 1,
            modelProvider: 'openai',
            source: 'cli',
          },
        ],
        skills: [
          {
            cwd: '/workspace/zero',
            errors: [],
            skills: [
              { name: 'code-review', description: 'Review code', path: '/p/SKILL.md', scope: 'repo', enabled: true },
              { name: 'pdf', description: 'PDF tools', path: '/u/SKILL.md', scope: 'user', enabled: false },
            ],
          },
        ],
        mcpServers: [],
      }),
    );

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'thread:thr_a',
        target: 'skill:/workspace/zero:code-review',
        relationship: 'workspaceKnowledge',
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'zero', target: 'skill:/u/SKILL.md', relationship: 'knowledge' }),
    );
    expect(graph.nodes.find((node) => node.id === 'skill:/u/SKILL.md')?.status).toBe('disabled');
  });

  it('links skill tool dependencies to the matching MCP server', () => {
    const graph = buildGraph(
      snapshot({
        mcpServers: [
          { name: 'perplexity', authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [] },
        ],
        skills: [
          {
            cwd: '/w',
            errors: [],
            skills: [
              {
                name: 'research',
                description: 'Research',
                path: '/p',
                scope: 'user',
                enabled: true,
                dependencies: { tools: [{ type: 'mcp', value: 'perplexity' }] },
              },
            ],
          },
        ],
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'skill:/p', target: 'mcp:perplexity', relationship: 'requires' }),
    );
  });

  it('records missing ZERO APIs as notes instead of inventing nodes', () => {
    const graph = buildGraph(
      snapshot({ capabilities: [{ method: 'app/list', ok: false, error: 'not supported' }] }),
    );
    expect(graph.notes.some((note) => note.includes('app/list'))).toBe(true);
    expect(graph.nodes.filter((node) => node.type === 'app')).toHaveLength(0);
  });
});

describe('runtime agent state', () => {
  it('marks an agent active only while its real run is in flight', () => {
    const withAgent = snapshot({
      agents: [
        {
          id: 'seo',
          name: 'SEO',
          cwd: '/agents/SEO',
          enabled: true,
          source: 'scan',
          classification: 'agent',
          classificationReason: 'ships agent instructions',
          callable: true,
          invocationMethod: 'thread/start',
        },
      ],
    });

    const idle = buildGraph(withAgent);
    expect(idle.nodes.find((node) => node.id === 'agent:seo')?.status).toBe('idle');

    const running = buildGraph(withAgent, {
      activeAgentIds: ['seo'],
      agentTasks: new Map([['seo', { task: 'Audit example.com', status: 'running', at: 1 }]]),
    });
    const node = running.nodes.find((entry) => entry.id === 'agent:seo');
    expect(node?.status).toBe('active');
    expect(node?.metadata['currentTask']).toBe('Audit example.com');
    expect(node?.metadata['lastRunStatus']).toBe('running');
  });

  it('keeps the finished task as last activity, not as a current one', () => {
    const graph = buildGraph(
      snapshot({
        agents: [
          {
            id: 'seo',
            name: 'SEO',
            cwd: '/agents/SEO',
            enabled: true,
            source: 'scan',
            classification: 'agent',
            classificationReason: 'runnable workspace',
            callable: true,
            invocationMethod: 'thread/start',
          },
        ],
      }),
      {
        activeAgentIds: [],
        agentTasks: new Map([['seo', { task: 'Audit example.com', status: 'completed', at: 1 }]]),
      },
    );
    const node = graph.nodes.find((entry) => entry.id === 'agent:seo');
    expect(node?.status).toBe('idle');
    expect(node?.metadata['lastTask']).toBe('Audit example.com');
    expect(node?.metadata['currentTask']).toBeUndefined();
  });
});

describe('ZERO runtime repository', () => {
  it('couples the ZERO checkout to the ZERO node', () => {
    const graph = buildGraph(
      snapshot({
        agentRegistry: {
          source: 'scan',
          root: '/agents',
          excluded: [],
          repositories: [
            {
              name: 'HWD-ZERO',
              cwd: '/agents/HWD-ZERO',
              agentInstructions: false,
              hasBin: false,
              hasEntrypoint: true,
              mcpServer: false,
              frontend: false,
              zeroRuntime: true,
              classification: 'zero',
              reason: 'contains the ZERO agent runtime',
              callable: false,
              repository: 'https://github.com/me/HWD-ZERO',
              branch: 'main',
            },
          ],
        },
      }),
    );
    const zero = graph.nodes.find((node) => node.id === 'zero');
    expect(zero?.metadata['runtimeWorkspace']).toBe('/agents/HWD-ZERO');
    expect(zero?.metadata['runtimeRepository']).toBe('https://github.com/me/HWD-ZERO');
    expect(zero?.metadata['runtimeBranch']).toBe('main');
    // The runtime is never drawn as an agent.
    expect(graph.nodes.filter((node) => node.type === 'agent')).toHaveLength(0);
  });
});
