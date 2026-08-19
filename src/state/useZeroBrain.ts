/**
 * React binding for the ZERO integration: owns the client, the adapter, the
 * snapshot → graph transformation, live activity and the voice service.
 *
 * All resources (WebSocket, timers, voice/audio) are cleaned up on unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { config } from '../config';
import { buildGraph } from '../graph/transform';
import type { GraphModel } from '../graph/model';
import { ZeroClient, type ConnectionState } from '../zero/client';
import { ZeroDataAdapter, type ActivityEvent, type ZeroSnapshot } from '../zero/adapter';
import type { ThreadStatus } from '../zero/protocol';
import { ZeroVoiceService } from '../voice/service';
import { ZeroRealtimeVoiceProvider } from '../voice/realtimeProvider';
import { SpeechSynthesisVoiceProvider } from '../voice/speechSynthesisProvider';
import { ZERO_VOICE_CHARACTER, type VoiceProvider } from '../voice/provider';
import type { VoiceState } from '../voice/service';

const MAX_ACTIVITY = 60;

export interface BrainState {
  /** The live ZERO client (null until the first connection attempt). */
  client: ZeroClient | null;
  connection: ConnectionState;
  connectionError: string | null;
  snapshot: ZeroSnapshot | null;
  graph: GraphModel;
  activity: ActivityEvent[];
  /** Node id → energy (1 = just happened), decayed by the render loop. */
  pulsesRef: RefObject<Map<string, { energy: number; at: number }>>;
  voiceState: VoiceState;
  voiceReason: string | undefined;
  voiceProviderId: string | null;
  lastAgentMessage: string | null;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  refresh: () => void;
  levels: () => ReturnType<ZeroVoiceService['levels']>;
}

