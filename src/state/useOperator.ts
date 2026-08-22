import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OperatorError } from '../hwd/client';
import type { HwdZeroClient } from '../hwd/client';
import type {
  GatewayHealth,
  OperatorApproval,
  OperatorConnection,
  OperatorEvent,
  OperatorMission,
  OperatorRegistry,
  OperatorState,
  OperatorTask,
} from '../hwd/types';
import { foldAgentRuntime, type AgentRuntimeFold } from '../runtime/agentActivity';
import { foldMissionPhase, type MissionPhase } from '../runtime/states';

/**
 * HWD-ZERO's live state, as the interface sees it.
 *
 * Two sources, on purpose. The event stream is what makes the brain move —
 * it is pushed, immediate, and driven by mission journals. The periodic read
 * is the correction: after a reconnect, or a mission the phone slept through,
 * the lists come from the operator rather than from replayed events. Nothing
 * here derives state the operator did not report, and nothing here decides:
 * every write is a request the operator is free to refuse.
 */

export const OPERATOR_EVENT_LIMIT = 200;

export interface OperatorView {
  connection: OperatorConnection;
  error: string;
  state: OperatorState | null;
  registry: OperatorRegistry | null;
  missions: OperatorMission[];
  approvals: OperatorApproval[];
  tasks: OperatorTask[];
  events: OperatorEvent[];
  /** Which agents are running, blocked or failing — folded from the stream. */
  agentRuntime: AgentRuntimeFold;
  /** Newest mission lifecycle phase seen on the stream. */
  missionPhase: MissionPhase | null;
  /** A runtime state HWD-ZERO reported itself, if it does. */
  reportedState: string | null;
  /** The gateway's own view: it answers even when HWD-ZERO does not. */
  gateway: GatewayHealth | null;
  /** Missions the operator currently reports as running. */
  runningMissionIds: string[];
  safeMode: boolean;
  /** Contracts the operator could not load — the reason comes from it. */
  refresh: () => Promise<void>;
  startMission: (task: string) => Promise<void>;
  approve: (approval: OperatorApproval) => Promise<void>;
  setSafeMode: (enabled: boolean) => Promise<void>;
}

function describe(error: unknown): string {
  if (error instanceof OperatorError) {
    return error.status === 502 || error.status === 503
      ? 'HWD-ZERO is not answering — start it with `zero serve`'
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function useOperator(
  client: HwdZeroClient,
  options: { pollIntervalMs?: number } = {},
): OperatorView {
  const pollIntervalMs = Math.max(2_000, options.pollIntervalMs ?? 10_000);
  const [connection, setConnection] = useState<OperatorConnection>('connecting');
  const [error, setError] = useState('');
  const [state, setState] = useState<OperatorState | null>(null);
  const [registry, setRegistry] = useState<OperatorRegistry | null>(null);
  const [missions, setMissions] = useState<OperatorMission[]>([]);
  const [approvals, setApprovals] = useState<OperatorApproval[]>([]);
  const [tasks, setTasks] = useState<OperatorTask[]>([]);
  const [events, setEvents] = useState<OperatorEvent[]>([]);
  const [gateway, setGateway] = useState<GatewayHealth | null>(null);
  const [reportedState, setReportedState] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    // The gateway probe is separate and never fails the whole read: it is the
    // one thing that still works when the operator is down.
    void client
      .gatewayHealth()
      .then((health) => {
        if (mounted.current) setGateway(health);
      })
      .catch(() => undefined);

    try {
      const [nextState, nextRegistry, nextMissions, nextApprovals, nextTasks] = await Promise.all([
        client.state(),
        client.registry(),
        client.missions(),
        client.approvals(),
        client.tasks(),
      ]);
      if (!mounted.current) return;
      setState(nextState);
      setRegistry(nextRegistry);
      setMissions(nextMissions);
      setApprovals(nextApprovals);
      setTasks(nextTasks);
      setError('');
    } catch (cause) {
      if (!mounted.current) return;
      setConnection('unreachable');
      setError(describe(cause));
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    // The first read is scheduled rather than run in the effect body: it is
    // the same polling subscription as every later one, just at zero delay,
    // and it keeps the effect free of a synchronous cascading render.
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      mounted.current = false;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh, pollIntervalMs]);

  useEffect(() => {
    const stop = client.connectEvents({
      onOpen: () => {
        setConnection('open');
        setError('');
      },
      onClose: () => setConnection('closed'),
      onError: (message) => setError(message),
      onEvent: (event) => {
        setEvents((current) => {
          // The server replays its buffer on reconnect, so an event we already
          // hold arrives again. The id decides, not the arrival order.
          if (current.some((seen) => seen.event_id === event.event_id)) return current;
          const next = [...current, event];
          return next.length > OPERATOR_EVENT_LIMIT
            ? next.slice(next.length - OPERATOR_EVENT_LIMIT)
            : next;
        });
        if (event.type === 'zero.state.changed') {
          const reported = event.payload?.['state'];
          setReportedState(typeof reported === 'string' ? reported : null);
        }
        // A mission that finished or a gate that opened changes the lists,
        // and those come from the operator rather than from the event.
        if (
          event.type === 'mission.completed' ||
          event.type === 'mission.failed' ||
          event.type === 'approval.required' ||
          event.type === 'approval.approved' ||
          event.type === 'approval.denied'
        ) {
          void refresh();
        }
      },
    });
    return stop;
  }, [client, refresh]);

  const startMission = useCallback(
    async (task: string) => {
      try {
        await client.startMission(task);
        setError('');
        await refresh();
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [client, refresh],
  );

  const approve = useCallback(
    async (approval: OperatorApproval) => {
      try {
        // Two steps, deliberately: the server mints a ticket bound to this
        // exact gate and payload, and the grant redeems that one ticket. A
        // client cannot approve by asserting that something is approved.
        const ticket = await client.requestApproval(approval.mission_id, approval.gate);
        await client.grantApproval(ticket);
        setError('');
        await refresh();
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [client, refresh],
  );

  const setSafeMode = useCallback(
    async (enabled: boolean) => {
      try {
        await client.setSafeMode(enabled);
        setError('');
        await refresh();
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [client, refresh],
  );

  const runningMissionIds = useMemo(
    () => missions.filter((mission) => mission.status === 'RUNNING').map((m) => m.mission_id),
    [missions],
  );

  const knownAgentIds = useMemo(
    () => (registry?.agents ?? []).map((agent) => agent.id),
    [registry],
  );

  const agentRuntime = useMemo(
    () => foldAgentRuntime(events, approvals, knownAgentIds),
    [events, approvals, knownAgentIds],
  );

  const missionPhase = useMemo(() => foldMissionPhase(events), [events]);

  return {
    connection,
    error,
    state,
    registry,
    missions,
    approvals,
    tasks,
    events,
    agentRuntime,
    missionPhase,
    reportedState,
    gateway,
    runningMissionIds,
    safeMode: state?.safe_mode ?? false,
    refresh,
    startMission,
    approve,
    setSafeMode,
  };
}
