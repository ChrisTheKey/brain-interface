/**
 * The shaders.
 *
 * Every visual signal in the brain is driven by a uniform rather than by
 * per-frame CPU work: audio bands, activity energy, and ZERO's state all reach
 * the GPU as numbers, and the geometry never changes. That is what keeps
 * hundreds of nodes and thousands of particles inside a frame budget on a
 * laptop that is also running an LLM.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  ShaderMaterial,
  UniformsUtils,
} from 'three';

export interface AudioUniforms {
  uTime: { value: number };
  uRms: { value: number };
  uLow: { value: number };
  uMid: { value: number };
  uHigh: { value: number };
  uTransient: { value: number };
}

export function createAudioUniforms(): AudioUniforms {
  return {
    uTime: { value: 0 },
    uRms: { value: 0 },
    uLow: { value: 0 },
    uMid: { value: 0 },
    uHigh: { value: 0 },
    uTransient: { value: 0 },
  };
}

/** Simplex-ish value noise, shared by the shaders that need organic motion. */
const NOISE = /* glsl */ `
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
  }
  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
              dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
          mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
              dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
      mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
              dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
          mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
              dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
  }
`;

/**
 * The ZERO core: obsidian, with light moving *inside* it.
 *
 * Fresnel gives the dark glassy edge; the internal veins are noise banded into
 * thin bright ridges, drifting slowly and pulsing with the low band. Both are
 * computed in object space, so the veins stay attached to the core as the
 * camera orbits instead of swimming across the surface.
 */
export function createCoreMaterial(uniforms: AudioUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      uniforms as unknown as Record<string, { value: number }>,
      {
        uVeinColor: { value: new Color('#ff2f5e') },
        uRimColor: { value: new Color('#f4eef8') },
        uActivity: { value: 0 },
      },
    ]) as never,
    transparent: true,
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vObject;
      uniform float uLow;
      uniform float uRms;
      uniform float uTime;
      ${NOISE}
      void main() {
        vObject = position;
        // The core breathes: slow always, harder on the low band while speaking.
        float breathe = 1.0
          + sin(uTime * 0.6) * 0.012
          + uLow * 0.075
          + uRms * 0.03;
        vec3 displaced = position * breathe
          + normal * noise(position * 1.7 + uTime * 0.12) * (0.03 + uLow * 0.09);
        vec4 world = modelMatrix * vec4(displaced, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vObject;
      uniform vec3 uVeinColor;
      uniform vec3 uRimColor;
      uniform float uTime;
      uniform float uRms;
      uniform float uLow;
      uniform float uMid;
      uniform float uActivity;
      ${NOISE}
      void main() {
        float fresnel = pow(1.0 - clamp(dot(vNormalW, vViewDir), 0.0, 1.0), 2.6);

        // Internal veins: banded noise, thin and bright.
        float field = noise(vObject * 2.6 + vec3(0.0, uTime * 0.16, 0.0))
                    + noise(vObject * 6.1 - vec3(uTime * 0.09, 0.0, 0.0)) * 0.45;
        float veins = smoothstep(0.965, 1.0, abs(sin(field * 6.2831 * 3.1 + uTime * 0.5)));
        veins *= 0.35 + uMid * 0.9 + uActivity * 0.55;

        // Obsidian: near-black, so the veins are the only light in it.
        vec3 obsidian = vec3(0.006, 0.006, 0.012);
        vec3 colour = obsidian;
        colour += uVeinColor * veins * (0.9 + uRms * 2.2);
        colour += uRimColor * fresnel * (0.42 + uLow * 0.7 + uActivity * 0.45);

        gl_FragColor = vec4(colour, 0.97 + fresnel * 0.03);
      }
    `,
  });
}

/**
 * Nodes, drawn as instanced camera-facing discs.
 *
 * Per-instance attributes carry the department colour and an activity level, so
 * one draw call renders every node in the brain and a cluster lighting up costs
 * an attribute update rather than a rebuild.
 */
export function createNodeMaterial(uniforms: AudioUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      uniforms as unknown as Record<string, { value: number }>,
      { uSelected: { value: -1 }, uReducedMotion: { value: 0 } },
    ]) as never,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aActivity;
      attribute float aSeed;
      attribute float aScale;
      varying vec3 vColor;
      varying float vActivity;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uHigh;
      uniform float uRms;
      uniform float uReducedMotion;
      void main() {
        vColor = aColor;
        vActivity = aActivity;
        vUv = uv;

        // Every node drifts a little, on its own phase. This is the "permanent
        // organic motion" — the brain is never frozen, even at rest.
        float wander = (1.0 - uReducedMotion) * 0.06;
        vec3 offset = vec3(
          sin(uTime * 0.5 + aSeed * 6.283),
          cos(uTime * 0.43 + aSeed * 4.712),
          sin(uTime * 0.37 + aSeed * 2.094)
        ) * wander;

        float pulse = 1.0
          + aActivity * (0.35 + sin(uTime * 4.0 + aSeed * 6.283) * 0.2)
          + uHigh * 0.25 * step(0.5, aSeed)
          + uRms * 0.1;

        vec3 centre = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz + offset;
        // Billboard: build the quad in view space so discs always face camera.
        vec3 viewCentre = (viewMatrix * modelMatrix * vec4(centre, 1.0)).xyz;
        vec3 viewPos = viewCentre + vec3(position.xy * aScale * pulse, 0.0);
        gl_Position = projectionMatrix * vec4(viewPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying float vActivity;
      varying vec2 vUv;
      void main() {
        vec2 centred = vUv * 2.0 - 1.0;
        float radius = length(centred);
        if (radius > 1.0) discard;

        // A neuron, not a bubble: a bright dense centre falling off into a soft
        // halo. An earlier version drew a rim ring, which at this density read
        // as a field of soap bubbles rather than as glowing cells.
        float centre = pow(max(0.0, 1.0 - radius / 0.34), 2.0);
        float halo = pow(max(0.0, 1.0 - radius), 3.0);

        vec3 colour =
            vColor * halo * (1.1 + vActivity * 2.0)
          + mix(vColor, vec3(1.0), 0.55) * centre * (1.5 + vActivity * 2.2);

        float alpha = clamp(halo * 0.55 + centre * 0.95, 0.0, 1.0);
        gl_FragColor = vec4(colour, alpha);
      }
    `,
  });
}

