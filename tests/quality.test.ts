import { describe, expect, it } from 'vitest';
import {
  detectTier,
  lowerTier,
  profileFor,
  QualityGovernor,
  type QualityTier,
} from '../src/three/quality';

const GALAXY_FLAGSHIP = {
  deviceMemory: 8,
  hardwareConcurrency: 8,
  coarsePointer: true,
  maxTouchPoints: 5,
  devicePixelRatio: 3,
  minViewport: 412,
};

const OLD_PHONE = {
  deviceMemory: 2,
  hardwareConcurrency: 4,
  coarsePointer: true,
  maxTouchPoints: 5,
  minViewport: 360,
};

const LAPTOP = {
  deviceMemory: 16,
  hardwareConcurrency: 12,
  coarsePointer: false,
  maxTouchPoints: 0,
  devicePixelRatio: 2,
  minViewport: 900,
};

describe('device detection', () => {
  it('never hands a phone the desktop tier', () => {
    expect(detectTier(GALAXY_FLAGSHIP)).not.toBe('high');
    expect(detectTier(OLD_PHONE)).toBe('low');
  });

  it('gives a capable laptop the dense brain', () => {
    expect(detectTier(LAPTOP)).toBe('high');
  });

  it('falls back to the middle tier when the browser reports nothing', () => {
    expect(detectTier({})).toBe('medium');
  });
});

describe('quality profiles', () => {
  it('scales every budget down with the tier', () => {
    const high = profileFor('high');
    const medium = profileFor('medium');
    const low = profileFor('low');
    for (const key of [
      'smokeParticles',
      'sparkParticles',
      'haloParticles',
      'filamentSegments',
      'strandsPerLink',
      'energyPerLink',
    ] as const) {
      expect(high[key]).toBeGreaterThanOrEqual(medium[key]);
      expect(medium[key]).toBeGreaterThanOrEqual(low[key]);
    }
    expect(low.targetFps).toBe(30);
    expect(high.targetFps).toBeGreaterThanOrEqual(58);
  });

  it('only ever blooms on the desktop tier, and never against the config', () => {
    expect(profileFor('high').bloom).toBe(true);
    expect(profileFor('medium').bloom).toBe(false);
    expect(profileFor('low').bloom).toBe(false);
    expect(profileFor('high', { bloom: false }).bloom).toBe(false);
  });

  it('honours a pixel-ratio cap on a high-density phone panel', () => {
    expect(profileFor('medium', { maxPixelRatio: 1 }).dpr).toEqual([1, 1]);
    expect(profileFor('low').dpr[1]).toBeLessThanOrEqual(1);
  });
});

describe('the frame-time governor', () => {
  const feed = (governor: QualityGovernor, frameMs: number, frames = 45) => {
    let last = null;
    for (let i = 0; i < frames; i += 1) {
      const decision = governor.sample(frameMs);
      if (decision) last = decision;
    }
    return last;
  };

  it('says nothing until it has a full window', () => {
    const governor = new QualityGovernor('high');
    for (let i = 0; i < 44; i += 1) expect(governor.sample(60)).toBeNull();
    expect(governor.sample(60)).not.toBeNull();
  });

  it('sheds pixels first when the frames are too long', () => {
    const governor = new QualityGovernor('high');
    const decision = feed(governor, 60);
    expect(decision?.scale).toBeLessThan(1);
    expect(decision?.tier).toBeNull();
  });

  it('drops the tier once the pixel ratio has bottomed out', () => {
    const governor = new QualityGovernor('high');
    let tier: QualityTier | null = null;
    for (let round = 0; round < 6 && tier === null; round += 1) {
      tier = feed(governor, 60)?.tier ?? null;
    }
    expect(tier).toBe('medium');
    expect(governor.currentTier).toBe('medium');
  });

  it('ignores a stall — a tab switch is not a rendering cost', () => {
    const governor = new QualityGovernor('high');
    for (let i = 0; i < 60; i += 1) expect(governor.sample(4_000)).toBeNull();
    expect(governor.currentScale).toBe(1);
  });

  it('never promotes on a single comfortable window', () => {
    const governor = new QualityGovernor('medium');
    feed(governor, 60); // scale down first
    const scaled = governor.currentScale;
    expect(scaled).toBeLessThan(1);
    feed(governor, 8);
    expect(governor.currentScale).toBe(scaled);
    feed(governor, 8);
    feed(governor, 8);
    expect(governor.currentScale).toBeGreaterThan(scaled);
  });

  it('bottoms out at the lowest tier instead of going below it', () => {
    expect(lowerTier('low')).toBe('low');
    expect(lowerTier('medium')).toBe('low');
    expect(lowerTier('high')).toBe('medium');
  });
});
