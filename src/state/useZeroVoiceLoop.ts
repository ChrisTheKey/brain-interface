/**
 * React binding for the spoken loop:
 *
 *   microphone → speech-to-text → ZERO routing → agent runs → answer → voice
 *
 * The hook owns the microphone lifecycle (opened only on an explicit user
 * action, fully released on stop/unmount), the conversation state machine and
 * the log of what really happened in each turn.
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
  startListening: () => void;
  stopListening: () => void;
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

  const meterRef = useRef<MicrophoneMeter | null>(null);
  const recognitionRef = useRef<WebSpeechInputProvider | null>(null);
  const pipelineRef = useRef<ConversationPipeline | null>(null);
  const agentsRef = useRef<ZeroAgent[]>(options.agents);
  const speakRef = useRef(options.speak);
  const stopSpeakingRef = useRef(options.stopSpeaking);
  const activityRef = useRef(options.onAgentActivity);

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

  const runTranscript = useCallback((text: string) => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      setError('ZERO is not connected');
      setState('error');
      return;
    }
    if (pipeline.isBusy) return;
    void pipeline.handleTranscript(text, agentsRef.current).then((log) => {
      setTurns((previous) => [log, ...previous].slice(0, 20));
    });
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    meterRef.current?.stop();
    meterRef.current = null;
    setListening(false);
    setState((current) => (current === 'listening' ? 'idle' : current));
  }, []);

  const startListening = useCallback(() => {
    if (listening) {
      stopListening();
      return;
    }
    if (config.speech.provider === 'none') {
      setError('speech input is disabled (VITE_ZERO_SPEECH_PROVIDER=none)');
      setState('error');
      return;
    }

    const provider = new WebSpeechInputProvider(config.speech.language);
    if (!provider.isSupported()) {
      setError('this browser has no SpeechRecognition engine');
      setState('error');
      return;
    }

    // Barge-in: if ZERO is talking, it yields the floor before listening.
    stopSpeakingRef.current?.();

    setTranscript('');
    setError(null);
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

    let finalText = '';
    provider.start({
      onTranscript: ({ text, final }) => {
        setTranscript(text);
        if (final) finalText = text;
      },
      onError: (message) => {
        setError(message);
        setListening(false);
        setState('error');
        meterRef.current?.stop();
        meterRef.current = null;
      },
      onEnd: () => {
        setListening(false);
        meterRef.current?.stop();
        meterRef.current = null;
        recognitionRef.current = null;
        const text = finalText.trim();
        if (text.length > 0) runTranscript(text);
        else setState((current) => (current === 'listening' ? 'idle' : current));
      },
    });
    recognitionRef.current = provider;
  }, [listening, runTranscript, stopListening]);

  const submitText = useCallback(
    (text: string) => {
      setTranscript(text);
      runTranscript(text);
    },
    [runTranscript],
  );

  const runAgent = useCallback((agent: ZeroAgent, task: string) => {
    const pipeline = pipelineRef.current;
    if (!pipeline || pipeline.isBusy) return;
    // A direct run is the same pipeline with the routing decision pre-made.
    void pipeline
      .handleTranscript(`Run this task in the ${agent.name} agent: ${task}`, [agent])
      .then((log) => setTurns((previous) => [log, ...previous].slice(0, 20)));
  }, []);

  useEffect(() => {
    return () => {
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
    startListening,
    stopListening,
    submitText,
    runAgent,
  };
}
