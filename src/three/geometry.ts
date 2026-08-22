/**
 * The geometry the brain is built from.
 *
 * Kept apart from the React components on purpose: these are pure functions
 * over the brain graph and the quality profile, so the buffer sizes — which
 * have to match the profile exactly, or a quality change would leave dead
 * vertices behind — are unit-tested without a WebGL context.
 */
import { BufferAttribute, BufferGeometry, type Color } from 'three';
import { hashUnit, type BrainGraph } from '../brain/model';
import { sampleCurve } from '../brain/layout3d';
import { accentFor } from '../brain/palette';
import type { QualityProfile } from './quality';

/** Axons carry the full stream; a dendrite gets half, rounded up to one. */
export function packetsPerLink(kind: 'axon' | 'dendrite', profile: QualityProfile): number {
  return kind === 'axon' ? profile.energyPerLink : Math.max(1, Math.round(profile.energyPerLink / 2));
}

function usableLinks(graph: BrainGraph): BrainGraph['links'] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  return graph.links.filter((link) => ids.has(link.source) && ids.has(link.target));
}

/**
 * The merged strand bundle.
 *
 * Strand 0 of every link is the real relationship HWD-ZERO reports. The other
 * strands bundle around it by a deterministic offset — that is texture, not
 * data, and it is what makes the brain read as tissue instead of as wires.
 */
export function buildFilamentGeometry(
  graph: BrainGraph,
  profile: QualityProfile,
  slotOf: ReadonlyMap<string, number>,
  uvOf: (slot: number) => number,
): BufferGeometry {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const segments = profile.filamentSegments;
  const strands = profile.strandsPerLink;
  const links = usableLinks(graph);
  const vertexCount = links.length * strands * segments * 2;

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const progress = new Float32Array(vertexCount);
  const slots = new Float32Array(vertexCount);
  const strandIds = new Float32Array(vertexCount);

  let cursor = 0;
  const write = (
    point: readonly [number, number, number],
    color: Color,
    t: number,
    slotUv: number,
    strand: number,
  ): void => {
    positions[cursor * 3] = point[0];
    positions[cursor * 3 + 1] = point[1];
    positions[cursor * 3 + 2] = point[2];
    colors[cursor * 3] = color.r;
    colors[cursor * 3 + 1] = color.g;
    colors[cursor * 3 + 2] = color.b;
    progress[cursor] = t;
    slots[cursor] = slotUv;
    strandIds[cursor] = strand;
    cursor += 1;
  };

  for (const link of links) {
    const source = nodeById.get(link.source);
    const target = nodeById.get(link.target);
    if (!source || !target) continue;
    const slotUv = uvOf(slotOf.get(link.clusterId) ?? 0);
    const color = accentFor(link.department, target.status);

    for (let strand = 0; strand < strands; strand += 1) {
      const spread = strand === 0 ? 0 : (hashUnit(`${link.id}:${strand}`) - 0.5) * 0.09;
      const control: readonly [number, number, number] = [
        link.control[0] + spread,
        link.control[1] + spread * 0.7,
        link.control[2] - spread,
      ];
      let previous = sampleCurve(source.position, control, target.position, 0);
      for (let i = 1; i <= segments; i += 1) {
        const t = i / segments;
        const point = sampleCurve(source.position, control, target.position, t);
        write(previous, color, (i - 1) / segments, slotUv, strand);
        write(point, color, t, slotUv, strand);
        previous = point;
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new BufferAttribute(colors, 3));
  geometry.setAttribute('aProgress', new BufferAttribute(progress, 1));
  geometry.setAttribute('aSlot', new BufferAttribute(slots, 1));
  geometry.setAttribute('aStrand', new BufferAttribute(strandIds, 1));
  return geometry;
}

/**
 * The travelling energy. Each packet carries its own curve, so the whole
 * system animates in the vertex shader with no per-frame CPU work.
 */
export function buildEnergyGeometry(
  graph: BrainGraph,
  profile: QualityProfile,
  slotOf: ReadonlyMap<string, number>,
  uvOf: (slot: number) => number,
): BufferGeometry {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const links = usableLinks(graph);
  const count = links.reduce((total, link) => total + packetsPerLink(link.kind, profile), 0);

  const positions = new Float32Array(count * 3);
  const from = new Float32Array(count * 3);
  const control = new Float32Array(count * 3);
  const to = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const offsets = new Float32Array(count);
  const speeds = new Float32Array(count);
  const slots = new Float32Array(count);

  let cursor = 0;
  for (const link of links) {
    const source = nodeById.get(link.source);
    const target = nodeById.get(link.target);
    if (!source || !target) continue;
    const color = accentFor(link.department, target.status);
    const slotUv = uvOf(slotOf.get(link.clusterId) ?? 0);
    const packets = packetsPerLink(link.kind, profile);
    for (let i = 0; i < packets; i += 1) {
      const base = cursor * 3;
      from[base] = source.position[0];
      from[base + 1] = source.position[1];
      from[base + 2] = source.position[2];
      control[base] = link.control[0];
      control[base + 1] = link.control[1];
      control[base + 2] = link.control[2];
      to[base] = target.position[0];
      to[base + 1] = target.position[1];
      to[base + 2] = target.position[2];
      colors[base] = color.r;
      colors[base + 1] = color.g;
      colors[base + 2] = color.b;
      // Evenly phased, with a deterministic jitter so packets never lock step.
      offsets[cursor] = i / packets + hashUnit(`${link.id}:${i}`) * 0.12;
      speeds[cursor] = link.kind === 'axon' ? 0.22 : 0.4;
      slots[cursor] = slotUv;
      cursor += 1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aFrom', new BufferAttribute(from, 3));
  geometry.setAttribute('aControl', new BufferAttribute(control, 3));
  geometry.setAttribute('aTo', new BufferAttribute(to, 3));
  geometry.setAttribute('aColor', new BufferAttribute(colors, 3));
  geometry.setAttribute('aOffset', new BufferAttribute(offsets, 1));
  geometry.setAttribute('aSpeed', new BufferAttribute(speeds, 1));
  geometry.setAttribute('aSlot', new BufferAttribute(slots, 1));
  return geometry;
}
