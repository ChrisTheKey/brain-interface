/**
 * The brain, as a real WebGL scene.
 *
 * This component owns the lifecycle and nothing else: it builds the scene once,
 * hands it *getter functions* for every live signal, and then never re-renders
 * for animation. React state changing sixty times a second would be the single
 * most expensive thing in the app; the render loop reads the current values
 * through refs instead.
 *
 * The labels are DOM rather than sprites — crisp at any zoom, screen-readable,
 * and free of a texture atlas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBrainScene,
  pickQuality,
  type AgentVisual,
  type BrainScene,
} from '../render3d/scene';
import { DEPARTMENT_COLORS, type Department } from '../zero/agentPolicy';
import type { AgentHealth, OperatorAgent, ZeroState } from '../hwd/types';

export interface BrainStage3DProps {
  agents: OperatorAgent[];
  zeroState: ZeroState;
  /** Per-agent activity 0..1, decayed from real ZERO events. */
  activityRef: React.RefObject<Map<string, number>>;
  /** Agents whose branch the server is holding at a permission gate. */
  gatedRef: React.RefObject<Set<string>>;
  /** 1 while an agent is being dispatched to, -1 while its result returns. */
  flowRef: React.RefObject<Map<string, number>>;
  /** Real analyser output for the audio that is playing. */
  audio: () => { rms: number; low: number; mid: number; high: number; transient: number };
  micLevel: () => number;
  selectedId: string | null;
  onSelect: (agentId: string | null) => void;
}

/** A dead branch is thinner, not absent: the agent still exists. */
function weightFor(health: AgentHealth): number {
  if (health === 'HEALTHY') return 1;
  if (health === 'DEGRADED') return 0.7;
  return 0.45;
}

function statusLabel(agent: OperatorAgent): string {
  if (agent.health === 'OFFLINE') return 'OFFLINE';
  if (agent.status === 'RUNNING') return 'RUNNING';
  if (agent.status === 'AWAITING_APPROVAL') return 'GATE';
  return agent.status;
}

export function BrainStage3D({
  agents,
  zeroState,
  activityRef,
  gatedRef,
  flowRef,
  audio,
  micLevel,
  selectedId,
  onSelect,
}: BrainStage3DProps): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<BrainScene | null>(null);
  const [labels, setLabels] = useState<Array<{ id: string; x: number; y: number }>>([]);

  // Every signal the render loop reads goes through a ref, so a state change
  // never restarts the scene.
  const zeroStateRef = useRef(zeroState);
  const selectedRef = useRef(selectedId);
  const audioRef = useRef(audio);
  const micRef = useRef(micLevel);
  useEffect(() => {
    zeroStateRef.current = zeroState;
  }, [zeroState]);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    audioRef.current = audio;
    micRef.current = micLevel;
  }, [audio, micLevel]);

  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );

  const visuals = useMemo<AgentVisual[]>(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        department: agent.department,
        color: DEPARTMENT_COLORS[agent.department as Department] ?? 'rgba(200,205,225,1)',
        label: agent.display_name,
        status: statusLabel(agent),
        weight: weightFor(agent.health),
      })),
    [agents],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const isMobile =
      typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const quality = pickQuality(mount.clientWidth || window.innerWidth, isMobile);

    let scene: BrainScene;
    try {
      scene = createBrainScene(
        mount,
        {
          audio: () => audioRef.current(),
          micLevel: () => micRef.current(),
          zeroState: () => zeroStateRef.current,
          activity: () => activityRef.current ?? new Map(),
          gated: () => gatedRef.current ?? new Set(),
          flow: () => flowRef.current ?? new Map(),
          selected: () => selectedRef.current,
          reducedMotion: () => reducedMotion.current,
        },
        quality,
      );
    } catch (error) {
      // A device without WebGL gets the panels and the voice loop rather than a
      // blank page. ZERO is still fully operable without the picture.
      console.warn('WebGL unavailable; the brain will not render', error);
      return undefined;
    }
    sceneRef.current = scene;

    const onResize = (): void => scene.resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    // Labels follow the projected hubs, at a rate the DOM can absorb.
    const labelTimer = setInterval(() => {
      setLabels(scene.labelPositions().map(({ id, x, y }) => ({ id, x, y })));
    }, 100);

    return () => {
      clearInterval(labelTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [activityRef, gatedRef, flowRef]);

  useEffect(() => {
    sceneRef.current?.setAgents(visuals);
  }, [visuals]);

  useEffect(() => {
    sceneRef.current?.focus(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onSelect(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const hit = sceneRef.current?.pick(event.clientX, event.clientY) ?? null;
      onSelect(hit === 'zero' ? null : hit);
    },
    [onSelect],
  );

  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  return (
    <div className="brain-stage" ref={mountRef} onClick={handleClick}>
      <div className="brain-labels" aria-live="off">
        {labels.map((label) => {
          const agent = byId.get(label.id);
          if (!agent) return null;
          const color = DEPARTMENT_COLORS[agent.department as Department];
          return (
            <span
              key={label.id}
              className={`brain-label${selectedId === label.id ? ' brain-label-selected' : ''}`}
              style={{
                transform: `translate3d(${label.x}px, ${label.y}px, 0)`,
                borderColor: color,
              }}
            >
              <b>{agent.display_name.toUpperCase()}</b>
              <i style={{ color }}>{statusLabel(agent)}</i>
            </span>
          );
        })}
      </div>
    </div>
  );
}
