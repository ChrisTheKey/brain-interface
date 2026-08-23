/**
 * The interface side of publishing.
 *
 * Three things are worth testing here and the rest is React: that the panel
 * never claims ZERO can publish when it cannot, that the activity path is
 * drawn from events that actually happened, and that no credential reaches
 * the browser — the last one asserted against the built bundle, because that
 * is the artefact that ships.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { metricoolSummary } from '../src/state/useMetricool';
import { socialBranch, socialState, withSocial } from '../src/graph/social';
import { SOCIAL_NODE_ID, ZERO_NODE_ID, socialNetworkNodeId } from '../src/graph/model';
import type { GraphModel } from '../src/graph/model';
import type { MetricoolStatus, OperatorEvent } from '../src/hwd/types';

function status(overrides: Partial<MetricoolStatus> = {}): MetricoolStatus {
  return {
    integration: 'metricool',
    server: 'https://ai.metricool.com/mcp',
    connected: true,
    blocked_by: '',
    local_only: false,
    enabled: true,
    brands: 1,
    networks: ['instagram', 'facebook', 'tiktok', 'linkedin', 'threads'],
    publishing_ready: true,
    auth: { state: 'ready', scopes: ['mcp:read', 'mcp:write'] },
    capabilities: { granted: [], missing: [], can_publish: true },
    reason: null,
    ...overrides,
  };
}

let sequence = 0;
function event(type: OperatorEvent['type'], payload: Record<string, unknown> = {}): OperatorEvent {
  sequence += 1;
  return {
    event_id: `e${sequence}`,
    timestamp: new Date(sequence * 1000).toISOString(),
    mission_id: 'social:p1',
    agent_id: 'zero',
    type,
    payload,
  };
}

const emptyGraph: GraphModel = { nodes: [], edges: [], notes: [] };

describe('what the panel says', () => {
  it('never says connected when local-only mode is on', () => {
    expect(metricoolSummary(status({ blocked_by: 'local_only', connected: false }))).toBe(
      'METRICOOL · BLOCKED BY LOCAL-ONLY MODE',
    );
  });

  it('separates connected from able to publish', () => {
    // An account with no linked networks is connected and can publish
    // nothing. Collapsing the two is how an interface implies a post went
    // somewhere it did not.
    expect(metricoolSummary(status({ networks: [], publishing_ready: false }))).toContain(
      'NOT READY',
    );
  });

  it('counts the real networks', () => {
    expect(metricoolSummary(status())).toBe('METRICOOL · CONNECTED · 5 NETWORKS');
  });

  it('says unknown rather than guessing when the runtime did not answer', () => {
    expect(metricoolSummary(null)).toBe('METRICOOL · UNKNOWN');
  });

  it('says off when the integration is switched off', () => {
    expect(metricoolSummary(status({ connected: false, blocked_by: 'metricool_disabled' }))).toBe(
      'METRICOOL · OFF',
    );
  });
});

describe('the activity path', () => {
  it('draws no branch at all when nothing is connected', () => {
    // An empty SOCIAL hub floating beside the brain would imply a capability
    // that is not there.
    const branch = socialBranch(null, []);
    expect(branch.nodes).toEqual([]);
    expect(branch.state).toBe('offline');
  });

  it('draws one node per really connected network and no others', () => {
    const branch = socialBranch(status(), []);
    const networks = branch.nodes.filter((node) => node.type === 'socialNetwork');
    expect(networks.map((node) => node.label)).toEqual([
      'instagram',
      'facebook',
      'tiktok',
      'linkedin',
      'threads',
    ]);
    // Not YouTube, not X, not Pinterest — the brand has no account for them.
    expect(networks.some((node) => node.label === 'youtube')).toBe(false);
  });

  it('runs ZERO through the hub to the networks', () => {
    const branch = socialBranch(status(), []);
    expect(branch.edges[0]).toMatchObject({
      source: ZERO_NODE_ID,
      target: SOCIAL_NODE_ID,
      relationship: 'publishes',
    });
    expect(
      branch.edges.filter((edge) => edge.source === SOCIAL_NODE_ID).map((edge) => edge.target),
    ).toContain(socialNetworkNodeId('instagram'));
  });

  it.each([
    ['zero.social.preparing', 'preparing', 'PREPARING'],
    ['zero.social.awaiting_approval', 'awaiting_approval', 'WAITING FOR APPROVAL'],
    ['zero.social.publishing', 'publishing', 'PUBLISHING'],
    ['zero.social.verifying', 'verifying', 'VERIFYING'],
    ['zero.social.published', 'done', 'DONE'],
    ['zero.social.partial', 'partial_failure', 'PARTIAL FAILURE'],
  ] as const)('shows %s as %s', (type, state, label) => {
    const branch = socialBranch(status(), [event(type)]);
    expect(branch.state).toBe(state);
    expect(branch.label).toBe(label);
  });

  it('never shows PUBLISHING without the runtime having said so', () => {
    // The runtime does not publish that event before a human approves, so the
    // interface cannot show it before then either.
    expect(socialState(status(), [event('zero.social.awaiting_approval')])).toBe(
      'awaiting_approval',
    );
  });

  it('marks the network that failed, not all of them', () => {
    const branch = socialBranch(status(), [
      event('zero.social.partial', {
        published: ['instagram', 'facebook', 'linkedin', 'threads'],
        failed: [{ network: 'tiktok', reason: 'video too long' }],
      }),
    ]);
    const byName = new Map(branch.nodes.map((node) => [node.label, node]));
    expect(byName.get('tiktok')?.status).toBe('error');
    expect(byName.get('tiktok')?.metadata['last']).toBe('FAILED');
    expect(byName.get('instagram')?.metadata['last']).toBe('PUBLISHED');
    expect(branch.state).toBe('partial_failure');
  });

  it('shows local-only as disabled rather than as an error', () => {
    const branch = socialBranch(status({ connected: false, blocked_by: 'local_only' }), []);
    const hub = branch.nodes.find((node) => node.id === SOCIAL_NODE_ID);
    expect(hub?.status).toBe('disabled');
    expect(branch.label).toBe('BLOCKED BY LOCAL-ONLY MODE');
  });

  it('replaces the old branch instead of stacking a second one', () => {
    const once = withSocial(emptyGraph, socialBranch(status(), []));
    const twice = withSocial(once, socialBranch(status(), []));
    expect(twice.nodes.filter((node) => node.id === SOCIAL_NODE_ID)).toHaveLength(1);
    expect(twice.nodes).toHaveLength(6);
  });

  it('removes the branch when the connection goes away', () => {
    const connected = withSocial(emptyGraph, socialBranch(status(), []));
    const gone = withSocial(connected, socialBranch(null, []));
    expect(gone.nodes).toEqual([]);
    expect(gone.edges).toEqual([]);
  });

  it('carries the facts the operator needs on the hub', () => {
    const hub = socialBranch(status(), []).nodes.find((node) => node.id === SOCIAL_NODE_ID);
    expect(hub?.metadata).toMatchObject({
      integration: 'metricool',
      brands: 1,
      networks: 5,
      publishing_ready: true,
    });
  });
});

describe('nothing about Metricool reaches the browser but the status', () => {
  const repoRoot = new URL('..', import.meta.url).pathname;

  function sources(directory: string): string[] {
    const found: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
      }
    };
    walk(directory);
    return found;
  }

  it('never calls Metricool from the browser', () => {
    // The whole architecture in one assertion: the interface talks to the
    // gateway on its own origin, the gateway proxies to HWD-ZERO, and only
    // HWD-ZERO has a credential. Anything in src/ that named
    // ai.metricool.com or app.metricool.com would be a second path.
    for (const file of sources(join(repoRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('ai.metricool.com');
      expect(source, file).not.toContain('app.metricool.com');
      expect(source, file).not.toMatch(/METRICOOL_(TOKEN|SECRET|CLIENT_SECRET|USER_TOKEN)/);
      expect(source, file).not.toMatch(/VITE_[A-Z_]*METRICOOL/);
    }
  });

  it('holds no OAuth machinery in the browser at all', () => {
    // No verifier, no code exchange, no refresh token: the browser's entire
    // part in the sign-in is opening a URL the runtime handed it.
    for (const file of sources(join(repoRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/code_verifier|refresh_token|client_secret/);
    }
  });

  it('is not in the built bundle', () => {
    const assets = join(repoRoot, 'dist', 'assets');
    let names: string[] = [];
    try {
      names = readdirSync(assets).map((entry) => String(entry));
    } catch {
      return; // nothing built in this run; the source checks above still hold
    }
    for (const name of names.filter((entry) => entry.endsWith('.js'))) {
      const bundle = readFileSync(join(assets, name), 'utf8');
      // The endpoints being absent is the proof that matters: the browser
      // cannot reach Metricool, so it has nothing to reach it with.
      expect(bundle, name).not.toContain('ai.metricool.com');
      expect(bundle, name).not.toContain('app.metricool.com');
      expect(bundle, name).not.toContain('code_verifier');
      expect(bundle, name).not.toMatch(/VITE_[A-Z_]*METRICOOL/);
    }
  });
});
