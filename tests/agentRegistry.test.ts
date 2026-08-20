import { describe, expect, it, vi } from 'vitest';
import { buildDiscoveryScript, loadAgents, parseDiscoveryOutput } from '../src/zero/agentRegistry';
import { CHILD_AGENTS, EXCLUDED_REPOSITORIES } from '../src/zero/agentPolicy';
import type { ZeroClient } from '../src/zero/client';

const SEP = '\u0001';

/** Mirrors ZERO's scan output: name, cwd, remote, branch, headline, then evidence. */
function scanLine(options: {
  name: string;
  cwd?: string;
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
    options.cwd ?? `/ws/${options.name}`,
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

/** A workspace that contains everything: agents, system repos, excluded repos. */
function fullWorkspaceScan(): string {
  return [
    '__SCAN__',
    ...CHILD_AGENTS.map((agent) =>
      scanLine({
        name: agent.repo,
        remote: `https://github.com/ChrisTheKey/${agent.repo}`,
        branch: 'main',
        instructions: true,
      }),
    ),
    scanLine({ name: 'HWD-ZERO', zero: true, entry: true }),
    scanLine({ name: 'brain-interface', frontend: true, entry: true }),
    ...EXCLUDED_REPOSITORIES.map((repo) =>
      // Deliberately "agent-looking": instructions and an entrypoint. The
      // exclusion must still win.
      scanLine({ name: repo, instructions: true, entry: true }),
    ),
  ].join('\n');
}

describe('agent registry discovery', () => {
  it('registers exactly the eight child agents of HWD-ZERO', () => {
    const result = parseDiscoveryOutput(fullWorkspaceScan(), '/ws');

    expect(result.agents.map((agent) => agent.id).sort()).toEqual(
      [
        'agent_installer',
        'funnel',
        'google_reviews',
        'insta',
        'lead_scraper',
        'meta',
        'seo',
        'website_outreach',
      ].sort(),
    );
    expect(result.agents).toHaveLength(8);
    expect(result.agents[0]).toMatchObject({
      cwd: expect.stringContaining('/ws/'),
      enabled: true,
      callable: true,
      classification: 'agent',
      source: 'scan',
    });
    // Every agent carries its department and its approval-gated capabilities.
    for (const agent of result.agents) {
      expect(agent.department).toBeTruthy();
      expect(agent.requiresApprovalFor?.length).toBeGreaterThan(0);
      expect(agent.invocationMethod).toContain('thread/start');
    }
  });

  it.each(EXCLUDED_REPOSITORIES)('never registers %s', (repo) => {
    const result = parseDiscoveryOutput(fullWorkspaceScan(), '/ws');
    expect(result.agents.some((agent) => agent.name === repo)).toBe(false);
    expect(result.agents.some((agent) => agent.cwd.endsWith(`/${repo}`))).toBe(false);
    // It is not silently dropped either: it is reported as excluded.
    expect(result.excluded).toContain(repo);
    // And it never even reaches the classifier output.
    expect(result.repositories.some((entry) => entry.name === repo)).toBe(false);
  });

  it('never registers HWD-ZERO or brain-interface as child agents', () => {
    const result = parseDiscoveryOutput(fullWorkspaceScan(), '/ws');
    expect(result.agents.some((agent) => agent.cwd.endsWith('/HWD-ZERO'))).toBe(false);
    expect(result.agents.some((agent) => agent.cwd.endsWith('/brain-interface'))).toBe(false);
    const classifications = new Map(
      result.repositories.map((entry) => [entry.name, entry.classification]),
    );
    expect(classifications.get('HWD-ZERO')).toBe('zero');
    expect(classifications.get('brain-interface')).toBe('interface');
  });

  it('does not register a repository just because it looks like an agent', () => {
    const stdout = [
      '__SCAN__',
      scanLine({ name: 'Some-Random-Agent', instructions: true, entry: true }),
    ].join('\n');
    const result = parseDiscoveryOutput(stdout, '/ws');
    expect(result.agents).toEqual([]);
  });

  it('takes ids, display names and departments from the policy, not from the folder', () => {
    const stdout = ['__SCAN__', scanLine({ name: 'Meta-Agent', instructions: true })].join('\n');
    const result = parseDiscoveryOutput(stdout, '/ws');
    expect(result.agents[0]).toMatchObject({
      id: 'meta',
      name: 'Meta Agent',
      department: 'orchestration',
    });
  });

  it('lets a manifest add metadata but never resurrect an excluded repository', () => {
    const manifest = JSON.stringify({
      agents: [
        {
          id: 'seo',
          name: 'SEO',
          cwd: '/ws/SEO',
          role: 'analyst',
          capabilities: ['audit', 'keywords'],
        },
        // An operator mistake: an excluded repository declared as an agent.
        { id: 'website_building', name: 'Website-Building', cwd: '/ws/Website-Building' },
      ],
    });
    const stdout = [
      '__MANIFEST__',
      manifest,
      '__SCAN__',
      scanLine({ name: 'SEO', remote: 'https://github.com/me/SEO', branch: 'main', instructions: true }),
      scanLine({ name: 'Website-Building', instructions: true }),
    ].join('\n');

    const result = parseDiscoveryOutput(stdout, '/ws');
    expect(result.source).toBe('manifest');
    expect(result.agents.map((agent) => agent.id)).toEqual(['seo']);
    expect(result.agents[0]).toMatchObject({
      role: 'analyst',
      capabilities: ['audit', 'keywords'],
      department: 'seo',
      repository: 'https://github.com/me/SEO',
      branch: 'main',
    });
    expect(result.excluded).toContain('Website-Building');
  });

  it('reports an empty registry instead of inventing agents', () => {
    const result = parseDiscoveryOutput('__SCAN__\n', '/ws');
    expect(result.agents).toEqual([]);
    expect(result.source).toBe('none');
  });

  it('quotes the root so paths with spaces or quotes stay safe', () => {
    const script = buildDiscoveryScript('/home/me/my agents', "/home/me/it's/zero-agents.json");
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
      root: '/ws',
      manifestPath: '/ws/zero-agents.json',
      execSandbox: 'readOnly',
    });
    expect(result.agents).toEqual([]);
    expect(result.error).toContain('sandbox denied exec');
  });

  it('does not call ZERO at all when no agent root is configured', async () => {
    const request = vi.fn();
    const client = { request } as unknown as ZeroClient;
    const result = await loadAgents(client, { root: '', manifestPath: '', execSandbox: 'readOnly' });
    expect(request).not.toHaveBeenCalled();
    expect(result.error).toContain('VITE_ZERO_AGENT_ROOT');
  });
});
