/**
 * ZERO — the core.
 *
 * Obsidian, dominant, at the centre of everything. Three layers:
 *
 *   body        an icosahedron displaced by layered noise; the surface has a
 *               faint metallic sheen and light veins running under it
 *   shell       a slightly larger inverted sphere: the atmosphere that carries
 *               the state accent and the fresnel rim
 *   halo        a cloud of particles held in orbit around it
 *
 * Everything it does is driven by something real: RMS scales it, the low band
 * is its pulse, the mid band lights the veins, and the runtime state sets the
 * accent. With silence and an idle operator it simply breathes.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  ShaderMaterial,
  type IcosahedronGeometry,
  type Mesh,
  type Points,
} from 'three';
import { GLSL_NOISE } from './shaders/noise';
import type { BrainSignals } from './signals';
import type { QualityProfile } from './quality';
import { CORE_VEIN, OBSIDIAN } from '../brain/palette';

const CORE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uRms;
uniform float uLow;
uniform float uAgitation;
uniform float uTransient;

varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vLocal;
varying float vDisplacement;

${GLSL_NOISE}

void main() {
  vec3 pos = position;
  // Slow organic swell plus the body of the voice: this is the "breathing".
  vec3 dir = normalize(pos);
  float slow = fbm(dir * 1.9 + vec3(0.0, uTime * 0.09, 0.0), 3);
  float relief = fbm(dir * 8.4 + vec3(0.0, uTime * 0.05, 0.0), 3);
  float pulse = fbm(dir * 3.4 - vec3(uTime * 0.32), 2);
  float amount =
      slow * (0.05 + uAgitation * 0.045)
    + relief * 0.014
    + pulse * (uLow * 0.11 + uTransient * 0.09)
    + uRms * 0.05;

  vDisplacement = amount;
  pos += normal * amount;

  vLocal = normalize(position);
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const CORE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uRms;
uniform float uMid;
uniform float uHigh;
uniform float uAgitation;
uniform vec3 uObsidian;
uniform vec3 uVein;
uniform vec3 uAccent;

varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vLocal;
varying float vDisplacement;

${GLSL_NOISE}

void main() {
  vec3 viewDir = normalize(vViewPosition);
  float facing = clamp(dot(normalize(vNormal), viewDir), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, 3.0);

  // Obsidian: near black, with a cold metallic sheen where the light grazes.
  vec3 base = uObsidian + vec3(0.055, 0.06, 0.085) * pow(facing, 5.0);

  // The veins live *under* the surface: a slowly drifting ridged field that
  // only shows where the shell is thin (the displaced ridges).
  float vein = veins(vLocal * 6.2 + vec3(0.0, uTime * 0.11, uTime * 0.04), 13.0);
  vein *= smoothstep(-0.055, 0.025, vDisplacement);
  // The seams are always faintly alive; the voice is what makes them blaze.
  // The band that carries vowels drives them hardest, so the core articulates
  // rather than merely brightening.
  float veinGlow = vein * (0.42 + uMid * 2.1 + uRms * 1.0 + uAgitation * 0.2);

  vec3 color = base;
  color += mix(uVein, uAccent, 0.14 + uMid * 0.3) * veinGlow;
  // A thin luminous edge, not a wash across the body: the fresnel term is
  // already high wherever the relief turns away from the camera.
  color += uAccent * pow(fresnel, 1.6) * (0.22 + uRms * 0.8 + uAgitation * 0.12);
  // Consonants glint on the rim rather than brightening the whole body.
  color += vec3(1.0, 0.92, 0.98) * pow(fresnel, 2.5) * uHigh * 0.45;

  gl_FragColor = vec4(color, 1.0);
}
`;

const SHELL_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewPosition;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uAccent;
uniform float uRms;
uniform float uAgitation;
uniform float uMic;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vec3 viewDir = normalize(vViewPosition);
  float facing = abs(dot(normalize(vNormal), viewDir));
  // Inverted sphere: the rim is where the normal turns away from the camera.
  float rim = pow(1.0 - facing, 2.2);
  float intensity = pow(rim, 1.5) * (0.10 + uRms * 0.55 + uAgitation * 0.14 + uMic * 0.3);
  gl_FragColor = vec4(uAccent * intensity, intensity);
}
`;

const HALO_VERTEX = /* glsl */ `
attribute vec3 aDirection;
attribute float aSeed;
attribute float aRadius;

uniform float uTime;
uniform float uRms;
uniform float uLow;
uniform float uAgitation;
uniform float uSize;
uniform float uCoreRadius;

varying float vAlpha;

void main() {
  float spin = uTime * (0.05 + aSeed * 0.12) * (1.0 + uAgitation * 0.7);
  float c = cos(spin);
  float s = sin(spin);
  vec3 dir = vec3(
    aDirection.x * c - aDirection.z * s,
    aDirection.y,
    aDirection.x * s + aDirection.z * c
  );
  float bob = sin(uTime * (0.6 + aSeed) + aSeed * 12.0) * 0.03;
  float radius = uCoreRadius * (aRadius + bob + uRms * 0.55 + uLow * 0.25);
  vec3 pos = dir * radius;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize * (0.5 + aSeed) / max(0.4, -mvPosition.z);
  vAlpha = (0.035 + uRms * 0.34 + uAgitation * 0.09) * (0.25 + aSeed * 0.75);
}
`;

