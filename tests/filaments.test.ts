import { describe, expect, it } from 'vitest';
import { dendriteCount, degreeMap, hashUnit } from '../src/render/filaments';
import type { GraphModel } from '../src/graph/model';

const GRAPH: GraphModel = {
  nodes: [],
  edges: [
    { id: 'e1', source: 'zero', target: 'agent:a', relationship: 'agent', status: 'idle' },
    { id: 'e2', source: 'zero', target: 'agent:b', relationship: 'agent', status: 'idle' },
    { id: 'e3', source: 'agent:a', target: 'thread:t', relationship: 'runsIn', status: 'idle' },
  ],
  notes: [],
};

describe('neural filaments', () => {
  it('derives strand parameters deterministically, so nothing flickers', () => {
    expect(hashUnit('e1:0')).toBe(hashUnit('e1:0'));
    expect(hashUnit('e1:0')).not.toBe(hashUnit('e1:1'));
    expect(hashUnit('e1:0')).toBeGreaterThanOrEqual(0);
    expect(hashUnit('e1:0')).toBeLessThanOrEqual(1);
  });

  it('counts degrees from the real edges', () => {
    const degrees = degreeMap(GRAPH);
    expect(degrees.get('zero')).toBe(2);
    expect(degrees.get('agent:a')).toBe(2);
    expect(degrees.get('thread:t')).toBe(1);
  });

  it('grows more dendrites where more real connections exist', () => {
    expect(dendriteCount(0, false)).toBeLessThan(dendriteCount(4, false));
    expect(dendriteCount(2, true)).toBeGreaterThan(dendriteCount(2, false));
    // Bounded, so a huge graph cannot explode the frame budget.
    expect(dendriteCount(500, false)).toBeLessThanOrEqual(11);
    expect(dendriteCount(500, true)).toBeLessThanOrEqual(26);
  });
});
