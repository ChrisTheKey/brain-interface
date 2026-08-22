import { describe, expect, it } from 'vitest';
import { buildBrain } from '../src/brain/build';
import { buildEnergyGeometry, buildFilamentGeometry, packetsPerLink } from '../src/three/geometry';
import { ActivityTexture } from '../src/three/activityTexture';
import { profileFor } from '../src/three/quality';
import { accentFor } from '../src/brain/palette';
import { DEPARTMENT_COLORS, departmentRgba } from '../src/zero/agentPolicy';
import type { OperatorRegistry } from '../src/hwd/types';

const REGISTRY: OperatorRegistry = {
  version: '1.0.0',
  agents: [
    { id: 'insta', role: 'social', status: 'idle', purpose: '', strengths: ['posting'], available: true },
    { id: 'seo', role: 'seo', status: 'idle', purpose: '', strengths: [], available: true },
  ],
  projects: [],
};

const graph = buildBrain(REGISTRY);
const slotOf = new Map(graph.clusters.map((cluster, index) => [cluster.agentId, index]));
const activity = new ActivityTexture(8);
const uv = (slot: number): number => activity.uv(slot);

describe('filament geometry', () => {
  it('fills the buffer exactly — no dead vertices at any quality tier', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const profile = profileFor(tier);
      const geometry = buildFilamentGeometry(graph, profile, slotOf, uv);
      const expected =
        graph.links.length * profile.strandsPerLink * profile.filamentSegments * 2;
      expect(geometry.getAttribute('position').count).toBe(expected);
      const positions = geometry.getAttribute('position').array as Float32Array;
      // A zeroed tail would render as a spike through the core.
      expect(positions.every((value) => Number.isFinite(value))).toBe(true);
      geometry.dispose();
    }
  });

  it('carries the department colour and the activity slot on every vertex', () => {
    const geometry = buildFilamentGeometry(graph, profileFor('medium'), slotOf, uv);
    const slots = new Set(Array.from(geometry.getAttribute('aSlot').array as Float32Array));
    expect(slots).toEqual(new Set([uv(0), uv(1)]));
    const progress = geometry.getAttribute('aProgress').array as Float32Array;
    expect(Math.min(...progress)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...progress)).toBeLessThanOrEqual(1);
    geometry.dispose();
  });

  it('renders nothing at all when there is no roster', () => {
    const empty = buildBrain(null);
    const geometry = buildFilamentGeometry(empty, profileFor('high'), new Map(), uv);
    expect(geometry.getAttribute('position').count).toBe(0);
    geometry.dispose();
  });
});

describe('energy geometry', () => {
  it('gives an axon the full stream and a dendrite half of it', () => {
    const profile = profileFor('high');
    expect(packetsPerLink('axon', profile)).toBe(profile.energyPerLink);
    expect(packetsPerLink('dendrite', profile)).toBeLessThan(profile.energyPerLink);
    expect(packetsPerLink('dendrite', profileFor('low'))).toBeGreaterThanOrEqual(1);
  });

  it('creates one packet per link per slot, with its own curve', () => {
    const profile = profileFor('medium');
    const geometry = buildEnergyGeometry(graph, profile, slotOf, uv);
    const expected = graph.links.reduce(
      (total, link) => total + packetsPerLink(link.kind, profile),
      0,
    );
    expect(geometry.getAttribute('position').count).toBe(expected);
    for (const name of ['aFrom', 'aControl', 'aTo', 'aColor']) {
      expect(geometry.getAttribute(name).count).toBe(expected);
    }
    const offsets = geometry.getAttribute('aOffset').array as Float32Array;
    // Packets must not lock step, or the flow looks like a metronome.
    expect(new Set(offsets).size).toBeGreaterThan(1);
    geometry.dispose();
  });
});

describe('the activity texture', () => {
  it('packs energy, direction and status into one pixel per agent', () => {
    const texture = new ActivityTexture(4);
    texture.set(1, 1, -1, 0.5);
    const data = texture.texture.image.data as Uint8Array;
    expect(data[4]).toBe(255); // energy
    expect(data[5]).toBe(0); // direction −1 → 0
    expect(data[6]).toBe(128); // status
    expect(data[7]).toBe(255); // in use

    texture.set(1, 0.5, 1, 1);
    expect(data[5]).toBe(255); // direction +1 → 255
    texture.clear();
    expect(data[4]).toBe(0);
    texture.dispose();
  });

  it('samples the middle of a texel, so a slot never bleeds into its neighbour', () => {
    const texture = new ActivityTexture(4);
    expect(texture.uv(0)).toBeCloseTo(0.125, 5);
    expect(texture.uv(3)).toBeCloseTo(0.875, 5);
    texture.dispose();
  });

  it('ignores a slot outside the texture instead of corrupting another agent', () => {
    const texture = new ActivityTexture(2);
    texture.set(9, 1, 1, 1);
    const data = texture.texture.image.data as Uint8Array;
    expect([...data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    texture.dispose();
  });
});

describe('the department palette', () => {
  it('keeps the hue and changes the brightness with status', () => {
    const idle = accentFor('social', 'idle');
    const active = accentFor('social', 'active');
    expect(active.r).toBeGreaterThan(idle.r);
    // Same hue: the ratio between channels survives.
    expect(active.r / active.b).toBeCloseTo(idle.r / idle.b, 3);
  });

  it('tints an error towards the warning colour without losing the department', () => {
    const error = accentFor('social', 'error');
    const idle = accentFor('social', 'idle');
    expect(error.r / error.b).not.toBeCloseTo(idle.r / idle.b, 2);
  });

  it('exposes each department in both the WebGL and the CSS form', () => {
    for (const [department, hex] of Object.entries(DEPARTMENT_COLORS)) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(departmentRgba(department as keyof typeof DEPARTMENT_COLORS, 0.5)).toMatch(
        /^rgba\(\d+, \d+, \d+, 0\.5\)$/,
      );
    }
  });
});
