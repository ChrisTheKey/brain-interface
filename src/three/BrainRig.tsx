/**
 * The rig: how the brain is looked at.
 *
 * One finger (or the mouse) turns it, two fingers (or the wheel) push in and
 * out. When nobody has touched it for a while it resumes a very slow drift, so
 * the brain is never a still image. All of it happens on refs — the camera and
 * the group are mutated in the render loop, never through React state.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { MathUtils, type Group, type PerspectiveCamera } from 'three';
import { BRAIN_EXTENT } from '../brain/layout3d';

/**
 * The camera's field of view and how far it may ever pull back. The background
 * plate is sized from these, so it covers the frame at every zoom level.
 */
export const CAMERA_FOV = 42;
export const MAX_CAMERA_DISTANCE = 7;
export const DEFAULT_CAMERA_DISTANCE = 4;

/**
 * How the brain is fitted into a given frame.
 *
 * The camera stays where it is and the brain is scaled instead — pulling the
 * camera back on a phone held upright would put it so far away that ZERO
 * stopped being the dominant node.
 *
 * Two deliberate choices for a tall screen: the outer clusters are allowed to
 * bleed past the left and right edges (a brain that reaches past the frame
 * reads better than one floating in the middle of it), and the whole thing is
 * lifted above the bottom HUD, so an open approval gate never covers ZERO.
 */
export function fitBrain(
  width: number,
  height: number,
  distance = DEFAULT_CAMERA_DISTANCE,
): { scale: number; offsetY: number } {
  const halfHeight = Math.tan((CAMERA_FOV * Math.PI) / 360) * distance;
  const aspect = width / Math.max(1, height);
  const halfWidth = halfHeight * aspect;
  const portrait = aspect < 1;
  const vertical = (halfHeight * 0.95) / BRAIN_EXTENT;
  const horizontal = (halfWidth * (portrait ? 1.5 : 1.18)) / BRAIN_EXTENT;
  return {
    // Never above 1: magnifying the brain is what pushes the outer ring off
    // the frame, which is the one thing this function exists to prevent.
    scale: MathUtils.clamp(Math.min(vertical, horizontal), 0.42, 1),
    // A sixth of the viewport upward. Balanced against both cases: with the
    // bottom HUD at its usual height the brain still sits centred in the space
    // it has, and with an approval gate open ZERO is not buried behind it.
    offsetY: portrait ? halfHeight * 0.32 : 0,
  };
}

export interface BrainRigProps {
  children: ReactNode;
  /** Seconds of no interaction before the drift resumes. */
  idleAfter?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Slowed down for `prefers-reduced-motion`. */
  driftSpeed?: number;
}

export function BrainRig({
  children,
  idleAfter = 3,
  minDistance = 2.2,
  maxDistance = MAX_CAMERA_DISTANCE,
  driftSpeed = 0.045,
}: BrainRigProps): React.JSX.Element {
  const group = useRef<Group>(null);
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera) as PerspectiveCamera;

  const target = useRef({
    yaw: 0.5,
    pitch: 0.18,
    distance: DEFAULT_CAMERA_DISTANCE,
    scale: 1,
    offsetY: 0,
  });
  const current = useRef({
    yaw: 0.5,
    pitch: 0.18,
    distance: DEFAULT_CAMERA_DISTANCE,
    scale: 0.6,
    offsetY: 0,
  });
  const idle = useRef(0);

  useEffect(() => {
    const element = gl.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;

    const down = (event: PointerEvent): void => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      idle.current = 0;
      if (pointers.size === 2) pinchDistance = spread(pointers);
      element.setPointerCapture?.(event.pointerId);
    };

    const move = (event: PointerEvent): void => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      idle.current = 0;

      if (pointers.size >= 2) {
        const next = spread(pointers);
        if (pinchDistance > 0 && next > 0) {
          target.current.distance = MathUtils.clamp(
            target.current.distance * (pinchDistance / next),
            minDistance,
            maxDistance,
          );
        }
        pinchDistance = next;
        return;
      }

      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      target.current.yaw -= dx * 0.005;
      // Never let the brain flip over: the core has an up.
      target.current.pitch = MathUtils.clamp(target.current.pitch - dy * 0.004, -0.85, 0.85);
    };

    const up = (event: PointerEvent): void => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
      element.releasePointerCapture?.(event.pointerId);
    };

    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      idle.current = 0;
      target.current.distance = MathUtils.clamp(
        target.current.distance * (1 + Math.sign(event.deltaY) * 0.1),
        minDistance,
        maxDistance,
      );
    };

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('wheel', wheel);
    };
  }, [gl, minDistance, maxDistance]);

  // A narrow viewport shrinks the brain rather than pushing the camera away,
  // so ZERO stays the dominant node on a phone held upright.
  const size = useThree((state) => state.size);
  useEffect(() => {
    const fit = fitBrain(size.width, size.height);
    target.current.scale = fit.scale;
    target.current.offsetY = fit.offsetY;
  }, [size]);

  useFrame((_, delta) => {
    const dt = Math.min(0.1, delta);
    idle.current += dt;
    if (idle.current > idleAfter) target.current.yaw += driftSpeed * dt;

    const smoothing = Math.min(1, dt * 5);
    current.current.yaw += (target.current.yaw - current.current.yaw) * smoothing;
    current.current.pitch += (target.current.pitch - current.current.pitch) * smoothing;
    current.current.distance += (target.current.distance - current.current.distance) * smoothing;
    current.current.scale += (target.current.scale - current.current.scale) * smoothing;
    current.current.offsetY += (target.current.offsetY - current.current.offsetY) * smoothing;

    if (group.current) {
      group.current.rotation.y = current.current.yaw;
      group.current.rotation.x = current.current.pitch;
      group.current.position.y = current.current.offsetY;
      // The brain settles into the frame on load instead of popping into it.
      group.current.scale.setScalar(current.current.scale);
    }
    camera.position.set(0, 0, current.current.distance);
    camera.lookAt(0, 0, 0);
  });

  return <group ref={group}>{children}</group>;
}

function spread(pointers: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}
