/**
 * Hybrid radial / force layout.
 *
 * ZERO is pinned at the geometric centre. Every other node lives on the ring
 * of its graph depth, so the visual hierarchy always reads
 * ZERO → agents → sub-agents / knowledge → tools / sources.
 *
 * Within a ring the nodes are relaxed with a force simulation in *polar*
 * space: angular repulsion between ring neighbours (prevents overlap for any
 * node count) plus a spring towards the parent's angle (keeps children
 * grouped under their origin). Working in polar space keeps rings intact,
 * makes the simulation O(n) per ring neighbour pair and gives the organic,
 * slowly settling motion the brain needs.
 */
import type { GraphModel, GraphNode } from './model';

export interface LayoutNode {
  id: string;
  node: GraphNode;
  /** Current + target polar coordinates. */
  angle: number;
  angularVelocity: number;
  radius: number;
  targetRadius: number;
  /** Cartesian position in layout units (centre = 0,0). */
  x: number;
  y: number;
  /** Visual radius in layout units. */
  size: number;
  /** 0..1 spawn animation. */
  appear: number;
}

export interface LayoutOptions {
  /** Radius of the first ring, in layout units. */
  baseRadius?: number;
  /** Additional radius per depth level. */
  ringSpacing?: number;
  /** Damping applied to angular velocity each step. */
  damping?: number;
  /** Strength of the pull towards the parent angle. */
  parentPull?: number;
  /** Strength of the angular repulsion between ring neighbours. */
  repulsion?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  baseRadius: 210,
  ringSpacing: 135,
  damping: 0.86,
  parentPull: 0.035,
  repulsion: 0.9,
};

export const NODE_SIZES: Record<GraphNode['type'], number> = {
  zero: 54,
  agent: 28,
  session: 21,
  subAgent: 18,
  mcpServer: 24,
  skill: 20,
  tool: 13,
  resource: 12,
  app: 18,
  socialHub: 26,
  socialNetwork: 15,
  adsHub: 26,
  adsAccount: 16,
  toolDependency: 12,
};

export class BrainLayout {
  private readonly options: Required<LayoutOptions>;
  private nodes = new Map<string, LayoutNode>();
  private order: LayoutNode[] = [];

