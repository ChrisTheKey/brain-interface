/**
 * The brain's shape in three dimensions.
 *
 * Positions are deterministic: the same agent id always lands in the same place,
 * from a seeded hash rather than `Math.random()`. That matters more than it
 * looks like it should — an operator learns where SEO lives, and a layout that
 * reshuffled on every reload would make the picture unreadable as a picture.
 *
 * The silhouette is a brain rather than a sphere: two lobes, longer than tall,
 * with a fissure down the middle and a stem below. It is not anatomy — it is
 * the outline you recognise from across the room, which is what the reference
 * image is doing too.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ClusterNode {
  id: string;
  position: Vec3;
  /** 0 = the cluster's own hub, 1..n = its filament nodes. */
  rank: number;
  /** Radius in world units. */
  size: number;
}

export interface AgentCluster {
  agentId: string;
  department: string;
  /** The cluster's hub — the node the ZERO core connects to. */
  hub: Vec3;
  nodes: ClusterNode[];
  /** Index pairs into `nodes`, forming the cluster's internal filaments. */
  links: Array<[number, number]>;
}

export interface BrainLayout3D {
  core: Vec3;
  coreRadius: number;
  clusters: AgentCluster[];
  /** Loose neurons that belong to no cluster; they give the brain its mass. */
  ambient: Vec3[];
  /** Long axon-like arcs across the silhouette. */
  axons: Array<{ from: Vec3; to: Vec3; bulge: number }>;
  bounds: { radius: number };
}

/** Overall size of the brain in world units. */
export const BRAIN_SCALE = 10;
const CORE_RADIUS = 1.55;

/**
 * A small deterministic hash → [0, 1).
 *
 * FNV-1a, then a couple of xorshift rounds. Cheap, stable across engines, and
 * it decorrelates adjacent seeds — important because seeds here are the agent
 * id plus a small integer, so a weak hash would line every cluster's nodes up
 * in the same relative pattern.
 */
export function hashUnit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491);
  hash ^= hash >>> 13;
  return ((hash >>> 0) % 1_000_003) / 1_000_003;
}

function jitter(seed: string, spread: number): number {
  return (hashUnit(seed) - 0.5) * 2 * spread;
}

/**
 * Whether a point is inside the brain silhouette.
 *
 * Two overlapping ellipsoids offset on x, minus a shallow fissure at the
 * midline, plus a stem below. Used to reject ambient neurons so the mass of the
 * brain has an outline instead of being a cloud.
 */
export function insideBrain(x: number, y: number, z: number): boolean {
  const lobeOffset = 0.42;
  const inLobe = (cx: number): boolean => {
    const dx = (x - cx) / 1.0;
    const dy = y / 0.78;
    const dz = z / 0.72;
    return dx * dx + dy * dy + dz * dz <= 1;
  };
  const inStem = Math.abs(x) < 0.3 && y < -0.45 && y > -0.95 && Math.abs(z) < 0.25;
  if (inStem) return true;
  if (!inLobe(-lobeOffset) && !inLobe(lobeOffset)) return false;
  // The fissure: a thin gap at the midline, only in the upper half.
  const inFissure = Math.abs(x) < 0.055 && y > -0.1;
  return !inFissure;
}

/**
 * Where each department sits.
 *
 * Chosen so related work is adjacent — acquisition, seo and outreach form the
 * left-to-right path a lead actually travels — and so the eight are spread
 * across both lobes rather than ringed evenly, which would read as a diagram.
 */
const DEPARTMENT_ANCHORS: Record<string, Vec3> = {
  orchestration: { x: 0.0, y: 0.62, z: 0.1 },
  acquisition: { x: -0.68, y: 0.26, z: 0.3 },
  seo: { x: -0.6, y: -0.2, z: -0.25 },
  outreach: { x: -0.3, y: -0.52, z: 0.34 },
  funnel: { x: 0.34, y: -0.5, z: -0.3 },
  social: { x: 0.7, y: 0.22, z: -0.3 },
  reputation: { x: 0.62, y: -0.16, z: 0.34 },
  infrastructure: { x: 0.06, y: 0.1, z: -0.62 },
};

/** Anchor for a department the operator adds later, derived from its name. */
function anchorFor(department: string, agentId: string): Vec3 {
  const known = DEPARTMENT_ANCHORS[department];
  if (known) return known;
  const angle = hashUnit(`${department}:angle`) * Math.PI * 2;
  const tilt = (hashUnit(`${agentId}:tilt`) - 0.5) * 1.1;
  return {
    x: Math.cos(angle) * 0.62,
    y: Math.sin(angle) * 0.5,
    z: tilt * 0.5,
  };
}

export interface AgentSeed {
  id: string;
  department: string;
  /** Fewer nodes for an agent that is offline — a dead branch looks thinner. */
  weight?: number;
}

