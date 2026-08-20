/**
 * Neural filaments.
 *
 * The brain reads as tissue, not as a diagram: every real edge carries a
 * bundle of fine strands beside it, and every node grows short dendrites.
 *
 * This is texture, not data — but it is *bound* to data: a node's dendrite
 * count comes from its real degree in the graph, and a filament only exists
 * where a real ZERO relationship exists. Nothing here invents nodes, edges or
 * activity, and every parameter is derived deterministically from ids, so the
 * strands stay in place instead of flickering each frame.
 */
import type { GraphModel } from '../graph/model';
import type { BrainLayout } from '../graph/layout';
import { hashAngle } from '../graph/layout';

/** Deterministic 0..1 value for a key (same key → same strand, every frame). */
export function hashUnit(key: string): number {
  return hashAngle(key) / (Math.PI * 2);
}

/** How many dendrites a node grows: more real connections → denser tissue. */
export function dendriteCount(degree: number, isZero: boolean): number {
  if (isZero) return Math.min(26, 12 + degree * 2);
  return Math.min(11, 4 + Math.round(degree * 1.6));
}

export interface FilamentOptions {
  /** Strands drawn alongside each edge. */
  strandsPerEdge?: number;
  /** Base opacity; activity and hover add on top. */
  opacity?: number;
}

export function degreeMap(graph: GraphModel): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const edge of graph.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  return degrees;
}

export function drawFilaments(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  scale: number,
  graph: GraphModel,
  layout: BrainLayout,
  pulses: Map<string, { energy: number }>,
  time: number,
  options: FilamentOptions = {},
): void {
  const strandsPerEdge = options.strandsPerEdge ?? 4;
  const baseOpacity = options.opacity ?? 0.2;
  const degrees = degreeMap(graph);

  ctx.save();
  ctx.lineCap = 'round';

  // --- strand bundles along the real edges ---------------------------------
  for (const edge of graph.edges) {
    const source = layout.get(edge.source);
    const target = layout.get(edge.target);
    if (!source || !target) continue;

    const sx = centerX + source.x * scale;
    const sy = centerY + source.y * scale;
    const tx = centerX + target.x * scale;
    const ty = centerY + target.y * scale;

    const dx = tx - sx;
    const dy = ty - sy;
    const length = Math.hypot(dx, dy);
    if (length < 4) continue;
    // Perpendicular unit vector: strands fan out sideways from the edge.
    const nx = -dy / length;
    const ny = dx / length;

    const energy = Math.max(
      pulses.get(edge.source)?.energy ?? 0,
      pulses.get(edge.target)?.energy ?? 0,
    );
    const visibility = Math.min(source.appear, target.appear);

    for (let strand = 0; strand < strandsPerEdge; strand += 1) {
      const seed = hashUnit(`${edge.id}:${strand}`);
      const side = strand % 2 === 0 ? 1 : -1;
      const spread = (0.06 + seed * 0.16) * length * side;
      const shimmer = 0.65 + 0.35 * Math.sin(time * 0.5 + seed * 12);
      const alpha = (baseOpacity * shimmer + energy * 0.3) * visibility;
      if (alpha < 0.008) continue;

      const midX = (sx + tx) / 2 + nx * spread;
      const midY = (sy + ty) / 2 + ny * spread;

      ctx.strokeStyle = `rgba(226, 232, 248, ${alpha.toFixed(4)})`;
      ctx.lineWidth = 0.55 * Math.max(0.6, scale);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(midX, midY, tx, ty);
      ctx.stroke();
    }
  }

  // --- dendrites around every node -----------------------------------------
  for (const layoutNode of layout.layoutNodes) {
    const isZero = layoutNode.node.type === 'zero';
    const degree = degrees.get(layoutNode.id) ?? 0;
    const count = dendriteCount(degree, isZero);
    if (count === 0) continue;

    const x = centerX + layoutNode.x * scale;
    const y = centerY + layoutNode.y * scale;
    const radius = layoutNode.size * scale;
    const energy = pulses.get(layoutNode.id)?.energy ?? 0;

    for (let i = 0; i < count; i += 1) {
      const seed = hashUnit(`${layoutNode.id}:dendrite:${i}`);
      const angle = seed * Math.PI * 2 + Math.sin(time * 0.12 + seed * 8) * 0.05;
      const length = radius * (isZero ? 1.4 + seed * 3.4 : 1.0 + seed * 2.4);
      const shimmer = 0.6 + 0.4 * Math.sin(time * 0.6 + seed * 14);
      const alpha = ((isZero ? 0.3 : 0.22) * shimmer + energy * 0.4) * layoutNode.appear;
      if (alpha < 0.008) continue;

      const startX = x + Math.cos(angle) * radius * 0.92;
      const startY = y + Math.sin(angle) * radius * 0.92;
      const endX = x + Math.cos(angle) * (radius + length);
      const endY = y + Math.sin(angle) * (radius + length);
      // A slight bend keeps the strands organic instead of star-shaped.
      const bend = (seed - 0.5) * length * 0.6;
      const controlX = (startX + endX) / 2 - Math.sin(angle) * bend;
      const controlY = (startY + endY) / 2 + Math.cos(angle) * bend;

      ctx.strokeStyle = `rgba(232, 238, 252, ${alpha.toFixed(4)})`;
      ctx.lineWidth = 0.5 * Math.max(0.6, scale);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(controlX, controlY, endX, endY);
      ctx.stroke();

      // Second-order branch: what makes the strands read as tissue.
      if (seed > 0.35) {
        const branchAngle = angle + (seed - 0.5) * 1.1;
        const branchStartX = x + Math.cos(angle) * (radius + length * 0.55);
        const branchStartY = y + Math.sin(angle) * (radius + length * 0.55);
        const branchLength = length * (0.35 + seed * 0.4);
        ctx.strokeStyle = `rgba(226, 234, 250, ${(alpha * 0.7).toFixed(4)})`;
        ctx.lineWidth = 0.4 * Math.max(0.6, scale);
        ctx.beginPath();
        ctx.moveTo(branchStartX, branchStartY);
        ctx.lineTo(
          branchStartX + Math.cos(branchAngle) * branchLength,
          branchStartY + Math.sin(branchAngle) * branchLength,
        );
        ctx.stroke();
      }

      // Terminal bouton: a barely visible dot at the tip.
      const tipAlpha = alpha * 0.9;
      ctx.fillStyle = `rgba(244, 246, 255, ${tipAlpha.toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(endX, endY, 0.7 * Math.max(0.6, scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}
