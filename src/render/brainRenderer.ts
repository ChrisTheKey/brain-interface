/**
 * Canvas 2D renderer for the brain.
 *
 * Rendering order: background image (CSS layer, below the canvas) → scrim →
 * edges → smoke around ZERO → nodes → labels. The renderer owns no data: it
 * draws the layout computed from ZERO's graph plus the transient activity
 * pulses the adapter reported.
 *
 * The visual language is deliberately black: over the background image every
 * node is a black disc with a dark separation aura and a thin luminous rim.
 * That keeps the graph elegant and legible without competing with the image.
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

export type ConversationVisualState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'agentActive'
  | 'speaking'
  | 'error';

export interface RenderState {
  graph: GraphModel;
  layout: BrainLayout;
  pulses: Map<string, ActivityPulse>;
  hoveredId: string | null;
  selectedId: string | null;
  audio: AudioLevels;
  /** What ZERO is doing right now — each state has its own quiet signature. */
  conversation: ConversationVisualState;
  /** Real microphone input level while listening, 0..1. */
  micLevel: number;
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

  drawScrim(ctx, width, height, centerX, centerY, state);
  drawEdges(ctx, centerX, centerY, scale, state);
  smoke.draw(ctx, centerX, centerY, scale);
  drawNodes(ctx, centerX, centerY, scale, state);
}

/**
 * Darkens the background image towards the centre so the black brain reads
 * against it. It breathes very slightly with ZERO's voice.
 */
function drawScrim(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  state: RenderState,
): void {
  const radius = Math.max(width, height) * 0.75;
  const voice = state.audio.amplitude;
  const scrim = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  scrim.addColorStop(0, `rgba(0, 0, 0, ${(0.82 - voice * 0.12).toFixed(3)})`);
  scrim.addColorStop(0.45, 'rgba(0, 0, 0, 0.6)');
  scrim.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, width, height);
}

