/**
 * Everything inside the WebGL canvas, in render order.
 *
 *   plate → filaments → energy → cluster nodes → ZERO core → smoke → sparks
 *
 * `SignalPump` runs first every frame: it samples the audio analyser and the
 * microphone, advances the shared signal object, and writes one pixel per
 * agent into the activity texture. Every other component only reads uniforms.
 * That is the whole reason the brain can run at 60 fps without a single React
 * render per frame.
 */
import { useFrame } from '@react-three/fiber';
import type { RefObject } from 'react';
import type { AudioLevels } from '../audio/analyser';
import { CORE_RADIUS, type BrainGraph, type BrainNode } from '../brain/model';
import { STATUS_INTENSITY } from '../brain/palette';
import { BackgroundPlate } from './BackgroundPlate';
import { Bloom } from './Bloom';
import { BrainRig } from './BrainRig';
import { ClusterNodes } from './ClusterNodes';
import { EnergyFlow } from './EnergyFlow';
import { Filaments } from './Filaments';
import { Smoke } from './Smoke';
import { Sparks } from './Sparks';
import { ZeroCore } from './ZeroCore';
import type { ActivityTexture } from './activityTexture';
import type { QualityProfile } from './quality';
import type { BrainSignals } from './signals';

export interface BrainSceneProps {
  graph: BrainGraph;
  profile: QualityProfile;
  activity: ActivityTexture;
  slotOf: ReadonlyMap<string, number>;
  signals: RefObject<BrainSignals>;
  backgroundImage: string;
  sampleLevels: () => AudioLevels;
  sampleMic: () => number;
  selectedId: string | null;
  onSelect: (node: BrainNode | null) => void;
  onHover: (node: BrainNode | null, screen: { x: number; y: number } | null) => void;
  onFrame?: (frameMs: number) => void;
  reducedMotion?: boolean;
}

function SignalPump({
  graph,
  activity,
  slotOf,
  signals,
  sampleLevels,
  sampleMic,
  onFrame,
}: Pick<
  BrainSceneProps,
  'graph' | 'activity' | 'slotOf' | 'signals' | 'sampleLevels' | 'sampleMic' | 'onFrame'
>): null {
  useFrame((_, delta) => {
    const signal = signals.current;
    if (!signal) return;
    const dt = Math.min(0.1, delta);
    onFrame?.(delta * 1000);

    signal.levels = sampleLevels();
    signal.micLevel = sampleMic();

    // An agent that is genuinely running holds its path lit; everything else
    // decays. `held` is what keeps a long mission from flickering.
    const held = new Set<string>();
    for (const cluster of graph.clusters) {
      if (cluster.status === 'active') held.add(cluster.agentId);
    }
    signal.step(dt, held);

    activity.clear();
    for (const cluster of graph.clusters) {
      const slot = slotOf.get(cluster.agentId);
      if (slot === undefined) continue;
      const pulse = signal.energyFor(cluster.agentId);
      const running = cluster.status === 'active';
      // A running agent glows from its own work and breathes with ZERO's voice.
      const energy = running
        ? Math.max(0.5 + signal.levels.amplitude * 0.35, pulse.energy)
        : pulse.energy;
      activity.set(slot, energy, pulse.direction, STATUS_INTENSITY[cluster.status]);
    }
    activity.commit();
  });
  return null;
}

export function BrainScene({
  graph,
  profile,
  activity,
  slotOf,
  signals,
  backgroundImage,
  sampleLevels,
  sampleMic,
  selectedId,
  onSelect,
  onHover,
  onFrame,
  reducedMotion,
}: BrainSceneProps): React.JSX.Element {
  return (
    <>
      <SignalPump
        graph={graph}
        activity={activity}
        slotOf={slotOf}
        signals={signals}
        sampleLevels={sampleLevels}
        sampleMic={sampleMic}
        {...(onFrame ? { onFrame } : {})}
      />
      <BackgroundPlate image={backgroundImage} signals={signals} />
      <BrainRig driftSpeed={reducedMotion ? 0.012 : 0.045}>
        <Filaments
          graph={graph}
          profile={profile}
          activity={activity}
          slotOf={slotOf}
          signals={signals}
        />
        <EnergyFlow
          graph={graph}
          profile={profile}
          activity={activity}
          slotOf={slotOf}
          signals={signals}
        />
        <ClusterNodes
          graph={graph}
          profile={profile}
          activity={activity}
          slotOf={slotOf}
          signals={signals}
          selectedId={selectedId}
          onSelect={onSelect}
          onHover={onHover}
        />
        <ZeroCore
          radius={CORE_RADIUS}
          profile={profile}
          signals={signals}
          onSelect={() => onSelect(graph.nodes.find((node) => node.kind === 'core') ?? null)}
        />
        <Smoke coreRadius={CORE_RADIUS} profile={profile} signals={signals} />
        <Sparks coreRadius={CORE_RADIUS} profile={profile} signals={signals} />
      </BrainRig>
      {profile.bloom ? <Bloom /> : null}
    </>
  );
}
