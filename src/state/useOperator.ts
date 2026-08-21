/**
 * The operator's live state, as this device sees it.
 *
 * One rule shapes this hook: HWD-ZERO holds the truth, and the interface holds
 * a *view* of it. Nothing here is computed optimistically — approving a gate
 * does not mark it approved locally and hope, it calls the server and waits for
 * the event. A phone whose screen was off for ten minutes and a laptop that
 * never slept therefore converge on the same picture, because both are showing
 * the same server state rather than two divergent local guesses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HwdZeroClient } from '../hwd/client';
import type {
  OperatorAgent,
  OperatorApproval,
  OperatorConnection,
  OperatorEvent,
  OperatorMission,
  OperatorPolicy,
  OperatorRegistry,
  OperatorStatus,
  VoiceReply,
  ZeroState,
} from '../hwd/types';

/** How often the structural view is re-read. Events drive everything urgent. */
const REFRESH_INTERVAL_MS = 15_000;
/** Events kept for the activity feed. Bounded so a long session cannot grow. */
const EVENT_BUFFER = 200;

export interface OperatorView {
  connection: OperatorConnection;
  zeroState: ZeroState;
  safeMode: boolean;
  status: OperatorStatus | null;
  registry: OperatorRegistry | null;
  agents: OperatorAgent[];
  /** Repositories the exclusion list refused. Never rendered as agents. */
  excluded: string[];
  missions: OperatorMission[];
  approvals: OperatorApproval[];
  policy: OperatorPolicy | null;
  events: OperatorEvent[];
  error: string | null;
  busy: boolean;

  createMission: (objective: string) => Promise<OperatorMission | null>;
  cancelMission: (id: string) => Promise<void>;
  approve: (approvalId: string) => Promise<void>;
  deny: (approvalId: string) => Promise<void>;
  createPolicy: (capability: string) => Promise<void>;
  stop: () => Promise<void>;
  resume: () => Promise<void>;
  sendTranscript: (text: string) => Promise<VoiceReply | null>;
  refresh: () => Promise<void>;
}

export function useOperator(client: HwdZeroClient): OperatorView {
  const [connection, setConnection] = useState<OperatorConnection>('connecting');
  const [status, setStatus] = useState<OperatorStatus | null>(null);
  const [registry, setRegistry] = useState<OperatorRegistry | null>(null);
  const [missions, setMissions] = useState<OperatorMission[]>([]);
  const [approvals, setApprovals] = useState<OperatorApproval[]>([]);
  const [policy, setPolicy] = useState<OperatorPolicy | null>(null);
  const [events, setEvents] = useState<OperatorEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zeroState, setZeroState] = useState<ZeroState>('IDLE');

  /** Deduplicates the buffer the server replays on every reconnect. */
  const seenEvents = useRef<Set<string>>(new Set());

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStatus, nextRegistry, nextMissions, nextApprovals] = await Promise.all([
        client.status(),
        client.registry(),
        client.missions(),
        client.approvals(),
      ]);
      setStatus(nextStatus);
      setZeroState(nextStatus.zero_state);
      setRegistry(nextRegistry);
      setMissions(nextMissions);
      setApprovals(nextApprovals);
      setPolicy(nextStatus.policy);
      setError(null);
      setConnection((current) => (current === 'unreachable' ? 'open' : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConnection('unreachable');
    }
  }, [client]);

  useEffect(() => {
    // The first read is scheduled rather than run inline: an effect that calls
    // setState synchronously forces a second render pass before paint, and this
    // one is a network read whose result is never needed that early.
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const disconnect = client.connectEvents({
      onOpen: () => {
        setConnection('open');
        // The socket coming back is the moment a phone rejoins after its screen
        // was off; re-read rather than trust the replayed buffer alone.
        void refresh();
      },
      onClose: () => setConnection('closed'),
      onError: (message) => setError(message),
      onEvent: (event) => {
        if (seenEvents.current.has(event.event_id)) return;
        seenEvents.current.add(event.event_id);
        if (seenEvents.current.size > EVENT_BUFFER * 4) {
          seenEvents.current = new Set([...seenEvents.current].slice(-EVENT_BUFFER));
        }

        setEvents((current) => [...current, event].slice(-EVENT_BUFFER));

        if (event.type === 'zero.state.changed') {
          const next = event.payload.state;
          if (typeof next === 'string') setZeroState(next as ZeroState);
        }

        // Anything that changes what the operator must decide or see is re-read
        // from the server rather than patched locally.
        if (
          event.type === 'approval.required' ||
          event.type === 'approval.approved' ||
          event.type === 'approval.denied' ||
          event.type === 'mission.completed' ||
          event.type === 'mission.failed' ||
          event.type === 'mission.created' ||
          event.type === 'system.safe_mode' ||
          event.type === 'system.resumed' ||
          event.type === 'policy.changed'
        ) {
          void refresh();
        }
      },
    });
    return disconnect;
  }, [client, refresh]);

  const guard = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      try {
        const result = await action();
        setError(null);
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  const createMission = useCallback(
    (objective: string) => guard(() => client.createMission(objective)),
    [client, guard],
  );
  const cancelMission = useCallback(
    async (id: string) => void (await guard(() => client.cancelMission(id))),
    [client, guard],
  );
  const approve = useCallback(
    async (approvalId: string) => void (await guard(() => client.approve(approvalId))),
    [client, guard],
  );
  const deny = useCallback(
    async (approvalId: string) => void (await guard(() => client.deny(approvalId))),
    [client, guard],
  );
  const createPolicy = useCallback(
    async (capability: string) => void (await guard(() => client.grantPolicy(capability))),
    [client, guard],
  );
  const stop = useCallback(async () => void (await guard(() => client.stop())), [client, guard]);
  const resume = useCallback(
    async () => void (await guard(() => client.resume())),
    [client, guard],
  );
  const sendTranscript = useCallback(
    (text: string) => guard(() => client.sendTranscript(text)),
    [client, guard],
  );

  const agents = useMemo(() => registry?.agents ?? [], [registry]);
  const excluded = useMemo(() => registry?.excluded ?? [], [registry]);
  const safeMode = status?.safe_mode.safe_mode ?? false;

  return {
    connection,
    zeroState: safeMode ? 'SAFE_MODE' : zeroState,
    safeMode,
    status,
    registry,
    agents,
    excluded,
    missions,
    approvals,
    policy,
    events,
    error,
    busy,
    createMission,
    cancelMission,
    approve,
    deny,
    createPolicy,
    stop,
    resume,
    sendTranscript,
    refresh,
  };
}
