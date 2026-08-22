/**
 * The WebGL surface.
 *
 * Owns three things React needs to know about: which quality tier the device
 * gets, the activity texture the shaders share, and the fallback when this
 * browser has no WebGL at all. Everything else lives inside `BrainScene`,
 * outside React's render cycle.
 */
import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { ACESFilmicToneMapping } from 'three';
import { config } from '../config';
import type { AudioLevels } from '../audio/analyser';
import type { BrainGraph, BrainNode } from '../brain/model';
import { ActivityTexture, MAX_CLUSTERS } from './activityTexture';
import { BrainScene } from './BrainScene';
import { CAMERA_FOV, DEFAULT_CAMERA_DISTANCE } from './BrainRig';
import {
  detectTier,
  profileFor,
  QualityGovernor,
  readDeviceHints,
  type QualityProfile,
  type QualityTier,
} from './quality';
import type { BrainSignals } from './signals';

export interface BrainCanvasProps {
  graph: BrainGraph;
  signals: RefObject<BrainSignals>;
  sampleLevels: () => AudioLevels;
  sampleMic: () => number;
  selectedId: string | null;
  onSelect: (node: BrainNode | null) => void;
  onHover: (node: BrainNode | null, screen: { x: number; y: number } | null) => void;
  /** Reported so the HUD can say which tier the device ended up on. */
  onQualityChange?: (profile: QualityProfile) => void;
}

function webglAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      canvas.getContext('webgl2') ??
        canvas.getContext('webgl') ??
        canvas.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

export function BrainCanvas({
  graph,
  signals,
  sampleLevels,
  sampleMic,
  selectedId,
  onSelect,
  onHover,
  onQualityChange,
}: BrainCanvasProps): React.JSX.Element {
  const hints = useMemo(() => readDeviceHints(), []);
  const [supported] = useState(() => webglAvailable());
  const [tier, setTier] = useState<QualityTier>(() =>
    config.render.quality === 'auto' ? detectTier(hints) : config.render.quality,
  );
  const [scale, setScale] = useState(1);

  // The governor is state, not a ref: it is created exactly once and never
  // written during render, so it survives a re-render without one.
  const [governor] = useState(() => new QualityGovernor(tier));

  const profile = useMemo(() => {
    const base = profileFor(tier, {
      maxPixelRatio: config.render.maxPixelRatio,
      bloom: config.render.bloom,
    });
    return { ...base, dpr: [base.dpr[0], base.dpr[1] * scale] as [number, number] };
  }, [tier, scale]);

  useEffect(() => {
    onQualityChange?.(profile);
  }, [profile, onQualityChange]);

  const onFrame = useCallback(
    (frameMs: number) => {
      // The quality tier is only ever pinned when the operator asked for it.
      if (config.render.quality !== 'auto') return;
      const decision = governor.sample(frameMs);
      if (!decision) return;
      setScale(decision.scale);
      if (decision.tier) setTier(decision.tier);
    },
    [governor],
  );

  const activity = useMemo(() => new ActivityTexture(MAX_CLUSTERS), []);
  useEffect(() => () => activity.dispose(), [activity]);

  const slotOf = useMemo(() => {
    const map = new Map<string, number>();
    // Slots are assigned in roster order and capped: a registry larger than the
    // texture keeps its first agents lit rather than corrupting the lookup.
    graph.clusters.slice(0, MAX_CLUSTERS).forEach((cluster, index) => {
      map.set(cluster.agentId, index);
    });
    return map;
  }, [graph.clusters]);

  if (!supported) {
    return (
      <div className="brain-fallback" role="status">
        <p>This browser has no WebGL, so the 3D brain cannot render.</p>
        <p className="dim">
          Everything else — voice, missions, approval gates and the kill switch — still works.
        </p>
      </div>
    );
  }

  return (
    <div className="brain-canvas">
      <Canvas
        dpr={profile.dpr}
        camera={{ fov: CAMERA_FOV, near: 0.1, far: 40, position: [0, 0, DEFAULT_CAMERA_DISTANCE] }}
        gl={{
          antialias: profile.tier !== 'low',
          alpha: true,
          powerPreference: profile.tier === 'high' ? 'high-performance' : 'default',
          // The plate is opaque and covers the frame, so nothing is gained by
          // preserving the drawing buffer.
          preserveDrawingBuffer: false,
        }}
        onCreated={({ gl }) => {
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = 1;
          gl.setClearColor(0x02_02_05, 1);
        }}
      >
        <BrainScene
          graph={graph}
          profile={profile}
          activity={activity}
          slotOf={slotOf}
          signals={signals}
          backgroundImage={config.backgroundImage}
          sampleLevels={sampleLevels}
          sampleMic={sampleMic}
          selectedId={selectedId}
          onSelect={onSelect}
          onHover={onHover}
          onFrame={onFrame}
          reducedMotion={hints.reducedMotion === true}
        />
      </Canvas>
    </div>
  );
}
