import { describe, expect, it } from 'vitest';
import { base64ToBytes, decodePcm16Base64, SILENT_LEVELS } from '../src/audio/analyser';
import { smokeParamsFromAudio, SmokeField } from '../src/render/smoke';

function pcm16Base64(samples: number[]): string {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString('base64');
}

describe('ZERO realtime audio decoding', () => {
  it('decodes interleaved PCM16 chunks into planar float samples', () => {
    const base64 = pcm16Base64([0, 32767, -32768, 16384]);
    const planes = decodePcm16Base64(base64, 2, base64ToBytes);
    expect(planes).toHaveLength(2);
    expect(planes[0]?.[0]).toBeCloseTo(0, 5);
    expect(planes[0]?.[1]).toBeCloseTo(-1, 4);
    expect(planes[1]?.[0]).toBeCloseTo(0.99997, 4);
    expect(planes[1]?.[1]).toBeCloseTo(0.5, 4);
  });

  it('handles empty chunks without throwing', () => {
    expect(decodePcm16Base64('', 1, base64ToBytes)[0]?.length).toBe(0);
  });
});

describe('smoke reacts to the measured signal', () => {
  it('emits nothing while ZERO is silent', () => {
    const params = smokeParamsFromAudio(SILENT_LEVELS);
    expect(params.emission).toBe(0);
    expect(params.opacity).toBe(0);

    const field = new SmokeField();
    for (let i = 0; i < 60; i += 1) field.update(1, SILENT_LEVELS, () => 0.5);
    expect(field.count).toBe(0);
  });

  it('scales emission, expansion and turbulence with amplitude and bands', () => {
    const calm = smokeParamsFromAudio({ amplitude: 0.2, peak: 0.3, low: 0.3, high: 0.1, onset: 0 });
    const emphasised = smokeParamsFromAudio({ amplitude: 0.8, peak: 0.95, low: 0.7, high: 0.6, onset: 0.9 });

    expect(emphasised.emission).toBeGreaterThan(calm.emission);
    expect(emphasised.velocity).toBeGreaterThan(calm.velocity);
    expect(emphasised.turbulence).toBeGreaterThan(calm.turbulence);
    expect(emphasised.density).toBeGreaterThan(calm.density);
    expect(emphasised.opacity).toBeGreaterThan(calm.opacity);
  });

  it('spawns and retires particles as the voice runs and stops', () => {
    const field = new SmokeField({ maxParticles: 50 });
    const speaking = { amplitude: 0.6, peak: 0.8, low: 0.5, high: 0.4, onset: 0.2 };
    for (let i = 0; i < 30; i += 1) field.update(1, speaking, () => 0.5);
    expect(field.count).toBeGreaterThan(0);
    expect(field.count).toBeLessThanOrEqual(50);

    for (let i = 0; i < 400; i += 1) field.update(1, SILENT_LEVELS, () => 0.5);
    expect(field.count).toBe(0);
  });
});
