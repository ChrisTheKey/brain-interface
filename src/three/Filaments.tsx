/**
 * Neural filaments.
 *
 * Every filament is a real relationship: ZERO → agent (an axon) or agent →
 * capability (a dendrite). Nothing here draws a connection HWD-ZERO does not
 * report. What *is* texture rather than data is the bundling — each link is
 * drawn as several fine strands beside each other, which is what makes the
 * brain read as tissue instead of as a wire diagram — and every strand offset
 * is derived deterministically from the link id, so nothing flickers.
 *
 * One merged geometry, one draw call, no per-frame CPU work: the shader reads
 * each strand's activity from the shared activity texture.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { AdditiveBlending, ShaderMaterial } from 'three';
import type { BrainGraph } from '../brain/model';
import { buildFilamentGeometry } from './geometry';
import { GLSL_ACTIVITY, type ActivityTexture } from './activityTexture';
import type { QualityProfile } from './quality';
import type { BrainSignals } from './signals';

const FILAMENT_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aProgress;
attribute float aSlot;
attribute float aStrand;

uniform float uTime;
uniform float uMid;

varying vec3 vColor;
varying float vProgress;
varying float vEnergy;
varying float vStatus;

${GLSL_ACTIVITY}

void main() {
  vec4 activity = readActivity(aSlot);
  vEnergy = activity.r;
  vStatus = activity.b;
  vColor = aColor;
  vProgress = aProgress;

  // A living fibre drifts: a slow, per-strand sway that grows with the voice.
  float sway = sin(uTime * (0.5 + aStrand * 0.31) + aProgress * 7.0 + aStrand * 3.1);
  float amount = (0.004 + uMid * 0.012 + vEnergy * 0.016) * sin(aProgress * 3.14159);
  vec3 pos = position + normalize(position + vec3(0.0001)) * sway * amount;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FILAMENT_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uMid;
uniform float uAgitation;

varying vec3 vColor;
varying float vProgress;
varying float vEnergy;
varying float vStatus;

void main() {
  // Filaments fade towards both ends so they melt into the nodes.
  float taper = sin(vProgress * 3.14159);
  float base = 0.07 + vStatus * 0.28;
  // The mid band is what makes the tissue answer the voice.
  float intensity = base + uMid * 0.30 + vEnergy * 0.65 + uAgitation * 0.06;
  float alpha = intensity * taper;
  if (alpha < 0.004) discard;
  vec3 color = vColor * (0.6 + intensity * 1.3);
  gl_FragColor = vec4(color, alpha);
}
`;

export interface FilamentsProps {
  graph: BrainGraph;
  profile: QualityProfile;
  activity: ActivityTexture;
  slotOf: ReadonlyMap<string, number>;
  signals: RefObject<BrainSignals>;
}

export function Filaments({
  graph,
  profile,
  activity,
  slotOf,
  signals,
}: FilamentsProps): React.JSX.Element | null {
  const geometry = useMemo(
    () => buildFilamentGeometry(graph, profile, slotOf, (slot) => activity.uv(slot)),
    [graph, profile, slotOf, activity],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: FILAMENT_VERTEX,
        fragmentShader: FILAMENT_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uMid: { value: 0 },
          uAgitation: { value: 0 },
          uActivity: { value: activity.texture },
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    [activity],
  );

  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    const signal = signals.current;
    if (!signal) return;
    const uniforms = material.uniforms;
    uniforms['uTime']!.value = signal.time;
    uniforms['uMid']!.value = signal.levels.mid;
    uniforms['uAgitation']!.value = signal.agitation;
  });

  if (geometry.getAttribute('position').count === 0) return null;
  return <lineSegments geometry={geometry} material={material} frustumCulled={false} />;
}
