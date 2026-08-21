/**
 * Turning ZERO's event stream into what the brain draws.
 *
 * The rule this hook exists to enforce: an agent glows because ZERO said it
 * started, and stops glowing because ZERO said it finished or because enough
 * time passed with no word from it. Nothing here invents activity, and nothing
 * animates on a timer that is not anchored to a real event.
 *
 * The values live in refs rather than state. The render loop reads them sixty
 * times a second; putting them in React state would re-render the whole tree at
 * frame rate for no benefit — the canvas is not made of components.
 */
import { useEffect, useRef } from 'react';
import type { OperatorEvent } from '../hwd/types';

/** How long an agent keeps glowing after its last sign of life. */
const DECAY_SECONDS = 2.6;
/** Below this, an agent is treated as idle and dropped from the map. */
const FLOOR = 0.02;

export interface ActivitySignals {
  activityRef: React.RefObject<Map<string, number>>;
  gatedRef: React.RefObject<Set<string>>;
  flowRef: React.RefObject<Map<string, number>>;
}

interface Tracked {
  level: number;
  /** Set while the agent is running; the level holds instead of decaying. */
  sustained: boolean;
  updatedAt: number;
}

export function useAgentActivity(events: OperatorEvent[]): ActivitySignals {
  const activityRef = useRef<Map<string, number>>(new Map());
  const gatedRef = useRef<Set<string>>(new Set());
  const flowRef = useRef<Map<string, number>>(new Map());
  const tracked = useRef<Map<string, Tracked>>(new Map());
  const consumed = useRef<Set<string>>(new Set());

  useEffect(() => {
    const now = performance.now() / 1000;

    for (const event of events) {
      if (consumed.current.has(event.event_id)) continue;
      consumed.current.add(event.event_id);

      const agentId = event.agent_id;
      const mark = (level: number, sustained: boolean): void => {
        if (!agentId) return;
        tracked.current.set(agentId, { level, sustained, updatedAt: now });
      };

      switch (event.type) {
        case 'agent.started':
          mark(1, true);
          flowRef.current.set(agentId, 1);
          gatedRef.current.delete(agentId);
          break;
        case 'agent.activity':
          mark(0.85, true);
          break;
        case 'agent.completed':
          // The result travelling back to ZERO: same branch, opposite direction.
          mark(0.9, false);
          flowRef.current.set(agentId, -1);
          gatedRef.current.delete(agentId);
          break;
        case 'agent.error':
          mark(0.75, false);
          flowRef.current.set(agentId, -1);
          break;
        case 'approval.required':
          if (agentId) gatedRef.current.add(agentId);
          mark(0.5, true);
          break;
        case 'approval.approved':
          gatedRef.current.delete(agentId);
          mark(1, true);
          flowRef.current.set(agentId, 1);
          break;
        case 'approval.denied':
          // Denied energy runs back to the core rather than through the gate.
          gatedRef.current.delete(agentId);
          mark(0.6, false);
          flowRef.current.set(agentId, -1);
          break;
        case 'mission.planning': {
          // Planning briefly lights every candidate branch — the moment ZERO is
          // weighing which agents to use, made visible.
          const agents = event.payload.agents;
          if (Array.isArray(agents)) {
            for (const candidate of agents) {
              if (typeof candidate !== 'string') continue;
              tracked.current.set(candidate, {
                level: 0.45,
                sustained: false,
                updatedAt: now,
              });
              flowRef.current.set(candidate, 1);
            }
          }
          break;
        }
        case 'mission.completed':
        case 'mission.failed':
          // The mission is over: nothing on this mission stays lit.
          for (const entry of tracked.current.values()) entry.sustained = false;
          gatedRef.current.clear();
          break;
        default:
          break;
      }
    }

    // Bound the dedup set so a long session cannot grow it without limit.
    if (consumed.current.size > 2000) {
      consumed.current = new Set([...consumed.current].slice(-500));
    }
  }, [events]);

  // Decay runs on its own clock rather than on React's, so an agent that stops
  // reporting fades out even if no new event ever arrives.
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const now = performance.now() / 1000;
      const next = new Map<string, number>();
      for (const [agentId, entry] of tracked.current) {
        const age = now - entry.updatedAt;
        // A sustained agent holds a floor until something says it stopped; a
        // finished one falls away.
        const level = entry.sustained
          ? Math.max(0.55, entry.level * Math.exp(-age / (DECAY_SECONDS * 4)))
          : entry.level * Math.exp(-age / DECAY_SECONDS);
        if (level < FLOOR) {
          tracked.current.delete(agentId);
          flowRef.current.delete(agentId);
          continue;
        }
        next.set(agentId, level);
      }
      activityRef.current = next;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return { activityRef, gatedRef, flowRef };
}
