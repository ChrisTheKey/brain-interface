import { describe, expect, it } from 'vitest';
import {
  curveControlPoint,
  fibonacciSpherePoint,
  hubPosition,
  orthonormalBasis,
  sampleCurve,
  satellitePosition,
} from '../src/brain/layout3d';

const length = (v: readonly [number, number, number]): number => Math.hypot(v[0], v[1], v[2]);

describe('the 3D layout', () => {
  it('spreads any number of clusters evenly on a sphere', () => {
    for (const count of [1, 2, 3, 8, 40]) {
      for (let i = 0; i < count; i += 1) {
        expect(length(fibonacciSpherePoint(i, count))).toBeCloseTo(1, 5);
      }
    }
  });

  it('puts a single agent on the equator rather than on a pole', () => {
    expect(fibonacciSpherePoint(0, 1)).toEqual([1, 0, 0]);
  });

  it('gives every hub a stable place that depends only on its id and rank', () => {
    const first = hubPosition('insta', 2, 8);
    const again = hubPosition('insta', 2, 8);
    expect(first).toEqual(again);
    expect(hubPosition('seo', 2, 8)).not.toEqual(first);
  });

  it('builds an orthonormal basis for every direction, poles included', () => {
    for (const axis of [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [0.3, 0.5, -0.8],
    ] as const) {
      const { u, v } = orthonormalBasis(axis);
      expect(length(u)).toBeCloseTo(1, 5);
      expect(length(v)).toBeCloseTo(1, 5);
      expect(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).toBeCloseTo(0, 5);
    }
  });

  it('fans a cluster outward from ZERO, never back through the core', () => {
    const hub = hubPosition('insta', 1, 4);
    const hubDistance = length(hub);
    for (let i = 0; i < 6; i += 1) {
      const satellite = satellitePosition(hub, `insta:${i}`, i, 6);
      // Every terminal sits further out than its hub.
      expect(length(satellite)).toBeGreaterThan(hubDistance * 0.95);
    }
  });

  it('bows a filament away from a straight line but keeps its endpoints', () => {
    const from = [0, 0, 0] as const;
    const to = [1, 0, 0] as const;
    const control = curveControlPoint(from, to, 'link:insta');
    expect(sampleCurve(from, control, to, 0)).toEqual([0, 0, 0]);
    expect(sampleCurve(from, control, to, 1)).toEqual([1, 0, 0]);
    const middle = sampleCurve(from, control, to, 0.5);
    expect(Math.hypot(middle[1], middle[2])).toBeGreaterThan(0);
    // Same key, same curve — a filament must not flicker between frames.
    expect(curveControlPoint(from, to, 'link:insta')).toEqual(control);
  });
});
