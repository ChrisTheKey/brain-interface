/**
 * Adaptive render quality.
 *
 * The brain runs on a Galaxy and on a laptop from the same bundle, so the
 * scene is sized from what the device actually is, and then corrected from
 * what it actually achieves: the governor watches real frame times and drops
 * the pixel ratio (and, if that is not enough, the tier) until the target
 * frame rate holds. It never climbs back up aggressively — a brain that
 * oscillates between two qualities is worse than one that stays at the lower.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityProfile {
  tier: QualityTier;
  /** [min, max] device pixel ratio handed to the renderer. */
  dpr: [number, number];
  /** Samples per filament curve. */
  filamentSegments: number;
  /** Extra strands drawn beside each filament — this is what reads as tissue. */
  strandsPerLink: number;
  /** Energy particles travelling on each link. */
  energyPerLink: number;
  smokeParticles: number;
  sparkParticles: number;
  haloParticles: number;
  /** Icosahedron subdivision of the ZERO core. */
  coreDetail: number;
  /** Subdivision of an agent hub / satellite. */
  nodeDetail: number;
  /** Whether the (limited) bloom pass may run. */
  bloom: boolean;
  targetFps: number;
}

const PROFILES: Record<QualityTier, Omit<QualityProfile, 'tier' | 'dpr' | 'bloom'>> = {
  high: {
    filamentSegments: 28,
    strandsPerLink: 3,
    energyPerLink: 5,
    smokeParticles: 900,
    sparkParticles: 260,
    haloParticles: 700,
    coreDetail: 5,
    nodeDetail: 2,
    targetFps: 58,
  },
  medium: {
    filamentSegments: 20,
    strandsPerLink: 2,
    energyPerLink: 4,
    smokeParticles: 460,
    sparkParticles: 140,
    haloParticles: 340,
    coreDetail: 4,
    nodeDetail: 1,
    targetFps: 45,
  },
  low: {
    filamentSegments: 12,
    strandsPerLink: 1,
    energyPerLink: 2,
    smokeParticles: 220,
    sparkParticles: 60,
    haloParticles: 160,
    coreDetail: 3,
    nodeDetail: 1,
    targetFps: 30,
  },
};

const DPR: Record<QualityTier, [number, number]> = {
  high: [1, 2],
  medium: [1, 1.5],
  low: [0.7, 1],
};

export interface DeviceHints {
  /** `navigator.deviceMemory`, in GB. */
  deviceMemory?: number;
  hardwareConcurrency?: number;
  /** True when the primary input is a finger — a strong phone/tablet signal. */
  coarsePointer?: boolean;
  maxTouchPoints?: number;
  devicePixelRatio?: number;
  /** Shortest viewport edge in CSS pixels. */
  minViewport?: number;
  /** `prefers-reduced-motion: reduce` — the brain calms down, it never stops. */
  reducedMotion?: boolean;
}

/**
 * Best guess at what this device can sustain, before a single frame has run.
 * Deliberately conservative on touch devices: a Galaxy that starts at `medium`
 * and stays there beats one that starts at `high` and stutters for two seconds.
 */
export function detectTier(hints: DeviceHints): QualityTier {
  const touch = hints.coarsePointer === true || (hints.maxTouchPoints ?? 0) > 0;
  const cores = hints.hardwareConcurrency ?? 4;
  const memory = hints.deviceMemory ?? (touch ? 4 : 8);
  const small = (hints.minViewport ?? 1024) < 520;

  if (memory <= 2 || cores <= 2) return 'low';
  if (touch) {
    // A modern flagship (8+ cores, 6+ GB) still gets the dense brain; the
    // governor will step it down if the panel cannot keep up.
    return cores >= 8 && memory >= 6 && !small ? 'medium' : 'low';
  }
  if (cores >= 8 && memory >= 8) return 'high';
  return 'medium';
}

export function readDeviceHints(): DeviceHints {
  if (typeof window === 'undefined') return {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    ...(nav.deviceMemory === undefined ? {} : { deviceMemory: nav.deviceMemory }),
    hardwareConcurrency: nav.hardwareConcurrency,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    maxTouchPoints: nav.maxTouchPoints,
    devicePixelRatio: window.devicePixelRatio,
    minViewport: Math.min(window.innerWidth, window.innerHeight),
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  };
}

export function profileFor(
  tier: QualityTier,
  options: { maxPixelRatio?: number; bloom?: boolean } = {},
): QualityProfile {
  const maxPixelRatio = options.maxPixelRatio ?? 2;
  const [min, max] = DPR[tier];
  return {
    tier,
    dpr: [Math.min(min, maxPixelRatio), Math.min(max, maxPixelRatio)],
    // Bloom is the first thing to go: it costs several full-screen passes and
    // is the least missed on a small panel.
    bloom: (options.bloom ?? true) && tier === 'high',
    ...PROFILES[tier],
  };
}

const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high'];

export function lowerTier(tier: QualityTier): QualityTier {
  const index = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(0, index - 1)] ?? 'low';
}

export interface GovernorDecision {
  /** Multiplier applied to the profile's max DPR, 0.55..1. */
  scale: number;
  /** Set when the tier itself must drop. */
  tier: QualityTier | null;
}

/**
 * Watches real frame times and decides when to shed load.
 *
 * Windows of 45 frames: if the median frame is more than 1.35× the target
 * budget the pixel ratio drops one step; once it has bottomed out and the
 * frames are still long, the tier drops. Recovery needs three consecutive
 * comfortable windows, so a single garbage-collection pause never promotes.
 */
export class QualityGovernor {
  private readonly samples: number[] = [];
  private scale = 1;
  private comfortable = 0;

  constructor(
    private tier: QualityTier,
    private readonly windowSize = 45,
  ) {}

  get currentTier(): QualityTier {
    return this.tier;
  }

  get currentScale(): number {
    return this.scale;
  }

  /** Feed one frame time in ms. Returns a decision only when it changes. */
  sample(frameMs: number): GovernorDecision | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    // A frame longer than a third of a second is a tab switch or a stall, not
    // a rendering cost — it must never trigger a downgrade.
    if (frameMs > 320) return null;
    this.samples.push(frameMs);
    if (this.samples.length < this.windowSize) return null;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    this.samples.length = 0;

    const budget = 1000 / PROFILES[this.tier].targetFps;

    if (median > budget * 1.35) {
      this.comfortable = 0;
      if (this.scale > 0.56) {
        this.scale = Math.max(0.55, this.scale - 0.2);
        return { scale: this.scale, tier: null };
      }
      const next = lowerTier(this.tier);
      if (next !== this.tier) {
        this.tier = next;
        this.scale = 1;
        return { scale: 1, tier: next };
      }
      return null;
    }

    if (median < budget * 0.8) {
      this.comfortable += 1;
      if (this.comfortable >= 3 && this.scale < 1) {
        this.comfortable = 0;
        this.scale = Math.min(1, this.scale + 0.2);
        return { scale: this.scale, tier: null };
      }
      return null;
    }

    this.comfortable = 0;
    return null;
  }
}
