import { describe, expect, it } from 'vitest';
import { buildBrain, definitionFor, isBlockedByPolicy, terminalsFor } from '../src/brain/build';
import { CORE_ID, agentHubId } from '../src/brain/model';
import { EXCLUDED_REPOSITORIES, CHILD_AGENTS } from '../src/zero/agentPolicy';
import type { OperatorAgent, OperatorRegistry } from '../src/hwd/types';

function agent(overrides: Partial<OperatorAgent> & { id: string }): OperatorAgent {
  return {
    role: '',
    status: 'idle',
    purpose: '',
    strengths: [],
    available: true,
    ...overrides,
  };
}

function registry(agents: OperatorAgent[]): OperatorRegistry {
  return { version: '1.0.0', agents, projects: [] };
}

const ROSTER = registry([
  agent({ id: 'lead_scraper', role: 'acquisition', purpose: 'Finds leads', strengths: ['scraping'] }),
  agent({ id: 'insta', role: 'social', purpose: 'Runs Instagram', strengths: ['posting', 'dm'] }),
  agent({ id: 'seo', role: 'seo', purpose: 'Ranks pages' }),
]);

describe('the brain graph', () => {
  it('shows ZERO alone until HWD-ZERO answers', () => {
    const graph = buildBrain(null);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.id).toBe(CORE_ID);
    expect(graph.clusters).toHaveLength(0);
    expect(graph.notes.join(' ')).toContain('/api/agents');
  });

  it('builds one cluster per agent the operator reports', () => {
    const graph = buildBrain(ROSTER);
    expect(graph.clusters.map((cluster) => cluster.agentId)).toEqual([
      'lead_scraper',
      'insta',
      'seo',
    ]);
    // Core + three hubs + their terminals.
    expect(graph.nodes.filter((node) => node.kind === 'agent')).toHaveLength(3);
    expect(graph.nodes.filter((node) => node.kind === 'satellite').length).toBeGreaterThan(3);
  });

  it('links every cluster to ZERO and every terminal to its own hub', () => {
    const graph = buildBrain(ROSTER);
    const axons = graph.links.filter((link) => link.kind === 'axon');
    expect(axons).toHaveLength(3);
    for (const axon of axons) expect(axon.source).toBe(CORE_ID);

    const dendrites = graph.links.filter((link) => link.kind === 'dendrite');
    for (const dendrite of dendrites) {
      expect(dendrite.source).toBe(agentHubId(dendrite.clusterId));
    }
    // No link ever points at a node that does not exist.
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const link of graph.links) {
      expect(ids.has(link.source)).toBe(true);
      expect(ids.has(link.target)).toBe(true);
    }
  });

  it('colours a cluster from the operator policy, not from the agent name', () => {
    const graph = buildBrain(ROSTER);
    const byId = new Map(graph.clusters.map((cluster) => [cluster.agentId, cluster]));
    expect(byId.get('lead_scraper')?.department).toBe('acquisition');
    expect(byId.get('insta')?.department).toBe('social');
    expect(byId.get('seo')?.department).toBe('seo');
  });

  it.each(EXCLUDED_REPOSITORIES)('never renders %s, whatever the operator sends', (repo) => {
    const graph = buildBrain(
      registry([
        agent({ id: repo, purpose: 'should not exist' }),
        agent({ id: 'x', repo, purpose: 'should not exist either' }),
        agent({ id: 'seo' }),
      ]),
    );
    const rendered = JSON.stringify(graph.nodes) + JSON.stringify(graph.clusters);
    expect(rendered).not.toContain(repo);
    expect(graph.excluded).toContain(repo);
    // …and the roster it did not block is untouched.
    expect(graph.clusters.map((cluster) => cluster.agentId)).toEqual(['seo']);
  });

  it('keeps HWD-ZERO and the interface out of the agent ring', () => {
    const graph = buildBrain(
      registry([agent({ id: 'hwd', repo: 'HWD-ZERO' }), agent({ id: 'ui', repo: 'brain-interface' })]),
    );
    expect(graph.clusters).toHaveLength(0);
  });

  it('lights exactly the agents the event stream reported as running', () => {
    const graph = buildBrain(ROSTER, {
      activeAgentIds: ['insta'],
      erroredAgentIds: ['seo'],
      blockedAgentIds: ['lead_scraper'],
      agentActivity: new Map([['insta', { label: 'posting story', missionId: 'M-1', at: 1 }]]),
    });
    const byId = new Map(graph.clusters.map((cluster) => [cluster.agentId, cluster]));
    expect(byId.get('insta')?.status).toBe('active');
    expect(byId.get('insta')?.activity).toBe('posting story');
    expect(byId.get('seo')?.status).toBe('error');
    expect(byId.get('lead_scraper')?.status).toBe('blocked');
    expect(graph.nodes.find((node) => node.id === CORE_ID)?.status).toBe('active');
  });

  it('says so when the operator reported no capability for an agent', () => {
    // An agent the policy does not declare and the registry describes with
    // nothing: the cluster still has a body, but the note says why it is bare.
    const graph = buildBrain(registry([agent({ id: 'unlisted_helper' })]));
    const note = graph.notes.find((entry) => entry.includes('structural terminals'));
    expect(note).toBeTruthy();
    expect(note).toContain('unlisted_helper');
    const terminals = graph.nodes.filter((node) => node.kind === 'satellite');
    expect(terminals.length).toBeGreaterThan(0);
    expect(terminals.every((node) => node.metadata['terminal'] === 'structural')).toBe(true);
  });

  it('is deterministic: the same roster lands in exactly the same places', () => {
    const a = buildBrain(ROSTER);
    const b = buildBrain(ROSTER);
    expect(a.nodes.map((node) => node.position)).toEqual(b.nodes.map((node) => node.position));
  });

  it('spreads the clusters apart instead of stacking them', () => {
    const graph = buildBrain(ROSTER);
    const hubs = graph.nodes.filter((node) => node.kind === 'agent');
    for (let i = 0; i < hubs.length; i += 1) {
      for (let j = i + 1; j < hubs.length; j += 1) {
        const a = hubs[i]!.position;
        const b = hubs[j]!.position;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.4);
      }
    }
  });
});

