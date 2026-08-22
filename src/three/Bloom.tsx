/**
 * Limited bloom.
 *
 * One pass, low strength, high threshold: only the emissive rims, the veins,
 * the sparks and the travelling energy are allowed to bleed. Enabled on the
 * high quality tier only — it costs several full-screen render targets, which
 * is exactly the budget a phone does not have.
 *
 * Taking over the render loop is the whole point of `priority={1}`: R3F stops
 * auto-rendering and the composer becomes the renderer.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Vector2 } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface BloomProps {
  strength?: number;
  radius?: number;
  threshold?: number;
}

export function Bloom({
  strength = 0.62,
  radius = 0.45,
  threshold = 0.62,
}: BloomProps): null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);

  const composer = useMemo(() => {
    const instance = new EffectComposer(gl);
    instance.addPass(new RenderPass(scene, camera));
    instance.addPass(
      new UnrealBloomPass(new Vector2(size.width, size.height), strength, radius, threshold),
    );
    instance.addPass(new OutputPass());
    return instance;
  }, [gl, scene, camera, size.width, size.height, strength, radius, threshold]);

  useEffect(() => {
    composer.setSize(size.width, size.height);
    composer.setPixelRatio(dpr);
  }, [composer, size, dpr]);

  useEffect(() => () => composer.dispose(), [composer]);

  useFrame(() => {
    composer.render();
  }, 1);

  return null;
}
