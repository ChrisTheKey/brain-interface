import { describe, expect, it, vi } from 'vitest';
import { buildDiscoveryScript, loadAgents, parseDiscoveryOutput } from '../src/zero/agentRegistry';
import type { ZeroClient } from '../src/zero/client';

const SEP = '\u0001';

/** Mirrors ZERO's scan output: name, cwd, remote, branch, headline, then evidence. */
function scanLine(options: {
  name: string;
  cwd: string;
  remote?: string;
  branch?: string;
  headline?: string;
  instructions?: boolean;
  packageName?: string;
  bin?: boolean;
  entry?: boolean;
  mcp?: boolean;
  frontend?: boolean;
  zero?: boolean;
}): string {
  const flag = (value?: boolean): string => (value ? 'yes' : 'no');
  return [
    options.name,
    options.cwd,
    options.remote ?? '',
    options.branch ?? '',
    options.headline ?? '',
    flag(options.instructions),
    options.packageName ?? '',
    flag(options.bin),
    flag(options.entry),
    flag(options.mcp),
    flag(options.frontend),
    flag(options.zero),
  ].join(SEP);
}

describe('agent registry discovery', () => {
  it('parses the repository scan ZERO returns and keeps only real agents', () => {
    const stdout = [
      '__SCAN__',
      scanLine({
        name: 'Meta-Agent',
        cwd: '/home/me/agents/Meta-Agent',
        remote: 'https://github.com/me/Meta-Agent',
        branch: 'main',
        headline: 'Builds other agents',
        instructions: true,
      }),
      // A frontend and the ZERO runtime must not become agent nodes.
      scanLine({ name: 'brain-interface', cwd: '/home/me/agents/brain-interface', frontend: true }),
      scanLine({ name: 'HWD-ZERO', cwd: '/home/me/agents/HWD-ZERO', zero: true }),
      // No entrypoint, no instructions → not an agent either.
      scanLine({ name: 'notes', cwd: '/home/me/agents/notes' }),
    ].join('\n');

    const result = parseDiscoveryOutput(stdout, '/home/me/agents');
    expect(result.source).toBe('scan');
    expect(result.agents.map((agent) => agent.id)).toEqual(['Meta-Agent']);
    expect(result.agents[0]).toMatchObject({
      name: 'Meta-Agent',
      cwd: '/home/me/agents/Meta-Agent',
      repository: 'https://github.com/me/Meta-Agent',
      branch: 'main',
      description: 'Builds other agents',
      hasInstructions: true,
      enabled: true,
      callable: true,
      source: 'scan',
      classification: 'agent',
    });
    expect(result.repositories.map((entry) => entry.classification).sort()).toEqual([
      'agent',
      'interface',
      'library',
      'zero',
    ]);
  });

  it('prefers the manifest and enriches it with what only disk knows', () => {
    const manifest = JSON.stringify({
      agents: [
        {
          id: 'seo',
          name: 'SEO',
          role: 'analyst',
          cwd: '/home/me/agents/SEO',
          capabilities: ['audit', 'keywords'],
          inputs: ['url'],
          outputs: ['report'],
        },
        { id: 'disabled-one', name: 'Funnel', cwd: '/home/me/agents/Funnel', enabled: false },
      ],
    });
    const stdout = [
      '__MANIFEST__',
      manifest,
      '__SCAN__',
      scanLine({
        name: 'SEO',
        cwd: '/home/me/agents/SEO',
        remote: 'https://github.com/me/SEO',
        branch: 'main',
        headline: 'SEO agent',
        instructions: true,
      }),
      scanLine({ name: 'Funnel', cwd: '/home/me/agents/Funnel', remote: 'https://github.com/me/Funnel', branch: 'main' }),
    ].join('\n');

    const result = parseDiscoveryOutput(stdout, '/home/me/agents');
    expect(result.source).toBe('manifest');
    expect(result.agents[0]).toMatchObject({
      id: 'seo',
      role: 'analyst',
      capabilities: ['audit', 'keywords'],
      repository: 'https://github.com/me/SEO',
      branch: 'main',
      hasInstructions: true,
    });
    expect(result.agents[1]?.enabled).toBe(false);
  });

  it('exposes the invocation method ZERO really uses', () => {
    const stdout = ['__SCAN__', scanLine({ name: 'SEO', cwd: '/a/SEO', instructions: true })].join('\n');
    const result = parseDiscoveryOutput(stdout, '/a');
    expect(result.agents[0]?.invocationMethod).toContain('thread/start');
  });

  it('reports an empty registry instead of inventing agents', () => {
    const result = parseDiscoveryOutput('__SCAN__\n', '/home/me/agents');
    expect(result.agents).toEqual([]);
    expect(result.source).toBe('none');
  });

  it('quotes the root so paths with spaces or quotes stay safe', () => {
    const script = buildDiscoveryScript("/home/me/my agents", "/home/me/it's/zero-agents.json");
    expect(script).toContain("'/home/me/my agents'");
    expect(script).toContain(`'/home/me/it'\\''s/zero-agents.json'`);
  });

  it('surfaces a failing discovery command as an error, with no agents', async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error('sandbox denied exec');
      }),
    } as unknown as ZeroClient;

    const result = await loadAgents(client, {
      root: '/home/me/agents',
      manifestPath: '/home/me/agents/zero-agents.json',
      execSandbox: 'readOnly',
    });
    expect(result.agents).toEqual([]);
    expect(result.error).toContain('sandbox denied exec');
  });

  it('does not call ZERO at all when no agent root is configured', async () => {
    const request = vi.fn();
    const client = { request } as unknown as ZeroClient;
    const result = await loadAgents(client, {
      root: '',
      manifestPath: '',
      execSandbox: 'readOnly',
    });
    expect(request).not.toHaveBeenCalled();
    expect(result.error).toContain('VITE_ZERO_AGENT_ROOT');
  });
});