const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uAccent;
varying float vAlpha;
void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d = length(offset);
  if (d > 0.5) discard;
  float falloff = pow(1.0 - d * 2.0, 2.0);
  gl_FragColor = vec4(uAccent, vAlpha * falloff);
}
`;

export interface ZeroCoreProps {
  radius: number;
  profile: QualityProfile;
  signals: RefObject<BrainSignals>;
  onSelect?: () => void;
}

export function ZeroCore({ radius, profile, signals, onSelect }: ZeroCoreProps): React.JSX.Element {
  const bodyRef = useRef<Mesh>(null);
  const geometryRef = useRef<IcosahedronGeometry>(null);

  const bodyMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: CORE_VERTEX,
        fragmentShader: CORE_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uRms: { value: 0 },
          uLow: { value: 0 },
          uMid: { value: 0 },
          uHigh: { value: 0 },
          uTransient: { value: 0 },
          uAgitation: { value: 0 },
          uObsidian: { value: new Color(OBSIDIAN) },
          uVein: { value: new Color(CORE_VEIN) },
          uAccent: { value: new Color('#ff2f8e') },
        },
      }),
    [],
  );

  const shellMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SHELL_VERTEX,
        fragmentShader: SHELL_FRAGMENT,
        uniforms: {
          uAccent: { value: new Color('#ff2f8e') },
          uRms: { value: 0 },
          uAgitation: { value: 0 },
          uMic: { value: 0 },
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: BackSide,
      }),
    [],
  );

  const halo = useMemo(() => {
    const count = profile.haloParticles;
    const geometry = new BufferGeometry();
    const positions = new Float32Array(count * 3);
    const directions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const radii = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      // Even distribution on a sphere from a deterministic golden-angle spiral.
      const y = 1 - ((i + 0.5) / count) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = Math.PI * (3 - Math.sqrt(5)) * i;
      directions[i * 3] = Math.cos(theta) * r;
      directions[i * 3 + 1] = y;
      directions[i * 3 + 2] = Math.sin(theta) * r;
      const seed = ((Math.sin(i * 127.1) * 43758.5453) % 1 + 1) % 1;
      seeds[i] = seed;
      radii[i] = 2.0 + seed * 3.4;
    }
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aDirection', new BufferAttribute(directions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.setAttribute('aRadius', new BufferAttribute(radii, 1));
    const material = new ShaderMaterial({
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uRms: { value: 0 },
        uLow: { value: 0 },
        uAgitation: { value: 0 },
        uSize: { value: 15 },
        uCoreRadius: { value: radius },
        uAccent: { value: new Color('#ff2f8e') },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    return { geometry, material };
  }, [profile.haloParticles, radius]);

  const haloRef = useRef<Points>(null);

  useFrame(() => {
    const signal = signals.current;
    if (!signal) return;
    const { levels, agitation, accent, micLevel, time } = signal;

    const body = bodyMaterial.uniforms;
    body['uTime']!.value = time;
    body['uRms']!.value = levels.amplitude;
    body['uLow']!.value = levels.low;
    body['uMid']!.value = levels.mid;
    body['uHigh']!.value = levels.high;
    body['uTransient']!.value = levels.transient;
    body['uAgitation']!.value = agitation;
    (body['uAccent']!.value as Color).copy(accent);

    const shell = shellMaterial.uniforms;
    shell['uRms']!.value = levels.amplitude;
    shell['uAgitation']!.value = agitation;
    shell['uMic']!.value = micLevel;
    (shell['uAccent']!.value as Color).copy(accent);

    const haloUniforms = halo.material.uniforms;
    haloUniforms['uTime']!.value = time;
    haloUniforms['uRms']!.value = levels.amplitude;
    haloUniforms['uLow']!.value = levels.low;
    haloUniforms['uAgitation']!.value = agitation;
    (haloUniforms['uAccent']!.value as Color).copy(accent);

    // RMS scales the whole core — the single most legible reaction to a voice.
    const scale = 1 + levels.amplitude * 0.16 + levels.low * 0.06;
    bodyRef.current?.scale.setScalar(scale);
    if (haloRef.current) haloRef.current.rotation.y = time * 0.02;
  });

  return (
    <group>
      <mesh
        ref={bodyRef}
        material={bodyMaterial}
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect?.();
        }}
      >
        <icosahedronGeometry ref={geometryRef} args={[radius, profile.coreDetail]} />
      </mesh>
      <mesh material={shellMaterial} scale={1.22}>
        <icosahedronGeometry args={[radius, Math.max(2, profile.coreDetail - 2)]} />
      </mesh>
      <points ref={haloRef} geometry={halo.geometry} material={halo.material} frustumCulled={false} />
    </group>
  );
}