describe('repository classification', () => {
  const evidence = (name: string, overrides: Record<string, boolean> = {}) => ({
    name,
    cwd: `/w/${name}`,
    agentInstructions: false,
    hasBin: false,
    hasEntrypoint: false,
    mcpServer: false,
    frontend: false,
    zeroRuntime: false,
    ...overrides,
  });

  it('says what each repository is, when the operator reports the evidence', () => {
    const graph = buildBrain({
      ...ROSTER,
      repositories: [
        evidence('HWD-ZERO', { zeroRuntime: true }),
        evidence('brain-interface', { frontend: true }),
        evidence('some-mcp', { mcpServer: true }),
        evidence('Insta-Agent', { agentInstructions: true }),
      ],
    });
    const notes = graph.notes.join(' | ');
    expect(notes).toContain('zero');
    expect(notes).toContain('HWD-ZERO');
    expect(notes).toContain('interface');
    expect(notes).toContain('toolProvider');
    // An actual agent is not listed as "not shown as an agent".
    expect(notes).not.toContain('Insta-Agent');
  });

  it('never classifies an excluded repository — it is blocked before that', () => {
    const graph = buildBrain({
      ...ROSTER,
      repositories: [evidence('Prompt-Optimizer', { agentInstructions: true })],
    });
    expect(graph.notes.join(' ')).not.toContain('Prompt-Optimizer');
  });

  it('says nothing extra when the operator reports no evidence at all', () => {
    const withEvidence = buildBrain({ ...ROSTER, repositories: [] });
    expect(withEvidence.notes).toEqual(buildBrain(ROSTER).notes);
  });
});

describe('policy resolution', () => {
  it('recognises every declared child agent by id and by repository', () => {
    for (const definition of CHILD_AGENTS) {
      expect(definitionFor(agent({ id: definition.id }))?.repo).toBe(definition.repo);
      expect(definitionFor(agent({ id: 'x', repo: definition.repo }))?.id).toBe(definition.id);
    }
  });

  it('blocks an excluded repository however it is spelled into the payload', () => {
    expect(isBlockedByPolicy(agent({ id: 'Prompt-Optimizer' }))).toBe(true);
    expect(isBlockedByPolicy(agent({ id: 'x', repo: 'prompt-optimizer' }))).toBe(true);
    expect(isBlockedByPolicy(agent({ id: 'x', role: 'Loop-Engeneering' }))).toBe(true);
    expect(isBlockedByPolicy(agent({ id: 'seo' }))).toBe(false);
  });

  it('turns real strengths and real gates into terminals, in that order', () => {
    const terminals = terminalsFor(
      agent({ id: 'insta', strengths: ['posting'] }),
      definitionFor(agent({ id: 'insta' })),
    );
    expect(terminals[0]).toEqual({ label: 'posting', kind: 'strength' });
    expect(terminals.some((terminal) => terminal.kind === 'gate')).toBe(true);
    expect(terminals.every((terminal) => terminal.kind !== 'structural')).toBe(true);
  });
});
