/**
 * Folds `/ws/events` into "what is each agent doing right now".
 *
 * This is the only place that decides whether an agent node lights up. Every
 * rule below is a rule about a real event HWD-ZERO emitted — the brain never
 * animates an agent because a mission is running somewhere, only because that
 * agent was actually reported as started, active, finished or failed.
 *
 * Pure, and folded from oldest to newest, so replay after a reconnect lands on
 * the same result as the live stream.
 */
import type { BrainRuntime } from '../brain/build';
import type { OperatorApproval, OperatorEvent } from '../hwd/types';

export interface AgentRuntimeFold extends BrainRuntime {
  activeAgentIds: string[];
  erroredAgentIds: string[];
  blockedAgentIds: string[];
  agentActivity: Map<string, { label: string; missionId?: string; at: number }>;
}

/** A short human label for what the operator said the agent is doing. */
export function activityLabel(event: OperatorEvent): string {
  const payload = event.payload ?? {};
  for (const key of ['action', 'step', 'label', 'summary', 'objective', 'message', 'detail']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return event.type.replace(/^agent\./, '');
}

export function foldAgentRuntime(
  events: readonly OperatorEvent[],
  approvals: readonly OperatorApproval[] = [],
  knownAgentIds?: readonly string[],
): AgentRuntimeFold {
  const active = new Set<string>();
  const errored = new Set<string>();
  const activity = new Map<string, { label: string; missionId?: string; at: number }>();
  /** agent id → mission it is attached to, so a finished mission clears it. */
  const missionOf = new Map<string, string>();

  const clearMission = (missionId: string): void => {
    if (!missionId) return;
    for (const [agentId, mission] of missionOf) {
      if (mission !== missionId) continue;
      active.delete(agentId);
      missionOf.delete(agentId);
    }
  };

  for (const event of events) {
    const agentId = event.agent_id;
    const at = Date.parse(event.timestamp) || 0;

    switch (event.type) {
      case 'agent.started':
      case 'agent.activity': {
        if (!agentId) break;
        active.add(agentId);
        errored.delete(agentId);
        if (event.mission_id) missionOf.set(agentId, event.mission_id);
        activity.set(agentId, {
          label: activityLabel(event),
          ...(event.mission_id ? { missionId: event.mission_id } : {}),
          at,
        });
        break;
      }
      case 'agent.completed': {
        if (!agentId) break;
        active.delete(agentId);
        missionOf.delete(agentId);
        activity.set(agentId, {
          label: activityLabel(event),
          ...(event.mission_id ? { missionId: event.mission_id } : {}),
          at,
        });
        break;
      }
      case 'agent.error': {
        if (!agentId) break;
        active.delete(agentId);
        missionOf.delete(agentId);
        errored.add(agentId);
        activity.set(agentId, {
          label: activityLabel(event),
          ...(event.mission_id ? { missionId: event.mission_id } : {}),
          at,
        });
        break;
      }
      case 'mission.completed':
      case 'mission.failed':
        // A mission that ended cannot leave its agents running, even if the
        // per-agent completion event was lost while the phone slept.
        clearMission(event.mission_id);
        break;
      default:
        break;
    }
  }

  // A gate blocks the executor named on it — that is the agent a human is
  // holding up, and it is the one that must read as "blocked" in the brain.
  const known = knownAgentIds ? new Set(knownAgentIds) : null;
  const blocked = new Set<string>();
  for (const approval of approvals) {
    const executor = approval.executor?.trim();
    if (!executor) continue;
    if (known && !known.has(executor)) continue;
    blocked.add(executor);
    active.delete(executor);
  }

  return {
    activeAgentIds: [...active],
    erroredAgentIds: [...errored],
    blockedAgentIds: [...blocked],
    agentActivity: activity,
  };
}
