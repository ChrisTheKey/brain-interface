import { describe, expect, it } from 'vitest';
import { bandEnergies, clamp01, SILENT_LEVELS } from '../src/audio/analyser';
import { emissionFor, stepEnvelope } from '../src/three/Smoke';

describe('band analysis', () => {
  it('separates the three bands the brain reacts to', () => {
    // 128 bins over 48 kHz: bin 0 ≈ 0 Hz, bin 127 ≈ 24 kHz.
    const bins = new Uint8Array(128);
    bins.fill(255, 0, 2); // < 400 Hz
    expect(bandEnergies(bins, 48_000).low).toBeGreaterThan(0.9);
    expect(bandEnergies(bins, 48_000).mid).toBe(0);
    expect(bandEnergies(bins, 48_000).high).toBe(0);

    bins.fill(0);
    bins.fill(255, 11, 128); // everything above ~2 kHz
    expect(bandEnergies(bins, 48_000).high).toBeGreaterThan(0.9);
    expect(bandEnergies(bins, 48_000).low).toBe(0);
    expect(bandEnergies(bins, 48_000).mid).toBe(0);

    bins.fill(0);
    bins.fill(255, 2, 11); // 400 Hz … 2 kHz
    expect(bandEnergies(bins, 48_000).mid).toBeGreaterThan(0.9);
    expect(bandEnergies(bins, 48_000).low).toBe(0);
    expect(bandEnergies(bins, 48_000).high).toBe(0);
  });

  it('returns nothing for an empty spectrum instead of dividing by zero', () => {
    expect(bandEnergies(new Uint8Array(0), 48_000)).toEqual({ low: 0, mid: 0, high: 0 });
  });

  it('clamps anything that is not a finite 0..1 value', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(4)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});

describe('smoke reacts to the measured signal', () => {
  it('emits nothing at all while ZERO is silent', () => {
    expect(emissionFor(SILENT_LEVELS.amplitude, SILENT_LEVELS.low, SILENT_LEVELS.transient)).toBe(0);
    // Below the noise floor is still silence, not a very quiet voice.
    expect(emissionFor(0.01, 0.9, 0.9)).toBe(0);
  });

  it('emits more for a louder voice, and more again on a stressed word', () => {
    const quiet = emissionFor(0.2, 0.2, 0);
    const loud = emissionFor(0.7, 0.2, 0);
    const stressed = emissionFor(0.7, 0.2, 0.8);
    expect(loud).toBeGreaterThan(quiet);
    expect(stressed).toBeGreaterThan(loud);
    expect(stressed).toBeLessThanOrEqual(1);
  });

  it('opens fast and closes slowly, so a sentence starts at once and dissipates', () => {
    let attack = 0;
    for (let i = 0; i < 6; i += 1) attack = stepEnvelope(attack, 1, 1 / 60);
    expect(attack).toBeGreaterThan(0.5);

    let release = 1;
    for (let i = 0; i < 6; i += 1) release = stepEnvelope(release, 0, 1 / 60);
    expect(release).toBeGreaterThan(0.85);

    let settled = 1;
    for (let i = 0; i < 300; i += 1) settled = stepEnvelope(settled, 0, 1 / 60);
    expect(settled).toBeLessThan(0.02);
  });
});