function edgeAlpha(edge: GraphEdge, pulses: Map<string, ActivityPulse>): number {
  const source = pulses.get(edge.source)?.energy ?? 0;
  const target = pulses.get(edge.target)?.energy ?? 0;
  const activity = Math.max(source, target);
  const base = edge.status === 'notLoaded' || edge.status === 'disabled' ? 0.1 : 0.2;
  return base + activity * 0.55;
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

    const visibility = Math.min(source.appear, target.appear);
    const alpha = edgeAlpha(edge, state.pulses) * visibility;
    const highlighted =
      state.hoveredId === edge.source ||
      state.hoveredId === edge.target ||
      state.selectedId === edge.source ||
      state.selectedId === edge.target;

    // Black underlay: separates the connection from the background image.
    ctx.strokeStyle = `rgba(0, 0, 0, ${(0.55 * visibility).toFixed(3)})`;
    ctx.lineWidth = (highlighted ? 4 : 3) * Math.max(0.6, scale);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(cx, cy, tx, ty);
    ctx.stroke();

    ctx.strokeStyle = highlighted
      ? `rgba(255, 244, 252, ${Math.min(0.9, alpha + 0.4).toFixed(3)})`
      : `rgba(226, 230, 244, ${alpha.toFixed(3)})`;
    ctx.lineWidth = (highlighted ? 1.4 : 0.85) * Math.max(0.6, scale);
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
      ctx.fillStyle = `rgba(255, 236, 250, ${(energy * 0.85).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, 1.9 * Math.max(0.7, scale), 0, Math.PI * 2);
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
  const radius = layoutNode.size * scale * appear * (1 + pulse * 0.16);

  if (radius < 0.6) return;

  // Dark aura: lifts the black disc off the background image.
  const auraRadius = radius * 2.6;
  const aura = ctx.createRadialGradient(x, y, radius * 0.5, x, y, auraRadius);
  aura.addColorStop(0, `rgba(0, 0, 0, ${(0.85 * appear).toFixed(3)})`);
  aura.addColorStop(0.6, `rgba(0, 0, 0, ${(0.45 * appear).toFixed(3)})`);
  aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(x, y, auraRadius, 0, Math.PI * 2);
  ctx.fill();

  // Black body with a barely visible top sheen.
  const body = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.4,
    radius * 0.1,
    x,
    y,
    radius,
  );
  body.addColorStop(0, palette.coreInner);
  body.addColorStop(1, palette.coreOuter);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = hovered || selected ? palette.rimActive : palette.rim;
  ctx.lineWidth = (selected ? 1.8 : hovered ? 1.4 : 0.9) * Math.max(0.7, scale);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Status arc: a quarter ring, so it never turns the node into a colour blob.
  if (layoutNode.node.status !== 'idle') {
    ctx.strokeStyle = STATUS_ACCENT[layoutNode.node.status];
    ctx.lineWidth = 1.6 * Math.max(0.7, scale);
    ctx.beginPath();
    ctx.arc(x, y, radius * 1.16, -Math.PI * 0.15, Math.PI * 0.35);
    ctx.stroke();
  }

  if (layoutNode.node.status === 'active') {
    const breathe = 0.5 + 0.5 * Math.sin(state.time * 2.4 + layoutNode.angle * 3);
    ctx.strokeStyle = `rgba(255, 150, 214, ${(0.12 + breathe * 0.3).toFixed(3)})`;
    ctx.lineWidth = 1 * Math.max(0.7, scale);
    ctx.beginPath();
    ctx.arc(x, y, radius * (1.38 + breathe * 0.22), 0, Math.PI * 2);
    ctx.stroke();
  }

  const showLabel = hovered || selected || layoutNode.node.depth <= 1 || radius > 12;
  if (showLabel) {
    const fontSize = Math.max(9, Math.min(14, radius * 0.8));
    ctx.font = `${fontSize}px "Inter", "SF Pro Text", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = truncate(layoutNode.node.label, 26);
    const labelY = y + radius + 7 * scale;
    // Black halo behind the text keeps it readable over the image.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineJoin = 'round';
    ctx.strokeText(label, x, labelY);
    ctx.fillStyle = hovered || selected ? 'rgba(255, 255, 255, 0.96)' : 'rgba(226, 230, 244, 0.7)';
    ctx.fillText(label, x, labelY);
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
  const radius = layoutNode.size * scale * (1 + breathe * 0.02 + pulse * 0.06 + voice * 0.1);

  // Deep black aura — ZERO sits in its own darkness.
  const auraRadius = radius * (3.1 + voice * 1.4);
  const aura = ctx.createRadialGradient(centerX, centerY, radius * 0.6, centerX, centerY, auraRadius);
  aura.addColorStop(0, 'rgba(0, 0, 0, 0.92)');
  aura.addColorStop(0.55, 'rgba(0, 0, 0, 0.6)');
  aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(centerX, centerY, auraRadius, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(
    centerX - radius * 0.3,
    centerY - radius * 0.36,
    radius * 0.08,
    centerX,
    centerY,
    radius,
  );
  body.addColorStop(0, '#0d0f18');
  body.addColorStop(0.72, '#040508');
  body.addColorStop(1, '#000000');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();

  // Two rims: a quiet inner one, and an outer one that answers the voice.
  ctx.strokeStyle = `rgba(240, 240, 248, ${(0.34 + breathe * 0.1 + voice * 0.35).toFixed(3)})`;
  ctx.lineWidth = 1.3 * Math.max(0.8, scale);
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();

  if (voice > 0.01 || pulse > 0.02) {
    ctx.strokeStyle = `rgba(255, 140, 208, ${(0.1 + voice * 0.5 + pulse * 0.2).toFixed(3)})`;
    ctx.lineWidth = 1 * Math.max(0.8, scale);
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * (1.14 + voice * 0.18), 0, Math.PI * 2);
    ctx.stroke();
  }

  drawConversationState(ctx, centerX, centerY, radius, state);

  const hovered = state.hoveredId === 'zero' || state.selectedId === 'zero';
  ctx.font = `${Math.max(11, radius * 0.3)}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hovered ? 'rgba(255, 255, 255, 0.96)' : 'rgba(232, 234, 246, 0.78)';
  ctx.letterSpacing = '4px';
  ctx.fillText('ZERO', centerX + 2, centerY);
  ctx.letterSpacing = '0px';
}

/**
 * The conversation states are visually distinct but deliberately quiet:
 * listening contracts inward with the real microphone level, processing turns
 * a thin arc, agentActive doubles it, error shows a red rim. Speaking needs no
 * extra mark — that is what the audio-reactive smoke is for.
 */
function drawConversationState(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  state: RenderState,
): void {
  const { conversation, time } = state;
  if (conversation === 'idle' || conversation === 'speaking') return;

  if (conversation === 'listening') {
    const level = Math.min(1, state.micLevel);
    const wave = (time * 0.6) % 1;
    for (const phase of [wave, (wave + 0.5) % 1]) {
      const ringRadius = radius * (2.1 - phase * 0.85);
      const alpha = (1 - phase) * (0.12 + level * 0.5);
      ctx.strokeStyle = `rgba(214, 232, 255, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 1 + level * 1.6;
      ctx.beginPath();
      ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }

  if (conversation === 'error') {
    ctx.strokeStyle = 'rgba(255, 120, 120, 0.8)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 1.2, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  // processing / agentActive: one or two slowly turning arcs.
  const arcs = conversation === 'agentActive' ? 2 : 1;
  for (let i = 0; i < arcs; i += 1) {
    const offset = (time * (0.9 + i * 0.35) + i * Math.PI) % (Math.PI * 2);
    ctx.strokeStyle =
      conversation === 'agentActive'
        ? 'rgba(255, 168, 220, 0.7)'
        : 'rgba(226, 232, 248, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * (1.24 + i * 0.16), offset, offset + Math.PI * 0.55);
    ctx.stroke();
  }
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
