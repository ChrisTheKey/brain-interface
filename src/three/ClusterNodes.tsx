/**
 * The agent clusters.
 *
 * Every hub is one child agent of HWD-ZERO; every satellite is one real
 * capability that agent reported (a strength, or a gate that always needs a
 * human). They are obsidian bodies with a department-coloured rim — the same
 * language as the core, one scale down — drawn as a single instanced mesh so
 * the count can grow with the roster without costing draw calls.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import {
  Color,
  InstancedBufferAttribute,
  Matrix4,
  ShaderMaterial,
  Vector3,
  type InstancedMesh,
} from 'three';
import type { BrainGraph, BrainNode } from '../brain/model';
import { accentFor, OBSIDIAN } from '../brain/palette';
import { GLSL_ACTIVITY, type ActivityTexture } from './activityTexture';
import type { QualityProfile } from './quality';
import type { BrainSignals } from './signals';

const NODE_VERTEX = /* glsl */ `
attribute vec3 aAccent;
attribute float aSlot;
attribute float aIndex;
attribute float aIsHub;

uniform float uTime;
uniform float uRms;
uniform float uHighlight;

varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vAccent;
varying float vEnergy;
varying float vStatus;
varying float vHighlight;

${GLSL_ACTIVITY}

void main() {
  vec4 activity = readActivity(aSlot);
  vEnergy = activity.r;
  vStatus = activity.b;
  vAccent = aAccent;
  vHighlight = step(abs(aIndex - uHighlight), 0.4);

  // A running agent breathes; an idle one is still. The voice lifts the hubs
  // a little so the whole brain answers ZERO, not just the core.
  float breathe = 1.0
    + sin(uTime * 1.7 + aIndex * 0.9) * (0.02 + vEnergy * 0.09)
    + uRms * 0.06 * aIsHub
    + vHighlight * 0.22;

  vec3 scaled = position * breathe;
  vec4 worldPosition = instanceMatrix * vec4(scaled, 1.0);
  vec4 mvPosition = modelViewMatrix * worldPosition;
  vViewPosition = -mvPosition.xyz;
  vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const NODE_FRAGMENT = /* glsl */ `
uniform vec3 uObsidian;
uniform float uMid;
uniform float uAgitation;

varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vAccent;
varying float vEnergy;
varying float vStatus;
varying float vHighlight;

void main() {
  vec3 viewDir = normalize(vViewPosition);
  float facing = clamp(dot(normalize(vNormal), viewDir), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, 2.6);

  vec3 base = uObsidian + vec3(0.045, 0.05, 0.065) * pow(facing, 5.0);
  float rim = fresnel * (0.30 + vStatus * 0.55 + vEnergy * 1.05 + uMid * 0.22 + uAgitation * 0.1);
  vec3 color = base + vAccent * rim;
  color += vAccent * vHighlight * 0.35;

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface ClusterNodesProps {
  graph: BrainGraph;
  profile: QualityProfile;
  activity: ActivityTexture;
  slotOf: ReadonlyMap<string, number>;
  signals: RefObject<BrainSignals>;
  selectedId: string | null;
  onSelect: (node: BrainNode | null) => void;
  onHover: (node: BrainNode | null, screen: { x: number; y: number } | null) => void;
}

export function ClusterNodes({
  graph,
  profile,
  activity,
  slotOf,
  signals,
  selectedId,
  onSelect,
  onHover,
}: ClusterNodesProps): React.JSX.Element | null {
  const meshRef = useRef<InstancedMesh>(null);

  // Only hubs and satellites — the core is its own mesh with its own shader.
  const instances = useMemo(
    () => graph.nodes.filter((node) => node.kind !== 'core'),
    [graph.nodes],
  );

  const attributes = useMemo(() => {
    const count = instances.length;
    const accents = new Float32Array(count * 3);
    const slots = new Float32Array(count);
    const indices = new Float32Array(count);
    const isHub = new Float32Array(count);
    instances.forEach((node, index) => {
      const accent = accentFor(node.department, node.status);
      accents[index * 3] = accent.r;
      accents[index * 3 + 1] = accent.g;
      accents[index * 3 + 2] = accent.b;
      slots[index] = activity.uv(node.clusterId ? (slotOf.get(node.clusterId) ?? 0) : 0);
      indices[index] = index;
      isHub[index] = node.kind === 'agent' ? 1 : 0;
    });
    return {
      accents: new InstancedBufferAttribute(accents, 3),
      slots: new InstancedBufferAttribute(slots, 1),
      indices: new InstancedBufferAttribute(indices, 1),
      isHub: new InstancedBufferAttribute(isHub, 1),
    };
  }, [instances, activity, slotOf]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: NODE_VERTEX,
        fragmentShader: NODE_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uRms: { value: 0 },
          uMid: { value: 0 },
          uAgitation: { value: 0 },
          uHighlight: { value: -1 },
          uObsidian: { value: new Color(OBSIDIAN) },
          uActivity: { value: activity.texture },
        },
      }),
    [activity],
  );
  useEffect(() => () => material.dispose(), [material]);

  // The instance transforms are written exactly once per graph — a position
  // that comes from a deterministic layout never needs a per-frame rewrite.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const scale = new Vector3();
    instances.forEach((node, index) => {
      scale.setScalar(node.radius);
      matrix.makeScale(scale.x, scale.y, scale.z);
      matrix.setPosition(node.position[0], node.position[1], node.position[2]);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.count = instances.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [instances]);

  const selectedIndex = useMemo(
    () => instances.findIndex((node) => node.id === selectedId),
    [instances, selectedId],
  );

  const hoveredRef = useRef<number>(-1);

  useFrame(() => {
    const signal = signals.current;
    if (!signal) return;
    const uniforms = material.uniforms;
    uniforms['uTime']!.value = signal.time;
    uniforms['uRms']!.value = signal.levels.amplitude;
    uniforms['uMid']!.value = signal.levels.mid;
    uniforms['uAgitation']!.value = signal.agitation;
    uniforms['uHighlight']!.value =
      hoveredRef.current >= 0 ? hoveredRef.current : selectedIndex;
  });

  if (instances.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, instances.length]}
      material={material}
      frustumCulled={false}
      onPointerDown={(event) => {
        event.stopPropagation();
        const index = event.instanceId;
        onSelect(index === undefined ? null : (instances[index] ?? null));
      }}
      onPointerMove={(event) => {
        const index = event.instanceId ?? -1;
        if (index === hoveredRef.current) return;
        hoveredRef.current = index;
        const node = index >= 0 ? (instances[index] ?? null) : null;
        onHover(node, node ? { x: event.clientX, y: event.clientY } : null);
      }}
      onPointerOut={() => {
        hoveredRef.current = -1;
        onHover(null, null);
      }}
    >
      <icosahedronGeometry args={[1, profile.nodeDetail]} />
      <primitive object={attributes.accents} attach="geometry-attributes-aAccent" />
      <primitive object={attributes.slots} attach="geometry-attributes-aSlot" />
      <primitive object={attributes.indices} attach="geometry-attributes-aIndex" />
      <primitive object={attributes.isHub} attach="geometry-attributes-aIsHub" />
    </instancedMesh>
  );
}
