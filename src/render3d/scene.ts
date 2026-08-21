/**
 * The 3D brain.
 *
 * Raw Three.js rather than react-three-fiber, deliberately. The interface's
 * existing render layer is imperative and driven from a layout module, the
 * scene graph is built once and then only has uniforms and attributes written
 * to it, and the target is a laptop with 8 GB of RAM that is simultaneously
 * running a language model. A reconciler that re-renders a component tree per
 * frame would add a dependency, a per-frame allocation path and no capability
 * this scene needs.
 *
 * Everything visible is driven by real state:
 *   - node and edge energy come from ZERO's events, not from a timer;
 *   - the core and the smoke are driven by the analyser reading the audio that
 *     is actually playing, not by the length of the text being spoken;
 *   - a branch stops at a visible gate exactly when the server raised one.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  QuadraticBezierCurve3,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  BRAIN_SCALE,
  buildBrainLayout,
  hashUnit,
  type AgentSeed,
  type BrainLayout3D,
  type Vec3,
} from './layout3d';
import {
  createAudioUniforms,
  createCoreMaterial,
  createEdgeMaterial,
  createNodeMaterial,
  createSmokeMaterial,
  type AudioUniforms,
} from './materials';

/** How the scene is sized for the device it is running on. */
export interface QualityProfile {
  nodesPerCluster: number;
  ambientCount: number;
  smokeParticles: number;
  /** Samples along each edge curve. More is smoother and costs vertices. */
  edgeSegments: number;
  maxPixelRatio: number;
  bloom: boolean;
}

export const DESKTOP_QUALITY: QualityProfile = {
  nodesPerCluster: 46,
  ambientCount: 900,
  smokeParticles: 900,
  edgeSegments: 26,
  maxPixelRatio: 2,
  bloom: true,
};

/**
 * The mobile profile keeps the shape and drops the density. The Galaxy is a
 * primary device, not a fallback, so it must look like the same brain — fewer
 * neurons, same silhouette, same colours, same motion.
 */
export const MOBILE_QUALITY: QualityProfile = {
  nodesPerCluster: 22,
  ambientCount: 380,
  smokeParticles: 320,
  edgeSegments: 14,
  maxPixelRatio: 1.5,
  bloom: false,
};

export function pickQuality(width: number, isMobileAgent: boolean): QualityProfile {
  return isMobileAgent || width < 820 ? MOBILE_QUALITY : DESKTOP_QUALITY;
}

/** The live signals the scene reads each frame. Supplied by the React layer. */
export interface SceneSignals {
  /** Real analyser output from the audio that is playing. */
  audio: () => { rms: number; low: number; mid: number; high: number; transient: number };
  /** Microphone level while listening, 0..1. */
  micLevel: () => number;
  /** ZERO's server-reported state. */
  zeroState: () => string;
  /** Per-agent activity, 0..1, decaying from real events. */
  activity: () => Map<string, number>;
  /** Agent ids whose branch is stopped at a permission gate. */
  gated: () => Set<string>;
  /** Direction of energy per agent: 1 outbound, -1 returning. */
  flow: () => Map<string, number>;
  selected: () => string | null;
  reducedMotion: () => boolean;
}

export interface AgentVisual extends AgentSeed {
  /** Department accent, as a CSS colour string. */
  color: string;
  label: string;
  status: string;
}

export interface BrainScene {
  mount: HTMLElement;
  resize: () => void;
  dispose: () => void;
  setAgents: (agents: AgentVisual[]) => void;
  /** Screen-space label anchors, recomputed each frame for the DOM overlay. */
  labelPositions: () => Array<{ id: string; x: number; y: number; depth: number }>;
  pick: (clientX: number, clientY: number) => string | null;
  focus: (agentId: string | null) => void;
}

interface ClusterHandle {
  agentId: string;
  hubWorld: Vector3;
  /** Index range in the node instance buffer. */
  start: number;
  count: number;
  /** Index range in the edge attribute buffer. */
  edgeStart: number;
  edgeCount: number;
  gate: Mesh;
}

