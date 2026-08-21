import { describe, expect, it } from 'vitest';
import { BRAIN_SCALE, buildBrainLayout, hashUnit, insideBrain } from '../src/render3d/layout3d';

const AGENTS = [
  { id: 'lead_scraper', department: 'acquisition' },
  { id: 'meta', department: 'orchestration' },
  { id: 'seo', department: 'seo' },
  { id: 'funnel', department: 'funnel' },
  { id: 'insta', department: 'social' },
  { id: 'google_reviews', department: 'reputation' },
  { id: 'website_outreach', department: 'outreach' },
  { id: 'agent_installer', department: 'infrastructure' },
];

describe('brain layout', () => {
  it('is deterministic, so an operator can learn where an agent lives', () => {
    const first = buildBrainLayout(AGENTS);
    const second = buildBrainLayout(AGENTS);
    expect(first.clusters.map((c) => c.hub)).toEqual(second.clusters.map((c) => c.hub));
    expect(first.ambient).toEqual(second.ambient);
  });

  it('gives every agent its own cluster', () => {
    const layout = buildBrainLayout(AGENTS);
    expect(layout.clusters).toHaveLength(AGENTS.length);
    expect(layout.clusters.map((c) => c.agentId).sort()).toEqual(AGENTS.map((a) => a.id).sort());
  });

  it('separates the eight departments, so clusters are visually distinct', () => {
    const layout = buildBrainLayout(AGENTS);
    for (const a of layout.clusters) {
      for (const b of layout.clusters) {
        if (a.agentId === b.agentId) continue;
        const gap = Math.hypot(a.hub.x - b.hub.x, a.hub.y - b.hub.y, a.hub.z - b.hub.z);
        expect(gap, `${a.agentId} vs ${b.agentId}`).toBeGreaterThan(BRAIN_SCALE * 0.25);
      }
    }
  });

  it('keeps every cluster inside the visible bounds', () => {
    const layout = buildBrainLayout(AGENTS);
    for (const cluster of layout.clusters) {
      for (const node of cluster.nodes) {
        const radius = Math.hypot(node.position.x, node.position.y, node.position.z);
        expect(radius).toBeLessThan(layout.bounds.radius * 1.6);
      }
    }
  });

  it('chains cluster filaments rather than spoking them all from the hub', () => {
    const layout = buildBrainLayout(AGENTS, { nodesPerCluster: 20 });
    const cluster = layout.clusters[0]!;
    const fromHub = cluster.links.filter(([from]) => from === 0).length;
    // Some links start at the hub — one per branch — but most must not, or the
    // cluster renders as a star instead of as branching filaments.
    expect(fromHub).toBeLessThan(cluster.links.length / 2);
  });

  it('scales density down without changing the shape', () => {
    const full = buildBrainLayout(AGENTS, { nodesPerCluster: 40, ambientCount: 600 });
    const mobile = buildBrainLayout(AGENTS, { nodesPerCluster: 14, ambientCount: 180 });
    // Same hubs — the phone shows the same brain, with fewer neurons.
    expect(mobile.clusters.map((c) => c.hub)).toEqual(full.clusters.map((c) => c.hub));
    expect(mobile.ambient.length).toBeLessThan(full.ambient.length);
  });

  it('draws a thinner branch for an agent that is offline', () => {
    const healthy = buildBrainLayout([{ id: 'seo', department: 'seo', weight: 1 }]);
    const offline = buildBrainLayout([{ id: 'seo', department: 'seo', weight: 0.45 }]);
    expect(offline.clusters[0]!.nodes.length).toBeLessThan(healthy.clusters[0]!.nodes.length);
  });

  it('confines ambient neurons to the brain silhouette', () => {
    const layout = buildBrainLayout(AGENTS, { ambientCount: 300 });
    for (const point of layout.ambient) {
      expect(
        insideBrain(point.x / BRAIN_SCALE, point.y / BRAIN_SCALE, point.z / BRAIN_SCALE),
      ).toBe(true);
    }
  });

  it('has a silhouette with a fissure and a stem, not a sphere', () => {
    // A point on the midline high up is in the fissure and must be rejected...
    expect(insideBrain(0, 0.3, 0)).toBe(false);
    // ...while the same height offset into a lobe is inside.
    expect(insideBrain(-0.4, 0.3, 0)).toBe(true);
    // The stem hangs below the lobes.
    expect(insideBrain(0, -0.7, 0)).toBe(true);
    // And nothing exists far outside.
    expect(insideBrain(2, 0, 0)).toBe(false);
  });

  it('hashes seeds into a well-spread unit interval', () => {
    const values = Array.from({ length: 400 }, (_, index) => hashUnit(`seed:${index}`));
    expect(Math.min(...values)).toBeLessThan(0.08);
    expect(Math.max(...values)).toBeGreaterThan(0.92);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });

  it('adds a cluster for an agent whose department it has never seen', () => {
    // Registering a new child agent must not require a code change.
    const layout = buildBrainLayout([{ id: 'brand_new', department: 'logistics' }]);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]!.nodes.length).toBeGreaterThan(1);
  });
});