/**
 * Build the layout.
 *
 * `nodesPerCluster` and `ambientCount` are the quality dial: the mobile profile
 * passes smaller numbers and gets the same shape with less geometry, rather
 * than a different-looking brain.
 */
export function buildBrainLayout(
  agents: AgentSeed[],
  options: { nodesPerCluster?: number; ambientCount?: number } = {},
): BrainLayout3D {
  const perCluster = options.nodesPerCluster ?? 26;
  const ambientCount = options.ambientCount ?? 420;

  const clusters: AgentCluster[] = agents.map((agent) => {
    const anchor = anchorFor(agent.department, agent.id);
    const weight = agent.weight ?? 1;
    const count = Math.max(6, Math.round(perCluster * weight));

    const hub: Vec3 = {
      x: (anchor.x + jitter(`${agent.id}:hx`, 0.03)) * BRAIN_SCALE,
      y: (anchor.y + jitter(`${agent.id}:hy`, 0.03)) * BRAIN_SCALE,
      z: (anchor.z + jitter(`${agent.id}:hz`, 0.03)) * BRAIN_SCALE,
    };

    const nodes: ClusterNode[] = [
      { id: `${agent.id}:hub`, position: hub, rank: 0, size: 0.5 },
    ];

    // Filaments grow outward from the hub in a few branching directions rather
    // than filling a ball, so a cluster reads as neural rather than as a blob.
    const branches = 3 + Math.floor(hashUnit(`${agent.id}:branches`) * 3);
    for (let index = 1; index <= count; index += 1) {
      const branch = index % branches;
      const along = index / count;
      const theta = hashUnit(`${agent.id}:${branch}:theta`) * Math.PI * 2;
      const phi = (hashUnit(`${agent.id}:${branch}:phi`) - 0.5) * Math.PI;
      const reach = (0.35 + along * 1.25) * (0.9 + hashUnit(`${agent.id}:${index}:r`) * 0.45);

      nodes.push({
        id: `${agent.id}:${index}`,
        position: {
          x: hub.x + Math.cos(theta) * Math.cos(phi) * reach + jitter(`${agent.id}:${index}:x`, 0.5),
          y: hub.y + Math.sin(phi) * reach + jitter(`${agent.id}:${index}:y`, 0.5),
          z: hub.z + Math.sin(theta) * Math.cos(phi) * reach + jitter(`${agent.id}:${index}:z`, 0.5),
        },
        rank: index,
        size: 0.16 + hashUnit(`${agent.id}:${index}:s`) * 0.12,
      });
    }

    // Chain each node to an earlier one on the same branch, so filaments are
    // connected paths rather than spokes from the hub.
    const links: Array<[number, number]> = [];
    for (let index = 1; index < nodes.length; index += 1) {
      const branch = index % branches;
      let parent = 0;
      for (let candidate = index - 1; candidate >= 1; candidate -= 1) {
        if (candidate % branches === branch) {
          parent = candidate;
          break;
        }
      }
      links.push([parent, index]);
    }

    return { agentId: agent.id, department: agent.department, hub, nodes, links };
  });

  // Ambient neurons: rejection-sampled so they fill the silhouette.
  const ambient: Vec3[] = [];
  for (let index = 0; ambient.length < ambientCount && index < ambientCount * 12; index += 1) {
    const x = jitter(`amb:${index}:x`, 1.25);
    const y = jitter(`amb:${index}:y`, 0.95);
    const z = jitter(`amb:${index}:z`, 0.9);
    if (!insideBrain(x, y, z)) continue;
    ambient.push({ x: x * BRAIN_SCALE, y: y * BRAIN_SCALE, z: z * BRAIN_SCALE });
  }

  // Long arcs between distant ambient neurons — the white filaments that give
  // the reference image its depth.
  const axons: Array<{ from: Vec3; to: Vec3; bulge: number }> = [];
  const axonCount = Math.min(150, Math.floor(ambient.length / 4));
  for (let index = 0; index < axonCount; index += 1) {
    const a = ambient[Math.floor(hashUnit(`axon:${index}:a`) * ambient.length)];
    const b = ambient[Math.floor(hashUnit(`axon:${index}:b`) * ambient.length)];
    if (!a || !b) continue;
    const span = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (span < BRAIN_SCALE * 0.35 || span > BRAIN_SCALE * 1.15) continue;
    axons.push({ from: a, to: b, bulge: 0.15 + hashUnit(`axon:${index}:c`) * 0.35 });
  }

  return {
    core: { x: 0, y: 0, z: 0 },
    coreRadius: CORE_RADIUS,
    clusters,
    ambient,
    axons,
    bounds: { radius: BRAIN_SCALE * 1.35 },
  };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
