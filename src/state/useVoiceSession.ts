/**
 * The spoken loop, end to end.
 *
 *   microphone → SpeechRecognition → partial transcript  ─▶ /ws/voice
 *                                  → final transcript    ─▶ /ws/voice (voice.final)
 *   HWD-ZERO   → voice.response (text) + voice.audio (PCM16)
 *              → AudioEngine → AnalyserNode → the brain reacts to real audio
 *
 * The hook owns the microphone lifecycle (opened only on an explicit user
 * action, fully released on stop and unmount), the voice channel and the
 * playback engine. It decides nothing about the work itself: the final
 * transcript is handed to HWD-ZERO and whatever comes back is what is shown.
 *
 * Degradation, in order, and always named in the HUD:
 *   1. no /ws/voice          → the transcript is handed over as a mission on
 *                              POST /api/missions, and the answer arrives on
 *                              /ws/events instead of on the voice channel
 *   2. no streamed audio     → POST /api/voice/tts, still measured
 *   3. no operator audio     → browser synthesis, levels estimated (flagged)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { config } from '../config';
import { AudioEngine } from '../audio/playback';
import { SILENT_LEVELS, type AudioLevels } from '../audio/analyser';
import type { HwdZeroClient } from '../hwd/client';
import { VoiceChannel, type VoiceChannelStatus } from '../hwd/voiceChannel';
import type { VoiceAudioChunk } from '../hwd/types';
import { MicrophoneMeter, WebSpeechInput } from '../voice/speechInput';
import { TtsPipeline, type VoiceTier } from '../voice/ttsPipeline';
import { ZERO_VOICE_CHARACTER } from '../voice/provider';

export interface VoiceSessionApi {
  /** This browser has a real speech-to-text engine. */
  speechSupported: boolean;
  listening: boolean;
  /** Live, still-changing recognition result. */
  partial: string;
  /** The sentence that was handed to HWD-ZERO. */
  finalTranscript: string;
  /** ZERO's answer, verbatim. */
  response: string;
  responseMissionId: string | null;
  error: string | null;
  channelStatus: VoiceChannelStatus;
  /** Which audio path is actually in use. */
  tier: VoiceTier;
  tierNote: string | null;
  /** True when the reaction is estimated from word timing, not measured. */
  estimated: boolean;
  /** Why there is no audio at all, when there is none. */
  audioUnavailable: string | null;
  /** The transcript is with HWD-ZERO and no answer has arrived. */
  awaitingResponse: boolean;
  /** The final transcript is being closed and handed over. */
  finalizing: boolean;
  speaking: boolean;
  /** A runtime state HWD-ZERO reported on the voice channel. */
  reportedState: string | null;
  /** Read-only samplers for the render loop — never React state. */
  micLevel: () => number;
  levels: () => AudioLevels;
  startListening: () => void;
  stopListening: () => void;
  submitText: (text: string) => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
}

export interface VoiceSessionOptions {
  client: HwdZeroClient;
  /** Called when a turn is handed over without the voice channel. */
  onMissionFallback?: (text: string) => Promise<void>;
}