  constructor(options: LayoutOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  get layoutNodes(): LayoutNode[] {
    return this.order;
  }

  get(id: string): LayoutNode | undefined {
    return this.nodes.get(id);
  }

  /** Reconcile with a new graph: keeps positions of surviving nodes. */
  sync(graph: GraphModel): void {
    const next = new Map<string, LayoutNode>();
    const parentAngles = new Map<string, number>();
    const ringRadii = computeRingRadii(graph, this.options);

    for (const node of graph.nodes) {
      const existing = this.nodes.get(node.id);
      const targetRadius =
        node.type === 'zero' ? 0 : (ringRadii.get(node.depth) ?? this.options.baseRadius);

      if (existing) {
        existing.node = node;
        existing.targetRadius = targetRadius;
        existing.size = NODE_SIZES[node.type] ?? 14;
        next.set(node.id, existing);
        continue;
      }

      const parentAngle =
        node.parentId !== null ? (parentAngles.get(node.parentId) ?? null) : null;
      const seedAngle = parentAngle ?? hashAngle(node.id);
      next.set(node.id, {
        id: node.id,
        node,
        angle: seedAngle + (hashAngle(`${node.id}:jitter`) - Math.PI) * 0.12,
        angularVelocity: 0,
        radius: node.type === 'zero' ? 0 : targetRadius * 0.35,
        targetRadius,
        x: 0,
        y: 0,
        size: NODE_SIZES[node.type] ?? 14,
        appear: 0,
      });
    }

    for (const [id, layoutNode] of next) parentAngles.set(id, layoutNode.angle);
    this.nodes = next;
    this.order = [...next.values()].sort((a, b) => a.node.depth - b.node.depth);
    // Materialise cartesian coordinates without advancing the simulation, so
    // that surviving nodes keep the exact position they already had.
    for (const layoutNode of this.order) {
      if (layoutNode.node.type === 'zero') {
        layoutNode.x = 0;
        layoutNode.y = 0;
        continue;
      }
      layoutNode.x = Math.cos(layoutNode.angle) * layoutNode.radius;
      layoutNode.y = Math.sin(layoutNode.angle) * layoutNode.radius;
    }
  }

  /** Advance the simulation. `dt` is in frames (1 = one 60fps frame). */
  step(dt: number): void {
    const clamped = Math.max(0, Math.min(dt, 3));
    const rings = new Map<number, LayoutNode[]>();

    for (const layoutNode of this.order) {
      if (layoutNode.node.type === 'zero') {
        layoutNode.radius = 0;
        layoutNode.x = 0;
        layoutNode.y = 0;
        layoutNode.appear = Math.min(1, layoutNode.appear + 0.06 * clamped);
        continue;
      }
      const ring = rings.get(layoutNode.node.depth) ?? [];
      ring.push(layoutNode);
      rings.set(layoutNode.node.depth, ring);
    }

    for (const [, ring] of rings) {
      const radius = ring[0]?.targetRadius ?? this.options.baseRadius;
      // Work in angular order: every force below is local to a node's two
      // neighbours, which keeps the relaxation stable for any ring population.
      const ordered = [...ring].sort((a, b) => a.angle - b.angle);
      const count = ordered.length;

      for (let i = 0; i < count; i += 1) {
        const a = ordered[i];
        if (!a) continue;
        let force = 0;

        if (count > 1) {
          const previous = ordered[(i - 1 + count) % count];
          const next = ordered[(i + 1) % count];
          if (previous && next) {
            const gapPrevious = positiveAngle(a.angle - previous.angle);
            const gapNext = positiveAngle(next.angle - a.angle);

            // Even out the spacing towards the midpoint of both neighbours.
            force += (gapNext - gapPrevious) * 0.02;

            // Hard separation: never let two discs touch.
            const minPrevious = Math.min(
              Math.PI,
              ((a.size + previous.size) * 1.6) / Math.max(radius, 1),
            );
            const minNext = Math.min(Math.PI, ((a.size + next.size) * 1.6) / Math.max(radius, 1));
            if (gapPrevious < minPrevious) {
              force += ((minPrevious - gapPrevious) / minPrevious) * this.options.repulsion * 0.05;
            }
            if (gapNext < minNext) {
              force -= ((minNext - gapNext) / minNext) * this.options.repulsion * 0.05;
            }
          }
        }

        const parent = a.node.parentId ? this.nodes.get(a.node.parentId) : undefined;
        if (parent && parent.node.type !== 'zero') {
          force += shortestAngle(parent.angle - a.angle) * this.options.parentPull;
        }

        const velocity = (a.angularVelocity + force * clamped) * this.options.damping;
        a.angularVelocity = Math.max(-0.12, Math.min(0.12, velocity));
      }
    }

    for (const layoutNode of this.order) {
      if (layoutNode.node.type === 'zero') continue;
      layoutNode.angle = normalizeAngle(layoutNode.angle + layoutNode.angularVelocity * clamped);
      layoutNode.radius += (layoutNode.targetRadius - layoutNode.radius) * 0.08 * clamped;
      layoutNode.x = Math.cos(layoutNode.angle) * layoutNode.radius;
      layoutNode.y = Math.sin(layoutNode.angle) * layoutNode.radius;
      layoutNode.appear = Math.min(1, layoutNode.appear + 0.045 * clamped);
    }
  }

  /** Scale factor that fits the outermost ring into the given viewport. */
  fitScale(width: number, height: number, padding = 72): number {
    const maxRadius = this.order.reduce(
      (max, node) => Math.max(max, node.targetRadius + node.size),
      this.options.baseRadius,
    );
    const available = Math.max(60, Math.min(width, height) / 2 - padding);
    return Math.min(1.45, available / maxRadius);
  }

  /** Hit-test in layout units. */
  pick(x: number, y: number, tolerance = 6): LayoutNode | null {
    let best: LayoutNode | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const node of this.order) {
      const dx = node.x - x;
      const dy = node.y - y;
      const distance = Math.hypot(dx, dy);
      if (distance <= node.size + tolerance && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }
}

export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

export function shortestAngle(delta: number): number {
  const twoPi = Math.PI * 2;
  let value = ((delta + Math.PI) % twoPi + twoPi) % twoPi;
  value -= Math.PI;
  return value;
}

/** Deterministic pseudo-angle from a node id (stable across reloads). */
export function hashAngle(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

/**
 * Ring radius per depth. A ring grows until every node on it fits with the
 * minimum arc spacing, and never falls inside the ring in front of it — that
 * is what keeps the brain overlap-free for any number of ZERO entities.
 */
export function computeRingRadii(
  graph: GraphModel,
  options: Required<LayoutOptions>,
): Map<number, number> {
  const circumferenceByDepth = new Map<number, number>();
  const maxSizeByDepth = new Map<number, number>();
  for (const node of graph.nodes) {
    if (node.type === 'zero') continue;
    const size = NODE_SIZES[node.type] ?? 14;
    circumferenceByDepth.set(node.depth, (circumferenceByDepth.get(node.depth) ?? 0) + size * 2.9);
    maxSizeByDepth.set(node.depth, Math.max(maxSizeByDepth.get(node.depth) ?? 0, size));
  }

  const radii = new Map<number, number>();
  let previousRadius = 0;
  let previousSize = NODE_SIZES.zero;
  for (const depth of [...circumferenceByDepth.keys()].sort((a, b) => a - b)) {
    const needed = (circumferenceByDepth.get(depth) ?? 0) / (Math.PI * 2);
    const size = maxSizeByDepth.get(depth) ?? 14;
    const spaced = previousRadius + previousSize + size + options.ringSpacing * 0.55;
    const nominal = options.baseRadius + (depth - 1) * options.ringSpacing;
    const radius = Math.max(nominal, needed, spaced);
    radii.set(depth, radius);
    previousRadius = radius;
    previousSize = size;
  }
  return radii;
}

/** Angle difference wrapped into [0, 2π). */
export function positiveAngle(delta: number): number {
  const twoPi = Math.PI * 2;
  return ((delta % twoPi) + twoPi) % twoPi;
}
