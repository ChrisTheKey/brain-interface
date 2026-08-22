/**
 * Energy travelling along the agent paths.
 *
 *   ZERO → agent   a task going out      (direction = 1)
 *   agent → ZERO   a result coming back  (direction = −1)
 *
 * A particle only exists on a path whose agent HWD-ZERO actually reported as
 * active — with every agent idle the whole system is invisible. Position is
 * computed entirely in the vertex shader from the curve's three control points,
 * so there is no per-frame CPU work at all: the only thing that changes is one
 * pixel in the activity texture.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { AdditiveBlending, ShaderMaterial } from 'three';
import type { BrainGraph } from '../brain/model';
import { buildEnergyGeometry } from './geometry';
import { GLSL_ACTIVITY, type ActivityTexture } from './activityTexture';
import { GLSL_CURVE } from './shaders/noise';
import type { QualityProfile } from './quality';
import type { BrainSignals } from './signals';

const ENERGY_VERTEX = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aControl;
attribute vec3 aTo;
attribute vec3 aColor;
attribute float aOffset;
attribute float aSpeed;
attribute float aSlot;

uniform float uTime;
uniform float uSize;
uniform float uTransient;

varying vec3 vColor;
varying float vAlpha;

${GLSL_ACTIVITY}
${GLSL_CURVE}

void main() {
  vec4 activity = readActivity(aSlot);
  float energy = activity.r;
  // g is direction packed into 0..1; 1 = outward, 0 = back to ZERO.
  float outward = step(0.5, activity.g);

  float speed = aSpeed * (0.35 + energy * 1.15);
  float t = fract(uTime * speed + aOffset);
  // A transient in the voice shoves every packet forward a little.
  t = fract(t + uTransient * 0.08);
  t = mix(1.0 - t, t, outward);

  vec3 pos = quadraticBezier(aFrom, aControl, aTo, t);
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Fade in and out at the ends so packets are born and absorbed, not clipped.
  float ends = sin(t * 3.14159);
  vColor = aColor;
  vAlpha = energy * ends * (0.45 + uTransient * 0.5);
  gl_PointSize = uSize * (0.4 + energy * 1.1) * ends / max(0.35, -mvPosition.z);
}
`;

const ENERGY_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d = length(offset);
  if (d > 0.5 || vAlpha <= 0.003) discard;
  float falloff = pow(1.0 - d * 2.0, 2.2);
  gl_FragColor = vec4(vColor * (1.0 + falloff), vAlpha * falloff);
}
`;

export interface EnergyFlowProps {
  graph: BrainGraph;
  profile: QualityProfile;
  activity: ActivityTexture;
  slotOf: ReadonlyMap<string, number>;
  signals: RefObject<BrainSignals>;
}

export function EnergyFlow({
  graph,
  profile,
  activity,
  slotOf,
  signals,
}: EnergyFlowProps): React.JSX.Element | null {
  const geometry = useMemo(
    () => buildEnergyGeometry(graph, profile, slotOf, (slot) => activity.uv(slot)),
    [graph, profile, slotOf, activity],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: ENERGY_VERTEX,
        fragmentShader: ENERGY_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: 34 },
          uTransient: { value: 0 },
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
    uniforms['uTransient']!.value = signal.levels.transient;
  });

  if (geometry.getAttribute('position').count === 0) return null;
  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