/** Pull a human-readable answer out of whatever `POST /api/missions` returned. */
export function describeRun(run: Record<string, unknown> | null | undefined): string {
  if (!run) return '';
  for (const key of ['answer', 'summary', 'result', 'objective', 'status']) {
    const value = run[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  const missionId = run['mission_id'];
  return typeof missionId === 'string' ? `Mission ${missionId} started.` : '';
}

export function useVoiceSession(options: VoiceSessionOptions): VoiceSessionApi {
  const { client } = options;
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [responseMissionId, setResponseMissionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channelStatus, setChannelStatus] = useState<VoiceChannelStatus>('idle');
  const [tier, setTier] = useState<VoiceTier>('none');
  const [tierNote, setTierNote] = useState<string | null>(null);
  const [audioUnavailable, setAudioUnavailable] = useState<string | null>(null);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [reportedState, setReportedState] = useState<string | null>(null);

  const engineRef = useRef<AudioEngine | null>(null);
  const channelRef = useRef<VoiceChannel | null>(null);
  const ttsRef = useRef<TtsPipeline | null>(null);
  const recognitionRef = useRef<WebSpeechInput | null>(null);
  const meterRef = useRef<MicrophoneMeter | null>(null);
  const onFallbackRef = useRef(options.onMissionFallback);
  /**
   * Audio that arrived before the browser let us start an AudioContext.
   * HWD-ZERO streams its answer whenever it is ready — it does not wait for a
   * tap — so the first sentence has to survive the unlock instead of being
   * dropped on the floor.
   */
  const pendingAudio = useRef<VoiceAudioChunk[]>([]);
  const unlocking = useRef(false);

  useEffect(() => {
    onFallbackRef.current = options.onMissionFallback;
  }, [options.onMissionFallback]);

  // Browsers only start an AudioContext from a user gesture. Any first
  // interaction with the page counts, so ZERO can speak without the user
  // having had to press the microphone first.
  useEffect(() => {
    const unlock = (): void => {
      void engineRef.current?.activate();
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  const speechSupported = useMemo(() => {
    if (config.speech.provider === 'none') return false;
    return new WebSpeechInput(config.speech.language).isSupported();
  }, []);

  /* ------------------------- channel + audio engine ---------------------- */

  useEffect(() => {
    // Captured once: the queue is emptied in place, never replaced, so this
    // is the same array the cleanup has to clear.
    const pending = pendingAudio.current;
    const engine = new AudioEngine({
      onStateChange: (state, detail) => {
        setSpeaking(state === 'playing');
        setAudioUnavailable(state === 'unavailable' ? (detail ?? 'audio unavailable') : null);
      },
    });
    engineRef.current = engine;
    engine.setVolume(config.voice.volume);

    const channel = new VoiceChannel(
      {
        openSocket: () => client.openSocket('/ws/voice'),
        language: config.speech.language,
        reconnectDelayMs: config.reconnectDelayMs,
      },
      {
        onStatus: (status) => {
          setChannelStatus(status);
          ttsRef.current?.refresh();
        },
        onState: (state) => setReportedState(state),
        onPartial: (text) => setPartial(text),
        onTranscript: (text, final) => {
          if (final) setFinalTranscript(text);
          else setPartial(text);
        },
        onResponse: (text, missionId) => {
          setResponse(text);
          setResponseMissionId(missionId ?? null);
          setAwaitingResponse(false);
          setFinalizing(false);
        },
        onAudio: (chunk) => {
          const engine = engineRef.current;
          if (!engine) return;
          if (engine.currentState === 'ready' || engine.currentState === 'playing') {
            engine.enqueuePcm(chunk);
            return;
          }
          if (engine.currentState === 'unavailable') return;
          pendingAudio.current.push(chunk);
          if (unlocking.current) return;
          unlocking.current = true;
          void engine.activate().then((ok) => {
            unlocking.current = false;
            const queued = pendingAudio.current.splice(0);
            if (!ok) return;
            // In order: they are consecutive slices of one sentence.
            for (const buffered of queued) engine.enqueuePcm(buffered);
          });
        },
        onAudioEnd: () => undefined,
        onError: (message) => setError(message),
      },
    );
    channelRef.current = channel;
    channel.connect();

    const tts = new TtsPipeline({
      mode: config.voice.mode,
      engine,
      client,
      channel,
      character: {
        ...ZERO_VOICE_CHARACTER,
        rate: config.voice.rate,
        pitch: config.voice.pitch,
        volume: config.voice.volume,
        preferredVoices: config.voice.preferredVoices,
      },
      onTierChange: (nextTier, note) => {
        setTier(nextTier);
        setTierNote(note);
      },
    });
    ttsRef.current = tts;
    tts.refresh();
    setTier(tts.currentTier);
    setTierNote(tts.note);

    return () => {
      pending.length = 0;
      unlocking.current = false;
      tts.dispose();
      channel.close();
      engine.dispose();
      ttsRef.current = null;
      channelRef.current = null;
      engineRef.current = null;
    };
  }, [client]);

  /* ------------------------------- speaking ------------------------------ */

  const speak = useCallback((text: string) => {
    const tts = ttsRef.current;
    if (!tts) return;
    void engineRef.current?.activate().then(() => {
      tts.refresh();
      setTier(tts.currentTier);
      setTierNote(tts.note);
      if (!tts.isMeasured) setSpeaking(true);
      void tts.speak(text).finally(() => {
        if (!tts.isMeasured) setSpeaking(false);
      });
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    ttsRef.current?.stop();
    setSpeaking(false);
  }, []);

  /* ------------------------------ the handoff ---------------------------- */

  /** Hand the finished sentence to HWD-ZERO. This is the only handoff. */
  const handOff = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        setFinalizing(false);
        return;
      }
      setFinalTranscript(trimmed);
      setResponse('');
      setResponseMissionId(null);
      setError(null);
      setAwaitingResponse(true);
      setFinalizing(false);

      const channel = channelRef.current;
      if (channel?.isAvailable) {
        channel.send({ type: 'voice.final', text: trimmed, language: config.speech.language });
        return;
      }

      // No voice channel: the transcript still reaches HWD-ZERO, as a mission.
      // The answer then arrives on /ws/events rather than on the voice channel.
      const fallback = onFallbackRef.current;
      if (fallback) {
        void fallback(trimmed)
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          )
          .finally(() => setAwaitingResponse(false));
        return;
      }
      void client
        .startMission(trimmed)
        .then((result) => {
          const text = describeRun(result?.run);
          if (text) setResponse(text);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setAwaitingResponse(false));
    },
    [client],
  );

  /* ------------------------------- listening ----------------------------- */

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    meterRef.current?.stop();
    meterRef.current = null;
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    if (recognitionRef.current) {
      stopListening();
      return;
    }
    if (config.speech.provider === 'none') {
      setError('speech input is disabled (VITE_ZERO_SPEECH_PROVIDER=none)');
      return;
    }
    const recognition = new WebSpeechInput(config.speech.language);
    if (!recognition.isSupported()) {
      setError('this browser has no SpeechRecognition engine — type to ZERO instead');
      return;
    }

    // Barge-in: ZERO yields the floor the moment a human starts speaking.
    ttsRef.current?.stop();
    setSpeaking(false);
    // The microphone gesture is also what unblocks the AudioContext, so the
    // answer can be played back without a second tap.
    void engineRef.current?.activate();

    setPartial('');
    setFinalTranscript('');
    setResponse('');
    setError(null);
    setListening(true);
    channelRef.current?.send({
      type: 'voice.hello',
      language: config.speech.language,
      client: 'brain-interface',
    });

    // The level meter is what makes "ZERO is listening" honest: it shows the
    // real input signal. A denied microphone costs the meter, not the words.
    const meter = new MicrophoneMeter();
    meterRef.current = meter;
    void meter.start().then((result) => {
      if (!result.ok && result.error) setError(result.error);
    });

    recognition.start({
      onPartial: (text) => {
        setPartial(text);
        channelRef.current?.send({ type: 'voice.partial', text });
      },
      onFinal: (text) => setFinalTranscript(text),
      onError: (message) => {
        setError(message);
        setListening(false);
        recognitionRef.current = null;
        meterRef.current?.stop();
        meterRef.current = null;
      },
      onEnd: (text) => {
        setListening(false);
        recognitionRef.current = null;
        meterRef.current?.stop();
        meterRef.current = null;
        if (text.length > 0) {
          setFinalizing(true);
          handOff(text);
        }
      },
    });
    recognitionRef.current = recognition;
  }, [handOff, stopListening]);

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setPartial(trimmed);
      const channel = channelRef.current;
      if (channel?.isAvailable) {
        setFinalTranscript(trimmed);
        setResponse('');
        setError(null);
        setAwaitingResponse(true);
        channel.send({ type: 'voice.text', text: trimmed });
        return;
      }
      handOff(trimmed);
    },
    [handOff],
  );

  /* ------------------------------- samplers ------------------------------ */

  const micLevel = useCallback(() => meterRef.current?.level() ?? 0, []);

  const levels = useCallback((): AudioLevels => {
    const reading = ttsRef.current?.levels();
    return reading?.levels ?? SILENT_LEVELS;
  }, []);

  const estimated = tier === 'synthesis';

  useEffect(() => {
    return () => {
      recognitionRef.current?.dispose();
      recognitionRef.current = null;
      meterRef.current?.stop();
      meterRef.current = null;
    };
  }, []);

  return {
    speechSupported,
    listening,
    partial,
    finalTranscript,
    response,
    responseMissionId,
    error,
    channelStatus,
    tier,
    tierNote,
    estimated,
    audioUnavailable,
    awaitingResponse,
    finalizing,
    speaking,
    reportedState,
    micLevel,
    levels,
    startListening,
    stopListening,
    submitText,
    speak,
    stopSpeaking,
  };
}
