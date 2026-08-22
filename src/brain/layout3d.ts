/**
 * Deterministic 3D layout.
 *
 * ZERO is pinned at the origin and every agent cluster sits on a sphere around
 * it, spread by a Fibonacci lattice — the only distribution that stays evenly
 * spaced for *any* agent count, which matters because the roster comes from the
 * operator and can change while the brain is running.
 *
 * Every position is a pure function of ids and counts, so a node keeps its
 * place across refreshes and nothing jumps when a mission updates the registry.
 */
import { hashUnit, type Vec3 } from './model';

export interface LayoutOptions {
  /** Radius of the agent-hub shell, in brain units. */
  hubRadius?: number;
  /** How far a satellite sits outside its hub. */
  satelliteSpread?: number;
  /** Vertical squash: a brain is wider than it is tall. */
  flatten?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  hubRadius: 0.78,
  satelliteSpread: 0.24,
  flatten: 0.74,
};

/**
 * The furthest any node can land from the core, in brain units: the hub shell
 * at its jitter maximum plus a terminal at its own. The rig sizes the brain
 * from this, so adding an agent can never push the outer ring off screen.
 */
export const BRAIN_EXTENT = 0.78 * 1.12 + 0.24 * 1.42 + 0.24 * 1.2;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * `index` of `count` points on a sphere. Even for one agent (which lands on
 * the equator rather than at a pole, so the brain never looks lopsided).
 */
export function fibonacciSpherePoint(index: number, count: number): Vec3 {
  const total = Math.max(1, count);
  if (total === 1) return [1, 0, 0];
  // Sample strictly inside the poles: a hub exactly on a pole would collapse
  // its satellite ring into a line.
  const y = 1 - ((index + 0.5) / total) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * index;
  return [Math.cos(theta) * radius, y, Math.sin(theta) * radius];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Two unit vectors perpendicular to `axis` — the plane a cluster fans out in. */
export function orthonormalBasis(axis: Vec3): { u: Vec3; v: Vec3 } {
  const normal = normalize(axis);
  // Pick the world axis least aligned with `normal`, so the cross product is
  // never degenerate.
  const reference: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(normal, reference));
  const v = normalize(cross(normal, u));
  return { u, v };
}

/** Position of an agent hub. */
export function hubPosition(
  agentId: string,
  index: number,
  count: number,
  options: LayoutOptions = {},
): Vec3 {
  const { hubRadius, flatten } = { ...DEFAULTS, ...options };
  const direction = fibonacciSpherePoint(index, count);
  // A small deterministic wobble keeps the shell from reading as a lattice.
  const jitter = 0.88 + hashUnit(`${agentId}:radius`) * 0.24;
  const radius = hubRadius * jitter;
  return [direction[0] * radius, direction[1] * radius * flatten, direction[2] * radius];
}

/**
 * Position of one satellite of a hub: on a small disc around the hub, tilted
 * into the plane perpendicular to the hub's own direction, so every cluster
 * fans *outward* from ZERO instead of into it.
 */
export function satellitePosition(
  hub: Vec3,
  key: string,
  index: number,
  count: number,
  options: LayoutOptions = {},
): Vec3 {
  const { satelliteSpread } = { ...DEFAULTS, ...options };
  const outward = normalize(hub);
  const { u, v } = orthonormalBasis(outward);
  const total = Math.max(1, count);
  const angle = (index / total) * Math.PI * 2 + hashUnit(`${key}:angle`) * 0.9;
  const spread = satelliteSpread * (0.72 + hashUnit(`${key}:spread`) * 0.7);
  const outwardPush = satelliteSpread * (0.35 + hashUnit(`${key}:push`) * 0.85);
  return [
    hub[0] + (u[0] * Math.cos(angle) + v[0] * Math.sin(angle)) * spread + outward[0] * outwardPush,
    hub[1] + (u[1] * Math.cos(angle) + v[1] * Math.sin(angle)) * spread + outward[1] * outwardPush,
    hub[2] + (u[2] * Math.cos(angle) + v[2] * Math.sin(angle)) * spread + outward[2] * outwardPush,
  ];
}

/**
 * Control point of the curve between two nodes. Bowed away from the centre so
 * axons arc like real fibres instead of forming a star, and deterministic so
 * the arc is identical on every frame.
 */
export function curveControlPoint(from: Vec3, to: Vec3, key: string, bow = 0.22): Vec3 {
  const mid: Vec3 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
  const outward = normalize(mid);
  const { u, v } = orthonormalBasis(outward);
  const angle = hashUnit(`${key}:bend`) * Math.PI * 2;
  const amount = bow * (0.5 + hashUnit(`${key}:bow`));
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const lateral = amount * distance;
  return [
    mid[0] + (u[0] * Math.cos(angle) + v[0] * Math.sin(angle)) * lateral + outward[0] * lateral * 0.5,
    mid[1] + (u[1] * Math.cos(angle) + v[1] * Math.sin(angle)) * lateral + outward[1] * lateral * 0.5,
    mid[2] + (u[2] * Math.cos(angle) + v[2] * Math.sin(angle)) * lateral + outward[2] * lateral * 0.5,
  ];
}

/** Quadratic Bézier sample — the shared definition for renderer and tests. */
export function sampleCurve(from: Vec3, control: Vec3, to: Vec3, t: number): Vec3 {
  const inverse = 1 - t;
  const a = inverse * inverse;
  const b = 2 * inverse * t;
  const c = t * t;
  return [
    a * from[0] + b * control[0] + c * to[0],
    a * from[1] + b * control[1] + c * to[1],
    a * from[2] + b * control[2] + c * to[2],
  ];
}
