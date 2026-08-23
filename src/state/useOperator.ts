import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OperatorError } from '../hwd/client';
import { onNetworkWake } from '../zero/lifecycle';
import type { HwdZeroClient } from '../hwd/client';
import type {
  OperatorApproval,
  RuntimeReadyPayload,
  OperatorConnection,
  OperatorEvent,
  OperatorMission,
  OperatorRegistry,
  OperatorState,
  OperatorTask,
} from '../hwd/types';

/**
 * HWD-ZERO's live state, as the interface sees it.
 *
 * Two sources, on purpose. The event stream is what makes the brain move —
 * it is pushed, immediate, and driven by mission journals. The periodic read
 * is the correction: after a reconnect, or a mission the phone slept through,
 * the lists come from the operator rather than from replayed events. Nothing
 * here derives state the operator did not report.
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
  /** Missions the operator currently reports as running. */
  runningMissionIds: string[];
  /** True once HWD-ZERO returned real operator state — not merely "socket open". */
  responded: boolean;
  /**
   * True once `zero.runtime.ready` arrived on the event stream.
   *
   * HWD-ZERO sends it to every subscriber as the first frame, so this is the
   * runtime itself confirming it is assembled — the difference between an open
   * socket and a working stream.
   */
  runtimeAnnounced: boolean;
  /** What the runtime said about itself, or null before it has spoken. */
  runtime: RuntimeReadyPayload | null;
  safeMode: boolean;
  refresh: () => Promise<void>;
  startMission: (task: string) => Promise<void>;
  approve: (approval: OperatorApproval) => Promise<void>;
  deny: (approval: OperatorApproval) => Promise<void>;
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
  const [responded, setResponded] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeReadyPayload | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
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
      setResponded(true);
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
      onClose: () => {
        setConnection('closed');
        // A closed stream is not a runtime that announced itself. Keeping the
        // flag would let the panel claim FULL coverage over a dead socket.
        setRuntime(null);
      },
      onError: (message) => setError(message),
      onEvent: (event) => {
        if (event.type === 'zero.runtime.ready') {
          // The runtime describing itself. Recorded separately from the event
          // list because it is state, not history: a reconnect re-announces,
          // and the newest answer is the true one.
          setRuntime(event.payload as unknown as RuntimeReadyPayload);
        }
        setEvents((current) => {
          // The server replays its buffer on reconnect, so an event we already
          // hold arrives again. The id decides, not the arrival order.
          if (current.some((seen) => seen.event_id === event.event_id)) return current;
          const next = [...current, event];
          return next.length > OPERATOR_EVENT_LIMIT
            ? next.slice(next.length - OPERATOR_EVENT_LIMIT)
            : next;
        });
        // A mission that finished or a gate that opened changes the lists,
        // and those come from the operator rather than from the event.
        if (
          event.type === 'mission.completed' ||
          event.type === 'mission.failed' ||
          event.type === 'approval.required' ||
          event.type === 'approval.approved'
        ) {
          void refresh();
        }
      },
    });
    // The phone waking up must not wait for the next backoff step.
    const offWake = onNetworkWake(() => {
      client.reconnectNow();
      void refresh();
    });
    return () => {
      offWake();
      stop();
    };
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

  const deny = useCallback(
    async (approval: OperatorApproval) => {
      try {
        // Denial is a decision, not a pause: for a publish the runtime drops
        // the prepared payload, so no later ticket can find it waiting.
        await client.denyApproval(approval.mission_id, approval.gate);
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

  return {
    connection,
    error,
    state,
    registry,
    missions,
    approvals,
    tasks,
    events,
    runningMissionIds,
    responded,
    runtimeAnnounced: runtime !== null && runtime.healthy !== false,
    runtime,
    safeMode: state?.safe_mode ?? false,
    refresh,
    startMission,
    approve,
    deny,
    setSafeMode,
  };
}