export function useZeroBrain(): BrainState {
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ZeroSnapshot | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [threadStatuses, setThreadStatuses] = useState<Map<string, ThreadStatus>>(new Map());
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceReason, setVoiceReason] = useState<string | undefined>(undefined);
  const [lastAgentMessage, setLastAgentMessage] = useState<string | null>(null);
  const [voiceProviderId, setVoiceProviderId] = useState<string | null>(null);

  // The transport is created once, outside the effect, so consumers can use it
  // during render without a state round-trip.
  const [client] = useState<ZeroClient>(
    () =>
      new ZeroClient({
        url: config.zeroWsUrl,
        clientInfo: {
          name: config.clientName,
          title: 'Brain Interface',
          version: config.clientVersion,
        },
        experimentalApi: config.experimentalApi,
        // The brain does not render token-level deltas; skip that firehose.
        optOutNotificationMethods: ['item/agentMessage/delta', 'item/reasoning/summaryTextDelta'],
      }),
  );

  const pulsesRef = useRef<Map<string, { energy: number; at: number }>>(new Map());
  const clientRef = useRef<ZeroClient | null>(null);
  const adapterRef = useRef<ZeroDataAdapter | null>(null);
  const voiceRef = useRef<ZeroVoiceService | null>(null);
  const selectedThreadRef = useRef<string | null>(null);

  useEffect(() => {
    const adapter = new ZeroDataAdapter(client, {
      extraCwds: config.extraCwds,
      threadLimit: config.threadLimit,
      agentRoot: config.agents.root,
      agentManifestPath: config.agents.manifestPath,
      execSandbox: config.agents.execSandbox,
    });
    clientRef.current = client;
    adapterRef.current = adapter;

    const providers: VoiceProvider[] = [];
    if (config.voice.provider === 'zero-realtime') {
      providers.push(
        new ZeroRealtimeVoiceProvider({
          client,
          getThreadId: () => selectedThreadRef.current,
          experimentalApi: config.experimentalApi,
          voicePrompt: config.voice.prompt,
        }),
      );
    }
    if (config.voice.provider !== 'none') {
      providers.push(
        new SpeechSynthesisVoiceProvider({
          ...ZERO_VOICE_CHARACTER,
          rate: config.voice.rate,
          pitch: config.voice.pitch,
          volume: config.voice.volume,
          preferredVoices: config.voice.preferredVoices,
        }),
      );
    }
    const voice = new ZeroVoiceService(providers);
    voiceRef.current = voice;

    const offVoice = voice.onState((state, detail) => {
      setVoiceState(state);
      setVoiceReason(detail?.reason);
      setVoiceProviderId(voice.providerId);
    });

    const offState = client.on('state', (state, detail) => {
      setConnection(state);
      setConnectionError(detail?.error ?? null);
    });

    const offSnapshot = adapter.on('snapshot', (next) => {
      setSnapshot(next);
      if (!selectedThreadRef.current) {
        selectedThreadRef.current = next.threads[0]?.id ?? null;
      }
    });

    const offActivity = adapter.on('activity', (event) => {
      const now = Date.now();
      if (event.threadId) {
        pulsesRef.current.set(`thread:${event.threadId}`, { energy: event.intensity, at: now });
      }
      for (const touched of event.touches ?? []) {
        pulsesRef.current.set(touched, { energy: event.intensity, at: now });
      }
      pulsesRef.current.set('zero', {
        energy: Math.max(pulsesRef.current.get('zero')?.energy ?? 0, event.intensity * 0.7),
        at: now,
      });
      setActivity((previous) => [event, ...previous].slice(0, MAX_ACTIVITY));
      if (event.kind === 'agentMessage' && event.text) {
        setLastAgentMessage(event.text);
        if (config.voice.speakAgentMessages) void voice.speak(event.text);
      }
    });

    const offThreadStatus = adapter.on('threadStatus', (threadId, status) => {
      setThreadStatuses((previous) => {
        const next = new Map(previous);
        next.set(threadId, status);
        return next;
      });
    });

    const stopListening = adapter.listen();

    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const bootstrap = async (): Promise<void> => {
      try {
        await client.connect();
      } catch {
        return; // the client retries with backoff; state listener already fired
      }
      if (disposed) return;
      await adapter.loadSnapshot();
    };

    const offConnected = client.on('state', (state) => {
      if (state === 'connected') void adapter.loadSnapshot();
    });

    void bootstrap();
    refreshTimer = setInterval(() => {
      if (client.connectionState === 'connected') void adapter.loadSnapshot();
    }, config.refreshIntervalMs);

    return () => {
      disposed = true;
      if (refreshTimer !== null) clearInterval(refreshTimer);
      stopListening();
      offState();
      offConnected();
      offSnapshot();
      offActivity();
      offThreadStatus();
      offVoice();
      voice.dispose();
      client.close();
      clientRef.current = null;
      adapterRef.current = null;
      voiceRef.current = null;
    };
  }, [client]);

  const graph = useMemo(() => {
    const model = buildGraph(snapshot);
    if (threadStatuses.size > 0) {
      for (const node of model.nodes) {
        const threadId = node.metadata['threadId'];
        if (typeof threadId !== 'string') continue;
        const status = threadStatuses.get(threadId);
        if (!status) continue;
        node.status =
          status.type === 'active'
            ? 'active'
            : status.type === 'systemError'
              ? 'error'
              : status.type === 'idle'
                ? 'idle'
                : 'notLoaded';
      }
    }
    return model;
  }, [snapshot, threadStatuses]);

  const speak = useCallback(async (text: string): Promise<void> => {
    await voiceRef.current?.speak(text);
  }, []);

  const stopSpeaking = useCallback(() => {
    voiceRef.current?.stop();
  }, []);

  const refresh = useCallback(() => {
    void adapterRef.current?.loadSnapshot();
  }, []);

  const levels = useCallback(() => {
    return (
      voiceRef.current?.levels() ?? {
        amplitude: 0,
        peak: 0,
        low: 0,
        high: 0,
        onset: 0,
      }
    );
  }, []);

  return {
    client,
    connection,
    connectionError,
    snapshot,
    graph,
    activity,
    pulsesRef,
    voiceState,
    voiceReason,
    voiceProviderId,
    lastAgentMessage,
    speak,
    stopSpeaking,
    refresh,
    levels,
  };
}
