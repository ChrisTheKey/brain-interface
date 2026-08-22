/**
 * Sparks: the high band made visible.
 *
 * Consonants and emphasis land in the FFT above ~2 kHz. Those become short,
 * bright flecks close to the core — the detail that makes the voice feel
 * articulated rather than merely loud. Gated hard: with no high-frequency
 * energy there are no sparks at all.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, ShaderMaterial } from 'three';
import type { QualityProfile } from './quality';
import type { BrainSignals } from './signals';

const SPARK_VERTEX = /* glsl */ `
attribute vec3 aDirection;
attribute vec2 aSeed;

uniform float uTime;
uniform float uHigh;
uniform float uTransient;
uniform float uCoreRadius;
uniform float uSize;

varying float vAlpha;

void main() {
  float life = 0.35 + aSeed.x * 0.55;
  float age = fract((uTime * 1.6 + aSeed.y * life) / life);
  float reach = uCoreRadius * (1.05 + age * (0.45 + uHigh * 1.4 + uTransient * 0.8));
  vec3 pos = aDirection * reach;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize * (1.0 - age) / max(0.35, -mvPosition.z);
  // A spark exists only while the high band does.
  vAlpha = uHigh * (1.0 - age) * (0.3 + aSeed.x * 0.7) * (0.4 + uTransient);
}
`;

const SPARK_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d = length(offset);
  if (d > 0.5 || vAlpha <= 0.004) discard;
  float falloff = pow(1.0 - d * 2.0, 3.0);
  gl_FragColor = vec4(uColor, vAlpha * falloff);
}
`;

export interface SparksProps {
  coreRadius: number;
  profile: QualityProfile;
  signals: RefObject<BrainSignals>;
}

export function Sparks({ coreRadius, profile, signals }: SparksProps): React.JSX.Element {
  const geometry = useMemo(() => {
    const count = profile.sparkParticles;
    const positions = new Float32Array(count * 3);
    const directions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      const y = 1 - ((i + 0.5) / count) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = Math.PI * (3 - Math.sqrt(5)) * i * 1.7;
      directions[i * 3] = Math.cos(theta) * r;
      directions[i * 3 + 1] = y;
      directions[i * 3 + 2] = Math.sin(theta) * r;
      seeds[i * 2] = ((Math.sin(i * 31.41) * 8237.19) % 1 + 1) % 1;
      seeds[i * 2 + 1] = ((Math.sin(i * 59.26) * 3371.77) % 1 + 1) % 1;
    }
    const buffer = new BufferGeometry();
    buffer.setAttribute('position', new BufferAttribute(positions, 3));
    buffer.setAttribute('aDirection', new BufferAttribute(directions, 3));
    buffer.setAttribute('aSeed', new BufferAttribute(seeds, 2));
    return buffer;
  }, [profile.sparkParticles]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SPARK_VERTEX,
        fragmentShader: SPARK_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uHigh: { value: 0 },
          uTransient: { value: 0 },
          uCoreRadius: { value: coreRadius },
          uSize: { value: 18 },
          uColor: { value: new Color('#fff0fa') },
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    [coreRadius],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    const signal = signals.current;
    if (!signal) return;
    const uniforms = material.uniforms;
    uniforms['uTime']!.value = signal.time;
    uniforms['uHigh']!.value = signal.levels.high;
    uniforms['uTransient']!.value = signal.levels.transient;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
