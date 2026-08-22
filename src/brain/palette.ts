/**
 * The brain's colour language.
 *
 * Derived from the reference plate (`public/reference/red-background.jpg`):
 * obsidian black, magenta filaments, crimson depth. Department accents are the
 * only saturated colour in the scene and they only ever appear on rims,
 * filaments and travelling energy — never as a filled body.
 */
import { Color } from 'three';
import { DEPARTMENT_COLORS, type Department } from '../zero/agentPolicy';
import type { BrainStatus } from './model';

/** Obsidian: the body colour of every node, including ZERO. */
export const OBSIDIAN = '#05060a';
/** The light that lives inside ZERO. */
export const CORE_VEIN = '#ff2f8e';
/** Neutral filament colour where no department applies. */
export const NEUTRAL_ACCENT = '#8b93ad';
/** Deep plate colour behind everything. */
export const VOID = '#020205';

const cache = new Map<string, Color>();

/** Cached `THREE.Color` — colours are read every frame, parsing is not. */
export function color(hex: string): Color {
  let value = cache.get(hex);
  if (!value) {
    value = new Color(hex);
    cache.set(hex, value);
  }
  return value;
}

export function departmentHex(department: Department | null): string {
  return department ? DEPARTMENT_COLORS[department] : NEUTRAL_ACCENT;
}

export function departmentColor(department: Department | null): Color {
  return color(departmentHex(department));
}

/**
 * Status changes brightness, not hue: an agent stays its department's colour
 * whether it is idle or running, so the palette reads as a map of the business
 * rather than as an alarm panel.
 */
export const STATUS_INTENSITY: Record<BrainStatus, number> = {
  active: 1,
  blocked: 0.74,
  error: 0.86,
  // An idle agent still exists, and the brain has to show that it does — a
  // roster that only appears when something runs is not a map of the system.
  idle: 0.52,
  disabled: 0.16,
  unknown: 0.3,
};

/** Error and blocked overlay the department hue with a warning tint. */
export const STATUS_TINT: Partial<Record<BrainStatus, string>> = {
  error: '#ff5f57',
  blocked: '#ffb066',
};

/** Final emissive colour of a node or filament, status included. */
export function accentFor(department: Department | null, status: BrainStatus): Color {
  const base = departmentColor(department).clone();
  const tint = STATUS_TINT[status];
  if (tint) base.lerp(color(tint), status === 'error' ? 0.62 : 0.4);
  return base.multiplyScalar(STATUS_INTENSITY[status]);
}
