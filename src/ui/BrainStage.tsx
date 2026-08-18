/**
 * The brain itself: a full-viewport canvas that renders the ZERO graph,
 * the audio-reactive smoke and the interaction affordances (hover, click).
 */
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { BrainLayout } from '../graph/layout';
import type { GraphModel, GraphNode } from '../graph/model';
import { drawBrain, type ActivityPulse } from '../render/brainRenderer';
import { SmokeField } from '../render/smoke';
import type { AudioLevels } from '../audio/analyser';

export interface BrainStageProps {
  graph: GraphModel;
  pulsesRef: RefObject<Map<string, ActivityPulse>>;
  levels: () => AudioLevels;
  selectedId: string | null;
  onSelect: (node: GraphNode | null) => void;
  onHover: (node: GraphNode | null, position: { x: number; y: number } | null) => void;
}

export function BrainStage({
  graph,
  pulsesRef,
  levels,
  selectedId,
  onSelect,
  onHover,
}: BrainStageProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<BrainLayout>(new BrainLayout());
  const smokeRef = useRef<SmokeField>(new SmokeField());
  const graphRef = useRef<GraphModel>(graph);
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [, setFrame] = useState(0);

  useEffect(() => {
    graphRef.current = graph;
    layoutRef.current.sync(graph);
  }, [graph]);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const smoke = smokeRef.current;

    let animationFrame = 0;
    let disposed = false;
    let lastTime = performance.now();
    let elapsed = 0;
    let width = 0;
    let height = 0;

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = (now: number): void => {
      if (disposed) return;
      const deltaMs = Math.min(64, now - lastTime);
      lastTime = now;
      const dt = deltaMs / 16.6667;
      elapsed += deltaMs / 1000;

      const layout = layoutRef.current;
      layout.step(dt);

      // Decay activity pulses.
      const pulses = pulsesRef.current;
      for (const [id, pulse] of pulses) {
        const next = pulse.energy - dt * 0.02;
        if (next <= 0.01) pulses.delete(id);
        else pulses.set(id, { energy: next, at: pulse.at });
      }

      const audio = levels();
      smoke.update(dt, audio);

      drawBrain(
        ctx,
        width,
        height,
        {
          graph: graphRef.current,
          layout,
          pulses,
          hoveredId: hoveredRef.current,
          selectedId: selectedRef.current,
          audio,
          time: elapsed,
        },
        smoke,
      );

      animationFrame = requestAnimationFrame(render);
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        cancelAnimationFrame(animationFrame);
      } else {
        lastTime = performance.now();
        animationFrame = requestAnimationFrame(render);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    animationFrame = requestAnimationFrame(render);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      smoke.clear();
    };
  }, [levels, pulsesRef]);

  const toLayoutCoords = (event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = layoutRef.current.fitScale(rect.width, rect.height);
    if (scale <= 0) return null;
    return {
      x: (event.clientX - rect.left - rect.width / 2) / scale,
      y: (event.clientY - rect.top - rect.height / 2) / scale,
    };
  };

  return (
    <canvas
      ref={canvasRef}
      className="brain-canvas"
      onPointerMove={(event) => {
        const point = toLayoutCoords(event);
        if (!point) return;
        const hit = layoutRef.current.pick(point.x, point.y);
        const nextId = hit?.id ?? null;
        pointerRef.current = { x: event.clientX, y: event.clientY };
        if (nextId !== hoveredRef.current) {
          hoveredRef.current = nextId;
          onHover(hit?.node ?? null, nextId ? pointerRef.current : null);
          setFrame((value) => value + 1);
        } else if (nextId) {
          onHover(hit?.node ?? null, pointerRef.current);
        }
      }}
      onPointerLeave={() => {
        hoveredRef.current = null;
        onHover(null, null);
      }}
      onPointerDown={(event) => {
        const point = toLayoutCoords(event);
        if (!point) return;
        const hit = layoutRef.current.pick(point.x, point.y);
        onSelect(hit?.node ?? null);
      }}
    />
  );
}
