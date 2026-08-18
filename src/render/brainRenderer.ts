/**
 * Canvas 2D renderer for the brain.
 *
 * Rendering order: background (CSS layer, below the canvas) → edges →
 * smoke around ZERO → nodes → labels. The renderer owns no data: it draws the
 * layout that was computed from ZERO's graph, plus the transient activity
 * pulses the adapter reported.
 */
import type { GraphEdge, GraphModel } from '../graph/model';
import type { BrainLayout, LayoutNode } from '../graph/layout';
import type { AudioLevels } from '../audio/analyser';
import { NODE_PALETTE, STATUS_ACCENT } from './palette';
import type { SmokeField } from './smoke';

export interface ActivityPulse {
  /** 1 → just happened, decays to 0. */
  energy: number;
  at: number;
}

export interface RenderState {
  graph: GraphModel;
  layout: BrainLayout;
  pulses: Map<string, ActivityPulse>;
  hoveredId: string | null;
  selectedId: string | null;
  audio: AudioLevels;
  /** Seconds since start, used for the slow ZERO breathing. */
  time: number;
}

export function drawBrain(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: RenderState,
  smoke: SmokeField,
): void {
  const centerX = width / 2;
  const centerY = height / 2;
  const scale = state.layout.fitScale(width, height);

  ctx.clearRect(0, 0, width, height);

  drawEdges(ctx, centerX, centerY, scale, state);
  smoke.draw(ctx, centerX, centerY, scale);
  drawNodes(ctx, centerX, centerY, scale, state);
}

