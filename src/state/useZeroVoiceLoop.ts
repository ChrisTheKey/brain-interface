/**
 * React binding for the spoken loop:
 *
 *   microphone → speech-to-text → ZERO routing → agent runs → answer → voice
 *
 * The hook owns the microphone lifecycle (opened only on an explicit user
 * action, fully released on stop/unmount), the conversation state machine and
 * the log of what really happened in each turn.
 *
 * Two ways to talk to ZERO, one pipeline behind both:
 *
 *   push to talk    `startListening()` — one turn, then the microphone closes.
 *   voice mode      `startConversation()` — the microphone re-opens by itself
 *                   after ZERO has finished answering, so the conversation
 *                   continues without touching the machine. It never listens
 *                   *while* ZERO speaks, so ZERO cannot hear itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { config } from '../config';
import type { ZeroClient } from '../zero/client';
import type { ZeroAgent } from '../zero/agentRegistry';
import type { AgentRunResult } from '../zero/agentRunner';
import {
  ConversationPipeline,
  type ConversationState,
  type ConversationTurnLog,
} from './conversation';
import { MicrophoneMeter, WebSpeechInputProvider } from '../voice/speechInput';

/**
 * Recognition errors that are part of normal speaking (a pause that was too
 * long, a phrase the engine could not resolve). In voice mode they re-arm the
 * microphone; anything else ends the conversation and is shown.
 */
const RECOVERABLE_SPEECH_ERRORS = new Set(['no-speech', 'aborted', 'audio-capture']);

export interface VoiceLoopApi {
  state: ConversationState;
  error: string | null;
  /** Live transcript while the engine is still refining it. */
  transcript: string;
  answer: string;
  /** Agent ids that are running right now. */
  activeAgentIds: string[];
  turns: ConversationTurnLog[];
  /** Real microphone input level, 0..1 (0 while the microphone is closed). */
  micLevel: () => number;
  listening: boolean;
  speechSupported: boolean;
  /** True while voice mode keeps the loop going on its own. */
  conversationActive: boolean;
  startListening: () => void;
  stopListening: () => void;
  /** Voice mode: listen → answer → listen again, until it is stopped. */
  startConversation: () => void;
  stopConversation: () => void;
  toggleConversation: () => void;
  /** Send a typed request through the exact same ZERO pipeline. */
  submitText: (text: string) => void;
  /** Run one specific agent directly (used by the node detail view). */
  runAgent: (agent: ZeroAgent, task: string) => void;
}

export interface VoiceLoopOptions {
  client: ZeroClient | null;
  agents: ZeroAgent[];
  speak: (text: string) => Promise<void>;
  /** Stops ZERO's voice output — used for barge-in when the user speaks. */
  stopSpeaking?: () => void;
  onAgentActivity?: (
    agentId: string,
    phase: 'start' | 'finish',
    detail?: { task?: string; result?: AgentRunResult },
  ) => void;
}

