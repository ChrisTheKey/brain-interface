/**
 * The smoke ZERO breathes while it speaks.
 *
 * Every property comes from the measured signal — there is no timer, no
 * "voice is playing" flag and no text-length heuristic anywhere in it:
 *
 *   RMS        → emission and expansion speed
 *   low band   → density and particle size (the body of the voice)
 *   high band  → turbulence (consonants, emphasis)
 *   transient  → a shove outward on a stressed word
 *
 * The emission envelope is smoothed on the CPU with a fast attack and a slow
 * release, so a sentence starts instantly and the plume dissipates afterwards
 * instead of being cut off. With silence the envelope reaches zero and every
 * fragment is discarded, which costs nothing.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, ShaderMaterial } from 'three';
import { GLSL_NOISE } from './shaders/noise';
import type { QualityProfile } from './quality';
import type { BrainSignals } from './signals';
import { CORE_VEIN } from '../brain/palette';

const SMOKE_VERTEX = /* glsl */ `
attribute vec3 aDirection;
attribute vec2 aSeed;

uniform float uTime;
uniform float uEmission;
uniform float uRms;
uniform float uLow;
uniform float uTurbulence;
uniform float uTransient;
uniform float uCoreRadius;
uniform float uSize;

varying float vAlpha;
varying float vAge;
varying float vSeed;

${GLSL_NOISE}

void main() {
  float life = 2.4 + aSeed.x * 3.2;
  float age = fract((uTime * (0.45 + uRms * 0.9) + aSeed.y * life) / life);

  // Radial rise out of the core, accelerating as the plume thins.
  float distance = uCoreRadius * (1.02 + age * (1.1 + uRms * 2.6 + uTransient * 0.9));

  // Curl: three noise samples turn the radial plume into rolling smoke.
  vec3 seedOffset = aDirection * 2.0 + vec3(aSeed.x * 9.0, aSeed.y * 7.0, 0.0);
  vec3 curl = vec3(
    snoise(seedOffset + vec3(0.0, uTime * 0.22, 0.0)),
    snoise(seedOffset + vec3(uTime * 0.19, 0.0, 3.7)),
    snoise(seedOffset + vec3(5.2, 0.0, uTime * 0.24))
  );
  vec3 pos = aDirection * distance + curl * uTurbulence * age * uCoreRadius * 1.5;
  // Smoke rises, slowly.
  pos.y += age * age * uCoreRadius * 0.55;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float size = uSize * (0.35 + age * 1.8) * (0.5 + uLow * 1.2);
  gl_PointSize = size / max(0.35, -mvPosition.z);

  vAge = age;
  vSeed = aSeed.x;
  // Born at the core, gone at the edge; the envelope gates the whole plume.
  vAlpha = uEmission * sin(age * 3.14159) * (0.35 + aSeed.x * 0.65);
}
`;

const SMOKE_FRAGMENT = /* glsl */ `
uniform vec3 uSmoke;
uniform vec3 uAccent;

varying float vAlpha;
varying float vAge;
varying float vSeed;

void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d = length(offset);
  if (d > 0.5 || vAlpha <= 0.002) discard;
  // Very soft edge: a hard disc reads as a bubble, not as smoke.
  float falloff = pow(1.0 - d * 2.0, 2.6);
  // Hot near the core, cooling to the accent as it drifts away.
  vec3 color = mix(uSmoke, uAccent, clamp(vAge * 1.4, 0.0, 1.0));
  float alpha = vAlpha * falloff * 0.34 * (1.0 - vAge * 0.35);
  gl_FragColor = vec4(color * (0.5 + vSeed * 0.6), alpha);
}
`;

export interface SmokeProps {
  coreRadius: number;
  profile: QualityProfile;
  signals: RefObject<BrainSignals>;
}

/**
 * The emission envelope. Fast attack (a sentence starts at once), slow
 * release (the plume dissipates). Pure, so the timing is unit-tested.
 */
export function stepEnvelope(current: number, target: number, dt: number): number {
  const rate = target > current ? 9 : 1.1;
  return current + (target - current) * Math.min(1, dt * rate);
}

/** How hard the core emits for a given signal. Silence emits nothing at all. */
export function emissionFor(amplitude: number, low: number, transient: number): number {
  if (amplitude < 0.02) return 0;
  return Math.min(1, amplitude * 1.25 + low * 0.35 + transient * 0.4);
}

export function Smoke({ coreRadius, profile, signals }: SmokeProps): React.JSX.Element {
  const geometry = useMemo(() => {
    const count = profile.smokeParticles;
    const positions = new Float32Array(count * 3);
    const directions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      // Deterministic sphere spread, so the pool is identical every reload.
      const y = 1 - ((i + 0.5) / count) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = Math.PI * (3 - Math.sqrt(5)) * i;
      directions[i * 3] = Math.cos(theta) * r;
      directions[i * 3 + 1] = y * 0.75;
      directions[i * 3 + 2] = Math.sin(theta) * r;
      seeds[i * 2] = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
      seeds[i * 2 + 1] = ((Math.sin(i * 78.233) * 12345.6789) % 1 + 1) % 1;
    }
    const buffer = new BufferGeometry();
    buffer.setAttribute('position', new BufferAttribute(positions, 3));
    buffer.setAttribute('aDirection', new BufferAttribute(directions, 3));
    buffer.setAttribute('aSeed', new BufferAttribute(seeds, 2));
    return buffer;
  }, [profile.smokeParticles]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SMOKE_VERTEX,
        fragmentShader: SMOKE_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uEmission: { value: 0 },
          uRms: { value: 0 },
          uLow: { value: 0 },
          uTurbulence: { value: 0 },
          uTransient: { value: 0 },
          uCoreRadius: { value: coreRadius },
          uSize: { value: 90 },
          uSmoke: { value: new Color('#f0e6f2') },
          uAccent: { value: new Color(CORE_VEIN) },
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    [coreRadius],
  );
  useEffect(() => () => material.dispose(), [material]);

  const envelope = useRef(0);

  useFrame((_, delta) => {
    const signal = signals.current;
    if (!signal) return;
    const { levels, accent, time } = signal;
    const target = emissionFor(levels.amplitude, levels.low, levels.transient);
    envelope.current = stepEnvelope(envelope.current, target, Math.min(0.1, delta));

    const uniforms = material.uniforms;
    uniforms['uTime']!.value = time;
    uniforms['uEmission']!.value = envelope.current;
    uniforms['uRms']!.value = levels.amplitude;
    uniforms['uLow']!.value = levels.low;
    uniforms['uTurbulence']!.value = 0.12 + levels.high * 1.35;
    uniforms['uTransient']!.value = levels.transient;
    (uniforms['uAccent']!.value as Color).copy(accent);
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
