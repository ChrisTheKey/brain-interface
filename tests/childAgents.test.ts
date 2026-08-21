import { describe, expect, it } from 'vitest';
import { looksRunnable, reconcile } from '../src/state/useChildAgents';
import { CHILD_AGENTS, EXCLUDED_REPOSITORIES } from '../src/zero/agentPolicy';
import type { DiscoveredRepository } from '../src/hwd/types';

/**
 * Reconciling what the runtime found with what the policy allows.
 *
 * The panel showed "6 REGISTERED" against a policy that names eight, and the
 * six were not child agents at all — they were HWD-ZERO's own roles (`zero`,
 * `codex`, `claude-code`, `perplexity`, `checkmate`, `pulse`), read from the
 * brain registry. Two populations under one label, and the real child agents
 * were invisible because discovery ran through the codex app-server that a
 * phone never runs.
 *
 * The split these tests pin down: the runtime reports facts, this module
 * applies policy, and neither invents an agent.
 */

function repo(name: string, extra: Partial<DiscoveredRepository> = {}): DiscoveredRepository {
  return {
    name,
    path: `/workspace/${name}`,
    is_git: true,
    markers: ['README.md'],
    ...extra,
  };
}

const ALL_EIGHT = CHILD_AGENTS.map((agent) => repo(agent.repo));

describe('child agent reconciliation', () => {
  it('counts all eight when all eight are on disk', () => {
    const { present, missing } = reconcile(ALL_EIGHT);
    expect(present).toHaveLength(8);
    expect(missing).toEqual([]);
    expect(new Set(present.map((agent) => agent.id)).size).toBe(8);
  });

  it('names exactly which ones are missing rather than rounding the count', () => {
    const { present, missing } = reconcile(ALL_EIGHT.slice(0, 6));
    expect(present).toHaveLength(6);
    // "6/8 DISCOVERED" is only useful if the two can be named.
    expect(missing).toEqual([CHILD_AGENTS[6]!.repo, CHILD_AGENTS[7]!.repo]);
  });

  it('never invents an agent from an unrelated directory', () => {
    const { present, missing } = reconcile([
      repo('some-other-project'),
      repo('notes'),
      repo('HWD-ZERO'),
      repo('brain-interface'),
    ]);
    // The runtime and the interface are system repositories, not agents.
    expect(present).toEqual([]);
    expect(missing).toHaveLength(8);
  });

  it('refuses the four excluded repositories even when they are present', () => {
    const excluded = EXCLUDED_REPOSITORIES.map((name) => repo(name));
    const { present } = reconcile([...excluded, ...ALL_EIGHT]);
    // The exclusions hold here exactly as they do everywhere else: a directory
    // on disk is not permission to become an agent.
    expect(present).toHaveLength(8);
    for (const name of EXCLUDED_REPOSITORIES) {
      expect(present.some((agent) => agent.repo === name)).toBe(false);
    }
  });

  it('does not count an empty directory as a discovered agent', () => {
    // A bare directory is not an agent, and counting it would make the tally
    // read complete when it is not.
    const hollow = repo('SEO', { is_git: false, markers: [] });
    expect(looksRunnable(hollow)).toBe(false);
    expect(reconcile([hollow]).present).toEqual([]);
    expect(reconcile([hollow]).missing).toContain('SEO');
  });

  it('accepts a checkout or any recognisable project marker', () => {
    expect(looksRunnable(repo('SEO', { is_git: true, markers: [] }))).toBe(true);
    expect(looksRunnable(repo('SEO', { is_git: false, markers: ['package.json'] }))).toBe(true);
    expect(reconcile([repo('SEO', { is_git: false, markers: ['pyproject.toml'] })]).present)
      .toHaveLength(1);
  });

  it('matches repository names case-insensitively', () => {
    // Checkouts differ in case across machines; the policy should not.
    const { present } = reconcile([repo('seo'), repo('FUNNEL')]);
    expect(present.map((agent) => agent.id).sort()).toEqual(['funnel', 'seo']);
  });

  it('counts a repository once even if it appears twice', () => {
    expect(reconcile([repo('SEO'), repo('SEO')]).present).toHaveLength(1);
  });

  it('reports nothing found when the workspace is empty', () => {
    const { present, missing } = reconcile([]);
    expect(present).toEqual([]);
    // All eight are named, so the operator knows what to clone.
    expect(missing).toHaveLength(8);
    expect(missing).toEqual(CHILD_AGENTS.map((agent) => agent.repo));
  });

  it('does not mistake ZERO\'s own roles for child agents', () => {
    // These are what the panel was actually counting: brain registry entries.
    const roles = ['zero', 'claude-code', 'codex', 'perplexity', 'checkmate', 'pulse'];
    const { present, missing } = reconcile(roles.map((name) => repo(name)));
    expect(present).toEqual([]);
    expect(missing).toHaveLength(8);
  });
});
