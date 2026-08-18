import { describe, expect, it } from 'vitest';
import { BrainLayout, hashAngle, shortestAngle } from '../src/graph/layout';
import type { GraphModel, GraphNode } from '../src/graph/model';

function graphWithAgents(count: number): GraphModel {
  const nodes: GraphNode[] = [
    { id: 'zero', type: 'zero', label: 'ZERO', status: 'idle', depth: 0, parentId: null, metadata: {} },
  ];
  for (let i = 0; i < count; i += 1) {
    nodes.push({
      id: `thread:thr_${i}`,
      type: 'agent',
      label: `agent ${i}`,
      status: 'idle',
      depth: 1,
      parentId: 'zero',
      metadata: {},
    });
  }
  return {
    nodes,
    edges: nodes.slice(1).map((node) => ({
      id: `e${node.id}`,
      source: 'zero',
      target: node.id,
      relationship: 'orchestrates' as const,
      status: 'idle' as const,
    })),
    notes: [],
  };
}

describe('BrainLayout', () => {
  it('pins ZERO to the centre', () => {
    const layout = new BrainLayout();
    layout.sync(graphWithAgents(6));
    const zero = layout.get('zero');
    expect(zero).toMatchObject({ x: 0, y: 0 });
  });

  it('keeps ring nodes apart for any node count', () => {
    for (const count of [1, 5, 24, 60]) {
      const layout = new BrainLayout();
      layout.sync(graphWithAgents(count));
      for (let i = 0; i < 600; i += 1) layout.step(1);

      const ring = layout.layoutNodes.filter((node) => node.node.type === 'agent');
      expect(ring).toHaveLength(count);
      for (let i = 0; i < ring.length; i += 1) {
        for (let j = i + 1; j < ring.length; j += 1) {
          const a = ring[i];
          const b = ring[j];
          if (!a || !b) continue;
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          // Discs must never overlap, no matter how many agents ZERO has.
          expect(distance).toBeGreaterThan(a.size + b.size);
        }
      }
    }
  });

  it('places deeper nodes on outer rings', () => {
    const graph = graphWithAgents(2);
    graph.nodes.push({
      id: 'thread:sub',
      type: 'subAgent',
      label: 'sub',
      status: 'idle',
      depth: 2,
      parentId: 'thread:thr_0',
      metadata: {},
    });
    const layout = new BrainLayout();
    layout.sync(graph);
    for (let i = 0; i < 200; i += 1) layout.step(1);
    const parent = layout.get('thread:thr_0');
    const child = layout.get('thread:sub');
    expect(Math.hypot(child?.x ?? 0, child?.y ?? 0)).toBeGreaterThan(
      Math.hypot(parent?.x ?? 0, parent?.y ?? 0),
    );
  });

  it('keeps existing node positions when the graph changes', () => {
    const layout = new BrainLayout();
    layout.sync(graphWithAgents(3));
    for (let i = 0; i < 120; i += 1) layout.step(1);
    const before = layout.get('thread:thr_1');
    const angleBefore = before?.angle ?? 0;

    layout.sync(graphWithAgents(4));
    expect(layout.get('thread:thr_1')?.angle).toBe(angleBefore);
    expect(layout.get('thread:thr_3')).toBeDefined();
  });

  it('produces stable seed angles per node id', () => {
    expect(hashAngle('thread:a')).toBe(hashAngle('thread:a'));
    expect(hashAngle('thread:a')).not.toBe(hashAngle('thread:b'));
  });

  it('normalizes angular differences to the shortest path', () => {
    expect(shortestAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI * 0.5, 6);
  });

  it('hit-tests nodes in layout space', () => {
    const layout = new BrainLayout();
    layout.sync(graphWithAgents(4));
    layout.step(1);
    expect(layout.pick(0, 0)?.id).toBe('zero');
    const agent = layout.layoutNodes.find((node) => node.node.type === 'agent');
    expect(layout.pick(agent?.x ?? 0, agent?.y ?? 0)?.id).toBe(agent?.id);
  });
});