export function useZeroVoiceLoop(options: VoiceLoopOptions): VoiceLoopApi {
  const [state, setState] = useState<ConversationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [answer, setAnswer] = useState('');
  const [activeAgentIds, setActiveAgentIds] = useState<string[]>([]);
  const [turns, setTurns] = useState<ConversationTurnLog[]>([]);
  const [listening, setListening] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);

  const meterRef = useRef<MicrophoneMeter | null>(null);
  const recognitionRef = useRef<WebSpeechInputProvider | null>(null);
  const pipelineRef = useRef<ConversationPipeline | null>(null);
  const agentsRef = useRef<ZeroAgent[]>(options.agents);
  const speakRef = useRef(options.speak);
  const stopSpeakingRef = useRef(options.stopSpeaking);
  const activityRef = useRef(options.onAgentActivity);
  /** Whether voice mode should re-open the microphone after each turn. */
  const continuousRef = useRef(false);
  const listeningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Voice mode re-arms itself: the turn that just ended asks for the next one.
   * The callback is reached through a ref so the re-arm always calls the
   * current one instead of capturing the version it was created with.
   */
  const beginListeningRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    agentsRef.current = options.agents;
  }, [options.agents]);
  useEffect(() => {
    speakRef.current = options.speak;
  }, [options.speak]);
  useEffect(() => {
    activityRef.current = options.onAgentActivity;
  }, [options.onAgentActivity]);
  useEffect(() => {
    stopSpeakingRef.current = options.stopSpeaking;
  }, [options.stopSpeaking]);

  const speechSupported = useMemo(() => {
    if (config.speech.provider === 'none') return false;
    return new WebSpeechInputProvider(config.speech.language).isSupported();
  }, []);

  const client = options.client;

  useEffect(() => {
    if (!client) {
      pipelineRef.current = null;
      return;
    }
    pipelineRef.current = new ConversationPipeline(
      client,
      {
        routerCwd: config.agents.orchestratorCwd || config.agents.root,
        routeTimeoutMs: config.agents.routeTimeoutMs,
        invokeTimeoutMs: config.agents.invokeTimeoutMs,
        sandbox: config.agents.threadSandbox,
      },
      {
        onState: (next, detail) => {
          setState(next);
          setError(detail?.error ?? null);
        },
        onTranscript: (text) => setTranscript(text),
        onAgentStart: (agent, task) => {
          setActiveAgentIds((previous) => [...new Set([...previous, agent.id])]);
          activityRef.current?.(agent.id, 'start', { task });
        },
        onAgentFinish: (result) => {
          setActiveAgentIds((previous) => previous.filter((id) => id !== result.agentId));
          activityRef.current?.(result.agentId, 'finish', { result });
        },
        onAnswer: (text) => setAnswer(text),
        speak: (text) => speakRef.current(text),
      },
    );
    return () => {
      pipelineRef.current = null;
    };
  }, [client]);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const releaseMicrophone = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    meterRef.current?.stop();
    meterRef.current = null;
    listeningRef.current = false;
    setListening(false);
  }, []);

  const runTranscript = useCallback((text: string): Promise<void> => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      setError('ZERO is not connected');
      setState('error');
      return Promise.resolve();
    }
    if (pipeline.isBusy) return Promise.resolve();
    return pipeline.handleTranscript(text, agentsRef.current).then((log) => {
      setTurns((previous) => [log, ...previous].slice(0, 20));
    });
  }, []);

  const stopListening = useCallback(() => {
    clearRestartTimer();
    releaseMicrophone();
    setState((current) => (current === 'listening' ? 'idle' : current));
  }, [clearRestartTimer, releaseMicrophone]);

  /**
   * Opens the microphone for one turn. `beginListening` is stable, so the
   * re-arm in voice mode can call it without recreating the whole loop.
   */
  const beginListening = useCallback((): void => {
    if (listeningRef.current) return;
    if (config.speech.provider === 'none') {
      setError('speech input is disabled (VITE_ZERO_SPEECH_PROVIDER=none)');
      setState('error');
      continuousRef.current = false;
      setConversationActive(false);
      return;
    }

    const provider = new WebSpeechInputProvider(config.speech.language);
    if (!provider.isSupported()) {
      setError('this browser has no SpeechRecognition engine');
      setState('error');
      continuousRef.current = false;
      setConversationActive(false);
      return;
    }

    // Barge-in: if ZERO is talking, it yields the floor before listening.
    stopSpeakingRef.current?.();

    setTranscript('');
    setError(null);
    listeningRef.current = true;
    setListening(true);
    setState('listening');

    // The level meter is what makes "ZERO is listening" honest: it shows the
    // real input signal. A denied microphone only costs the meter, not the
    // recognition itself.
    const meter = new MicrophoneMeter();
    meterRef.current = meter;
    void meter.start().then((result) => {
      if (!result.ok && result.error) setError(result.error);
    });

    /** Re-opens the microphone after ZERO has finished, in voice mode only. */
    const rearm = (): void => {
      if (!continuousRef.current) return;
      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (continuousRef.current) beginListeningRef.current?.();
      }, config.voiceMode.restartDelayMs);
    };

    let finalText = '';
    provider.start({
      onTranscript: ({ text, final }) => {
        setTranscript(text);
        if (final) finalText = text;
      },
      onError: (message) => {
        releaseMicrophone();
        // A pause that was too long is not a failure of the conversation.
        if (continuousRef.current && RECOVERABLE_SPEECH_ERRORS.has(message)) {
          setState('idle');
          rearm();
          return;
        }
        setError(message);
        setState('error');
        continuousRef.current = false;
        setConversationActive(false);
      },
      onEnd: () => {
        releaseMicrophone();
        const text = finalText.trim();
        if (text.length === 0) {
          setState((current) => (current === 'listening' ? 'idle' : current));
          rearm();
          return;
        }
        // The turn owns the floor: ZERO routes, the agents run, ZERO speaks —
        // and only then does the microphone open again.
        void runTranscript(text).then(rearm);
      },
    });
    recognitionRef.current = provider;
  }, [clearRestartTimer, releaseMicrophone, runTranscript]);

  useEffect(() => {
    beginListeningRef.current = beginListening;
  }, [beginListening]);

  const startListening = useCallback(() => {
    if (listeningRef.current) {
      stopListening();
      return;
    }
    beginListening();
  }, [beginListening, stopListening]);

  const startConversation = useCallback(() => {
    continuousRef.current = true;
    setConversationActive(true);
    beginListening();
  }, [beginListening]);

  const stopConversation = useCallback(() => {
    continuousRef.current = false;
    setConversationActive(false);
    clearRestartTimer();
    releaseMicrophone();
    stopSpeakingRef.current?.();
    setState((current) => (current === 'listening' || current === 'speaking' ? 'idle' : current));
  }, [clearRestartTimer, releaseMicrophone]);

  const toggleConversation = useCallback(() => {
    if (continuousRef.current) stopConversation();
    else startConversation();
  }, [startConversation, stopConversation]);

  const submitText = useCallback(
    (text: string) => {
      setTranscript(text);
      void runTranscript(text);
    },
    [runTranscript],
  );

  const runAgent = useCallback(
    (agent: ZeroAgent, task: string) => {
      const pipeline = pipelineRef.current;
      if (!pipeline || pipeline.isBusy) return;
      // A direct run is the same pipeline with the routing decision pre-made.
      void pipeline
        .handleTranscript(`Run this task in the ${agent.name} agent: ${task}`, [agent])
        .then((log) => setTurns((previous) => [log, ...previous].slice(0, 20)));
    },
    [],
  );

  useEffect(() => {
    return () => {
      continuousRef.current = false;
      if (restartTimerRef.current !== null) clearTimeout(restartTimerRef.current);
      recognitionRef.current?.dispose();
      recognitionRef.current = null;
      meterRef.current?.stop();
      meterRef.current = null;
    };
  }, []);

  const micLevel = useCallback(() => meterRef.current?.level() ?? 0, []);

  return {
    state,
    error,
    transcript,
    answer,
    activeAgentIds,
    turns,
    micLevel,
    listening,
    speechSupported,
    conversationActive,
    startListening,
    stopListening,
    startConversation,
    stopConversation,
    toggleConversation,
    submitText,
    runAgent,
  };
}