const TEMP_OBJECT = new Object3D();
const TEMP_VECTOR = new Vector3();

export function createBrainScene(
  mount: HTMLElement,
  signals: SceneSignals,
  quality: QualityProfile,
): BrainScene {
  const renderer = new WebGLRenderer({ antialias: quality.bloom, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  mount.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';

  const scene = new Scene();
  const camera = new PerspectiveCamera(46, 1, 0.1, 400);
  camera.position.set(0, 2.2, 23);

  const uniforms: AudioUniforms = createAudioUniforms();

  // ------------------------------------------------------------------ core
  const coreMaterial = createCoreMaterial(uniforms);
  const core = new Mesh(new IcosahedronGeometry(1, 5), coreMaterial);
  scene.add(core);

  // ------------------------------------------------------- dynamic contents
  const dynamic = new Group();
  scene.add(dynamic);

  const nodeMaterial = createNodeMaterial(uniforms);
  const edgeMaterial = createEdgeMaterial(uniforms);

  let layout: BrainLayout3D | null = null;
  let clusters: ClusterHandle[] = [];
  let nodeMesh: InstancedMesh | null = null;
  let nodeColors: InstancedBufferAttribute | null = null;
  let nodeActivity: InstancedBufferAttribute | null = null;
  let edgeGeometry: BufferGeometry | null = null;
  let edgeEnergy: BufferAttribute | null = null;
  let edgeDirection: BufferAttribute | null = null;
  let visuals: AgentVisual[] = [];

  // -------------------------------------------------------------- the smoke
  const smokeCount = quality.smokeParticles;
  const smokeGeometry = new BufferGeometry();
  const smokePositions = new Float32Array(smokeCount * 3);
  const smokeVelocity = new Float32Array(smokeCount * 3);
  const smokeBirth = new Float32Array(smokeCount);
  const smokeSeed = new Float32Array(smokeCount);
  for (let index = 0; index < smokeCount; index += 1) {
    smokeBirth[index] = -1000;
    smokeSeed[index] = hashUnit(`smoke:${index}`);
  }
  smokeGeometry.setAttribute('position', new BufferAttribute(smokePositions, 3).setUsage(DynamicDrawUsage));
  smokeGeometry.setAttribute('aVelocity', new BufferAttribute(smokeVelocity, 3).setUsage(DynamicDrawUsage));
  smokeGeometry.setAttribute('aBirth', new BufferAttribute(smokeBirth, 1).setUsage(DynamicDrawUsage));
  smokeGeometry.setAttribute('aSeed', new BufferAttribute(smokeSeed, 1));
  const smokeMaterial = createSmokeMaterial(uniforms);
  const smoke = new Points(smokeGeometry, smokeMaterial);
  smoke.frustumCulled = false;
  scene.add(smoke);
  let smokeCursor = 0;

  // ------------------------------------------------------------ build/rebuild

  function disposeDynamic(): void {
    for (const child of [...dynamic.children]) {
      dynamic.remove(child);
      const mesh = child as Mesh;
      mesh.geometry?.dispose();
    }
    nodeMesh = null;
    edgeGeometry?.dispose();
    edgeGeometry = null;
    clusters = [];
  }

  function setAgents(next: AgentVisual[]): void {
    visuals = next;
    disposeDynamic();

    layout = buildBrainLayout(
      next.map((agent) => ({ id: agent.id, department: agent.department, weight: agent.weight })),
      { nodesPerCluster: quality.nodesPerCluster, ambientCount: quality.ambientCount },
    );

    const colorByAgent = new Map(next.map((agent) => [agent.id, new Color(agent.color)]));
    const ambientColor = new Color('#8892b8');

    // ---- nodes: one instanced draw for the whole brain --------------------
    const totalNodes =
      layout.clusters.reduce((sum, cluster) => sum + cluster.nodes.length, 0) +
      layout.ambient.length;

    const geometry = new PlaneGeometry(1, 1);
    nodeMesh = new InstancedMesh(geometry, nodeMaterial, totalNodes);
    nodeMesh.frustumCulled = false;

    const colors = new Float32Array(totalNodes * 3);
    const activity = new Float32Array(totalNodes);
    const seeds = new Float32Array(totalNodes);
    const scales = new Float32Array(totalNodes);

    let cursor = 0;
    for (const cluster of layout.clusters) {
      const color = colorByAgent.get(cluster.agentId) ?? ambientColor;
      const start = cursor;
      for (const node of cluster.nodes) {
        TEMP_OBJECT.position.set(node.position.x, node.position.y, node.position.z);
        TEMP_OBJECT.updateMatrix();
        nodeMesh.setMatrixAt(cursor, TEMP_OBJECT.matrix);
        colors[cursor * 3] = color.r;
        colors[cursor * 3 + 1] = color.g;
        colors[cursor * 3 + 2] = color.b;
        seeds[cursor] = hashUnit(node.id);
        // The hub is the agent; its filaments are smaller.
        scales[cursor] = node.rank === 0 ? node.size * 2.6 : node.size * 1.6;
        cursor += 1;
      }
      clusters.push({
        agentId: cluster.agentId,
        hubWorld: new Vector3(cluster.hub.x, cluster.hub.y, cluster.hub.z),
        start,
        count: cursor - start,
        edgeStart: 0,
        edgeCount: 0,
        gate: buildGate(cluster.hub),
      });
    }

    for (const point of layout.ambient) {
      TEMP_OBJECT.position.set(point.x, point.y, point.z);
      TEMP_OBJECT.updateMatrix();
      nodeMesh.setMatrixAt(cursor, TEMP_OBJECT.matrix);
      colors[cursor * 3] = ambientColor.r * 0.85;
      colors[cursor * 3 + 1] = ambientColor.g * 0.9;
      colors[cursor * 3 + 2] = ambientColor.b * 1.0;
      seeds[cursor] = hashUnit(`ambient:${cursor}`);
      scales[cursor] = 0.10 + hashUnit(`ambient:s:${cursor}`) * 0.10;
      cursor += 1;
    }

    nodeColors = new InstancedBufferAttribute(colors, 3);
    nodeActivity = new InstancedBufferAttribute(activity, 1).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    geometry.setAttribute('aColor', nodeColors);
    geometry.setAttribute('aActivity', nodeActivity);
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    geometry.setAttribute('aScale', new InstancedBufferAttribute(scales, 1));
    nodeMesh.instanceMatrix.needsUpdate = true;
    dynamic.add(nodeMesh);

    // ---- edges -----------------------------------------------------------
    buildEdges(layout, colorByAgent, ambientColor);

    for (const handle of clusters) dynamic.add(handle.gate);
  }

  function buildGate(hub: Vec3): Mesh {
    // The permission gate: a ring on the ZERO→agent path, invisible until the
    // server actually raises an approval.
    const gate = new Mesh(
      new RingGeometry(0.55, 0.78, 40),
      new MeshBasicMaterial({
        color: new Color('#ffb45a'),
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    const midpoint = new Vector3(hub.x, hub.y, hub.z).multiplyScalar(0.55);
    gate.position.copy(midpoint);
    gate.visible = false;
    return gate;
  }

  function buildEdges(
    built: BrainLayout3D,
    colorByAgent: Map<string, Color>,
    ambientColor: Color,
  ): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const energy: number[] = [];
    const direction: number[] = [];
    const along: number[] = [];
    const seeds: number[] = [];

    const push = (
      from: Vec3,
      to: Vec3,
      color: Color,
      bulge: number,
      seed: number,
      clusterIndex: number,
    ): void => {
      const curve = new QuadraticBezierCurve3(
        new Vector3(from.x, from.y, from.z),
        new Vector3(
          (from.x + to.x) / 2 + bulge * BRAIN_SCALE * 0.14,
          (from.y + to.y) / 2 + bulge * BRAIN_SCALE * 0.2,
          (from.z + to.z) / 2 + bulge * BRAIN_SCALE * 0.1,
        ),
        new Vector3(to.x, to.y, to.z),
      );
      const points = curve.getPoints(quality.edgeSegments);
      for (let index = 0; index < points.length - 1; index += 1) {
        const a = points[index];
        const b = points[index + 1];
        if (!a || !b) continue;
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        energy.push(0, 0);
        direction.push(1, 1);
        along.push(index / points.length, (index + 1) / points.length);
        seeds.push(seed, seed);
        void clusterIndex;
      }
    };

    // ZERO → each agent hub: the trunk lines.
    built.clusters.forEach((cluster, clusterIndex) => {
      const color = colorByAgent.get(cluster.agentId) ?? ambientColor;
      const handle = clusters[clusterIndex];
      const edgeStart = energy.length;
      push(built.core, cluster.hub, color, 0.5, hashUnit(cluster.agentId), clusterIndex);
      // and the cluster's own filaments
      for (const [fromIndex, toIndex] of cluster.links) {
        const from = cluster.nodes[fromIndex];
        const to = cluster.nodes[toIndex];
        if (!from || !to) continue;
        push(
          from.position,
          to.position,
          color,
          0.12,
          hashUnit(`${cluster.agentId}:${fromIndex}:${toIndex}`),
          clusterIndex,
        );
      }
      if (handle) {
        handle.edgeStart = edgeStart;
        handle.edgeCount = energy.length - edgeStart;
      }
    });

    // Long ambient axons — structure, never activity. Deliberately dim: at full
    // brightness they read as a wireframe cage across the viewport and the
    // agent clusters stop being the subject of the picture.
    const axonColor = ambientColor.clone().multiplyScalar(0.16);
    for (const axon of built.axons) {
      push(axon.from, axon.to, axonColor, axon.bulge, hashUnit(`${axon.from.x}:${axon.to.y}`), -1);
    }

    edgeGeometry = new BufferGeometry();
    edgeGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    edgeGeometry.setAttribute('aColor', new BufferAttribute(new Float32Array(colors), 3));
    edgeEnergy = new BufferAttribute(new Float32Array(energy), 1).setUsage(DynamicDrawUsage) as BufferAttribute;
    edgeDirection = new BufferAttribute(new Float32Array(direction), 1).setUsage(DynamicDrawUsage) as BufferAttribute;
    edgeGeometry.setAttribute('aEnergy', edgeEnergy);
    edgeGeometry.setAttribute('aDirection', edgeDirection);
    edgeGeometry.setAttribute('aAlong', new BufferAttribute(new Float32Array(along), 1));
    edgeGeometry.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds), 1));

    const lines = new LineSegments(edgeGeometry, edgeMaterial);
    lines.frustumCulled = false;
    dynamic.add(lines);
  }

  // ------------------------------------------------------------------ camera

  const orbit = { theta: 0, phi: 0.12, radius: 23, targetRadius: 23 };
  const focusTarget = new Vector3(0, 0, 0);
  const cameraTarget = new Vector3(0, 0, 0);

  function focus(agentId: string | null): void {
    const handle = clusters.find((entry) => entry.agentId === agentId);
    if (handle) {
      focusTarget.copy(handle.hubWorld);
      orbit.targetRadius = 15;
    } else {
      focusTarget.set(0, 0, 0);
      orbit.targetRadius = 23;
    }
  }

  // ------------------------------------------------------------------ picking

  const raycaster = new Raycaster();
  const pointer = new Vector2();

  function pick(clientX: number, clientY: number): string | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // Hubs are picked by proximity to the ray rather than by mesh intersection:
    // the nodes are billboarded in the vertex shader, so their CPU-side geometry
    // does not describe where they actually appear.
    let best: { id: string; distance: number } | null = null;
    for (const handle of clusters) {
      const distance = raycaster.ray.distanceToPoint(handle.hubWorld);
      if (distance < 1.6 && (best === null || distance < best.distance)) {
        best = { id: handle.agentId, distance };
      }
    }
    if (best) return best.id;
    return raycaster.ray.distanceToPoint(new Vector3(0, 0, 0)) < 2.4 ? 'zero' : null;
  }

  function labelPositions(): Array<{ id: string; x: number; y: number; depth: number }> {
    const rect = renderer.domElement.getBoundingClientRect();
    const out: Array<{ id: string; x: number; y: number; depth: number }> = [];
    for (const handle of clusters) {
      TEMP_VECTOR.copy(handle.hubWorld).project(camera);
      if (TEMP_VECTOR.z > 1) continue;
      out.push({
        id: handle.agentId,
        x: (TEMP_VECTOR.x * 0.5 + 0.5) * rect.width,
        y: (-TEMP_VECTOR.y * 0.5 + 0.5) * rect.height,
        depth: TEMP_VECTOR.z,
      });
    }
    return out;
  }

  // --------------------------------------------------------------- animation

  let running = true;
  let previous = performance.now();
  let elapsed = 0;
  let smokeEmission = 0;

  function emitSmoke(count: number, now: number): void {
    for (let index = 0; index < count; index += 1) {
      const slot = smokeCursor % smokeCount;
      smokeCursor += 1;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 1.35;
      smokePositions[slot * 3] = Math.sin(phi) * Math.cos(theta) * radius;
      smokePositions[slot * 3 + 1] = Math.cos(phi) * radius * 0.7;
      smokePositions[slot * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;
      const speed = 0.35 + Math.random() * 0.5;
      smokeVelocity[slot * 3] = Math.sin(phi) * Math.cos(theta) * speed * 0.6;
      smokeVelocity[slot * 3 + 1] = 0.35 + Math.random() * 0.5;
      smokeVelocity[slot * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed * 0.6;
      smokeBirth[slot] = now;
    }
    smokeGeometry.attributes.position!.needsUpdate = true;
    smokeGeometry.attributes.aVelocity!.needsUpdate = true;
    smokeGeometry.attributes.aBirth!.needsUpdate = true;
  }

  function frame(): void {
    if (!running) return;
    const now = performance.now();
    const delta = Math.min(0.1, (now - previous) / 1000);
    previous = now;
    elapsed += delta;

    const audio = signals.audio();
    const state = signals.zeroState();
    const reduced = signals.reducedMotion();
    const listening = state === 'LISTENING';
    const speaking = state === 'SPEAKING';

    uniforms.uTime.value = elapsed;
    // While listening there is no output audio; the microphone drives the core
    // instead, so the brain reacts to the operator's own voice.
    uniforms.uRms.value = listening ? signals.micLevel() * 0.8 : audio.rms;
    uniforms.uLow.value = listening ? signals.micLevel() * 0.6 : audio.low;
    uniforms.uMid.value = audio.mid;
    uniforms.uHigh.value = audio.high;
    uniforms.uTransient.value = audio.transient;

    const coreUniforms = coreMaterial.uniforms as Record<string, { value: number }>;
    coreUniforms.uActivity!.value =
      state === 'THINKING' || state === 'PLANNING' || state === 'EXECUTING' ? 0.65 : 0.15;
    (nodeMaterial.uniforms as Record<string, { value: number }>).uReducedMotion!.value = reduced ? 1 : 0;
    (edgeMaterial.uniforms as Record<string, { value: number }>).uReducedMotion!.value = reduced ? 1 : 0;

    // --- activity → node and edge attributes ------------------------------
    const activityMap = signals.activity();
    const flowMap = signals.flow();
    const gatedSet = signals.gated();

    if (nodeActivity && edgeEnergy && edgeDirection) {
      const nodeArray = nodeActivity.array as Float32Array;
      const energyArray = edgeEnergy.array as Float32Array;
      const directionArray = edgeDirection.array as Float32Array;

      for (const handle of clusters) {
        const level = activityMap.get(handle.agentId) ?? 0;
        const direction = flowMap.get(handle.agentId) ?? 1;
        for (let index = handle.start; index < handle.start + handle.count; index += 1) {
          nodeArray[index] = level;
        }
        for (let index = handle.edgeStart; index < handle.edgeStart + handle.edgeCount; index += 1) {
          energyArray[index] = level;
          directionArray[index] = direction;
        }

        // The gate: visible exactly while the server holds this branch.
        const isGated = gatedSet.has(handle.agentId);
        handle.gate.visible = isGated;
        const gateMaterial = handle.gate.material as MeshBasicMaterial;
        gateMaterial.opacity = isGated ? 0.55 + Math.sin(elapsed * 3.2) * 0.25 : 0;
        handle.gate.lookAt(camera.position);
      }
      nodeActivity.needsUpdate = true;
      edgeEnergy.needsUpdate = true;
      edgeDirection.needsUpdate = true;
    }

    // --- smoke -------------------------------------------------------------
    const targetEmission = speaking ? 0.35 + audio.rms * 1.6 + audio.low * 0.9 : 0;
    // Asymmetric: the plume swells quickly and falls back slowly, which is what
    // makes a pause in speech read as a pause rather than as a cut.
    smokeEmission += (targetEmission - smokeEmission) * (targetEmission > smokeEmission ? 0.35 : 0.04);
    (smokeMaterial.uniforms as Record<string, { value: number }>).uEmission!.value = smokeEmission;
    if (smokeEmission > 0.02 && !reduced) {
      emitSmoke(Math.round(smokeEmission * (quality.smokeParticles / 90)), elapsed);
    }

    // --- camera ------------------------------------------------------------
    orbit.radius += (orbit.targetRadius - orbit.radius) * 0.06;
    cameraTarget.lerp(focusTarget, 0.07);
    // A slow drift so the scene is never dead, suppressed under reduced motion
    // and while the operator is dragging.
    const drift = reduced || dragging ? 0 : Math.sin(elapsed * 0.07) * 0.06;
    const theta = orbit.theta + drift;
    camera.position.set(
      cameraTarget.x + Math.sin(theta) * Math.cos(orbit.phi) * orbit.radius,
      cameraTarget.y + Math.sin(orbit.phi) * orbit.radius,
      cameraTarget.z + Math.cos(theta) * Math.cos(orbit.phi) * orbit.radius,
    );
    camera.lookAt(cameraTarget);

    core.scale.setScalar(1.55);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------- interaction

  let dragging = false;
  let lastPointer: { x: number; y: number } | null = null;
  let pinchDistance = 0;

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    renderer.domElement.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || !lastPointer) return;
    orbit.theta -= (event.clientX - lastPointer.x) * 0.005;
    orbit.phi = Math.max(-1.2, Math.min(1.2, orbit.phi + (event.clientY - lastPointer.y) * 0.004));
    lastPointer = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    lastPointer = null;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    orbit.targetRadius = Math.max(8, Math.min(60, orbit.targetRadius + event.deltaY * 0.02));
  };
  const onTouchMove = (event: TouchEvent): void => {
    if (event.touches.length !== 2) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    if (!a || !b) return;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinchDistance > 0) {
      orbit.targetRadius = Math.max(8, Math.min(60, orbit.targetRadius - (distance - pinchDistance) * 0.06));
    }
    pinchDistance = distance;
  };
  const onTouchEnd = (): void => {
    pinchDistance = 0;
  };

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: true });
  renderer.domElement.addEventListener('touchend', onTouchEnd);

  function resize(): void {
    const width = mount.clientWidth || 1;
    const height = mount.clientHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio);
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    (smokeMaterial.uniforms as Record<string, { value: number }>).uPixelRatio!.value = ratio;
  }

  resize();
  requestAnimationFrame(frame);

  function dispose(): void {
    running = false;
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointercancel', onPointerUp);
    renderer.domElement.removeEventListener('wheel', onWheel);
    renderer.domElement.removeEventListener('touchmove', onTouchMove);
    renderer.domElement.removeEventListener('touchend', onTouchEnd);
    disposeDynamic();
    smokeGeometry.dispose();
    core.geometry.dispose();
    coreMaterial.dispose();
    nodeMaterial.dispose();
    edgeMaterial.dispose();
    smokeMaterial.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  void visuals;

  return { mount, resize, dispose, setAgents, labelPositions, pick, focus };
}
