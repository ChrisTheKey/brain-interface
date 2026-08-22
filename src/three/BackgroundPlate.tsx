/**
 * The plate the brain sits on: `public/reference/red-background.jpg`.
 *
 * It lives inside the scene rather than behind the canvas, so it takes part in
 * the depth of field, drifts very slightly with the voice, and is what bloom
 * blooms against. A CSS copy of the same image sits under the canvas as the
 * fallback for the moment before the texture decodes — and for a device where
 * WebGL is unavailable entirely.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Color, ShaderMaterial, TextureLoader, SRGBColorSpace, type Texture } from 'three';
import type { BrainSignals } from './signals';
import { CAMERA_FOV, MAX_CAMERA_DISTANCE } from './BrainRig';
import { VOID } from '../brain/palette';

const PLATE_DEPTH = -7;

const PLATE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PLATE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uHasMap;
uniform float uTime;
uniform float uRms;
uniform float uAgitation;
uniform vec3 uVoid;
uniform vec3 uAccent;

varying vec2 vUv;

void main() {
  // A very slow drift keeps the plate from reading as a static screenshot.
  vec2 uv = vUv + vec2(sin(uTime * 0.014) * 0.006, cos(uTime * 0.011) * 0.005);
  uv = clamp(uv, 0.0, 1.0);

  vec3 plate = mix(uVoid, texture2D(uMap, uv).rgb, uHasMap);
  // Fallback gradient for the frame before the texture exists.
  plate += uAccent * (1.0 - uHasMap) * pow(1.0 - length(vUv - 0.5) * 1.4, 3.0) * 0.35;

  // Vignette towards the centre: the brain must own the middle of the frame.
  float d = length((vUv - 0.5) * vec2(1.35, 1.0));
  float centre = smoothstep(0.62, 0.06, d);
  float dim = mix(0.46, 0.07, centre);
  vec3 color = plate * dim;

  // The plate answers the voice, faintly — never enough to compete with it.
  color += uAccent * centre * (uRms * 0.05 + uAgitation * 0.012);

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface BackgroundPlateProps {
  image: string;
  signals: RefObject<BrainSignals>;
}

export function BackgroundPlate({ image, signals }: BackgroundPlateProps): React.JSX.Element {
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let disposed = false;
    let loaded: Texture | null = null;
    new TextureLoader().load(
      image,
      (result) => {
        if (disposed) {
          result.dispose();
          return;
        }
        result.colorSpace = SRGBColorSpace;
        loaded = result;
        setTexture(result);
      },
      undefined,
      // A missing plate is not an error worth breaking the brain over: the
      // shader falls back to the void gradient.
      () => undefined,
    );
    return () => {
      disposed = true;
      loaded?.dispose();
    };
  }, [image]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: PLATE_VERTEX,
        fragmentShader: PLATE_FRAGMENT,
        uniforms: {
          uMap: { value: null },
          uHasMap: { value: 0 },
          uTime: { value: 0 },
          uRms: { value: 0 },
          uAgitation: { value: 0 },
          uVoid: { value: new Color(VOID) },
          uAccent: { value: new Color('#ff2f8e') },
        },
        depthWrite: false,
        depthTest: false,
      }),
    [],
  );

  useEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    material.uniforms['uMap']!.value = texture;
    material.uniforms['uHasMap']!.value = texture ? 1 : 0;
  }, [material, texture]);

  const dimensions = useMemo(() => {
    // The camera dollies towards and away from the brain, so the plate is
    // sized for the furthest it can ever be — then it covers the frame at
    // every zoom level, and never has to be resized while the user pinches.
    const distance = MAX_CAMERA_DISTANCE - PLATE_DEPTH;
    const planeHeight = 2 * Math.tan((CAMERA_FOV * Math.PI) / 360) * distance;
    const planeWidth = planeHeight * (width / Math.max(1, height));
    // A little oversize so the drift never exposes an edge.
    return [planeWidth * 1.08, planeHeight * 1.08] as const;
  }, [width, height]);

  useFrame(() => {
    const signal = signals.current;
    if (!signal) return;
    const uniforms = material.uniforms;
    uniforms['uTime']!.value = signal.time;
    uniforms['uRms']!.value = signal.levels.amplitude;
    uniforms['uAgitation']!.value = signal.agitation;
    (uniforms['uAccent']!.value as Color).copy(signal.accent);
  });

  return (
    <mesh position={[0, 0, PLATE_DEPTH]} material={material} renderOrder={-10} frustumCulled={false}>
      <planeGeometry args={[dimensions[0], dimensions[1], 1, 1]} />
    </mesh>
  );
}