function edgeAlpha(edge: GraphEdge, pulses: Map<string, ActivityPulse>): number {
  const source = pulses.get(edge.source)?.energy ?? 0;
  const target = pulses.get(edge.target)?.energy ?? 0;
  const activity = Math.max(source, target);
  const base = edge.status === 'notLoaded' || edge.status === 'disabled' ? 0.07 : 0.14;
  return base + activity * 0.5;
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  scale: number,
  state: RenderState,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  for (const edge of state.graph.edges) {
    const source = state.layout.get(edge.source);
    const target = state.layout.get(edge.target);
    if (!source || !target) continue;

    const sx = centerX + source.x * scale;
    const sy = centerY + source.y * scale;
    const tx = centerX + target.x * scale;
    const ty = centerY + target.y * scale;

    // Slight outward bow so concentric edges stay readable.
    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;
    const bow = 0.12;
    const cx = midX + (midX - centerX) * bow;
    const cy = midY + (midY - centerY) * bow;

    const alpha = edgeAlpha(edge, state.pulses) * Math.min(source.appear, target.appear);
    const highlighted =
      state.hoveredId === edge.source ||
      state.hoveredId === edge.target ||
      state.selectedId === edge.source ||
      state.selectedId === edge.target;

    ctx.strokeStyle = highlighted
      ? `rgba(180, 214, 255, ${Math.min(0.85, alpha + 0.35).toFixed(3)})`
      : `rgba(150, 175, 225, ${alpha.toFixed(3)})`;
    ctx.lineWidth = (highlighted ? 1.5 : 0.9) * Math.max(0.6, scale);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(cx, cy, tx, ty);
    ctx.stroke();

    // Travelling pulse on live edges.
    const energy = Math.max(
      state.pulses.get(edge.source)?.energy ?? 0,
      state.pulses.get(edge.target)?.energy ?? 0,
    );
    if (energy > 0.05) {
      const t = (state.time * 0.5) % 1;
      const px = quadratic(sx, cx, tx, t);
      const py = quadratic(sy, cy, ty, t);
      ctx.fillStyle = `rgba(190, 230, 255, ${(energy * 0.8).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, 1.8 * Math.max(0.7, scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  scale: number,
  state: RenderState,
): void {
  for (const layoutNode of state.layout.layoutNodes) {
    if (layoutNode.node.type === 'zero') continue;
    drawNode(ctx, centerX, centerY, scale, state, layoutNode);
  }
  const zero = state.layout.get('zero');
  if (zero) drawZero(ctx, centerX, centerY, scale, state, zero);
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  scale: number,
  state: RenderState,
  layoutNode: LayoutNode,
): void {
  const palette = NODE_PALETTE[layoutNode.node.type];
  const pulse = state.pulses.get(layoutNode.id)?.energy ?? 0;
  const hovered = state.hoveredId === layoutNode.id;
  const selected = state.selectedId === layoutNode.id;
  const appear = easeOut(layoutNode.appear);

  const x = centerX + layoutNode.x * scale;
  const y = centerY + layoutNode.y * scale;
  const radius = layoutNode.size * scale * appear * (1 + pulse * 0.22);

  if (radius < 0.6) return;

  const haloRadius = radius * (2.4 + pulse * 1.4);
  const halo = ctx.createRadialGradient(x, y, radius * 0.4, x, y, haloRadius);
  halo.addColorStop(0, palette.halo);
  halo.addColorStop(1, 'rgba(6,9,18,0)');
  ctx.fillStyle = halo;
  ctx.globalAlpha = 0.6 * appear;
  ctx.beginPath();
  ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = palette.core;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = STATUS_ACCENT[layoutNode.node.status];
  ctx.lineWidth = (selected ? 2.2 : hovered ? 1.7 : 1) * Math.max(0.7, scale);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();

  if (layoutNode.node.status === 'active') {
    const breathe = 0.5 + 0.5 * Math.sin(state.time * 2.4 + layoutNode.angle * 3);
    ctx.strokeStyle = `rgba(126,224,255,${(0.15 + breathe * 0.35).toFixed(3)})`;
    ctx.lineWidth = 1 * Math.max(0.7, scale);
    ctx.beginPath();
    ctx.arc(x, y, radius * (1.35 + breathe * 0.25), 0, Math.PI * 2);
    ctx.stroke();
  }

  const showLabel = hovered || selected || layoutNode.node.depth <= 1 || radius > 12;
  if (showLabel) {
    const fontSize = Math.max(9, Math.min(14, radius * 0.85));
    ctx.font = `${fontSize}px "Inter", "SF Pro Text", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = hovered || selected ? 'rgba(236,244,255,0.95)' : 'rgba(206,220,244,0.62)';
    ctx.fillText(truncate(layoutNode.node.label, 26), x, y + radius + 6 * scale);
  }
}

function drawZero(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  scale: number,
  state: RenderState,
  layoutNode: LayoutNode,
): void {
  const pulse = state.pulses.get('zero')?.energy ?? 0;
  const breathe = 0.5 + 0.5 * Math.sin(state.time * 0.9);
  const voice = state.audio.amplitude;
  const radius = layoutNode.size * scale * (1 + breathe * 0.02 + pulse * 0.08 + voice * 0.12);

  const glowRadius = radius * (2.6 + voice * 2.2 + pulse * 0.9);
  const glow = ctx.createRadialGradient(centerX, centerY, radius * 0.6, centerX, centerY, glowRadius);
  glow.addColorStop(0, `rgba(120,170,255,${(0.16 + voice * 0.3 + pulse * 0.12).toFixed(3)})`);
  glow.addColorStop(1, 'rgba(4,6,14,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(centerX, centerY, glowRadius, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(
    centerX - radius * 0.3,
    centerY - radius * 0.35,
    radius * 0.1,
    centerX,
    centerY,
    radius,
  );
  body.addColorStop(0, '#0d1220');
  body.addColorStop(0.7, '#05070d');
  body.addColorStop(1, '#010205');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(180,208,255,${(0.35 + breathe * 0.15 + voice * 0.4).toFixed(3)})`;
  ctx.lineWidth = 1.4 * Math.max(0.8, scale);
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();

  const hovered = state.hoveredId === 'zero' || state.selectedId === 'zero';
  ctx.font = `${Math.max(11, radius * 0.32)}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hovered ? 'rgba(240,246,255,0.95)' : 'rgba(214,228,255,0.72)';
  ctx.letterSpacing = '3px';
  ctx.fillText('ZERO', centerX, centerY);
  ctx.letterSpacing = '0px';
}

function quadratic(p0: number, p1: number, p2: number, t: number): number {
  const inverse = 1 - t;
  return inverse * inverse * p0 + 2 * inverse * t * p1 + t * t * p2;
}

function easeOut(value: number): number {
  return 1 - (1 - value) * (1 - value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