/**
 * Edges, with energy travelling along them.
 *
 * `aDirection` is +1 for ZERO→agent and -1 for agent→ZERO, so a mission's
 * outbound dispatch and its returning result are visually distinct without any
 * change to the geometry.
 */
export function createEdgeMaterial(uniforms: AudioUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      uniforms as unknown as Record<string, { value: number }>,
      { uReducedMotion: { value: 0 } },
    ]) as never,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aEnergy;
      attribute float aDirection;
      attribute float aAlong;
      attribute float aSeed;
      varying vec3 vColor;
      varying float vEnergy;
      varying float vAlong;
      varying float vDirection;
      varying float vSeed;
      void main() {
        vColor = aColor;
        vEnergy = aEnergy;
        vAlong = aAlong;
        vDirection = aDirection;
        vSeed = aSeed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying float vEnergy;
      varying float vAlong;
      varying float vDirection;
      varying float vSeed;
      uniform float uTime;
      uniform float uRms;
      uniform float uMid;
      uniform float uReducedMotion;
      void main() {
        // A travelling packet of light. Direction flips its travel, so energy
        // visibly returns to the core during verification.
        float speed = 0.55 + vEnergy * 1.1;
        float head = fract(vSeed + uTime * speed * vDirection * (1.0 - uReducedMotion * 0.75));
        float d = abs(fract(vAlong - head + 0.5) - 0.5);
        float packet = smoothstep(0.06, 0.0, d) * vEnergy;

        // The resting filament: always faintly alive, never fully static.
        // Bright enough to read as a neural web over the backdrop — a filament
        // that is only visible while carrying a packet makes the brain look
        // like scattered dots at rest, which is the opposite of the reference.
        float base = 0.34 + 0.10 * sin(uTime * 0.8 + vSeed * 6.283) + uMid * 0.18;

        float intensity = base + packet * (1.5 + uRms * 1.1);
        gl_FragColor = vec4(vColor * intensity * 2.6, min(1.0, intensity * 1.35));
      }
    `,
  });
}

/**
 * The smoke ZERO exhales while speaking.
 *
 * Particles are pooled: the buffer is allocated once at the largest size the
 * quality profile allows, and emission only moves `uEmission`. Nothing is
 * allocated per frame, which is what keeps it from stuttering on a phone.
 */
export function createSmokeMaterial(uniforms: AudioUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      uniforms as unknown as Record<string, { value: number }>,
      { uEmission: { value: 0 }, uPixelRatio: { value: 1 } },
    ]) as never,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aBirth;
      attribute vec3 aVelocity;
      attribute float aSeed;
      varying float vLife;
      varying float vSeed;
      uniform float uTime;
      uniform float uLow;
      uniform float uEmission;
      uniform float uPixelRatio;
      ${NOISE}
      void main() {
        float age = uTime - aBirth;
        float lifespan = 3.2 + aSeed * 2.4;
        vLife = clamp(1.0 - age / lifespan, 0.0, 1.0);
        vSeed = aSeed;
        if (age < 0.0 || vLife <= 0.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          return;
        }

        // Rise, drift, and curl. Low frequencies push a bigger plume.
        vec3 pos = position + aVelocity * age * (1.0 + uLow * 1.5);
        pos.y += age * age * 0.06;
        vec3 curl = vec3(
          noise(pos * 0.25 + uTime * 0.15),
          noise(pos * 0.25 + 13.7 + uTime * 0.12),
          noise(pos * 0.25 + 27.3 + uTime * 0.17)
        );
        pos += curl * age * 0.75;

        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        float grow = 1.0 + age * 0.85;
        gl_PointSize = (48.0 * grow * uPixelRatio * (0.35 + uEmission)) / max(-mv.z, 0.001);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vLife;
      varying float vSeed;
      uniform float uRms;
      void main() {
        vec2 centred = gl_PointCoord * 2.0 - 1.0;
        float radius = length(centred);
        if (radius > 1.0) discard;
        float soft = pow(1.0 - radius, 2.0);
        // Dark smoke, faintly lit from within — it must read against the red
        // background without turning into a grey fog over the brain.
        vec3 colour = mix(vec3(0.02, 0.02, 0.035), vec3(0.30, 0.06, 0.12), uRms * 0.7);
        float alpha = soft * vLife * 0.30;
        gl_FragColor = vec4(colour, alpha);
      }
    `,
  });
}
